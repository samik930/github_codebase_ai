"""
RAGAS-based evaluation wrapper for Codebase Copilot.

Uses ragas==0.2.x API:
  - ragas.dataset_schema.SingleTurnSample, EvaluationDataset
  - ragas.evaluate()
  - ragas.llms.LangchainLLMWrapper (wraps a LangChain BaseChatModel)

Supported evaluator LLM backends (configured via env vars):
  EVAL_LLM_PROVIDER = "groq"   (default)  — uses langchain_groq.ChatGroq
  EVAL_LLM_PROVIDER = "gemini"            — uses langchain_google_genai.ChatGoogleGenerativeAI
  EVAL_LLM_MODEL    = model name override (optional)

Environment variables required:
  GROQ_API_KEY    — when EVAL_LLM_PROVIDER=groq
  GOOGLE_API_KEY  — when EVAL_LLM_PROVIDER=gemini

RAGAS metrics evaluated:
  Faithfulness, AnswerRelevancy, ContextPrecision, ContextRecall
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# LLM factory
# ---------------------------------------------------------------------------

def _build_ragas_llm():
    """
    Build a BaseRagasLLM instance using the configured provider.
    Returns None if the provider cannot be initialised (never raises).
    """
    from ragas.llms import LangchainLLMWrapper  # noqa: PLC0415

    provider = os.getenv("EVAL_LLM_PROVIDER", "groq").lower().strip()

    try:
        if provider == "groq":
            from langchain_groq import ChatGroq  # noqa: PLC0415
            model = os.getenv("EVAL_LLM_MODEL", "openai/gpt-oss-20b")
            api_key = os.getenv("GROQ_API_KEY")
            if not api_key:
                raise ValueError("GROQ_API_KEY is not set.")
            lm = ChatGroq(model=model, api_key=api_key, temperature=0)
            logger.info("[ragas_eval] Using Groq LLM: %s", model)
            return LangchainLLMWrapper(lm)

        elif provider == "gemini":
            from langchain_google_genai import ChatGoogleGenerativeAI  # noqa: PLC0415
            model = os.getenv("EVAL_LLM_MODEL", "gemini-1.5-flash")
            api_key = os.getenv("GOOGLE_API_KEY")
            if not api_key:
                raise ValueError("GOOGLE_API_KEY is not set.")
            lm = ChatGoogleGenerativeAI(model=model, google_api_key=api_key, temperature=0)
            logger.info("[ragas_eval] Using Gemini LLM: %s", model)
            return LangchainLLMWrapper(lm)

        else:
            raise ValueError(f"Unknown EVAL_LLM_PROVIDER: '{provider}'. Use 'groq' or 'gemini'.")

    except ImportError as e:
        logger.warning("[ragas_eval] LLM provider '%s' not installed: %s", provider, e)
        return None
    except Exception as e:
        logger.warning("[ragas_eval] Failed to build RAGAS LLM (%s): %s", provider, e)
        return None


# ---------------------------------------------------------------------------
# RAGAS embeddings factory (required by AnswerRelevancy and ContextPrecision)
# ---------------------------------------------------------------------------

def _build_ragas_embeddings():
    """
    Build a BaseRagasEmbeddings instance using the locally cached FastEmbed model
    (BAAI/bge-small-en-v1.5) for accurate AnswerRelevancy cosine similarity,
    falling back to FakeEmbeddings if unavailable.
    """
    try:
        from ragas.embeddings import LangchainEmbeddingsWrapper  # noqa: PLC0415
        try:
            from langchain_core.embeddings import Embeddings  # noqa: PLC0415
            from fastembed import TextEmbedding  # noqa: PLC0415

            class _FastEmbedLangchain(Embeddings):
                def __init__(self):
                    self._model = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")

                def embed_documents(self, texts: list[str]) -> list[list[float]]:
                    return [v.tolist() for v in self._model.embed(texts)]

                def embed_query(self, text: str) -> list[float]:
                    return next(iter(self._model.embed([text]))).tolist()

            logger.info("[ragas_eval] Using FastEmbed (BAAI/bge-small-en-v1.5) for RAGAS embeddings.")
            return LangchainEmbeddingsWrapper(_FastEmbedLangchain())
        except Exception as fe_err:
            logger.warning("[ragas_eval] FastEmbed unavailable (%s), falling back to FakeEmbeddings.", fe_err)
            from langchain_community.embeddings import FakeEmbeddings  # noqa: PLC0415
            return LangchainEmbeddingsWrapper(FakeEmbeddings(size=384))
    except Exception as e:
        logger.warning("[ragas_eval] Could not build RAGAS embeddings: %s", e)
        return None


# ---------------------------------------------------------------------------
# Core evaluation function
# ---------------------------------------------------------------------------

def evaluate_with_ragas(
    samples: list[dict[str, Any]],
    metrics: list | None = None,
    reference_free: bool = False,
) -> dict[str, Any]:
    """
    Run RAGAS evaluation over a list of samples.

    Each sample dict must contain:
        user_input         (str)   — the user's question
        response           (str)   — the generated answer
        retrieved_contexts (list[str]) — the retrieved context strings
        reference          (str)   — the reference/ground-truth answer (optional if reference_free=True)

    Args:
        samples: List of sample dicts as described above.
        metrics: Optional list of ragas Metric instances. Defaults to
                 [Faithfulness, AnswerRelevancy, ContextPrecision, ContextRecall],
                 or [Faithfulness, AnswerRelevancy] when reference_free=True.
        reference_free: If True, only run metrics that do not require a ground-truth
                        reference answer (Faithfulness and AnswerRelevancy).

    Returns:
        {
          "status": "ok" | "partial" | "failed",
          "aggregate": {metric_name: float, ...},
          "per_sample": [{metric_name: float, ...}, ...],
          "error": str | None,
        }
    """
    # -------------------------------------------------------------------
    # Lazy imports — RAGAS is optional; if unavailable, return gracefully
    # -------------------------------------------------------------------
    try:
        import sys  # noqa: PLC0415
        if sys.version_info >= (3, 14):
            # ragas 0.2.x calls nest_asyncio.apply(), which breaks asyncio.wait_for()
            # on Python 3.14 ("Timeout should be used inside a task").
            import nest_asyncio  # noqa: PLC0415
            nest_asyncio.apply = lambda *args, **kwargs: None

        from ragas import evaluate as ragas_evaluate  # noqa: PLC0415
        from ragas.dataset_schema import EvaluationDataset, SingleTurnSample  # noqa: PLC0415
        from ragas.metrics import (  # noqa: PLC0415
            Faithfulness,
            AnswerRelevancy,
            ContextPrecision,
            ContextRecall,
        )
    except ImportError as e:
        logger.error("[ragas_eval] RAGAS package not available: %s", e)
        return {"status": "failed", "aggregate": {}, "per_sample": [], "error": str(e)}

    # -------------------------------------------------------------------
    # Build LLM and Embeddings
    # -------------------------------------------------------------------
    ragas_llm = _build_ragas_llm()
    ragas_emb = _build_ragas_embeddings()

    if ragas_llm is None:
        logger.warning(
            "[ragas_eval] No RAGAS LLM available. Returning None scores for all RAGAS metrics."
        )
        null_aggregate = {
            "faithfulness": None,
            "answer_relevancy": None,
            "context_precision": None,
            "context_recall": None,
        }
        return {
            "status": "failed",
            "aggregate": null_aggregate,
            "per_sample": [null_aggregate.copy() for _ in samples],
            "error": "LLM initialisation failed — check EVAL_LLM_PROVIDER and API key env vars.",
        }

    # -------------------------------------------------------------------
    # Build metric instances
    # -------------------------------------------------------------------
    if metrics is None:
        if reference_free:
            metric_instances = [
                Faithfulness(llm=ragas_llm),
                AnswerRelevancy(llm=ragas_llm, embeddings=ragas_emb),
            ]
        else:
            metric_instances = [
                Faithfulness(llm=ragas_llm),
                AnswerRelevancy(llm=ragas_llm, embeddings=ragas_emb),
                ContextPrecision(llm=ragas_llm),
                ContextRecall(llm=ragas_llm),
            ]
    else:
        metric_instances = metrics

    # -------------------------------------------------------------------
    # Build EvaluationDataset
    # -------------------------------------------------------------------
    ragas_samples = []
    for s in samples:
        try:
            ragas_samples.append(
                SingleTurnSample(
                    user_input=str(s.get("user_input", "")),
                    response=str(s.get("response", "")),
                    retrieved_contexts=[str(c) for c in s.get("retrieved_contexts", [])],
                    reference=str(s.get("reference", "")),
                )
            )
        except Exception as e:
            logger.warning("[ragas_eval] Skipping malformed sample: %s", e)

    if not ragas_samples:
        return {
            "status": "failed",
            "aggregate": {},
            "per_sample": [],
            "error": "No valid samples to evaluate.",
        }

    dataset = EvaluationDataset(samples=ragas_samples)

    # -------------------------------------------------------------------
    # Run evaluation
    # -------------------------------------------------------------------
    try:
        from ragas.run_config import RunConfig  # noqa: PLC0415
        result = ragas_evaluate(
            dataset=dataset,
            metrics=metric_instances,
            run_config=RunConfig(max_workers=1, max_retries=3, timeout=120),
            raise_exceptions=False,
            show_progress=True,
        )
    except Exception as e:
        logger.error("[ragas_eval] RAGAS evaluate() raised an exception: %s", e)
        return {
            "status": "failed",
            "aggregate": {},
            "per_sample": [],
            "error": str(e),
        }

    # -------------------------------------------------------------------
    # Parse results — result is an EvaluationResult with a .to_pandas() method
    # -------------------------------------------------------------------
    try:
        df = result.to_pandas()
        metric_cols = [
            c for c in df.columns
            if c not in ("user_input", "response", "retrieved_contexts", "reference")
        ]

        per_sample = []
        for _, row in df.iterrows():
            per_sample.append(
                {col: (None if _is_nan(row[col]) else round(float(row[col]), 4))
                 for col in metric_cols}
            )

        aggregate = {}
        for col in metric_cols:
            valid_vals = [ps[col] for ps in per_sample if ps[col] is not None]
            aggregate[col] = round(sum(valid_vals) / len(valid_vals), 4) if valid_vals else None

        has_any_score = any(v is not None for v in aggregate.values())
        return {
            "status": "ok" if has_any_score else "failed",
            "aggregate": aggregate,
            "per_sample": per_sample,
            "error": None if has_any_score else "All RAGAS metric jobs returned NaN (check evaluator LLM/API access).",
        }

    except Exception as e:
        logger.error("[ragas_eval] Failed to parse RAGAS result: %s", e)
        return {
            "status": "partial",
            "aggregate": {},
            "per_sample": [],
            "error": f"Result parsing error: {e}",
        }


def _is_nan(value: Any) -> bool:
    """Safe NaN check that works for floats, None, and non-numeric types."""
    if value is None:
        return True
    try:
        import math
        return math.isnan(float(value))
    except (TypeError, ValueError):
        return False

