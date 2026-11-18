import os
import json
from dotenv import load_dotenv
from groq import Groq
from google import genai
from sensitive_guard import redact_sensitive_content

load_dotenv()

groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))
gemini_client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))

# Groq model cascade: fastest first, then fallbacks
GROQ_MODELS = [
    "openai/gpt-oss-20b",
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
]

# Gemini fallback models (used only if ALL Groq models fail)
GEMINI_FALLBACK_MODELS = [
    "gemini-2.0-flash",
    "gemini-1.5-flash",
]


def _build_prompt(question: str, documents: list, repo_id: str = "") -> tuple[str, list]:
    """Build the generation prompt and deduplicated sources list."""
    context_parts = []
    has_visual_assets = False

    for doc in documents:
        metadata = doc.get("metadata", {})
        file_path = metadata.get("path") or metadata.get("source") or "File"
        content = doc.get("pageContent", "")
        doc_type = metadata.get("type", "code")
        language = metadata.get("language") or "text"

        if doc_type == "visual_asset":
            has_visual_assets = True
            raw_url = metadata.get("raw_url", "")
            context_parts.append(f"--- Architecture Diagram / Visual Asset: {file_path} (Image URL: {raw_url}) ---\n{content}")
        elif doc_type == "documentation":
            context_parts.append(f"--- Documentation File: {file_path} ---\n{content}")
        else:
            context_parts.append(f"--- Source Code File: {file_path} (Language: {language}) ---\n{content}")

    context = "\n\n".join(context_parts)

    if not context.strip():
        print("[WARN] Context is empty! Gemini will report that information could not be found.")
    else:
        print(f"[DEBUG] Context Total Length: {len(context)} characters (Contains visual assets: {has_visual_assets})")
        print(f"[DEBUG] Context Snippet:\n{context[:300]}...")

    repo_boundary = ""
    if repo_id:
        repo_boundary = f"""
REPOSITORY BOUNDARY:
You are answering a question about this repository ONLY:
Repository: {repo_id}

Use ONLY the provided repository context to answer the question.
Do NOT use information from other repositories.
If the answer cannot be determined from the provided repository context, state that clearly.
"""

    prompt = f"""
You are an expert AI assistant for analyzing software codebases and architectural designs.

Your task is to answer the user's question by thoroughly analyzing the provided codebase context (source code files, functions, resolvers, configurations, exports, and visual asset / diagram analyses).
{repo_boundary}
CRITICAL SECURITY POLICY:
1. Under NO circumstances should you reveal, output, or display sensitive information such as API keys, database connection strings/URLs, passwords, private keys, authentication tokens, or secret credentials.
2. If the user asks for sensitive information (e.g. API keys, DB URLs, secrets, passwords, or credentials), explicitly refuse the request by stating: "For security reasons, I cannot disclose sensitive information, API keys, database URLs, or credentials."
3. Do not include raw secrets or credentials in code snippets or explanations.

CRITICAL CODEBASE-FIRST GROUNDING POLICY:
1. PRIORITIZE ACTUAL SOURCE CODE: Ground your explanations directly in the actual source code files, functions, routes, schemas, database models, and logic provided in the context.
2. DO NOT MERELY SUMMARIZE README.MD: Documentation files (such as README.md) provide high-level context, but you must NOT simply regurgitate README bullet points. Always verify and anchor your explanation in the accompanying source code files (e.g. controllers, services, routes, models, utilities).
3. CITE SPECIFIC CODE EVIDENCE: When explaining how a feature works or what the codebase does, explicitly cite specific filenames (e.g., `backend/main.py`), functions, endpoints, classes, and logic rather than giving generic overviews.
4. SYNTHESIZE CODE AND DOCS: If both code and documentation are present, synthesize them: use the source code to provide accurate technical detail on implementation, and documentation to corroborate project intent.

General Instructions:
1. Carefully analyze the provided codebase context, which may include source code files, documentation files, and visual asset descriptions (architecture diagrams, flowcharts, schemas, UML).
2. When answering questions regarding architecture, service interactions, communication flows, or design, reference the relevant architecture diagrams and visual assets provided in the context.
3. Architecture diagrams in repositories often appear in two forms:
   - Visual image assets (e.g. PNG, SVG, JPG diagrams described in the context).
   - Textual/Mermaid diagrams inside Markdown documentation files (e.g. ```mermaid flowchart/sequenceDiagram ... ``` blocks in files like `architecture.md` or `README.md`).
   Thoroughly inspect and explain all nodes, subgraphs, connections, and directional arrows from any Mermaid diagrams or image visual descriptions found in the context.
4. Explicitly connect the visual elements and diagram flows with the actual source code implementations (routes, controllers, services, database models, event handlers) whenever both are present.
5. When referring to a diagram, cite its filename or path (e.g., `docs/architecture.md` or `docs/architecture.png`).
6. If the user asks what the project does, explain and infer its functionality, tech stack, endpoints, and purpose directly from the provided code and visual assets.
7. Provide a clear, concise, and professional answer based on the provided evidence.
8. Only state that you could not find the information if the provided context is completely empty or completely unrelated.

Context:

{context}

Question:

{question}
"""

    # Build deduplicated sources
    unique_sources_map = {}
    for doc in documents:
        metadata = doc.get("metadata", {})
        path_key = metadata.get("path") or metadata.get("source")
        if path_key and path_key not in unique_sources_map:
            unique_sources_map[path_key] = {
                "source": metadata.get("source"),
                "path": metadata.get("path"),
                "language": metadata.get("language"),
                "repo_id": metadata.get("repo_id"),
                "type": metadata.get("type", "code"),
                "raw_url": metadata.get("raw_url", ""),
                "filename": metadata.get("filename", os.path.basename(path_key))
            }

    return prompt, list(unique_sources_map.values())


def stream_answer(question: str, documents: list, repo_id: str = ""):
    """
    Stream the generated answer token-by-token as SSE events.

    Yields JSON-encoded SSE strings:
      - {"type": "token", "token": "..."}   — one per streamed chunk
      - {"type": "sources", "sources": [...]}  — once at the end
      - {"type": "done"}                      — signals completion
      - {"type": "error", "error": "..."}    — on failure
    """
    print("\n[DEBUG] --- Starting Streaming Answer Generation ---")
    print(f"[DEBUG] Repository: {repo_id}")
    print(f"[DEBUG] Received {len(documents)} documents for context")

    prompt, sources = _build_prompt(question, documents, repo_id)

    full_text = ""
    success = False

    for model_name in GROQ_MODELS:
        try:
            print(f"[DEBUG] Streaming with Groq model: {model_name}")
            stream = groq_client.chat.completions.create(
                model=model_name,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=4096,
                stream=True,
            )
            for chunk in stream:
                token = chunk.choices[0].delta.content or ""
                if token:
                    full_text += token
                    yield f"data: {json.dumps({'type': 'token', 'token': token})}\n\n"

            success = True
            break

        except Exception as e:
            print(f"[WARN] Groq streaming with {model_name} failed: {e}")
            full_text = ""

    if not success:
        # Groq exhausted — fall back to Gemini streaming
        print("[WARN] All Groq models failed. Falling back to Gemini streaming...")
        for gem_model in GEMINI_FALLBACK_MODELS:
            try:
                print(f"[DEBUG] Gemini fallback streaming: {gem_model}")
                gem_stream = gemini_client.models.generate_content_stream(
                    model=gem_model,
                    contents=prompt,
                )
                for chunk in gem_stream:
                    token = chunk.text or ""
                    if token:
                        full_text += token
                        yield f"data: {json.dumps({'type': 'token', 'token': token})}\n\n"
                success = True
                break
            except Exception as e:
                print(f"[WARN] Gemini fallback {gem_model} failed: {e}")
                full_text = ""

    if not success:
        error_msg = "Sorry, I could not generate an answer at this time due to an upstream model error. Please try again in a moment."
        yield f"data: {json.dumps({'type': 'token', 'token': error_msg})}\n\n"
        full_text = error_msg

    # Redact any secrets that slipped through in the full response
    redacted = redact_sensitive_content(full_text)
    if redacted != full_text:
        # If redaction changed something, send a correction event
        yield f"data: {json.dumps({'type': 'redacted', 'full_answer': redacted})}\n\n"

    # Send sources and done signal
    yield f"data: {json.dumps({'type': 'sources', 'sources': sources})}\n\n"
    yield f"data: {json.dumps({'type': 'done'})}\n\n"


def generate_answer(question: str, documents: list, repo_id: str = "") -> dict:
    """
    Non-streaming fallback. Collects all tokens and returns a single dict.
    Used by internal callers (e.g. evaluation runner) that don't use SSE.
    """
    print("\n[DEBUG] --- Starting Answer Generation (non-streaming) ---")
    print(f"[DEBUG] Repository: {repo_id}")
    print(f"[DEBUG] Received {len(documents)} documents for context")

    prompt, sources = _build_prompt(question, documents, repo_id)

    safe_answer = None
    for model_name in GROQ_MODELS:
        try:
            response = groq_client.chat.completions.create(
                model=model_name,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=4096,
                stream=False,
            )
            safe_answer = redact_sensitive_content(response.choices[0].message.content)
            break
        except Exception as e:
            print(f"[WARN] Groq answer generation with {model_name} failed: {e}")

    if not safe_answer:
        # Groq exhausted — fall back to Gemini non-streaming
        print("[WARN] All Groq models failed. Falling back to Gemini non-streaming...")
        for gem_model in GEMINI_FALLBACK_MODELS:
            try:
                resp = gemini_client.models.generate_content(model=gem_model, contents=prompt)
                safe_answer = redact_sensitive_content(resp.text)
                break
            except Exception as e:
                print(f"[WARN] Gemini fallback {gem_model} failed: {e}")

    if not safe_answer:
        safe_answer = "Sorry, I could not generate an answer at this time due to an upstream model error. Please try again in a moment."

    return {"answer": safe_answer, "sources": sources}
