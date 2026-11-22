"""
Code-specific retrieval metrics for Codebase Copilot evaluation.

These metrics measure retrieval quality using ground-truth labels
(expected files, expected functions, expected line ranges) rather than
relying solely on LLM-based evaluation.

All functions accept the standard `retrieved_docs` list produced by
`retrieve_documents()`, where each doc is:
  {
    "pageContent": str,
    "metadata": {
      "path": str,
      "filename": str,
      "source": str,
      ...
    }
  }
"""
from __future__ import annotations

import re
import logging
from difflib import SequenceMatcher

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_path(doc: dict) -> str:
    """Return the best available path string from a retrieved document."""
    meta = doc.get("metadata", {})
    return (meta.get("path") or meta.get("source") or meta.get("filename") or "").strip()


def _normalise_path(path: str) -> str:
    """Normalise a file path for comparison: lowercase, forward slashes, strip leading ./"""
    p = path.lower().replace("\\", "/")
    if p.startswith("./"):
        p = p[2:]
    return p


def _path_matches(retrieved_path: str, expected_path: str) -> bool:
    """
    True when retrieved_path matches expected_path.
    Accepts full-path matches, basename matches, and suffix matches
    so that expected="src/auth/login.py" matches retrieved="/repo/src/auth/login.py".
    """
    rp = _normalise_path(retrieved_path)
    ep = _normalise_path(expected_path)
    if not rp or not ep:
        return False
    # Exact or suffix match
    if rp == ep or rp.endswith("/" + ep) or ep.endswith("/" + rp):
        return True
    # Basename match (last component)
    r_base = rp.rsplit("/", 1)[-1]
    e_base = ep.rsplit("/", 1)[-1]
    return r_base == e_base and bool(e_base)


def _text_overlap_ratio(a: str, b: str) -> float:
    """Return the longest-common-subsequence ratio between two strings."""
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


# ---------------------------------------------------------------------------
# 1. File Recall@K
# ---------------------------------------------------------------------------

def file_recall_at_k(
    retrieved_docs: list[dict],
    expected_files: list[str],
    k: int = 10,
) -> dict:
    """
    Fraction of expected files that appear in the top-K retrieved documents.

    Returns:
        {
          "score": float,          # 0.0 – 1.0
          "found_files": list[str],
          "missing_files": list[str],
          "k": int,
          "total_expected": int,
        }
    """
    if not expected_files:
        return {
            "score": None,
            "found_files": [],
            "missing_files": [],
            "k": k,
            "total_expected": 0,
            "note": "No expected_files provided — metric not applicable.",
        }

    top_k_docs = retrieved_docs[:k]

    found: list[str] = []
    missing: list[str] = []

    for ef in expected_files:
        matched = any(_path_matches(_get_path(doc), ef) for doc in top_k_docs)
        if matched:
            found.append(ef)
        else:
            missing.append(ef)

    score = len(found) / len(expected_files)

    return {
        "score": round(score, 4),
        "found_files": found,
        "missing_files": missing,
        "k": k,
        "total_expected": len(expected_files),
    }


# ---------------------------------------------------------------------------
# 2. Chunk Recall@K
# ---------------------------------------------------------------------------

def chunk_recall_at_k(
    retrieved_docs: list[dict],
    reference_contexts: list[str],
    k: int = 10,
    min_overlap: float = 0.35,
) -> dict:
    """
    Fraction of expected reference_contexts that have a sufficiently similar
    chunk among the top-K retrieved documents.

    A reference context is considered "matched" if the best overlap ratio
    with any top-K chunk exceeds `min_overlap`.

    Returns:
        {
          "score": float,          # 0.0 – 1.0
          "matched_count": int,
          "total_expected": int,
          "k": int,
          "min_overlap_threshold": float,
          "per_context": list[dict],  # per-reference match detail
        }
    """
    if not reference_contexts:
        return {
            "score": None,
            "matched_count": 0,
            "total_expected": 0,
            "k": k,
            "min_overlap_threshold": min_overlap,
            "per_context": [],
            "note": "No reference_contexts provided — metric not applicable.",
        }

    # Filter out REQUIRES_MANUAL_FILL placeholders
    real_contexts = [
        c for c in reference_contexts
        if c and "REQUIRES_MANUAL_FILL" not in c
    ]
    if not real_contexts:
        return {
            "score": None,
            "matched_count": 0,
            "total_expected": 0,
            "k": k,
            "min_overlap_threshold": min_overlap,
            "per_context": [],
            "note": "All reference_contexts are REQUIRES_MANUAL_FILL placeholders.",
        }

    top_k_texts = [doc.get("pageContent", "") for doc in retrieved_docs[:k]]
    per_context = []
    matched = 0

    for ref in real_contexts:
        best_ratio = 0.0
        best_idx = -1
        for idx, chunk_text in enumerate(top_k_texts):
            ratio = _text_overlap_ratio(ref[:500], chunk_text[:500])
            if ratio > best_ratio:
                best_ratio = ratio
                best_idx = idx
        is_match = best_ratio >= min_overlap
        if is_match:
            matched += 1
        per_context.append({
            "reference_snippet": ref[:100] + "..." if len(ref) > 100 else ref,
            "best_overlap": round(best_ratio, 4),
            "matched_chunk_index": best_idx,
            "is_match": is_match,
        })

    score = matched / len(real_contexts)
    return {
        "score": round(score, 4),
        "matched_count": matched,
        "total_expected": len(real_contexts),
        "k": k,
        "min_overlap_threshold": min_overlap,
        "per_context": per_context,
    }


# ---------------------------------------------------------------------------
# 3. Function Coverage
# ---------------------------------------------------------------------------

def function_coverage(
    retrieved_docs: list[dict],
    expected_functions: list[str],
) -> dict:
    """
    Fraction of expected function names that appear as substrings in the
    concatenated retrieved document content.

    Uses word-boundary matching so "login" does not match "loginUser" unless
    both are listed. Set exact=False to allow substring matching.

    Returns:
        {
          "score": float,
          "found_functions": list[str],
          "missing_functions": list[str],
          "total_expected": int,
        }
    """
    if not expected_functions:
        return {
            "score": None,
            "found_functions": [],
            "missing_functions": [],
            "total_expected": 0,
            "note": "No expected_functions provided — metric not applicable.",
        }

    # Filter placeholders
    real_funcs = [
        f for f in expected_functions
        if f and "REQUIRES_MANUAL_FILL" not in f
    ]
    if not real_funcs:
        return {
            "score": None,
            "found_functions": [],
            "missing_functions": [],
            "total_expected": 0,
            "note": "All expected_functions are REQUIRES_MANUAL_FILL placeholders.",
        }

    combined_text = "\n".join(doc.get("pageContent", "") for doc in retrieved_docs)

    found: list[str] = []
    missing: list[str] = []

    for func_name in real_funcs:
        # Match as a whole identifier token (word boundaries)
        pattern = r'\b' + re.escape(func_name) + r'\b'
        if re.search(pattern, combined_text):
            found.append(func_name)
        else:
            missing.append(func_name)

    score = len(found) / len(real_funcs)
    return {
        "score": round(score, 4),
        "found_functions": found,
        "missing_functions": missing,
        "total_expected": len(real_funcs),
    }


# ---------------------------------------------------------------------------
# 4. Line Coverage
# ---------------------------------------------------------------------------

def line_coverage(
    retrieved_docs: list[dict],
    expected_line_ranges: list[list[int]],
    file_contents: dict[str, str] | None = None,
) -> dict:
    """
    Fraction of expected source lines covered by the retrieved chunks.

    Because retrieved chunks may not carry line-number metadata, this metric
    requires `file_contents`: a dict mapping file path → full source text.
    If `file_contents` is None or empty, the metric returns a clear
    "metadata_missing" result — it NEVER silently treats missing data as success.

    Args:
        retrieved_docs: list of retrieved document dicts.
        expected_line_ranges: list of [start_line, end_line] pairs (1-indexed).
        file_contents: optional dict of {file_path: file_text} for the expected files.

    Returns:
        {
          "score": float | None,
          "covered_lines": int,
          "total_expected_lines": int,
          "metadata_missing": bool,
          "reason": str,
        }
    """
    if not expected_line_ranges:
        return {
            "score": None,
            "covered_lines": 0,
            "total_expected_lines": 0,
            "metadata_missing": False,
            "reason": "No expected_line_ranges provided — metric not applicable.",
        }

    if not file_contents:
        return {
            "score": None,
            "covered_lines": 0,
            "total_expected_lines": 0,
            "metadata_missing": True,
            "reason": (
                "file_contents not provided. Line coverage requires the original source text "
                "to extract expected lines for comparison. Pass file_contents={path: text}."
            ),
        }

    # Build set of expected line strings from file_contents
    expected_lines: set[str] = set()

    for file_path, file_text in file_contents.items():
        source_lines = file_text.splitlines()
        for rng in expected_line_ranges:
            if not isinstance(rng, (list, tuple)) or len(rng) != 2:
                logger.warning("Invalid line range %s — skipping.", rng)
                continue
            start, end = int(rng[0]), int(rng[1])
            # Convert to 0-indexed
            for ln in range(start - 1, min(end, len(source_lines))):
                stripped = source_lines[ln].strip()
                if stripped:  # skip blank lines
                    expected_lines.add(stripped)

    total_expected_lines = len(expected_lines)

    if total_expected_lines == 0:
        return {
            "score": None,
            "covered_lines": 0,
            "total_expected_lines": 0,
            "metadata_missing": False,
            "reason": "All expected line ranges resolved to blank lines or were out of range.",
        }

    # Build set of lines present in retrieved chunks
    retrieved_text_lines: set[str] = set()
    for doc in retrieved_docs:
        for line in doc.get("pageContent", "").splitlines():
            stripped = line.strip()
            if stripped:
                retrieved_text_lines.add(stripped)

    covered = expected_lines & retrieved_text_lines
    score = len(covered) / total_expected_lines

    return {
        "score": round(score, 4),
        "covered_lines": len(covered),
        "total_expected_lines": total_expected_lines,
        "metadata_missing": False,
        "reason": f"{len(covered)}/{total_expected_lines} expected lines found in retrieved chunks.",
    }


# ---------------------------------------------------------------------------
# 5. Composite code-specific score
# ---------------------------------------------------------------------------

def compute_code_specific_scores(
    retrieved_docs: list[dict],
    sample: dict,
    k: int = 10,
) -> dict:
    """
    Runs all four code-specific metrics for a single evaluation sample.

    Args:
        retrieved_docs: Output of retrieve_documents().
        sample: One record from the evaluation dataset with keys:
                expected_files, expected_functions, reference_contexts, expected_line_ranges.
        k: Top-K cutoff applied to file and chunk recall metrics.

    Returns dict with keys: file_recall, chunk_recall, function_coverage, line_coverage.
    """
    expected_files = sample.get("expected_files", [])
    expected_functions = sample.get("expected_functions", [])
    reference_contexts = sample.get("reference_contexts", [])
    expected_line_ranges = sample.get("expected_line_ranges", [])

    return {
        "file_recall": file_recall_at_k(retrieved_docs, expected_files, k=k),
        "chunk_recall": chunk_recall_at_k(retrieved_docs, reference_contexts, k=k),
        "function_coverage": function_coverage(retrieved_docs, expected_functions),
        "line_coverage": line_coverage(retrieved_docs, expected_line_ranges, file_contents=None),
    }

