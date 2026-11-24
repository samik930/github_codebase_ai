"""
Live background RAGAS evaluation for production /query responses.

Runs concurrently in a daemon thread after streaming finishes so the frontend
response is never delayed. Stores per-repository RAGAS metrics (Faithfulness
and AnswerRelevancy, which are reference-free) in:
    RAG/evaluation/reports/live/<sanitized_repo_id>.json
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger("eval.live")

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
LIVE_REPORTS_DIR = os.path.join(CURRENT_DIR, "reports", "live")
os.makedirs(LIVE_REPORTS_DIR, exist_ok=True)

_WRITE_LOCK = threading.Lock()


def is_live_eval_enabled() -> bool:
    """Return True if live background RAGAS evaluation is enabled via env var."""
    return os.getenv("ENABLE_LIVE_RAGAS_EVAL", "true").strip().lower() in ("1", "true", "yes", "on")


def _sanitize_repo(repo_id: str) -> str:
    """Convert repo_id like 'owner/repo' into a safe filename stem."""
    return re.sub(r"[^a-zA-Z0-9._-]", "__", repo_id.strip()) or "unknown_repo"


def get_live_metrics_path(repo_id: str) -> str:
    """Return the JSON file path where live RAGAS metrics for repo_id are stored."""
    os.makedirs(LIVE_REPORTS_DIR, exist_ok=True)
    return os.path.join(LIVE_REPORTS_DIR, f"{_sanitize_repo(repo_id)}.json")


def _compute_aggregate(history: list[dict[str, Any]]) -> dict[str, float | None]:
    """Compute average RAGAS scores across all recorded queries for a repo."""
    if not history:
        return {}
    keys: set[str] = set()
    for entry in history:
        scores = entry.get("ragas_scores") or {}
        keys.update(scores.keys())

    agg: dict[str, float | None] = {}
    for key in sorted(keys):
        vals = [
            entry["ragas_scores"][key]
            for entry in history
            if isinstance((entry.get("ragas_scores") or {}).get(key), (int, float))
        ]
        agg[key] = round(sum(vals) / len(vals), 4) if vals else None
    return agg


def _persist_live_result(repo_id: str, entry: dict[str, Any]) -> None:
    """Thread-safely append a live evaluation entry to the repo's JSON report."""
    path = get_live_metrics_path(repo_id)
    with _WRITE_LOCK:
        data: dict[str, Any] = {
            "repo_id": repo_id,
            "updated_at": None,
            "total_evaluated_queries": 0,
            "aggregate_ragas_scores": {},
            "history": [],
        }
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict):
                    data.update(loaded)
            except Exception as e:
                logger.warning("[live_eval] Could not read existing %s: %s", path, e)

        history = data.get("history", [])
        history.append(entry)
        # Keep the most recent 200 entries per repo to prevent unbounded growth
        if len(history) > 200:
            history = history[-200:]

        data["history"] = history
        data["total_evaluated_queries"] = len(history)
        data["updated_at"] = entry["timestamp"]
        data["aggregate_ragas_scores"] = _compute_aggregate(history)

        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)


def evaluate_and_store_live(
    question: str,
    answer: str,
    documents: list[dict[str, Any]],
    repo_id: str,
    user_id: str = "default_user",
) -> None:
    """
    Synchronously evaluate one live Q&A interaction with reference-free RAGAS
    (Faithfulness + AnswerRelevancy) and store the result for `repo_id`.
    Designed to be run inside a background thread.
    """
    if not answer or not answer.strip() or not documents:
        return

    try:
        # Wait briefly so the Groq TPM bucket used by /query can refill
        delay = float(os.getenv("LIVE_EVAL_DELAY_SECONDS", "12"))
        if delay > 0 and os.getenv("EVAL_LLM_PROVIDER", "groq").lower().strip() == "groq":
            time.sleep(delay)

        from evaluation.ragas_evaluator import evaluate_with_ragas  # noqa: PLC0415

        # Keep total context well within Groq's 8,000 TPM limit for Faithfulness NLI:
        # take top 4 chunks, capped at 1,000 chars each (~1,000 tokens total).
        contexts = []
        total_chars = 0
        for d in documents[:4]:
            content = str(d.get("pageContent", "")).strip()
            if not content:
                continue
            snippet = content[:1000]
            if total_chars + len(snippet) > 4000:
                break
            contexts.append(snippet)
            total_chars += len(snippet)

        if not contexts:
            return

        sample = {
            "user_input": question,
            "response": answer[:1500],
            "retrieved_contexts": contexts,
            "reference": "",
        }
        ragas_res = evaluate_with_ragas([sample], reference_free=True)
        per_sample = ragas_res.get("per_sample") or []
        scores = per_sample[0] if per_sample else ragas_res.get("aggregate", {})

        sources = []
        for d in documents:
            p = (d.get("metadata") or {}).get("path")
            if p and p not in sources:
                sources.append(p)

        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "user_id": user_id,
            "question": question,
            "answer_preview": answer[:300],
            "retrieved_chunks_count": len(documents),
            "sources": sources,
            "ragas_status": ragas_res.get("status", "unknown"),
            "ragas_scores": scores,
            "error": ragas_res.get("error"),
        }
        _persist_live_result(repo_id, entry)
        logger.info(
            "[live_eval] Stored RAGAS metrics for repo=%s status=%s scores=%s",
            repo_id,
            entry["ragas_status"],
            scores,
        )
    except Exception as e:
        logger.warning("[live_eval] Background RAGAS evaluation failed for repo=%s: %s", repo_id, e)


def schedule_live_ragas_eval(
    question: str,
    answer: str,
    documents: list[dict[str, Any]],
    repo_id: str,
    user_id: str = "default_user",
) -> threading.Thread | None:
    """Spawn a daemon thread to evaluate and store RAGAS metrics concurrently."""
    if not is_live_eval_enabled():
        return None
    if not answer or not answer.strip() or not documents:
        return None

    t = threading.Thread(
        target=evaluate_and_store_live,
        args=(question, answer, documents, repo_id, user_id),
        daemon=True,
        name=f"live-ragas-{_sanitize_repo(repo_id)[:20]}",
    )
    t.start()
    return t


def load_live_metrics(repo_id: str | None = None) -> dict[str, Any]:
    """
    Read stored live RAGAS metrics.
    If repo_id is given, returns that repo's report (or empty structure if none).
    If repo_id is None, returns a summary of all evaluated repositories.
    """
    if repo_id:
        path = get_live_metrics_path(repo_id)
        if not os.path.exists(path):
            return {
                "repo_id": repo_id,
                "total_evaluated_queries": 0,
                "aggregate_ragas_scores": {},
                "history": [],
            }
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    os.makedirs(LIVE_REPORTS_DIR, exist_ok=True)
    repos = []
    for fname in sorted(os.listdir(LIVE_REPORTS_DIR)):
        if fname.endswith(".json"):
            try:
                with open(os.path.join(LIVE_REPORTS_DIR, fname), encoding="utf-8") as f:
                    d = json.load(f)
                repos.append({
                    "repo_id": d.get("repo_id"),
                    "updated_at": d.get("updated_at"),
                    "total_evaluated_queries": d.get("total_evaluated_queries", 0),
                    "aggregate_ragas_scores": d.get("aggregate_ragas_scores", {}),
                })
            except Exception:
                continue
    return {"repositories": repos}

