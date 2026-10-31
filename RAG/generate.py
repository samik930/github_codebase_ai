import os
from dotenv import load_dotenv
from google import genai
from sensitive_guard import redact_sensitive_content

load_dotenv()

client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))

def generate_answer(question: str, documents: list, repo_id: str = "") -> dict:
    print("\n[DEBUG] --- Starting Answer Generation ---")
    print(f"[DEBUG] Repository: {repo_id}")
    print(f"[DEBUG] Received {len(documents)} documents for context")

    context_parts = []
    for doc in documents:
        # Assuming doc is a dict containing 'metadata' and 'pageContent' (from our reciprocal_rank_fusion)
        metadata = doc.get("metadata", {})
        file_path = metadata.get("path") or metadata.get("source") or "File"
        content = doc.get("pageContent", "")
        context_parts.append(f"--- File: {file_path} ---\n{content}")
        
    context = "\n\n".join(context_parts)
    
    if not context.strip():
        print("[WARN] Context is empty! Gemini will report that information could not be found.")
    else:
        print(f"[DEBUG] Context Total Length: {len(context)} characters")
        print(f"[DEBUG] Context Snippet:\n{context[:300]}...")

    # Build repository boundary instruction
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
You are an expert AI assistant for analyzing software codebases.

Your task is to answer the user's question by thoroughly analyzing the provided codebase context (source code files, functions, resolvers, configurations, and exports).
{repo_boundary}
CRITICAL SECURITY POLICY:
1. Under NO circumstances should you reveal, output, or display sensitive information such as API keys, database connection strings/URLs, passwords, private keys, authentication tokens, or secret credentials.
2. If the user asks for sensitive information (e.g. API keys, DB URLs, secrets, passwords, or credentials), explicitly refuse the request by stating: "For security reasons, I cannot disclose sensitive information, API keys, database URLs, or credentials."
3. Do not include raw secrets or credentials in code snippets or explanations.

General Instructions:
1. Carefully analyze the provided code snippets and files to answer the user's question.
2. If the user asks what the project does, explain and infer its functionality, tech stack, endpoints, and purpose directly from the provided code, resolvers, and functions.
3. Provide a clear, concise, and professional answer based on the code provided.
4. Only state that you could not find the information if the provided context is completely empty or completely unrelated.

Context:

{context}

Question:

{question}
"""
    try:
        response = client.models.generate_content(
            model="gemini-3.6-flash",
            contents=prompt,
            config={
                "temperature": 0.0
            }
        )
        safe_answer = redact_sensitive_content(response.text)
    except Exception as e:
        print("[ERROR] Answer Generation failed:", str(e))
        safe_answer = "Sorry, I could not generate an answer at this time due to an error."

    # Deduplicate sources by path
    unique_sources_map = {}
    for doc in documents:
        metadata = doc.get("metadata", {})
        path_key = metadata.get("path") or metadata.get("source")
        if path_key and path_key not in unique_sources_map:
            unique_sources_map[path_key] = {
                "source": metadata.get("source"),
                "path": metadata.get("path"),
                "language": metadata.get("language"),
                "repo_id": metadata.get("repo_id")
            }

    return {
        "answer": safe_answer,
        "sources": list(unique_sources_map.values())
    }
