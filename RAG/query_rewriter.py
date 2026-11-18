import os
from dotenv import load_dotenv
from google import genai

load_dotenv()

client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))

MODELS = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-3.1-flash-lite"]

# Keywords that signal the question has enough technical specificity to benefit from rewriting
_TECHNICAL_KEYWORDS = [
    ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".go", ".rs", ".cpp", ".cs", ".php",
    ".json", ".yml", ".yaml", ".md", ".sql", ".env", ".docker",
    "function", "class", "method", "endpoint", "route", "controller", "service",
    "model", "schema", "database", "auth", "middleware", "config", "hook",
    "api", "query", "mutation", "resolver", "interface", "component",
    "import", "export", "module", "package", "dependency",
    "redis", "mongo", "postgres", "queue", "worker", "socket",
    "jwt", "oauth", "token", "session", "webhook", "stream", "async",
    "src/", "server/", "client/", "backend/", "frontend/"
]


def _should_rewrite(question: str) -> bool:
    """
    Returns False (skip rewriting) for:
    - Very short questions (≤ 6 words) — the original is already concise enough.
    - Casual/conversational questions with no technical keywords — rewriting adds no value.
    Returns True only when the question is long enough and has technical content to compress.
    """
    words = question.strip().split()
    if len(words) <= 6:
        return False

    lower_q = question.lower()
    return any(kw in lower_q for kw in _TECHNICAL_KEYWORDS)


def rewrite_query(question: str) -> str:
    """
    Rewrites the question into a concise search query optimised for vector + BM25 retrieval.
    Fast-paths: returns the original question unchanged when rewriting would add no value.
    """
    if not _should_rewrite(question):
        print(f"[DEBUG] Query rewrite skipped (short/non-technical): \"{question[:80]}\"")
        return question

    prompt = f"""You are a search query optimizer for a codebase RAG system.

Convert the user's question into a short, dense search query (10 words max) that maximises retrieval of relevant code chunks.

Rules:
1. Keep the core technical intent intact.
2. Extract filenames, function names, class names, frameworks, and libraries.
3. Drop filler words: "can you", "please", "explain", "tell me", "how does", "what is".
4. Do NOT answer the question.
5. Do NOT invent filenames or technologies not mentioned.
6. Return ONLY the rewritten query — no explanation, no quotes, no punctuation.

User question: {question}
Rewritten query:"""

    for model_name in MODELS:
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config={"temperature": 0.0, "max_output_tokens": 64}
            )
            rewritten = response.text.strip().strip('"').strip("'")
            # Sanity check: if the model returned something suspiciously long or empty, fall back
            if rewritten and len(rewritten.split()) <= 20:
                print(f"[DEBUG] Rewritten query ({model_name}): \"{rewritten}\"")
                return rewritten
            print(f"[WARN] Rewrite output from {model_name} looks invalid ({len(rewritten)} chars). Using original.")
            return question
        except Exception as e:
            print(f"[WARN] Query rewriting with {model_name} failed: {e}")

    print("[ERROR] All query rewriting models failed. Using original question.")
    return question
