"""
RAG Evaluation Runner.
Executes the evaluation pipeline against the existing Codebase Copilot RAG system:
User Question -> Hybrid Retrieval (BM25 + Qdrant + RRF) -> Gemini Answer Generation
-> Metric Evaluation (Faithfulness, Answer Relevancy, Context Precision, Code Grounding)
-> JSON / CSV Reports.
"""

import os
import sys
import json
import csv
import time
import argparse
from datetime import datetime

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

REPORTS_DIR = os.path.join(CURRENT_DIR, "reports")
os.makedirs(REPORTS_DIR, exist_ok=True)


def run_evaluation(
    repo_id: str = "SpandanDevOps/Airproof-x402",
    user_id: str = "samikpodder396@gmail.com",
    category: str = None,
    limit: int = None,
    output_dir: str = REPORTS_DIR
) -> dict:
    print("\n" + "=" * 70)
    print("        CODEBASE COPILOT — RAG PIPELINE EVALUATION RUNNER")
    print("=" * 70)
    print(f"Target Repository : {repo_id}")
    print(f"User Tenant ID    : {user_id}")
    if category:
        print(f"Category Filter   : {category}")
    if limit:
        print(f"Sample Limit      : {limit}")
    print(f"Reports Output    : {output_dir}")
    print("=" * 70 + "\n")

    dataset = get_evaluation_dataset(repo_id=repo_id, category=category, limit=limit)
    total_samples = len(dataset)
    print(f"Loaded {total_samples} evaluation questions.\n")

    results = []
    start_time = time.time()

    for idx, item in enumerate(dataset, start=1):
        q_id = item.get("id", f"q_{idx}")
        cat = item.get("category", "general")
        question = item["question"]
        ref_ans = item.get("reference_answer", "")
        exp_files = item.get("expected_files", [])

        print(f"[{idx}/{total_samples}] Evaluating: {q_id} ({cat})")
        print(f"    Q: \"{question}\"")

        try:
            # 1. Real Retrieval via existing pipeline
            retrieved_docs = retrieve_documents(question, repo_id=repo_id, user_id=user_id)

            # 2. Real Generation via existing pipeline
            gen_result = generate_answer(question, retrieved_docs, repo_id=repo_id)
            generated_answer = gen_result.get("answer", "")
            cited_sources = gen_result.get("sources", [])

            # 3. Evaluate Metrics
            eval_metrics = evaluate_sample(
                question=question,
                answer=generated_answer,
                retrieved_docs=retrieved_docs,
                reference_answer=ref_ans,
                expected_files=exp_files
            )

            # Extract scores
            faith_score = eval_metrics["faithfulness"]["score"]
            relev_score = eval_metrics["answer_relevancy"]["score"]
            prec_score = eval_metrics["context_precision"]["score"]
            ground_score = eval_metrics["code_grounding"]["score"]
            comp_score = eval_metrics["composite_score"]

            print(f"    Scores: Faithfulness={faith_score:.2f} | Relevancy={relev_score:.2f} | Precision={prec_score:.2f} | Composite={comp_score:.2f}")

            results.append({
                "id": q_id,
                "category": cat,
                "question": question,
                "reference_answer": ref_ans,
                "expected_files": exp_files,
                "retrieved_sources": [d.get("metadata", {}).get("path") for d in retrieved_docs],
                "retrieved_chunks_count": len(retrieved_docs),
                "generated_answer": generated_answer,
                "cited_sources": cited_sources,
                "scores": {
                    "faithfulness": faith_score,
                    "answer_relevancy": relev_score,
                    "context_precision": prec_score,
                    "code_grounding": ground_score,
                    "composite": comp_score
                },
                "details": eval_metrics,
                "status": "PASS" if comp_score >= 0.70 else "NEEDS_REVIEW"
            })

        except Exception as e:
            print(f"    [ERROR] Evaluation failed for {q_id}: {e}")
            results.append({
                "id": q_id,
                "category": cat,
                "question": question,
                "error": str(e),
                "status": "ERROR",
                "scores": {
                    "faithfulness": 0.0,
                    "answer_relevancy": 0.0,
                    "context_precision": 0.0,
                    "code_grounding": 0.0,
                    "composite": 0.0
                }
            })

    elapsed_time = round(time.time() - start_time, 2)

    # Compute Aggregate Metrics
    valid_results = [r for r in results if r["status"] != "ERROR"]
    n_valid = len(valid_results) or 1

    avg_faith = round(sum(r["scores"]["faithfulness"] for r in valid_results) / n_valid, 3)
    avg_relev = round(sum(r["scores"]["answer_relevancy"] for r in valid_results) / n_valid, 3)
    avg_prec = round(sum(r["scores"]["context_precision"] for r in valid_results) / n_valid, 3)
    avg_ground = round(sum(r["scores"]["code_grounding"] for r in valid_results) / n_valid, 3)
    avg_comp = round(sum(r["scores"]["composite"] for r in valid_results) / n_valid, 3)

    passed_count = sum(1 for r in valid_results if r["status"] == "PASS")
    pass_rate = round((passed_count / len(results)) * 100, 1) if results else 0.0

    low_scoring = [
        {
            "id": r["id"],
            "question": r["question"],
            "composite": r["scores"]["composite"],
            "faithfulness": r["scores"]["faithfulness"],
            "precision": r["scores"]["context_precision"]
        }
        for r in results if r["scores"]["composite"] < 0.70
    ]

    report = {
        "timestamp": datetime.utcnow().isoformat(),
        "repository": repo_id,
        "user_id": user_id,
        "evaluation_duration_seconds": elapsed_time,
        "total_questions": len(results),
        "passed_questions": passed_count,
        "pass_rate_percentage": pass_rate,
        "aggregate_metrics": {
            "average_faithfulness": avg_faith,
            "average_answer_relevancy": avg_relev,
            "average_context_precision": avg_prec,
            "average_code_grounding": avg_ground,
            "overall_composite_score": avg_comp
        },
        "low_scoring_questions": low_scoring,
        "individual_results": results
    }

    # Save JSON Report
    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    json_path = os.path.join(output_dir, f"eval_report_{timestamp_str}.json")
    latest_json_path = os.path.join(output_dir, "latest_report.json")

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    with open(latest_json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    # Save CSV Summary Report
    csv_path = os.path.join(output_dir, f"eval_report_{timestamp_str}.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["ID", "Category", "Question", "Faithfulness", "Relevancy", "Precision", "Code Grounding", "Composite", "Status"])
        for r in results:
            writer.writerow([
                r["id"],
                r["category"],
                r["question"][:60],
                r["scores"]["faithfulness"],
                r["scores"]["answer_relevancy"],
                r["scores"]["context_precision"],
                r["scores"]["code_grounding"],
                r["scores"]["composite"],
                r["status"]
            ])

    # Print Formatted Executive Summary
    print("\n" + "=" * 70)
    print("                    EVALUATION EXECUTIVE SUMMARY")
    print("=" * 70)
    print(f"Evaluated Questions       : {len(results)}")
    print(f"Pass Rate (Score >= 0.70) : {pass_rate}% ({passed_count}/{len(results)})")
    print(f"Evaluation Time           : {elapsed_time}s")
    print("-" * 70)
    print(f"Average Faithfulness      : {avg_faith:.3f} / 1.000")
    print(f"Average Answer Relevancy  : {avg_relev:.3f} / 1.000")
    print(f"Average Context Precision : {avg_prec:.3f} / 1.000")
    print(f"Average Code Grounding    : {avg_ground:.3f} / 1.000")
    print(f"OVERALL COMPOSITE SCORE   : {avg_comp:.3f} / 1.000")
    print("-" * 70)
    if low_scoring:
        print(f"Low-scoring questions ({len(low_scoring)}):")
        for item in low_scoring:
            print(f"  - [{item['id']}] (Score: {item['composite']:.2f}) {item['question']}")
    else:
        print("All questions achieved passing scores (>= 0.70)!")
    print("-" * 70)
    print(f"Full JSON Report Saved    : {json_path}")
    print(f"Full CSV Report Saved     : {csv_path}")
    print("=" * 70 + "\n")

    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Codebase Copilot RAG Evaluation Runner")
    parser.add_argument("--repo-id", default="SpandanDevOps/Airproof-x402", help="Repository identifier")
    parser.add_argument("--user-id", default="samikpodder396@gmail.com", help="User identifier")
    parser.add_argument("--category", default=None, help="Optional category filter")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of evaluation questions")
    parser.add_argument("--output-dir", default=REPORTS_DIR, help="Output directory for reports")

    args = parser.parse_args()
    run_evaluation(
        repo_id=args.repo_id,
        user_id=args.user_id,
        category=args.category,
        limit=args.limit,
        output_dir=args.output_dir
    )

