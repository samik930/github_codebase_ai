# Codebase Copilot — RAGAS Evaluation Framework

This document explains how to run the evaluation pipeline, populate the dataset template, and interpret reports.

---

## Directory Layout

```
RAG/evaluation/
├── __init__.py
├── dataset.py              # Built-in repo-specific datasets (Airproof, MedAppt)
├── dataset_template.jsonl  # Generic 40-question template — fill in before use
├── evaluator.py            # Custom Gemini-based evaluator (faithfulness, relevancy, precision, recall, grounding)
├── code_metrics.py         # Code-specific metrics (file recall, chunk recall, function coverage, line coverage)
├── ragas_evaluator.py      # RAGAS 0.2.x wrapper (Faithfulness, AnswerRelevancy, ContextPrecision, ContextRecall)
├── runner.py               # Evaluation runner (CLI entry point)
├── tests/
│   └── test_eval.py        # Unit test suite
└── reports/                # JSON + CSV evaluation reports (auto-created)
```

---

## Required Environment Variables

Set these in `RAG/.env` or export them before running:

| Variable | Required | Default | Description |
|---|---|---|---|
| `GOOGLE_API_KEY` | Yes (custom evaluator) | — | Gemini API key for faithfulness / relevancy / recall |
| `GROQ_API_KEY` | Yes (RAGAS default) | — | Groq API key for RAGAS LLM evaluation |
| `EVAL_LLM_PROVIDER` | No | `groq` | RAGAS LLM backend: `groq` or `gemini` |
| `EVAL_LLM_MODEL` | No | `llama3-8b-8192` | Model name for RAGAS LLM |
| `RETRIEVAL_CACHE_TTL_SECONDS` | No | 604800 | Production retrieval cache TTL (do not set during eval — use `--bypass-cache` instead) |

> **Important:** Never set `DISABLE_RETRIEVAL_CACHE=true` in production. Use `--bypass-cache` in the runner to route evaluation queries to an isolated cache namespace.

---

## Populating the Dataset Template

`dataset_template.jsonl` contains 40 generic question templates across 8 categories.

**Every record marked `"REQUIRES_MANUAL_FILL": true` must be filled in before it can produce meaningful scores.** Fields to fill:

| Field | What to fill |
|---|---|
| `user_input` | Leave as-is or refine for your specific codebase |
| `reference` | The correct, complete answer for your repo |
| `reference_contexts` | Copy-paste the actual source lines that answer the question |
| `expected_files` | Relative file paths (e.g. `src/auth/login.py`) |
| `expected_functions` | Function/method names that must appear in retrieved chunks |
| `expected_line_ranges` | `[[start, end], ...]` (1-indexed) if you want line coverage |

Remove the `"REQUIRES_MANUAL_FILL": true` key when a record is fully filled.

**Out-of-scope (negative) questions** (`neg_*`) require no `reference_contexts` or `expected_files` — just fill in `reference` with the correct "not present" statement.

---

## Running the Evaluation

> Run all commands from the `RAG/` directory.

### Basic run (built-in dataset, production cache)

```bash
venv\Scripts\python.exe -m evaluation.runner --repo-id YOUR_REPO --user-id YOUR_EMAIL
```

### Cache-isolated run (recommended for evaluation)

```bash
venv\Scripts\python.exe -m evaluation.runner --repo-id YOUR_REPO --user-id YOUR_EMAIL --bypass-cache
```

The `--bypass-cache` flag prefixes the user ID with `__eval__:`, routing retrieval results to a separate Redis namespace so production cache entries are never contaminated.

### Limit to a quick smoke test

```bash
venv\Scripts\python.exe -m evaluation.runner --repo-id YOUR_REPO --user-id YOUR_EMAIL --limit 3 --bypass-cache
```

### Filter by category

```bash
venv\Scripts\python.exe -m evaluation.runner --repo-id YOUR_REPO --user-id YOUR_EMAIL --category api_endpoints --bypass-cache
```

### Use a custom JSONL dataset file

```bash
venv\Scripts\python.exe -m evaluation.runner --repo-id YOUR_REPO --user-id YOUR_EMAIL --dataset-file evaluation/dataset_template.jsonl --bypass-cache
```

### Full run with RAGAS metrics

```bash
venv\Scripts\python.exe -m evaluation.runner --repo-id YOUR_REPO --user-id YOUR_EMAIL --use-ragas --bypass-cache
```

### RAGAS with Gemini as the evaluator LLM

```bash
set EVAL_LLM_PROVIDER=gemini && set EVAL_LLM_MODEL=gemini-1.5-flash
venv\Scripts\python.exe -m evaluation.runner --repo-id YOUR_REPO --user-id YOUR_EMAIL --use-ragas --bypass-cache
```

---

## Running the Test Suite

```bash
cd RAG
venv\Scripts\python.exe -m pytest evaluation/tests/test_eval.py -v
```

---

## Report Format

Each run produces two files in `RAG/evaluation/reports/`:

- `eval_report_<TIMESTAMP>.json` — full report including per-sample details, diagnostics, RAGAS scores
- `eval_report_<TIMESTAMP>.csv` — summary table (one row per question)
- `latest_report.json` — always overwritten with the most recent run

### JSON structure (top-level keys)

```json
{
  "timestamp": "...",
  "repository": "...",
  "bypass_cache": true,
  "aggregate_metrics": {
    "average_faithfulness": 0.0,
    "average_answer_relevancy": 0.0,
    "average_context_precision": 0.0,
    "average_code_grounding": 0.0,
    "overall_composite_score": 0.0,
    "average_file_recall_at_k": 0.0,
    "average_chunk_recall_at_k": 0.0,
    "average_function_coverage": 0.0
  },
  "ragas_scores": { "status": "ok", "aggregate": {...}, "per_sample": [...] },
  "diagnostics": {
    "zero_retrieval_questions": [...],
    "file_hit_but_function_missed": [...],
    "low_scoring_questions": [...]
  },
  "individual_results": [...]
}
```

---

## Metric Reference

| Metric | Source | What it measures |
|---|---|---|
| **Faithfulness** | Custom (Gemini) | % claims in answer supported by retrieved context |
| **Answer Relevancy** | Custom (Gemini) | How directly the answer addresses the question |
| **Context Precision** | Custom (Gemini) | Average Precision of ranked retrieved chunks |
| **Context Recall** | Custom (Gemini) | % of reference answer statements covered by contexts |
| **Code Grounding** | Custom (Gemini) | % of cited file names that exist in retrieved docs |
| **Composite** | Weighted avg | 40% Faith + 35% Relevancy + 25% Precision |
| **File Recall@K** | `code_metrics.py` | % of `expected_files` found in top-K docs |
| **Chunk Recall@K** | `code_metrics.py` | % of `reference_contexts` matched in top-K chunks |
| **Function Coverage** | `code_metrics.py` | % of `expected_functions` appearing in retrieved content |
| **Line Coverage** | `code_metrics.py` | % of expected source lines found (requires `file_contents`) |
| **RAGAS Faithfulness** | RAGAS 0.2.x | LLM-graded faithfulness (independent) |
| **RAGAS AnswerRelevancy** | RAGAS 0.2.x | LLM-graded answer relevancy (independent) |
| **RAGAS ContextPrecision** | RAGAS 0.2.x | LLM-graded context precision (independent) |
| **RAGAS ContextRecall** | RAGAS 0.2.x | LLM-graded context recall (independent) |

> A `None` score means the metric could not be computed (missing metadata, placeholder data, or LLM failure) — it is never treated as 0 or 1.

---

## Diagnosing Failures

| Diagnostic | What it means |
|---|---|
| **Zero-retrieval questions** | Retrieval returned 0 chunks — likely a repo ingestion issue or wrong `repo_id` |
| **File hit but function missed** | The right file was retrieved but the specific function chunk was not — consider increasing `top_k` or adjusting chunking |
| **Low composite score** | Score < 0.70 — check faithfulness and precision details in the JSON report |
| **RAGAS status = "failed"** | LLM API key missing or provider unavailable — check `EVAL_LLM_PROVIDER` and API key |

