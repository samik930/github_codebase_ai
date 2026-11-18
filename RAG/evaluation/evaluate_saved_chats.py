"""
Evaluate Real Stored Chat Answers for samik930/med_appt_booking from MongoDB.
Evaluates Faithfulness, Answer Relevancy, Code Grounding, and Composite Quality.
"""

import os
import sys
import json
import csv
import time
from datetime import datetime

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
RAG_ROOT = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
if RAG_ROOT not in sys.path:
    sys.path.insert(0, RAG_ROOT)

from evaluation.evaluator import evaluate_faithfulness, evaluate_answer_relevancy, evaluate_code_grounding

CHAT_PAIRS_FILE = os.path.join(CURRENT_DIR, "med_appt_chat_pairs.json")
REPORTS_DIR = os.path.join(CURRENT_DIR, "reports")
os.makedirs(REPORTS_DIR, exist_ok=True)


def evaluate_stored_chats():
    print("\n" + "=" * 75)
    print("      EVALUATING REAL CHAT ANSWERS — samik930/med_appt_booking")
    print("=" * 75)

    if not os.path.exists(CHAT_PAIRS_FILE):
        print(f"[ERROR] Chat pairs file not found: {CHAT_PAIRS_FILE}")
        return

    with open(CHAT_PAIRS_FILE, "r", encoding="utf-8") as f:
        pairs = json.load(f)

    print(f"Loaded {len(pairs)} stored conversation turns from MongoDB.\n")

    results = []
    start_time = time.time()

    for idx, turn in enumerate(pairs, start=1):
        question = turn["question"]
        answer = turn["answer"]
        sources = turn.get("sources", [])
        timestamp = turn.get("timestamp")

        print(f"[{idx}/{len(pairs)}] Evaluating Turn {idx}:")
        print(f"    Q: \"{question}\"")
        preview = answer[:120].replace('\n', ' ')
        print(f"    A: \"{preview}...\"")

        # Check for upstream model errors
        is_model_error = "upstream model error" in answer.lower() or "could not generate an answer" in answer.lower()

        if is_model_error:
            print("    [ALERT] Upstream model failure detected on this turn.")
            results.append({
                "turn": idx,
                "question": question,
                "answer": answer,
                "sources": sources,
                "timestamp": timestamp,
                "is_model_error": True,
                "scores": {
                    "faithfulness": 0.0,
                    "answer_relevancy": 0.0,
                    "code_grounding": 0.0,
                    "composite": 0.0
                },
                "status": "FAILED (UPSTREAM_ERROR)"
            })
            continue

        # Prepare context snippets from cited sources metadata or source paths
        dummy_docs = [
            {"metadata": s if isinstance(s, dict) else {"path": str(s)}, "pageContent": str(s)}
            for s in sources
        ]

        # 1. Faithfulness
        context_texts = [
            (s.get("path") or s.get("source") or json.dumps(s)) if isinstance(s, dict) else str(s)
            for s in sources
        ]
        faith_res = evaluate_faithfulness(question, context_texts, answer)

        # 2. Answer Relevancy
        relev_res = evaluate_answer_relevancy(question, answer)

        # 3. Code Grounding
        ground_res = evaluate_code_grounding(answer, dummy_docs)

        # Composite score
        faith_score = faith_res.get("score", 0.0)
        relev_score = relev_res.get("score", 0.0)
        ground_score = ground_res.get("score", 0.0)
        composite = round((faith_score * 0.45) + (relev_score * 0.40) + (ground_score * 0.15), 3)

        print(f"    Scores: Faithfulness={faith_score:.2f} | Relevancy={relev_score:.2f} | Grounding={ground_score:.2f} | Composite={composite:.2f}")

        results.append({
            "turn": idx,
            "question": question,
            "answer": answer,
            "sources": sources,
            "timestamp": timestamp,
            "is_model_error": False,
            "scores": {
                "faithfulness": faith_score,
                "answer_relevancy": relev_score,
                "code_grounding": ground_score,
                "composite": composite
            },
            "faithfulness_details": faith_res,
            "relevancy_details": relev_res,
            "grounding_details": ground_res,
            "status": "PASS" if composite >= 0.70 else "NEEDS_REVIEW"
        })

    elapsed = round(time.time() - start_time, 2)

    # Compute Aggregate Metrics
    success_turns = [r for r in results if not r["is_model_error"]]
    n_succ = len(success_turns) or 1

    avg_faith = round(sum(r["scores"]["faithfulness"] for r in success_turns) / n_succ, 3)
    avg_relev = round(sum(r["scores"]["answer_relevancy"] for r in success_turns) / n_succ, 3)
    avg_ground = round(sum(r["scores"]["code_grounding"] for r in success_turns) / n_succ, 3)
    avg_comp = round(sum(r["scores"]["composite"] for r in success_turns) / n_succ, 3)

    passed_count = sum(1 for r in success_turns if r["status"] == "PASS")
    pass_rate = round((passed_count / len(results)) * 100, 1)

    report = {
        "timestamp": datetime.now().isoformat(),
        "repository": "samik930/med_appt_booking",
        "total_turns_evaluated": len(results),
        "successful_responses": len(success_turns),
        "upstream_model_failures": len(results) - len(success_turns),
        "pass_rate_percentage": pass_rate,
        "evaluation_duration_seconds": elapsed,
        "aggregate_metrics_on_successful_turns": {
            "average_faithfulness": avg_faith,
            "average_answer_relevancy": avg_relev,
            "average_code_grounding": avg_ground,
            "overall_composite_score": avg_comp
        },
        "turns": results
    }

    # Save JSON and CSV
    json_path = os.path.join(REPORTS_DIR, "med_appt_chat_evaluation.json")
    csv_path = os.path.join(REPORTS_DIR, "med_appt_chat_evaluation.csv")

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Turn", "Question", "Faithfulness", "Relevancy", "Grounding", "Composite", "Status"])
        for r in results:
            writer.writerow([
                r["turn"],
                r["question"],
                r["scores"]["faithfulness"],
                r["scores"]["answer_relevancy"],
                r["scores"]["code_grounding"],
                r["scores"]["composite"],
                r["status"]
            ])

    # Print Executive Report
    print("\n" + "=" * 75)
    print("              MED APPT BOOKING CHAT EVALUATION REPORT")
    print("=" * 75)
    print(f"Total Stored Chat Turns     : {len(results)}")
    print(f"Successful Answer Turns     : {len(success_turns)}")
    print(f"Upstream Error Turns        : {len(results) - len(success_turns)} (Turns 6 & 9)")
    print(f"Pass Rate (>= 0.70)         : {pass_rate}% ({passed_count}/{len(results)})")
    print("-" * 75)
    print("Aggregate Scores (Successful Answers):")
    print(f"  • Average Faithfulness    : {avg_faith:.3f} / 1.000")
    print(f"  • Average Answer Relevancy: {avg_relev:.3f} / 1.000")
    print(f"  • Average Code Grounding  : {avg_ground:.3f} / 1.000")
    print(f"  • OVERALL COMPOSITE SCORE : {avg_comp:.3f} / 1.000")
    print("-" * 75)
    print("Turn-by-Turn Evaluation Breakdown:")
    for r in results:
        status_icon = "✅" if r["status"] == "PASS" else ("⚠️" if r["status"] == "NEEDS_REVIEW" else "❌")
        print(f"  {status_icon} Turn {r['turn']:02d}: Score={r['scores']['composite']:.2f} | \"{r['question']}\"")
    print("-" * 75)
    print(f"JSON Report : {json_path}")
    print(f"CSV Report  : {csv_path}")
    print("=" * 75 + "\n")

    return report


if __name__ == "__main__":
    evaluate_stored_chats()

