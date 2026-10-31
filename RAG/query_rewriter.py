import os
from dotenv import load_dotenv
from google import genai

load_dotenv()

client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))

def rewrite_query(question: str) -> str:
    prompt = f"""
You are a query rewriting system for a codebase RAG application.

Rewrite the user's question into a concise search query
that will help retrieve relevant code chunks.

Rules:
1. Preserve the original intent.
2. Extract important technical concepts, filenames,
   functions, classes, libraries, frameworks, and technologies.
3. Add useful related technical terms when strongly implied.
4. Do NOT answer the question.
5. Do NOT invent filenames, functions, or technologies.
6. Keep the rewritten query concise.
7. Return ONLY the rewritten query.

User question:
"{question}"
"""
    try:
        response = client.models.generate_content(
            model="gemini-3.6-flash",
            contents=prompt
        )
        rewritten_query = response.text.strip()
        print("[DEBUG] Original query:", question)
        print("[DEBUG] Rewritten query:", rewritten_query)
        return rewritten_query
    except Exception as e:
        print("[ERROR] Query rewriting failed:", str(e))
        return question
