import pickle
from rank_bm25 import BM25Okapi


def create_bm25_index(chunks):
    documents = []
    for i, c in enumerate(chunks):
        # Support both dicts and Langchain Document objects
        page_content = c.page_content if hasattr(c, 'page_content') else c.get("pageContent", "")
        metadata = c.metadata if hasattr(c, 'metadata') else c.get("metadata", {})
        
        documents.append({
            "id": i + 1,
            "pageContent": page_content,
            "metadata": {**metadata, "chunkId": i + 1}
        })

    tokenized = [d["pageContent"].lower().split() for d in documents]

    if not tokenized:
        return {"documents": [], "bm25": None}

    return {
        "documents": documents,
        "bm25": BM25Okapi(tokenized)
    }


import os

def save_bm25_index(index, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        pickle.dump(index, f)


def load_bm25_index(path):
    with open(path, "rb") as f:
        return pickle.load(f)


def search_bm25(index, query, limit=10):
    if not index.get("bm25"):
        return []
        
    scores = index["bm25"].get_scores(query.lower().split())

    results = sorted(
        zip(index["documents"], scores),
        key=lambda x: x[1],
        reverse=True
    )

    return [
        {"document": doc, "score": score}
        for doc, score in results[:limit]
    ]