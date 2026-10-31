import os
import json
from dotenv import load_dotenv
from google import genai
from qdrant_client import QdrantClient
from qdrant_client.http import models as qmodels
from bm25 import load_bm25_index, search_bm25
from query_rewriter import rewrite_query
from ingest import get_bm25_path

load_dotenv()

COLLECTION_NAME = "codebase_documents"

client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))
qdrant = QdrantClient(
    url=os.getenv("QDRANT_URL"),
    api_key=os.getenv("QDRANT_API_KEY"),
    timeout=60.0
)

def extract_metadata(question: str) -> dict:
    metadata_keywords = [
        ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".cpp", ".c", ".cs", ".go", ".rs", ".php",
        ".json", ".yml", ".yaml", ".md", ".html", ".css", ".env", ".sql", ".docker",
        ".png", ".jpg", ".jpeg", ".webp", ".svg",
        "javascript", "js", "typescript", "ts", "python", "py", "java", "cpp", "c++",
        "csharp", "c#", "golang", "go", "rust", "php", "diagram", "flowchart",
        "path", "file", "controller", "route", "service", "model", "config", "src/", "server/", "client/", "/"
    ]
    
    lower_q = question.lower()
    if not any(kw in lower_q for kw in metadata_keywords):
        print("[DEBUG] Query contains no file/language/path metadata indicators. Skipping Gemini call for metadata extraction.")
        return {"language": None, "path": None, "source": None}
        
    prompt = f"""
You are a metadata extraction system for a codebase RAG system.

The indexed documents contain these metadata fields:

- language: programming language of the file (e.g. javascript, typescript, python, cpp, csharp, go, rust, java, php)
- path: file path (e.g. src/index.js, docs/architecture.md, or assets/diagram.png)
- source: source file path

Analyze the user's query and extract ONLY metadata constraints
that are explicitly stated or strongly implied by the query.

Rules:

1. Do NOT answer the user's question.
2. Do NOT invent metadata.
3. If the user does not specify a metadata constraint, return null.
4. For language, extract ONLY actual programming languages. Normalize common names:
   - JS / JavaScript -> javascript
   - TS / TypeScript -> typescript
   - Py / Python -> python
   - C++ / cpp -> cpp
   - C# / csharp -> csharp
   - Golang -> go
   - Rust -> rust
   - Java -> java
   - PHP -> php
   Do NOT set language for general concepts like 'diagram', 'architecture', or 'docs' (return null for language instead so all files can be searched).
5. If a filename or path is explicitly mentioned, return it.
6. Keep path/source values exactly as they appear in the query as much as possible.
7. Metadata extraction should be conservative.
User query:
"{question}"
"""
    try:
        response = client.models.generate_content(
            model="gemini-3.6-flash",
            contents=prompt,
            config={
                "response_mime_type": "application/json",
            }
        )
        metadata = json.loads(response.text)
        print("[DEBUG] Extracted metadata:", metadata)
        return metadata
    except Exception as e:
        print("[ERROR] Metadata extraction failed:", str(e))
        return {"language": None, "path": None, "source": None}

def build_qdrant_filter(metadata: dict, repo_id: str):
    """Build Qdrant filter that ALWAYS includes repo_id and optionally language/path/source."""
    conditions = [
        # repo_id is ALWAYS required — this ensures repo isolation
        qmodels.FieldCondition(
            key="metadata.repo_id",
            match=qmodels.MatchValue(value=repo_id)
        )
    ]
    
    if metadata.get("language"):
        conditions.append(qmodels.FieldCondition(
            key="metadata.language", match=qmodels.MatchValue(value=metadata["language"])
        ))
        
    if metadata.get("path"):
        conditions.append(qmodels.FieldCondition(
            key="metadata.path", match=qmodels.MatchValue(value=metadata["path"])
        ))
        
    if metadata.get("source"):
        conditions.append(qmodels.FieldCondition(
            key="metadata.source", match=qmodels.MatchValue(value=metadata["source"])
        ))
        
    return qmodels.Filter(must=conditions)

def reciprocal_rank_fusion(dense_results, sparse_results):
    scores = {}
    documents_map = {}
    RRF_K = 60
    
    # Dense results (from Qdrant)
    # qdrant returns ScoredPoint objects
    for index, point in enumerate(dense_results):
        payload = point.payload or {}
        meta = payload.get("metadata", {})
        chunk_id = meta.get("chunkId")
        if not chunk_id:
            continue
            
        rank = index + 1
        rrf_score = 1 / (RRF_K + rank)
        
        scores[chunk_id] = scores.get(chunk_id, 0) + rrf_score
        
        # reconstruct a dict similar to JS Document
        documents_map[chunk_id] = {
            "pageContent": payload.get("page_content", ""),
            "metadata": meta
        }
        
    # Sparse results (from BM25)
    for index, result in enumerate(sparse_results):
        doc = result.get("document", {})
        meta = doc.get("metadata", {})
        chunk_id = meta.get("chunkId")
        if not chunk_id:
            continue
            
        rank = index + 1
        rrf_score = 1 / (RRF_K + rank)
        
        scores[chunk_id] = scores.get(chunk_id, 0) + rrf_score
        
        if chunk_id not in documents_map:
            documents_map[chunk_id] = {
                "pageContent": doc.get("pageContent", ""),
                "metadata": meta
            }
            
    # Sort by RRF score
    sorted_ids = sorted(scores.keys(), key=lambda k: scores[k], reverse=True)
    return [documents_map[chunk_id] for chunk_id in sorted_ids]

def retrieve_documents(question: str, repo_id: str):
    print(f"\n[DEBUG] === Starting Retrieval ===")
    print(f"[DEBUG] Repository: {repo_id}")
    print(f"[DEBUG] Query: \"{question}\"")
    
    rewritten_query = rewrite_query(question)
    metadata = extract_metadata(question)
    
    # Qdrant filter ALWAYS includes repo_id for isolation
    qdrant_filter = build_qdrant_filter(metadata, repo_id)
    print(f"[DEBUG] Qdrant filter: {qdrant_filter}")
    
    # Load repo-specific BM25 index
    bm25_path = get_bm25_path(repo_id)
    if not os.path.exists(bm25_path):
        print(f"[ERROR] BM25 index not found for repo: {repo_id} at {bm25_path}")
        raise FileNotFoundError(f"Repository '{repo_id}' is not indexed. BM25 index not found.")
    
    bm25_index = load_bm25_index(bm25_path)
    
    # Query Vector Embedding
    emb_response = client.models.embed_content(
        model="gemini-embedding-2",
        contents=rewritten_query
    )
    query_vector = emb_response.embeddings[0].values if isinstance(emb_response.embeddings, list) else emb_response.embeddings
    
    dense_response = qdrant.query_points(
        collection_name=COLLECTION_NAME,
        query=query_vector,
        query_filter=qdrant_filter,
        limit=10
    )
    dense_results = dense_response.points
    
    # Sparse Search (BM25 is already repo-scoped via per-repo index file)
    sparse_results = search_bm25(bm25_index, rewritten_query, limit=10)
    
    print(f"[DEBUG] Dense (Qdrant) results: {len(dense_results)}")
    print(f"[DEBUG] Sparse (BM25) results: {len(sparse_results)}")
    
    # Verify repo isolation in dense results
    for i, point in enumerate(dense_results):
        point_repo = point.payload.get("metadata", {}).get("repo_id", "UNKNOWN")
        if point_repo != repo_id:
            print(f"[WARNING] Cross-repo contamination detected in Qdrant result {i}: expected {repo_id}, got {point_repo}")
    
    # Verify repo isolation in sparse results
    for i, result in enumerate(sparse_results):
        doc_repo = result.get("document", {}).get("metadata", {}).get("repo_id", "UNKNOWN")
        if doc_repo != repo_id:
            print(f"[WARNING] Cross-repo contamination detected in BM25 result {i}: expected {repo_id}, got {doc_repo}")
    
    final_documents = reciprocal_rank_fusion(dense_results, sparse_results)
    
    documents = final_documents[:8]
    print(f"[DEBUG] Final hybrid (RRF) results: {len(documents)}")
    
    for i, doc in enumerate(documents):
        meta = doc.get("metadata", {})
        content = doc.get("pageContent", "")
        doc_type = meta.get("type", "code")
        
        print(f"\n[DEBUG] Hybrid Result {i + 1} ({doc_type}):")
        print(f"  Chunk ID: {meta.get('chunkId')}")
        print(f"  Repo ID: {meta.get('repo_id')}")
        print(f"  Source: {meta.get('source')}")
        print(f"  Type: {doc_type}")
        if meta.get("raw_url"):
            print(f"  Raw URL: {meta.get('raw_url')}")
        safe_preview = content[:150].encode('ascii', errors='replace').decode('ascii').replace('\n', ' ')
        print(f"  Preview: {safe_preview}...")
        
    return documents
