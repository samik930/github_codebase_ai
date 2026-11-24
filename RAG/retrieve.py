import os
import json
import time
import hashlib
import redis
from concurrent.futures import ThreadPoolExecutor, as_completed
from dotenv import load_dotenv
from fastembed import TextEmbedding
from qdrant_client import QdrantClient
from qdrant_client.http import models as qmodels
from bm25 import load_bm25_index, search_bm25
from query_rewriter import rewrite_query
from ingest import get_bm25_path
from redis_cache import (
    get_cached_query_embedding,
    set_cached_query_embedding,
    get_query_embedding_cache_key,
    normalize_query,
    EXPECTED_EMBEDDING_DIM,
    get_cached_retrieval_results,
    set_cached_retrieval_results,
)

load_dotenv()

COLLECTION_NAME = "codebase_documents"
FASTEMBED_MODEL = os.getenv("FASTEMBED_MODEL", "BAAI/bge-small-en-v1.5")

qdrant = QdrantClient(
    url=os.getenv("QDRANT_URL"),
    api_key=os.getenv("QDRANT_API_KEY"),
    timeout=60.0
)

# Lazy-loaded FastEmbed singleton for retrieval
_retrieve_embed_model: TextEmbedding | None = None

def _get_retrieve_embed_model() -> TextEmbedding:
    global _retrieve_embed_model
    if _retrieve_embed_model is None:
        print(f"[RETRIEVE] Loading FastEmbed model: {FASTEMBED_MODEL}")
        _retrieve_embed_model = TextEmbedding(model_name=FASTEMBED_MODEL)
        print("[RETRIEVE] FastEmbed model loaded.")
    return _retrieve_embed_model

# ---------------------------------------------------------------------------
# In-memory LRU-style cache for query rewrites (avoids repeat Gemini calls)
# ---------------------------------------------------------------------------
_REWRITE_CACHE: dict[str, str] = {}
_REWRITE_CACHE_MAX = 128

def _cached_rewrite_query(question: str) -> str:
    key = hashlib.md5(question.strip().lower().encode()).hexdigest()
    if key in _REWRITE_CACHE:
        print(f"[DEBUG] Query rewrite cache hit for: \"{question[:60]}\"")
        return _REWRITE_CACHE[key]
    result = rewrite_query(question)
    if len(_REWRITE_CACHE) >= _REWRITE_CACHE_MAX:
        # Evict oldest entry
        oldest = next(iter(_REWRITE_CACHE))
        del _REWRITE_CACHE[oldest]
    _REWRITE_CACHE[key] = result
    return result

def extract_metadata(question: str) -> dict:
    """
    Extract file/language metadata from the question.
    Fast-path: skip Gemini entirely for short or generic questions.
    """
    _EMPTY = {"language": None, "path": None, "source": None}

    lower_q = question.lower().strip()

    # Fast-path 1: very short questions never need metadata filtering
    if len(lower_q.split()) <= 7:
        print("[DEBUG] Short query — skipping metadata extraction.")
        return _EMPTY

    metadata_keywords = [
        ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".cpp", ".c", ".cs", ".go", ".rs", ".php",
        ".json", ".yml", ".yaml", ".md", ".html", ".css", ".env", ".sql", ".docker",
        ".png", ".jpg", ".jpeg", ".webp", ".svg",
        "javascript", "typescript", "python", "csharp", "golang", "rust",
        "controller", "route", "service", "model", "config", "src/", "server/", "client/", "/"
    ]

    # Fast-path 2: no metadata keywords present — skip Gemini call
    if not any(kw in lower_q for kw in metadata_keywords):
        print("[DEBUG] Query contains no file/language/path metadata indicators. Skipping Gemini call for metadata extraction.")
        return _EMPTY
        
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
    for model_name in ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.6-flash"]:
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config={
                    "response_mime_type": "application/json",
                }
            )
            metadata = json.loads(response.text)
            print(f"[DEBUG] Extracted metadata ({model_name}):", metadata)
            return metadata
        except Exception as e:
            print(f"[WARN] Metadata extraction with {model_name} failed: {e}")

    print("[ERROR] All metadata extraction models failed. Continuing without metadata filter.")
    return {"language": None, "path": None, "source": None}

def build_qdrant_filter(metadata, repo_id: str, user_id: str = "default_user"):
    """Build Qdrant filter that ALWAYS enforces both repo_id and user_id isolation."""
    conditions = [
        # repo_id is ALWAYS required — this ensures repo isolation
        qmodels.FieldCondition(
            key="metadata.repo_id",
            match=qmodels.MatchValue(value=repo_id)
        )
    ]
    
    # user_id is ALWAYS required when present — ensures multi-tenant user isolation
    if user_id:
        conditions.append(qmodels.FieldCondition(
            key="metadata.userId",
            match=qmodels.MatchValue(value=user_id)
        ))
    
    if not metadata:
        return qmodels.Filter(must=conditions)

    # Normalize metadata if Gemini returned a list of dicts or a single dict
    items = metadata if isinstance(metadata, list) else [metadata]
    
    languages = set()
    paths = set()
    sources = set()
    
    for item in items:
        if isinstance(item, dict):
            lang = item.get("language")
            if lang:
                if isinstance(lang, list):
                    languages.update(lang)
                else:
                    languages.add(lang)
                    
            p = item.get("path")
            if p:
                if isinstance(p, list):
                    paths.update(p)
                else:
                    paths.add(p)
                    
            src = item.get("source")
            if src:
                if isinstance(src, list):
                    sources.update(src)
                else:
                    sources.add(src)
                    
    if languages:
        lang_list = [l for l in languages if l]
        if len(lang_list) == 1:
            conditions.append(qmodels.FieldCondition(
                key="metadata.language", match=qmodels.MatchValue(value=lang_list[0])
            ))
        elif len(lang_list) > 1:
            conditions.append(qmodels.FieldCondition(
                key="metadata.language", match=qmodels.MatchAny(any=lang_list)
            ))
            
    if paths:
        path_list = [p for p in paths if p]
        if len(path_list) == 1:
            conditions.append(qmodels.FieldCondition(
                key="metadata.path", match=qmodels.MatchValue(value=path_list[0])
            ))
        elif len(path_list) > 1:
            conditions.append(qmodels.FieldCondition(
                key="metadata.path", match=qmodels.MatchAny(any=path_list)
            ))
            
    if sources:
        src_list = [s for s in sources if s]
        if len(src_list) == 1:
            conditions.append(qmodels.FieldCondition(
                key="metadata.source", match=qmodels.MatchValue(value=src_list[0])
            ))
        elif len(src_list) > 1:
            conditions.append(qmodels.FieldCondition(
                key="metadata.source", match=qmodels.MatchAny(any=src_list)
            ))
        
    return qmodels.Filter(must=conditions)

def reciprocal_rank_fusion(dense_results, sparse_results):
    scores = {}
    documents_map = {}
    RRF_K = 60
    
    # Dense results (from Qdrant)
    for index, point in enumerate(dense_results):
        payload = point.payload or {}
        meta = payload.get("metadata", {})
        chunk_id = meta.get("chunkId")
        if not chunk_id:
            continue
            
        rank = index + 1
        rrf_score = 1 / (RRF_K + rank)
        
        scores[chunk_id] = scores.get(chunk_id, 0) + rrf_score
        
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

def enforce_source_diversity(
    documents: list,
    max_total: int = 16,
    max_per_file: int = 2,
    explicit_files: list = None
) -> list:
    """
    Prevents any single file (especially README.md) from dominating the retrieved context.
    - Limits any single file to max_per_file chunks (default: 2), unless explicitly requested.
    - If user explicitly requested a file, allows up to 6 chunks for that file.
    - Balances representation across code files, documentation, and architecture diagrams.
    - Fills up to max_total documents (default: 16) with diverse sources.
    """
    if not documents:
        return []

    explicit_set = set()
    if explicit_files:
        for f in explicit_files:
            if f and isinstance(f, str):
                explicit_set.add(f.lower().strip())

    selected = []
    file_chunk_counts = {}
    deferred_documents = []

    for doc in documents:
        meta = doc.get("metadata", {})
        raw_path = meta.get("path") or meta.get("source") or meta.get("filePath") or "unknown"
        norm_path = raw_path.lower()
        filename = (meta.get("filename") or os.path.basename(raw_path)).lower()

        # Check if this document matches any explicitly requested file
        is_explicit = any(
            (exp == norm_path or exp == filename or exp in norm_path or norm_path.endswith(exp))
            for exp in explicit_set
        )

        allowed_limit = 6 if is_explicit else max_per_file
        current_count = file_chunk_counts.get(norm_path, 0)

        if current_count < allowed_limit:
            selected.append(doc)
            file_chunk_counts[norm_path] = current_count + 1
            if len(selected) >= max_total:
                break
        else:
            deferred_documents.append(doc)

    # If we still have slots available before reaching max_total,
    # fill them with the deferred documents in their original RRF order.
    if len(selected) < max_total:
        for doc in deferred_documents:
            selected.append(doc)
            if len(selected) >= max_total:
                break

    return selected

# ---------------------------------------------------------------------------
# Redis cache for query embeddings
# Shared across FastAPI processes/containers; query vectors are repo-independent.
# ---------------------------------------------------------------------------
_embedding_cache = None
EMBEDDING_CACHE_TTL = int(os.getenv("EMBEDDING_CACHE_TTL_SECONDS", "604800"))  # 7 days
EMBEDDING_CACHE_PREFIX = "codebase:query-embedding:v1"


def _get_embedding_cache():
    """Create the Redis client lazily so retrieval still works if Redis is unavailable."""
    global _embedding_cache
    if _embedding_cache is None:
        redis_url = os.getenv("REDIS_URL")
        if redis_url:
            _embedding_cache = redis.Redis.from_url(
                redis_url,
                decode_responses=True,
                socket_connect_timeout=1,
                socket_timeout=1,
            )
        else:
            _embedding_cache = redis.Redis(
                host=os.getenv("REDIS_HOST", "localhost"),
                port=int(os.getenv("REDIS_PORT", "6379")),
                password=os.getenv("REDIS_PASSWORD") or None,
                decode_responses=True,
                socket_connect_timeout=1,
                socket_timeout=1,
            )
    return _embedding_cache


def embed_query(query: str, model: str = None) -> list[float]:
    """Embed with the same FastEmbed model as ingestion; cache vectors in Redis."""
    sanitized = query.strip() if query and query.strip() else "codebase search query"

    # Include the model and exact normalized input in the key. Do not lowercase:
    # code identifiers can be case-sensitive.
    cache_digest = hashlib.sha256(
        f"{FASTEMBED_MODEL}:{sanitized}".encode("utf-8")
    ).hexdigest()
    cache_key = f"{EMBEDDING_CACHE_PREFIX}:{FASTEMBED_MODEL}:{cache_digest}"

    try:
        cached = _get_embedding_cache().get(cache_key)
        if cached:
            vector = json.loads(cached)
            if isinstance(vector, list) and len(vector) == 384:
                print("[CACHE] Query embedding hit")
                return [float(value) for value in vector]
            print("[CACHE] Invalid query embedding entry; recomputing")
    except Exception as e:
        print(f"[CACHE WARN] Redis read failed; computing embedding: {e}")

    embedder = _get_retrieve_embed_model()
    result = list(embedder.embed([sanitized]))
    vector = [float(value) for value in result[0]]

    try:
        _get_embedding_cache().setex(
            cache_key,
            EMBEDDING_CACHE_TTL,
            json.dumps(vector, separators=(",", ":")),
        )
        print("[CACHE] Query embedding stored")
    except Exception as e:
        print(f"[CACHE WARN] Redis write failed; returning computed embedding: {e}")

    return vector
    """
    Embed the user's query with Redis caching.
    - Checks Redis cache first (exact match by version, model, and SHA-256 of case-preserved normalized query).
    - On cache miss: computes embedding using FastEmbed (local, 384-dim, ~20ms).
    - Caches embedding in Redis with TTL (default 7 days).
    - On Redis failure: falls back gracefully to FastEmbed without interrupting retrieval.
    """
    model_name = model or FASTEMBED_MODEL
    sanitized = normalize_query(query)

    # 1. Check Redis cache
    cached = get_cached_query_embedding(sanitized, model_name)
    if cached is not None:
        return cached

    # 2. Compute embedding with FastEmbed
    embedder = _get_retrieve_embed_model()
    result = list(embedder.embed([sanitized]))
    embedding = [float(x) for x in result[0]]

    # 3. Store in Redis cache (graceful on failure)
    set_cached_query_embedding(sanitized, model_name, embedding)

    return embedding

def retrieve_documents(question: str, repo_id: str, user_id: str = "default_user"):
    print(f"\n[DEBUG] === Starting Retrieval ===")
    print(f"[DEBUG] Repository: {repo_id}, User: {user_id}")
    print(f"[DEBUG] Query: \"{question}\"")

    # -------------------------------------------------------------------
    # Step 1: Run query rewriting AND metadata extraction IN PARALLEL
    # Previously these ran sequentially (8–15s total). Now concurrent.
    # -------------------------------------------------------------------
    rewritten_query = question  # default if rewrite fails
    metadata = {"language": None, "path": None, "source": None}

    with ThreadPoolExecutor(max_workers=2) as executor:
        future_rewrite  = executor.submit(_cached_rewrite_query, question)
        future_metadata = executor.submit(extract_metadata, question)

        try:
            rewritten_query = future_rewrite.result(timeout=10)
        except Exception as e:
            print(f"[WARN] Query rewriting failed (using original): {e}")

        try:
            metadata = future_metadata.result(timeout=10)
        except Exception as e:
            print(f"[WARN] Metadata extraction failed (continuing without): {e}")
    
    # Qdrant filter ALWAYS includes repo_id and user_id for strict isolation
    qdrant_filter = build_qdrant_filter(metadata, repo_id=repo_id, user_id=user_id)
    print(f"[DEBUG] Qdrant filter: {qdrant_filter}")
    
    # Load user- and repo-specific BM25 index
    bm25_path = get_bm25_path(repo_id, user_id=user_id)
    if not os.path.exists(bm25_path):
        print(f"[ERROR] BM25 index not found for repo: {repo_id} (user: {user_id}) at {bm25_path}")
        raise FileNotFoundError(f"Repository '{repo_id}' is not indexed for this user. BM25 index not found.")

    # -------------------------------------------------------------------
    # Step 2: Check retrieval cache BEFORE running Qdrant + BM25
    # Cache key encodes: user, repo, BM25 mtime (auto-invalidates on
    # re-index), query, retrieval config, and metadata filter.
    # -------------------------------------------------------------------
    cached_docs = get_cached_retrieval_results(
        query=rewritten_query,
        repo_id=repo_id,
        user_id=user_id,
        bm25_path=bm25_path,
        metadata=metadata,
    )
    if cached_docs is not None:
        print(f"[DEBUG] Served {len(cached_docs)} docs from retrieval cache (skipped Qdrant + BM25).")
        return cached_docs

    # -------------------------------------------------------------------
    # Step 3: Cache miss — run full hybrid retrieval
    # -------------------------------------------------------------------
    bm25_index = load_bm25_index(bm25_path)
    
    # Query Vector Embedding with fallback support
    query_vector = embed_query(rewritten_query)
    
    dense_response = qdrant.query_points(
        collection_name=COLLECTION_NAME,
        query=query_vector,
        query_filter=qdrant_filter,
        limit=30
    )
    dense_results = dense_response.points
    
    # Fallback: If strict metadata filtering yielded 0 results, retry dense query with strict repo & user isolation only
    has_meta_filter = bool(
        (metadata.get("path") or metadata.get("language") or metadata.get("source"))
        if isinstance(metadata, dict)
        else bool(metadata)
    )
    if len(dense_results) == 0 and has_meta_filter:
        print("[DEBUG] Strict metadata filter returned 0 dense results. Retrying with repo_id and user_id isolation only.")
        base_filter = build_qdrant_filter(None, repo_id=repo_id, user_id=user_id)
        fallback_resp = qdrant.query_points(
            collection_name=COLLECTION_NAME,
            query=query_vector,
            query_filter=base_filter,
            limit=30
        )
        dense_results = fallback_resp.points
    
    # Sparse Search (BM25 is already user- and repo-scoped, only positive scores)
    sparse_results = search_bm25(bm25_index, rewritten_query, limit=30)
    
    print(f"[DEBUG] Dense (Qdrant) results: {len(dense_results)}")
    print(f"[DEBUG] Sparse (BM25) results: {len(sparse_results)}")
    
    # Verify strict repo and user isolation in dense results
    filtered_dense_results = []
    for i, point in enumerate(dense_results):
        meta = point.payload.get("metadata", {})
        point_repo = meta.get("repo_id", "UNKNOWN")
        point_user = meta.get("userId", "UNKNOWN")
        if point_repo != repo_id:
            print(f"[WARNING] Cross-repo contamination detected in Qdrant result {i}: expected {repo_id}, got {point_repo}")
            continue
        if user_id and point_user != "UNKNOWN" and point_user != user_id:
            print(f"[SECURITY ALERT] Cross-user contamination prevented in Qdrant result {i}: expected {user_id}, got {point_user}")
            continue
        filtered_dense_results.append(point)
    
    final_documents = reciprocal_rank_fusion(filtered_dense_results, sparse_results)
    
    # Extract explicitly referenced paths or filenames to allow more chunks for them
    explicit_files = []
    if isinstance(metadata, dict):
        if metadata.get("path"):
            p = metadata["path"]
            if isinstance(p, list): explicit_files.extend(p)
            else: explicit_files.append(p)
        if metadata.get("source"):
            s = metadata["source"]
            if isinstance(s, list): explicit_files.extend(s)
            else: explicit_files.append(s)
    elif isinstance(metadata, list):
        for m in metadata:
            if isinstance(m, dict):
                if m.get("path"):
                    p = m["path"]
                    if isinstance(p, list): explicit_files.extend(p)
                    else: explicit_files.append(p)
                if m.get("source"):
                    s = m["source"]
                    if isinstance(s, list): explicit_files.extend(s)
                    else: explicit_files.append(s)

    # Also detect if question directly names files (e.g. "readme.md", "main.py")
    lower_q = question.lower()
    for potential_file in ["readme.md", "readme", "main.py", "config.py", "database.py", "package.json"]:
        if potential_file in lower_q and potential_file not in explicit_files:
            explicit_files.append(potential_file)

    # Source diversity enforcement: cap any single file (e.g. README.md) at max 2 chunks
    # Expand final retrieved context from 8 to 16 chunks
    documents = enforce_source_diversity(
        final_documents,
        max_total=16,
        max_per_file=2,
        explicit_files=explicit_files
    )
    print(f"[DEBUG] Final hybrid diverse results: {len(documents)} (from {len(final_documents)} candidates)")
    
    for i, doc in enumerate(documents):
        meta = doc.get("metadata", {})
        content = doc.get("pageContent", "")
        doc_type = meta.get("type", "code")
        
        print(f"\n[DEBUG] Hybrid Result {i + 1} ({doc_type}):")
        print(f"  Chunk ID: {meta.get('chunkId')}")
        print(f"  Repo ID: {meta.get('repo_id')}")
        print(f"  User ID: {meta.get('userId')}")
        print(f"  Source: {meta.get('source')}")
        print(f"  Type: {doc_type}")
        if meta.get("raw_url"):
            print(f"  Raw URL: {meta.get('raw_url')}")
        safe_preview = content[:150].encode('ascii', errors='replace').decode('ascii').replace('\n', ' ')
        print(f"  Preview: {safe_preview}...")

    # -------------------------------------------------------------------
    # Step 4: Cache the final ranked results for future identical requests
    # -------------------------------------------------------------------
    set_cached_retrieval_results(
        query=rewritten_query,
        repo_id=repo_id,
        user_id=user_id,
        bm25_path=bm25_path,
        results=documents,
        metadata=metadata,
    )

    return documents
