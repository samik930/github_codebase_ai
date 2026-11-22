"""
RAG Evaluation Runner — extended version.

Executes the full evaluation pipeline against the existing Codebase Copilot RAG system:
  User Question → Hybrid Retrieval (BM25 + Qdrant + RRF) → Answer Generation
  → Metric Evaluation (Faithfulness, Relevancy, Precision, Recall, Code-specific, RAGAS)
  → JSON / CSV Reports.

New flags (backward-compatible, all optional):
  --bypass-cache       Prefix user_id with '__eval__:' to isolate from production Redis cache.
  --use-ragas          Run RAGAS metrics (Faithfulness, AnswerRelevancy, Precision, Recall).
  --dataset-file PATH  Load evaluation samples from a JSONL file (generic template).
  --k INT              Top-K cutoff for code-specific metrics (default: 10).
"""

import os
import sys
import json
import csv
import time
import argparse
import logging
from datetime import datetime

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s — %(message)s")
logger = logging.getLogger("eval.runner")

# Ensure RAG root is on Python sys.path
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
RAG_ROOT = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
if RAG_ROOT not in sys.path:
    sys.path.insert(0, RAG_ROOT)

from dotenv import load_dotenv
load_dotenv(os.path.join(RAG_ROOT, ".env"))
load_dotenv()

from retrieve import retrieve_documents
from generate import generate_answer
from evaluation.dataset import get_evaluation_dataset
from evaluation.evaluator import evaluate_sample
from evaluation.code_metrics import compute_code_specific_scores

REPORTS_DIR = os.path.join(CURRENT_DIR, "reports")
os.makedirs(REPORTS_DIR, exist_ok=True)

EVAL_CACHE_PREFIX = "__eval__"


# ---------------------------------------------------------------------------
# Dataset helpers
# ---------------------------------------------------------------------------

def _load_jsonl_dataset(path: str, limit: int | None = None, category: str | None = None) -> list[dict]:
    """Load evaluation samples from a JSONL file."""
    samples = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("//") or line.startswith("#"):
                continue
            try:
                record = json.loads(line)
                # Normalise field names (supports both 'user_input' and 'question')
                if "question" in record and "user_input" not in record:
                    record["user_input"] = record["question"]
                if "user_input" not in record:
                    continue
                if category and record.get("category") != category:
                    continue
                samples.append(record)
                if limit and len(samples) >= limit:
                    break
            except json.JSONDecodeError as e:
                logger.warning("Skipping malformed JSONL line: %s", e)
    return samples


def _load_dataset(
    repo_id: str,
    category: str | None,
    limit: int | None,
    dataset_file: str | None,
) -> list[dict]:
    """Load dataset from JSONL file (if given) or built-in dataset module."""
    if dataset_file:
        logger.info("Loading dataset from JSONL file: %s", dataset_file)
        samples = _load_jsonl_dataset(dataset_file, limit=limit, category=category)
        # Inject repo_id as a default if not in sample
        for s in samples:
            s.setdefault("repo_id", repo_id)
        return samples
    else:
        raw = get_evaluation_dataset(repo_id=repo_id, category=category, limit=limit)
        # Normalise legacy dataset format
        normalised = []
        for item in raw:
            if "question" in item and "user_input" not in item:
                item["user_input"] = item["question"]
            if "reference_answer" in item and "reference" not in item:
                item["reference"] = item["reference_answer"]
            normalised.append(item)
        return normalised


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------

def run_evaluation(
    repo_id: str = "SpandanDevOps/Airproof-x402",
    user_id: str = "samikpodder396@gmail.com",
    category: str | None = None,
    limit: int | None = None,
    output_dir: str = REPORTS_DIR,
    bypass_cache: bool = False,
    use_ragas: bool = False,
    dataset_file: str | None = None,
    k: int = 10,
) -> dict:
    # -------------------------------------------------------------------
    # Banner
    # -------------------------------------------------------------------
    print("\n" + "=" * 72)
    print("        CODEBASE COPILOT — RAG PIPELINE EVALUATION RUNNER")
    print("=" * 72)
    print(f"Target Repository : {repo_id}")
    print(f"User Tenant ID    : {user_id}")
    if bypass_cache:
        effective_user_id = f"{EVAL_CACHE_PREFIX}:{user_id}"
        print(f"Cache Isolation   : ENABLED  (retrieval user_id = '{effective_user_id}')")
    else:
        effective_user_id = user_id
        print("Cache Isolation   : DISABLED (using production cache namespace)")
    if category:
        print(f"Category Filter   : {category}")
    if limit:
        print(f"Sample Limit      : {limit}")
    if dataset_file:
        print(f"Dataset File      : {dataset_file}")
    print(f"Top-K Cutoff (code metrics): {k}")
    print(f"RAGAS Metrics     : {'ENABLED' if use_ragas else 'DISABLED'}")
    print(f"Reports Output    : {output_dir}")
    print("=" * 72 + "\n")

    # -------------------------------------------------------------------
    # Load dataset
    # -------------------------------------------------------------------
    dataset = _load_dataset(repo_id, category, limit, dataset_file)
    total_samples = len(dataset)
    if total_samples == 0:
        print("[ERROR] No evaluation samples loaded. Exiting.")
        return {}
    print(f"Loaded {total_samples} evaluation question(s).\n")

    results = []
    ragas_samples = []
    start_time = time.time()

    # -------------------------------------------------------------------
    # Per-sample evaluation loop
    # -------------------------------------------------------------------
    for idx, item in enumerate(dataset, start=1):
        q_id = item.get("id", f"q_{idx}")
        cat = item.get("category", "general")
        question = item.get("user_input") or item.get("question", "")
        ref_ans = item.get("reference") or item.get("reference_answer", "")
        exp_files = item.get("expected_files", [])

        print(f"[{idx}/{total_samples}] {q_id} ({cat})")
        print(f"    Q: \"{question[:100]}{'...' if len(question) > 100 else ''}\"")

        try:
            # 1. Real retrieval via existing pipeline
            retrieved_docs = retrieve_documents(
                question,
                repo_id=repo_id,
                user_id=effective_user_id,
            )
            retrieved_count = len(retrieved_docs)

            # 2. Real generation via existing pipeline
            gen_result = generate_answer(question, retrieved_docs, repo_id=repo_id)
            generated_answer = gen_result.get("answer", "")
            cited_sources = gen_result.get("sources", [])

            # 3. Custom Gemini-based metrics (faithfulness, relevancy, precision, grounding)
            eval_metrics = evaluate_sample(
                question=question,
                answer=generated_answer,
                retrieved_docs=retrieved_docs,
                reference_answer=ref_ans,
                expected_files=[f for f in exp_files if f and "REQUIRES_MANUAL_FILL" not in f],
            )

            faith_score = eval_metrics["faithfulness"]["score"]
            relev_score = eval_metrics["answer_relevancy"]["score"]
            prec_score = eval_metrics["context_precision"]["score"]
            ground_score = eval_metrics["code_grounding"]["score"]
            comp_score = eval_metrics["composite_score"]

            # 4. Code-specific metrics
            code_metrics = compute_code_specific_scores(retrieved_docs, item, k=k)
            file_recall_score = (code_metrics["file_recall"].get("score"))
            chunk_recall_score = (code_metrics["chunk_recall"].get("score"))
            func_cov_score = (code_metrics["function_coverage"].get("score"))

            # 5. Zero-retrieval diagnostic
            if retrieved_count == 0:
                logger.warning("ZERO documents retrieved for question '%s'", q_id)

            print(
                f"    Retrieval: {retrieved_count} docs | "
                f"Faithfulness={faith_score:.2f} Relevancy={relev_score:.2f} "
                f"Precision={prec_score:.2f} Composite={comp_score:.2f}"
            )
            if file_recall_score is not None:
                print(f"    File Recall@{k}={file_recall_score:.2f} | Func Coverage={func_cov_score:.2f if func_cov_score is not None else 'N/A'}")

            # Collect for RAGAS (if enabled)
            ragas_samples.append({
                "user_input": question,
                "response": generated_answer,
                "retrieved_contexts": [d.get("pageContent", "") for d in retrieved_docs],
                "reference": ref_ans,
            })

            results.append({
                "id": q_id,
                "category": cat,
                "question": question,
                "reference": ref_ans,
                "expected_files": exp_files,
                "retrieved_sources": [d.get("metadata", {}).get("path") for d in retrieved_docs],
                "retrieved_chunks_count": retrieved_count,
                "generated_answer": generated_answer,
                "cited_sources": cited_sources,
                "scores": {
                    "faithfulness": faith_score,
                    "answer_relevancy": relev_score,
                    "context_precision": prec_score,
                    "code_grounding": ground_score,
                    "composite": comp_score,
                    "file_recall_at_k": file_recall_score,
                    "chunk_recall_at_k": chunk_recall_score,
                    "function_coverage": func_cov_score,
                },
                "code_metrics_detail": code_metrics,
                "details": eval_metrics,
                "status": "PASS" if comp_score >= 0.70 else "NEEDS_REVIEW",
                "zero_retrieval": retrieved_count == 0,
            })

        except Exception as e:
            logger.exception("Evaluation failed for %s", q_id)
            ragas_samples.append({"user_input": question, "response": "", "retrieved_contexts": [], "reference": ref_ans})
            results.append({
                "id": q_id,
                "category": cat,
                "question": question,
                "error": str(e),
                "status": "ERROR",
                "zero_retrieval": True,
                "scores": {
                    "faithfulness": 0.0, "answer_relevancy": 0.0,
                    "context_precision": 0.0, "code_grounding": 0.0,
                    "composite": 0.0, "file_recall_at_k": None,
                    "chunk_recall_at_k": None, "function_coverage": None,
                },
            })

    elapsed_time = round(time.time() - start_time, 2)

    # -------------------------------------------------------------------
    # Optional RAGAS pass
    # -------------------------------------------------------------------
    ragas_report: dict = {}
    if use_ragas:
        print("\n[RAGAS] Running RAGAS metric evaluation...")
        try:
            from evaluation.ragas_evaluator import evaluate_with_ragas  # noqa: PLC0415
            ragas_report = evaluate_with_ragas(ragas_samples)
            agg = ragas_report.get("aggregate", {})
            print(f"[RAGAS] Status: {ragas_report.get('status')} | Aggregate: {agg}")
            # Merge per-sample RAGAS scores into results
            per_s = ragas_report.get("per_sample", [])
            for i, r in enumerate(results):
                if i < len(per_s):
                    r["ragas_scores"] = per_s[i]
        except Exception as e:
            logger.error("[RAGAS] evaluation failed: %s", e)
            ragas_report = {"status": "failed", "error": str(e)}

    # -------------------------------------------------------------------
    # Aggregate metrics
    # -------------------------------------------------------------------
    valid_results = [r for r in results if r["status"] != "ERROR"]
    n_valid = len(valid_results) or 1

    def _avg(key: str) -> float:
        vals = [r["scores"].get(key) for r in valid_results if r["scores"].get(key) is not None]
        return round(sum(vals) / len(vals), 3) if vals else 0.0

    avg_faith = _avg("faithfulness")
    avg_relev = _avg("answer_relevancy")
    avg_prec = _avg("context_precision")
    avg_ground = _avg("code_grounding")
    avg_comp = _avg("composite")
    avg_file_recall = _avg("file_recall_at_k")
    avg_chunk_recall = _avg("chunk_recall_at_k")
    avg_func_cov = _avg("function_coverage")

    passed_count = sum(1 for r in valid_results if r["status"] == "PASS")
    pass_rate = round((passed_count / len(results)) * 100, 1) if results else 0.0

    # Diagnostic: zero-retrieval questions
    zero_retrieval_items = [
        {"id": r["id"], "question": r["question"]} for r in results if r.get("zero_retrieval")
    ]

    # Diagnostic: file retrieved but function missed
    file_hit_func_miss = []
    for r in valid_results:
        cm = r.get("code_metrics_detail", {})
        fr = cm.get("file_recall", {})
        fc = cm.get("function_coverage", {})
        if (fr.get("score") or 0) > 0 and (fc.get("score") or 1) == 0:
            file_hit_func_miss.append({
                "id": r["id"],
                "question": r["question"],
                "found_files": fr.get("found_files", []),
                "missing_functions": fc.get("missing_functions", []),
            })

    low_scoring = [
        {"id": r["id"], "question": r["question"],
         "composite": r["scores"]["composite"],
         "faithfulness": r["scores"]["faithfulness"],
         "precision": r["scores"]["context_precision"]}
        for r in results if r["scores"]["composite"] < 0.70
    ]

    report = {
        "timestamp": datetime.utcnow().isoformat(),
        "repository": repo_id,
        "user_id": user_id,
        "effective_user_id": effective_user_id,
        "bypass_cache": bypass_cache,
        "use_ragas": use_ragas,
        "k_cutoff": k,
        "evaluation_duration_seconds": elapsed_time,
        "total_questions": len(results),
        "passed_questions": passed_count,
        "pass_rate_percentage": pass_rate,
        "aggregate_metrics": {
            "average_faithfulness": avg_faith,
            "average_answer_relevancy": avg_relev,
            "average_context_precision": avg_prec,
            "average_code_grounding": avg_ground,
            "overall_composite_score": avg_comp,
            "average_file_recall_at_k": avg_file_recall,
            "average_chunk_recall_at_k": avg_chunk_recall,
            "average_function_coverage": avg_func_cov,
        },
        "ragas_scores": ragas_report,
        "diagnostics": {
            "zero_retrieval_questions": zero_retrieval_items,
            "file_hit_but_function_missed": file_hit_func_miss,
            "low_scoring_questions": low_scoring,
        },
        "individual_results": results,
    }

    # -------------------------------------------------------------------
    # Save reports
    # -------------------------------------------------------------------
    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    json_path = os.path.join(output_dir, f"eval_report_{timestamp_str}.json")
    latest_json_path = os.path.join(output_dir, "latest_report.json")
    csv_path = os.path.join(output_dir, f"eval_report_{timestamp_str}.csv")

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    with open(latest_json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "ID", "Category", "Question",
            "Faithfulness", "Relevancy", "Precision", "Code Grounding", "Composite",
            "File Recall@K", "Chunk Recall@K", "Func Coverage",
            "Retrieved Docs", "Status",
        ])
        for r in results:
            sc = r["scores"]
            writer.writerow([
                r["id"], r["category"], r["question"][:80],
                sc.get("faithfulness", ""), sc.get("answer_relevancy", ""),
                sc.get("context_precision", ""), sc.get("code_grounding", ""), sc.get("composite", ""),
                sc.get("file_recall_at_k", ""), sc.get("chunk_recall_at_k", ""),
                sc.get("function_coverage", ""),
                r.get("retrieved_chunks_count", 0), r["status"],
            ])

    # -------------------------------------------------------------------
    # Executive summary
    # -------------------------------------------------------------------
    print("\n" + "=" * 72)
    print("                     EVALUATION EXECUTIVE SUMMARY")
    print("=" * 72)
    print(f"Evaluated Questions        : {len(results)}")
    print(f"Pass Rate (Score >= 0.70)  : {pass_rate}% ({passed_count}/{len(results)})")
    print(f"Evaluation Time            : {elapsed_time}s")
    print("-" * 72)
    print(f"Average Faithfulness       : {avg_faith:.3f} / 1.000")
    print(f"Average Answer Relevancy   : {avg_relev:.3f} / 1.000")
    print(f"Average Context Precision  : {avg_prec:.3f} / 1.000")
    print(f"Average Code Grounding     : {avg_ground:.3f} / 1.000")
    print(f"OVERALL COMPOSITE SCORE    : {avg_comp:.3f} / 1.000")
    print("-" * 72)
    if avg_file_recall:
        print(f"Avg File Recall@{k:<3}        : {avg_file_recall:.3f} / 1.000")
    if avg_chunk_recall:
        print(f"Avg Chunk Recall@{k:<3}       : {avg_chunk_recall:.3f} / 1.000")
    if avg_func_cov:
        print(f"Avg Function Coverage      : {avg_func_cov:.3f} / 1.000")
    if use_ragas and ragas_report.get("aggregate"):
        print("-" * 72)
        print("RAGAS Scores:")
        for k_name, v in ragas_report["aggregate"].items():
            print(f"  {k_name:<30}: {v:.3f}" if v is not None else f"  {k_name:<30}: N/A")
    print("-" * 72)
    if zero_retrieval_items:
        print(f"Zero-Retrieval Questions ({len(zero_retrieval_items)}):")
        for item in zero_retrieval_items:
            print(f"  - [{item['id']}] {item['question'][:60]}")
    if file_hit_func_miss:
        print(f"File Hit but Function Missed ({len(file_hit_func_miss)}):")
        for item in file_hit_func_miss:
            print(f"  - [{item['id']}] missing: {item['missing_functions']}")
    if low_scoring:
        print(f"Low-Scoring Questions ({len(low_scoring)}):")
        for item in low_scoring:
            print(f"  - [{item['id']}] (Score: {item['composite']:.2f}) {item['question'][:60]}")
    else:
        print("All questions achieved passing scores (>= 0.70)!")
    print("-" * 72)
    print(f"Full JSON Report : {json_path}")
    print(f"Full CSV Report  : {csv_path}")
    print("=" * 72 + "\n")

    return report


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Codebase Copilot RAG Evaluation Runner")
    parser.add_argument("--repo-id", default="SpandanDevOps/Airproof-x402", help="Repository identifier")
    parser.add_argument("--user-id", default="samikpodder396@gmail.com", help="User identifier")
    parser.add_argument("--category", default=None, help="Optional category filter")
    parser.add_argument("--limit", type=int, default=None, help="Max number of evaluation questions")
    parser.add_argument("--output-dir", default=REPORTS_DIR, help="Output directory for reports")
    parser.add_argument(
        "--bypass-cache", action="store_true",
        help="Prefix user_id with '__eval__:' to isolate from production Redis cache",
    )
    parser.add_argument(
        "--use-ragas", action="store_true",
        help="Run RAGAS metrics in addition to custom evaluator (requires GROQ_API_KEY or GOOGLE_API_KEY)",
    )
    parser.add_argument(
        "--dataset-file", default=None,
        help="Path to a JSONL evaluation dataset file (overrides built-in dataset)",
    )
    parser.add_argument(
        "--k", type=int, default=10,
        help="Top-K cutoff for file/chunk recall metrics (default: 10)",
    )

    args = parser.parse_args()
    run_evaluation(
        repo_id=args.repo_id,
        user_id=args.user_id,
        category=args.category,
        limit=args.limit,
        output_dir=args.output_dir,
        bypass_cache=args.bypass_cache,
        use_ragas=args.use_ragas,
        dataset_file=args.dataset_file,
        k=args.k,
    )
