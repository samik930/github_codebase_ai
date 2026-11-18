import os
import json
import time
from dotenv import load_dotenv
from google import genai

_rag_env = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
load_dotenv(_rag_env)
load_dotenv()

client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))
EVAL_MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.6-flash"]


def _call_gemini_json(prompt: str) -> dict:
    """Call Gemini in JSON mode with model fallback and retry."""
    for model_name in EVAL_MODELS:
        for attempt in range(3):
            try:
                response = client.models.generate_content(
                    model=model_name,
                    contents=prompt,
                    config={
                        "response_mime_type": "application/json",
                        "temperature": 0.0,
                    }
                )
                text = response.text.strip()
                return json.loads(text)
            except Exception as e:
                err = str(e)
                if "429" in err or "RESOURCE_EXHAUSTED" in err:
                    time.sleep(2.0 * (1.5 ** attempt))
                else:
                    break
    return {}


def evaluate_faithfulness(question: str, contexts: list[str], answer: str) -> dict:
    """
    Evaluates whether the generated answer is faithful to (grounded in) the retrieved context.
    Faithfulness = (Number of claims supported by context) / (Total claims in answer).
    """
    if not answer or not answer.strip():
        return {"score": 0.0, "reason": "Empty answer", "claims": []}

    context_str = "\n\n---\n\n".join(contexts[:10]) if contexts else "No context provided."

    prompt = f"""
You are an expert AI evaluator assessing the FAITHFULNESS of a RAG-generated answer against the retrieved codebase context.
Faithfulness measures whether every factual claim made in the answer can be directly verified from the provided context.

Context:
\"\"\"
{context_str}
\"\"\"

User Question:
\"{question}\"

Generated Answer:
\"\"\"
{answer}
\"\"\"

Instructions:
1. Break down the generated answer into individual, atomic factual claims.
2. For each claim, check whether it is SUPPORTED or UNSUPPORTED by the context.
   - If the answer states that certain information is not in the codebase (and the context confirms no such feature exists), mark that statement as SUPPORTED.
   - If a claim makes a factual statement about code, files, or logic that is NOT evidenced in the context, mark it as UNSUPPORTED (hallucination).
3. Compute the score: (count of supported claims) / (total claims).
   If there are no factual claims, return 1.0.

Return JSON in this exact structure:
{{
  "claims": [
    {{"claim": "...", "supported": true, "reason": "..."}}
  ],
  "score": 0.95,
  "feedback": "Brief summary of faithfulness findings."
}}
"""
    result = _call_gemini_json(prompt)
    if not result:
        return {"score": 0.5, "claims": [], "feedback": "Evaluation call failed; default fallback score assigned."}
    
    score = float(result.get("score", 0.0))
    return {
        "score": max(0.0, min(1.0, score)),
        "claims": result.get("claims", []),
        "feedback": result.get("feedback", "")
    }


def evaluate_answer_relevancy(question: str, answer: str) -> dict:
    """
    Evaluates how directly, completely, and appropriately the generated answer addresses the question.
    Penalizes evasive, incomplete, or off-topic responses.
    """
    if not answer or not answer.strip():
        return {"score": 0.0, "reasoning": "Empty answer"}

    prompt = f"""
You are an expert AI evaluator assessing the ANSWER RELEVANCY of a codebase assistant response.
Answer Relevancy measures how well the answer directly answers the user's specific prompt without unnecessary fluff or missing the main point.

User Question:
\"{question}\"

Generated Answer:
\"\"\"
{answer}
\"\"\"

Instructions:
1. Assess whether the answer directly addresses all components of the user's question.
2. Check if the answer provides specific, actionable technical details relevant to the question.
3. If the question was asking about a non-existent feature, a good answer will clearly state that it is not in the codebase (which is highly relevant).
4. Assign a score between 0.0 (completely irrelevant or evasive) and 1.0 (completely relevant, direct, and complete).

Return JSON in this exact structure:
{{
  "score": 0.9,
  "reasoning": "Explanation of relevancy evaluation.",
  "strengths": ["..."],
  "weaknesses": ["..."]
}}
"""
    result = _call_gemini_json(prompt)
    if not result:
        return {"score": 0.5, "reasoning": "Evaluation call failed; default fallback assigned."}

    score = float(result.get("score", 0.0))
    return {
        "score": max(0.0, min(1.0, score)),
        "reasoning": result.get("reasoning", ""),
        "strengths": result.get("strengths", []),
        "weaknesses": result.get("weaknesses", [])
    }


def evaluate_context_precision(question: str, retrieved_docs: list[dict], reference_answer: str = "", expected_files: list[str] = None) -> dict:
    """
    Evaluates Context Precision: Did the retrieval engine rank the most relevant chunks at the top?
    Computes Average Precision (AP) across ranked chunks.
    AP = sum(P@k * rel(k)) / total_relevant_chunks
    """
    if not retrieved_docs:
        return {"score": 0.0, "reasoning": "No documents retrieved", "chunk_evaluations": []}

    expected_files = expected_files or []

    # Format chunks with rank and source path
    formatted_chunks = []
    for rank, doc in enumerate(retrieved_docs[:10], start=1):
        meta = doc.get("metadata", {})
        path = meta.get("path") or meta.get("source") or "unknown"
        snippet = doc.get("pageContent", "")[:250].replace("\n", " ")
        formatted_chunks.append(f"[Rank {rank}] File: {path}\nSnippet: {snippet}")

    chunks_str = "\n\n".join(formatted_chunks)
    expected_str = ", ".join(expected_files) if expected_files else "None explicitly specified"

    prompt = f"""
You are an expert AI evaluator assessing the CONTEXT PRECISION of a codebase RAG retrieval engine.
Context Precision evaluates whether the retrieved chunks are relevant to answering the question and whether relevant chunks are ranked higher than irrelevant chunks.

Question:
\"{question}\"

Expected Target Files:
{expected_str}

Reference Answer:
\"{reference_answer}\"

Retrieved Chunks in Rank Order:
\"\"\"
{chunks_str}
\"\"\"

Instructions:
1. For each chunk (from Rank 1 to {len(formatted_chunks)}), determine if it is RELEVANT (true) or IRRELEVANT (false) to answering the question.
   - A chunk is relevant if it contains code, definitions, or documentation needed to answer the question.
2. Return the relevance determination for each rank.

Return JSON in this exact structure:
{{
  "chunk_relevance": [
    {{"rank": 1, "relevant": true, "reason": "..."}}
  ],
  "reasoning": "Brief explanation of ranking quality."
}}
"""
    result = _call_gemini_json(prompt)
    chunk_rels = result.get("chunk_relevance", [])

    if not chunk_rels:
        # Fallback to file-name matching if LLM parsing failed
        ap = 0.0
        relevant_count = 0
        running_relevant = 0
        for rank, doc in enumerate(retrieved_docs[:10], start=1):
            path = doc.get("metadata", {}).get("path", "").lower()
            is_rel = any(ef.lower() in path for ef in expected_files) if expected_files else True
            if is_rel:
                relevant_count += 1
                running_relevant += 1
                ap += running_relevant / rank
        score = (ap / relevant_count) if relevant_count > 0 else 0.5
        return {
            "score": round(score, 3),
            "reasoning": "Rule-based target file ranking precision.",
            "chunk_evaluations": []
        }

    # Calculate Average Precision (AP)
    total_relevant = 0
    running_relevant = 0
    precision_sum = 0.0

    for item in chunk_rels:
        rank = item.get("rank", 1)
        is_rel = bool(item.get("relevant", False))
        if is_rel:
            total_relevant += 1
            running_relevant += 1
            precision_sum += (running_relevant / rank)

    if total_relevant == 0:
        # If no chunks were relevant, score is 0.0 (or 1.0 if the question is out-of-scope and no chunks should be relevant)
        final_score = 1.0 if not expected_files else 0.0
    else:
        final_score = precision_sum / total_relevant

    return {
        "score": round(max(0.0, min(1.0, final_score)), 3),
        "total_relevant_chunks": total_relevant,
        "total_evaluated_chunks": len(chunk_rels),
        "reasoning": result.get("reasoning", ""),
        "chunk_evaluations": chunk_rels
    }


def evaluate_code_grounding(answer: str, retrieved_docs: list[dict]) -> dict:
    """
    Checks if filenames cited in the answer actually exist in the retrieved context chunks.
    Detects hallucinated file citations.
    """
    retrieved_paths = set()
    for doc in retrieved_docs:
        meta = doc.get("metadata", {})
        p = meta.get("path") or meta.get("source") or ""
        if p:
            retrieved_paths.add(p.lower())
            retrieved_paths.add(os.path.basename(p).lower())

    prompt = f"""
Extract all code file paths or file names mentioned in this answer (e.g. `backend/main.py`, `src/App.jsx`, `requirements.txt`).

Answer:
\"\"\"
{answer}
\"\"\"

Return JSON:
{{
  "cited_files": ["..."]
}}
"""
    res = _call_gemini_json(prompt)
    cited = res.get("cited_files", [])

    if not cited:
        return {"score": 1.0, "valid_citations": [], "hallucinated_citations": [], "feedback": "No specific files cited."}

    valid = []
    hallucinated = []
    for f in cited:
        clean_f = f.strip().lower()
        base_f = os.path.basename(clean_f)
        if clean_f in retrieved_paths or base_f in retrieved_paths:
            valid.append(f)
        else:
            hallucinated.append(f)

    score = len(valid) / (len(valid) + len(hallucinated)) if (valid or hallucinated) else 1.0
    return {
        "score": round(score, 3),
        "valid_citations": valid,
        "hallucinated_citations": hallucinated,
        "feedback": f"{len(valid)} valid citations, {len(hallucinated)} ungrounded citations."
    }


def evaluate_sample(question: str, answer: str, retrieved_docs: list[dict], reference_answer: str = "", expected_files: list[str] = None) -> dict:
    """
    Runs complete evaluation suite on a single RAG generation instance:
    1. Faithfulness
    2. Answer Relevancy
    3. Context Precision
    4. Code Grounding
    """
    context_texts = [d.get("pageContent", "") for d in retrieved_docs]

    faith_res = evaluate_faithfulness(question, context_texts, answer)
    relev_res = evaluate_answer_relevancy(question, answer)
    prec_res = evaluate_context_precision(question, retrieved_docs, reference_answer, expected_files)
    ground_res = evaluate_code_grounding(answer, retrieved_docs)

    # Composite RAG Score (weighted average: 40% Faithfulness, 35% Relevancy, 25% Context Precision)
    composite = round((faith_res["score"] * 0.40) + (relev_res["score"] * 0.35) + (prec_res["score"] * 0.25), 3)

    return {
        "composite_score": composite,
        "faithfulness": faith_res,
        "answer_relevancy": relev_res,
        "context_precision": prec_res,
        "code_grounding": ground_res
    }
