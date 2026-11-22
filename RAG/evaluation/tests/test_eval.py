"""
Test suite for the Codebase Copilot evaluation framework.

Covers all 9 required scenarios:
  1. Dataset loading and schema validation (JSONL)
  2. Code-specific metric calculations with known inputs
  3. Missing metadata → line_coverage returns metadata_missing=True (never silent success)
  4. Empty retrieved context → all metrics return 0 or None gracefully
  5. Duplicate chunks in retrieved docs → correct deduplication/counting
  6. Incorrect file paths → file_recall correctly scores 0
  7. Line-range coverage → correct percentage calculation
  8. RAGAS LLM failure → graceful None scores (no crash)
  9. Code-specific metrics with explicit expected values

Run with:
    cd RAG
    venv\\Scripts\\python.exe -m pytest evaluation/tests/test_eval.py -v
"""
from __future__ import annotations

import json
import os
import sys
import textwrap
import pytest

# Ensure RAG root is on sys.path so evaluation package imports work
TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
EVAL_DIR = os.path.dirname(TESTS_DIR)
RAG_ROOT = os.path.dirname(EVAL_DIR)
for path in (RAG_ROOT, EVAL_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

from evaluation.code_metrics import (
    file_recall_at_k,
    chunk_recall_at_k,
    function_coverage,
    line_coverage,
    compute_code_specific_scores,
)


# ---------------------------------------------------------------------------
# Fixtures: shared test data
# ---------------------------------------------------------------------------

def _make_doc(path: str, content: str) -> dict:
    return {"pageContent": content, "metadata": {"path": path}}


DOCS_BASIC = [
    _make_doc("src/auth/login.py", "def login_user(email, password):\n    return authenticate(email, password)"),
    _make_doc("src/api/routes.py", "app.get('/health', health_check)\napp.post('/login', handle_login)"),
    _make_doc("src/models/user.py", "class User:\n    id: int\n    email: str\n    password_hash: str"),
    _make_doc("src/utils/helpers.py", "def paginate(items, page, limit):\n    start = page * limit\n    return items[start:start+limit]"),
    _make_doc("src/config.py", "DATABASE_URL = os.getenv('DATABASE_URL')\nSECRET_KEY = os.getenv('SECRET_KEY')"),
]


# ===========================================================================
# Scenario 1 — Dataset loading and schema validation
# ===========================================================================

class TestDatasetLoading:
    """Scenario 1: JSONL dataset loads correctly and validates required fields."""

    def test_template_file_exists(self):
        template_path = os.path.join(EVAL_DIR, "dataset_template.jsonl")
        assert os.path.isfile(template_path), "dataset_template.jsonl not found"

    def test_template_has_required_fields(self):
        template_path = os.path.join(EVAL_DIR, "dataset_template.jsonl")
        required_keys = {"id", "category", "user_input", "reference"}
        records = []
        with open(template_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
        assert len(records) >= 30, f"Expected >= 30 records, got {len(records)}"
        for rec in records:
            for key in required_keys:
                assert key in rec, f"Record '{rec.get('id', '?')}' missing field '{key}'"

    def test_template_has_expected_categories(self):
        template_path = os.path.join(EVAL_DIR, "dataset_template.jsonl")
        expected_categories = {
            "function_implementation", "api_endpoints", "authentication",
            "database_models", "cross_file_dependency", "error_handling",
            "code_execution_flow", "out_of_scope_negative",
        }
        seen = set()
        with open(template_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    rec = json.loads(line)
                    seen.add(rec.get("category", ""))
        assert expected_categories.issubset(seen), f"Missing categories: {expected_categories - seen}"

    def test_jsonl_malformed_lines_skipped(self, tmp_path):
        """Runner's _load_jsonl_dataset should skip malformed lines gracefully."""
        from evaluation.runner import _load_jsonl_dataset
        jl = tmp_path / "test.jsonl"
        jl.write_text(
            '{"id": "q1", "user_input": "good line"}\n'
            'NOT_JSON\n'
            '{"id": "q2", "user_input": "another good line"}\n',
            encoding="utf-8",
        )
        samples = _load_jsonl_dataset(str(jl))
        assert len(samples) == 2
        assert samples[0]["id"] == "q1"
        assert samples[1]["id"] == "q2"

    def test_jsonl_category_filter(self, tmp_path):
        from evaluation.runner import _load_jsonl_dataset
        jl = tmp_path / "test.jsonl"
        lines = [
            '{"id": "a1", "user_input": "q", "category": "auth"}',
            '{"id": "b1", "user_input": "q", "category": "api_endpoints"}',
            '{"id": "a2", "user_input": "q", "category": "auth"}',
        ]
        jl.write_text("\n".join(lines), encoding="utf-8")
        samples = _load_jsonl_dataset(str(jl), category="auth")
        assert len(samples) == 2
        assert all(s["category"] == "auth" for s in samples)

    def test_jsonl_limit(self, tmp_path):
        from evaluation.runner import _load_jsonl_dataset
        jl = tmp_path / "test.jsonl"
        lines = [f'{{"id": "q{i}", "user_input": "q{i}"}}' for i in range(10)]
        jl.write_text("\n".join(lines), encoding="utf-8")
        samples = _load_jsonl_dataset(str(jl), limit=3)
        assert len(samples) == 3


# ===========================================================================
# Scenario 2 — Metric calculations with known inputs
# ===========================================================================

class TestMetricCalculations:
    """Scenario 2: All four code metrics return correct values on known inputs."""

    def test_file_recall_full_match(self):
        expected = ["src/auth/login.py", "src/models/user.py"]
        result = file_recall_at_k(DOCS_BASIC, expected, k=10)
        assert result["score"] == pytest.approx(1.0)
        assert set(result["found_files"]) == set(expected)
        assert result["missing_files"] == []

    def test_file_recall_partial_match(self):
        expected = ["src/auth/login.py", "src/nonexistent/file.py"]
        result = file_recall_at_k(DOCS_BASIC, expected, k=10)
        assert result["score"] == pytest.approx(0.5)
        assert "src/auth/login.py" in result["found_files"]
        assert "src/nonexistent/file.py" in result["missing_files"]

    def test_chunk_recall_full_match(self):
        ref_contexts = ["def login_user(email, password):\n    return authenticate(email, password)"]
        result = chunk_recall_at_k(DOCS_BASIC, ref_contexts, k=5, min_overlap=0.3)
        assert result["score"] is not None
        assert result["score"] > 0.0
        assert result["matched_count"] >= 1

    def test_function_coverage_found(self):
        result = function_coverage(DOCS_BASIC, ["login_user", "paginate", "health_check"])
        assert result["score"] is not None
        assert "login_user" in result["found_functions"]
        assert "paginate" in result["found_functions"]
        # health_check is in routes.py content
        assert result["total_expected"] == 3

    def test_function_coverage_all_missing(self):
        result = function_coverage(DOCS_BASIC, ["nonexistent_fn_xyz", "another_missing_fn"])
        assert result["score"] == pytest.approx(0.0)
        assert result["found_functions"] == []
        assert len(result["missing_functions"]) == 2

    def test_line_coverage_correct_percentage(self):
        source = "line1\nline2\nline3\nline4\nline5\n"
        docs = [_make_doc("file.py", "line2\nline3")]
        result = line_coverage(
            docs,
            expected_line_ranges=[[2, 4]],  # lines 2,3,4
            file_contents={"file.py": source},
        )
        assert result["metadata_missing"] is False
        assert result["score"] is not None
        # lines 2 and 3 are in retrieved docs, line 4 ("line4") is not
        assert result["covered_lines"] == 2
        assert result["total_expected_lines"] == 3
        assert result["score"] == pytest.approx(2 / 3, rel=1e-3)


# ===========================================================================
# Scenario 3 — Missing metadata → metadata_missing=True
# ===========================================================================

class TestMissingMetadata:
    """Scenario 3: line_coverage must NEVER silently succeed when file_contents is absent."""

    def test_no_file_contents_returns_metadata_missing(self):
        result = line_coverage(DOCS_BASIC, [[1, 10]], file_contents=None)
        assert result["metadata_missing"] is True
        assert result["score"] is None
        assert "file_contents" in result["reason"].lower() or "metadata" in result["reason"].lower()

    def test_empty_file_contents_dict_returns_metadata_missing(self):
        result = line_coverage(DOCS_BASIC, [[1, 10]], file_contents={})
        assert result["metadata_missing"] is True
        assert result["score"] is None

    def test_no_expected_ranges_returns_not_applicable(self):
        result = line_coverage(DOCS_BASIC, [], file_contents=None)
        assert result["score"] is None
        assert result["metadata_missing"] is False  # it's a "not applicable" case, not missing metadata


# ===========================================================================
# Scenario 4 — Empty retrieved context
# ===========================================================================

class TestEmptyRetrievedContext:
    """Scenario 4: All metrics return 0 or None gracefully when no docs are retrieved."""

    def test_file_recall_zero_docs(self):
        result = file_recall_at_k([], ["src/auth/login.py"])
        assert result["score"] == pytest.approx(0.0)
        assert result["found_files"] == []
        assert result["missing_files"] == ["src/auth/login.py"]

    def test_chunk_recall_zero_docs(self):
        result = chunk_recall_at_k([], ["some expected context"], k=10)
        assert result["score"] == pytest.approx(0.0)
        assert result["matched_count"] == 0

    def test_function_coverage_zero_docs(self):
        result = function_coverage([], ["login_user"])
        assert result["score"] == pytest.approx(0.0)
        assert result["found_functions"] == []

    def test_line_coverage_zero_docs(self):
        result = line_coverage([], [[1, 5]], file_contents={"f.py": "a\nb\nc\nd\ne\n"})
        assert result["metadata_missing"] is False
        assert result["score"] is not None
        assert result["score"] == pytest.approx(0.0)
        assert result["covered_lines"] == 0

    def test_compute_code_specific_scores_zero_docs(self):
        sample = {
            "expected_files": ["src/auth/login.py"],
            "expected_functions": ["login_user"],
            "reference_contexts": ["def login_user"],
            "expected_line_ranges": [],
        }
        result = compute_code_specific_scores([], sample, k=10)
        assert result["file_recall"]["score"] == pytest.approx(0.0)
        assert result["function_coverage"]["score"] == pytest.approx(0.0)


# ===========================================================================
# Scenario 5 — Duplicate chunks
# ===========================================================================

class TestDuplicateChunks:
    """Scenario 5: Duplicated retrieved docs are handled correctly (not double-counted)."""

    def test_file_recall_no_double_count_with_duplicates(self):
        """File recall@K should count a file as found/not found once, even if retrieved twice."""
        dup_docs = DOCS_BASIC + DOCS_BASIC  # 10 docs, same 5 files twice
        expected = ["src/auth/login.py", "src/models/user.py"]
        result = file_recall_at_k(dup_docs, expected, k=10)
        # Should still be 1.0, not > 1.0
        assert 0.0 <= result["score"] <= 1.0
        assert result["score"] == pytest.approx(1.0)

    def test_function_coverage_no_double_count(self):
        """Function coverage should not give > 1.0 if the function appears in multiple chunks."""
        dup_docs = DOCS_BASIC * 3
        result = function_coverage(dup_docs, ["login_user", "paginate"])
        assert result["score"] is not None
        assert 0.0 <= result["score"] <= 1.0

    def test_chunk_recall_min_overlap_threshold_respected(self):
        """With a very high threshold, even near-identical chunks should not match."""
        ref = "completely different unrelated text that shares nothing"
        docs = [_make_doc("x.py", "def login_user(): pass"), _make_doc("x.py", "def login_user(): pass")]
        result = chunk_recall_at_k(docs, [ref], k=10, min_overlap=0.99)
        assert result["score"] == pytest.approx(0.0)


# ===========================================================================
# Scenario 6 — Incorrect file paths → file_recall scores 0
# ===========================================================================

class TestIncorrectFilePaths:
    """Scenario 6: file_recall returns 0 when expected paths don't match retrieved paths."""

    def test_wrong_paths_score_zero(self):
        expected = ["completely/wrong/path.py", "also/wrong.ts"]
        result = file_recall_at_k(DOCS_BASIC, expected)
        assert result["score"] == pytest.approx(0.0)
        assert result["found_files"] == []
        assert set(result["missing_files"]) == set(expected)

    def test_path_matching_is_case_insensitive(self):
        """Path normalisation makes matching case-insensitive."""
        expected = ["SRC/AUTH/LOGIN.PY"]
        result = file_recall_at_k(DOCS_BASIC, expected)
        # Should find src/auth/login.py via lowercased comparison
        assert result["score"] == pytest.approx(1.0)

    def test_basename_matching(self):
        """A short basename like 'login.py' should match the full path 'src/auth/login.py'."""
        expected = ["login.py"]
        result = file_recall_at_k(DOCS_BASIC, expected)
        assert result["score"] == pytest.approx(1.0)

    def test_no_expected_files_returns_not_applicable(self):
        result = file_recall_at_k(DOCS_BASIC, [])
        assert result["score"] is None
        assert "not applicable" in result.get("note", "").lower()


# ===========================================================================
# Scenario 7 — Line-range coverage percentage
# ===========================================================================

class TestLineCoveragePercentage:
    """Scenario 7: line_coverage computes exact percentages."""

    SOURCE = textwrap.dedent("""\
        def authenticate(email, password):
            user = db.find_user(email)
            if not user:
                return None
            if not check_hash(password, user.password_hash):
                return None
            return generate_token(user)
    """)

    def test_full_coverage(self):
        docs = [_make_doc("auth.py", self.SOURCE)]
        # SOURCE has 7 non-blank lines (lines 1-7). 'return None' appears twice so
        # unique set size = 6. total_expected_lines (raw count) = 7. covered = 6 unique.
        result = line_coverage(docs, [[1, 7]], file_contents={"auth.py": self.SOURCE})
        assert result["metadata_missing"] is False
        assert result["score"] is not None
        # 6 unique lines covered / 7 raw expected → maximum achievable score
        assert result["score"] > 0.8
        assert result["covered_lines"] == 6

    def test_zero_coverage(self):
        docs = [_make_doc("other.py", "print('hello')")]
        result = line_coverage(docs, [[1, 7]], file_contents={"auth.py": self.SOURCE})
        assert result["score"] == pytest.approx(0.0)
        assert result["covered_lines"] == 0

    def test_partial_coverage(self):
        # Retrieved doc contains only the first 2 unique code lines of the source.
        # SOURCE lines 1-7, with [[1,7]]: total=7 raw (return None x2), unique=6.
        partial_text = "def authenticate(email, password):\n    user = db.find_user(email)"
        docs = [_make_doc("auth.py", partial_text)]
        result = line_coverage(docs, [[1, 7]], file_contents={"auth.py": self.SOURCE})
        assert result["metadata_missing"] is False
        assert result["score"] is not None
        assert 0.0 < result["score"] < 1.0
        assert result["covered_lines"] == 2  # only 2 unique non-blank lines matched

    def test_multiple_ranges(self):
        # Line 1 = "def authenticate(email, password):" and line 7 = "    return generate_token(user)"
        docs = [_make_doc("auth.py", "def authenticate(email, password):\n    return generate_token(user)")]
        result = line_coverage(docs, [[1, 1], [7, 7]], file_contents={"auth.py": self.SOURCE})
        assert result["metadata_missing"] is False
        assert result["covered_lines"] == 2
        assert result["score"] == pytest.approx(1.0)

    def test_out_of_range_lines_ignored(self):
        """Line numbers beyond the file length should be silently skipped."""
        result = line_coverage(DOCS_BASIC[:1], [[1, 999]], file_contents={"src/auth/login.py": "a\nb\nc\n"})
        assert result["metadata_missing"] is False
        assert result["total_expected_lines"] == 3  # only 3 non-blank lines


# ===========================================================================
# Scenario 8 — RAGAS LLM failure → graceful None scores
# ===========================================================================

class TestRagasFailureHandling:
    """Scenario 8: RAGAS evaluator returns graceful None/failed status when LLM is unavailable."""

    def test_missing_api_key_returns_failed(self, monkeypatch):
        """When no API key is set, evaluate_with_ragas must return a dict with status (never raise)."""
        monkeypatch.setenv("EVAL_LLM_PROVIDER", "groq")
        monkeypatch.delenv("GROQ_API_KEY", raising=False)
        from evaluation.ragas_evaluator import _build_ragas_llm
        # _build_ragas_llm should return None when API key is missing
        llm = _build_ragas_llm()
        assert llm is None, "Expected None when GROQ_API_KEY is unset"

    def test_empty_samples_returns_failed(self, monkeypatch):
        """An empty sample list must return status=failed without crashing."""
        monkeypatch.setenv("EVAL_LLM_PROVIDER", "groq")
        monkeypatch.delenv("GROQ_API_KEY", raising=False)
        from evaluation.ragas_evaluator import evaluate_with_ragas
        result = evaluate_with_ragas([])
        assert isinstance(result, dict)
        assert result.get("status") == "failed"
        assert result.get("per_sample") == []

    def test_malformed_sample_skipped_gracefully(self, monkeypatch):
        """Malformed samples (missing fields) must not crash the evaluator setup code."""
        monkeypatch.setenv("EVAL_LLM_PROVIDER", "groq")
        monkeypatch.delenv("GROQ_API_KEY", raising=False)
        from evaluation.ragas_evaluator import evaluate_with_ragas
        samples = [
            {"user_input": "q", "response": "a", "retrieved_contexts": [], "reference": "r"},
            {},  # completely empty — should be handled gracefully
        ]
        # With no API key, should return failed without raising
        result = evaluate_with_ragas(samples)
        assert isinstance(result, dict)
        assert result.get("status") in ("failed", "partial", "ok")


# ===========================================================================
# Scenario 9 — Code-specific metrics with explicit expected values
# ===========================================================================

class TestCodeSpecificMetricsExplicit:
    """Scenario 9: Explicit expected values verified against metric outputs."""

    DOCS = [
        _make_doc(
            "backend/services/auth_service.py",
            "def verify_token(token):\n    payload = jwt.decode(token, SECRET_KEY)\n    return payload",
        ),
        _make_doc(
            "backend/routes/auth_routes.py",
            "router.post('/login', login_handler)\nrouter.post('/logout', logout_handler)\nrouter.get('/me', get_current_user)",
        ),
        _make_doc(
            "backend/models/user_model.py",
            "class UserModel:\n    id: UUID\n    email: str\n    created_at: datetime",
        ),
    ]

    def test_file_recall_exact_score(self):
        # 2 out of 3 expected files are present in DOCS
        expected = [
            "backend/services/auth_service.py",
            "backend/routes/auth_routes.py",
            "backend/does_not_exist.py",
        ]
        r = file_recall_at_k(self.DOCS, expected, k=10)
        assert r["score"] == pytest.approx(2 / 3, rel=1e-3)
        assert r["total_expected"] == 3

    def test_function_coverage_exact(self):
        # verify_token and login_handler are in content; nonexistent_fn is not
        r = function_coverage(self.DOCS, ["verify_token", "login_handler", "nonexistent_fn"])
        assert r["total_expected"] == 3
        assert "verify_token" in r["found_functions"]
        assert "login_handler" in r["found_functions"]
        assert "nonexistent_fn" in r["missing_functions"]
        assert r["score"] == pytest.approx(2 / 3, rel=1e-3)

    def test_chunk_recall_with_exact_reference(self):
        ref = "def verify_token(token):\n    payload = jwt.decode(token, SECRET_KEY)\n    return payload"
        r = chunk_recall_at_k(self.DOCS, [ref], k=5, min_overlap=0.5)
        assert r["score"] == pytest.approx(1.0)
        assert r["matched_count"] == 1

    def test_line_coverage_exact_lines(self):
        source = "def verify_token(token):\n    payload = jwt.decode(token, SECRET_KEY)\n    return payload\n"
        docs = [_make_doc("backend/services/auth_service.py", source)]
        r = line_coverage(
            docs,
            [[1, 3]],
            file_contents={"backend/services/auth_service.py": source},
        )
        assert r["score"] == pytest.approx(1.0)
        assert r["covered_lines"] == 3
        assert r["total_expected_lines"] == 3

    def test_compute_code_specific_scores_integration(self):
        sample = {
            "expected_files": ["backend/services/auth_service.py"],
            "expected_functions": ["verify_token", "jwt.decode"],
            "reference_contexts": [
                "def verify_token(token):\n    payload = jwt.decode(token, SECRET_KEY)\n    return payload"
            ],
            "expected_line_ranges": [],
        }
        scores = compute_code_specific_scores(self.DOCS, sample, k=5)
        assert scores["file_recall"]["score"] == pytest.approx(1.0)
        assert scores["function_coverage"]["score"] is not None
        assert scores["function_coverage"]["score"] > 0.0
        assert scores["chunk_recall"]["score"] is not None
        # line_coverage should be metadata_missing because file_contents=None in compute helper
        assert scores["line_coverage"]["metadata_missing"] is True
