import os
import re
import time
import uuid
import threading
from concurrent.futures import ThreadPoolExecutor
from dotenv import load_dotenv
from langchain_text_splitters import RecursiveCharacterTextSplitter
from fastembed import TextEmbedding
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, Filter, FieldCondition, MatchValue

from sensitive_guard import is_sensitive_file, redact_sensitive_content
from bm25 import create_bm25_index, save_bm25_index
from visual_pipeline import analyze_visual_asset
from langchain_core.documents import Document

load_dotenv()

COLLECTION = "codebase_documents"
# FastEmbed BAAI/bge-small-en-v1.5 produces 384-dim vectors
FASTEMBED_MODEL = os.getenv("FASTEMBED_MODEL", "BAAI/bge-small-en-v1.5")
VECTOR_SIZE = 384
BM25_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "50"))
MAX_RETRIES = int(os.getenv("MAX_RETRY_ATTEMPTS", "7"))

# Lazy-loaded singleton — model downloads on first use (~50MB, cached after that)
_fastembed_model: TextEmbedding | None = None

def _get_embed_model() -> TextEmbedding:
    global _fastembed_model
    if _fastembed_model is None:
        print(f"[EMBED] Loading FastEmbed model: {FASTEMBED_MODEL}")
        _fastembed_model = TextEmbedding(model_name=FASTEMBED_MODEL)
        print("[EMBED] FastEmbed model loaded.")
    return _fastembed_model

# Thread-safe cancellation registry for active repository ingestions
_cancellation_lock = threading.Lock()
_cancelled_ingestions = set()


def cancel_ingestion(repo_id: str, user_id: str = None):
    """Signal any active or pending ingestion for this repo & user to abort immediately."""
    with _cancellation_lock:
        _cancelled_ingestions.add((repo_id, user_id or "*"))
        _cancelled_ingestions.add((repo_id, "*"))
    print(f"[INGEST CANCEL] Registered cancellation for repo: {repo_id}, user: {user_id}")


def is_ingestion_cancelled(repo_id: str, user_id: str = None) -> bool:
    """Check if the given repo & user ingestion has received a cancellation signal."""
    with _cancellation_lock:
        if (repo_id, "*") in _cancelled_ingestions:
            return True
        if user_id and (repo_id, user_id) in _cancelled_ingestions:
            return True
        return False


def clear_ingestion_cancellation(repo_id: str, user_id: str = None):
    """Clear cancellation marker once cleanup is completed or when starting a fresh run."""
    with _cancellation_lock:
        _cancelled_ingestions.discard((repo_id, user_id or "*"))
        _cancelled_ingestions.discard((repo_id, "*"))
        if user_id:
            _cancelled_ingestions.discard((repo_id, user_id))


def sanitize_repo_id(repo_id: str) -> str:
    """Convert 'owner/repo' into a safe filename component like 'owner__repo'."""
    return re.sub(r'[^\w\-.]', '__', repo_id)


def sanitize_user_id(user_id: str) -> str:
    """Convert user identifier into a safe filename component."""
    return re.sub(r'[^\w\-.]', '__', user_id or "default_user")


def get_bm25_path(repo_id: str, user_id: str = "default_user") -> str:
    """Return the isolated BM25 index path for a specific user and repository."""
    os.makedirs(BM25_DIR, exist_ok=True)
    user_sanitized = sanitize_user_id(user_id)
    repo_sanitized = sanitize_repo_id(repo_id)
    
    # Check if user-scoped file exists
    user_scoped_path = os.path.join(BM25_DIR, f"bm25-{user_sanitized}__{repo_sanitized}.pkl")
    if os.path.exists(user_scoped_path):
        return user_scoped_path
        
    # Check legacy repo-only path for backwards compatibility
    legacy_path = os.path.join(BM25_DIR, f"bm25-{repo_sanitized}.pkl")
    if os.path.exists(legacy_path):
        return legacy_path
        
    return user_scoped_path


def get_language(path):
    return {
        ".js": "javascript",
        ".jsx": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".py": "python",
        ".java": "java",
        ".cpp": "cpp",
        ".c": "c",
        ".cs": "csharp",
        ".go": "go",
        ".rs": "rust",
        ".php": "php"
    }.get(os.path.splitext(path)[1].lower(), "text")


def embed_single(text: str, model: str = None) -> list[float]:
    """Single text embed using FastEmbed — local, ~20ms, no API quota."""
    return embed_batch([text])[0]


def embed_batch(texts: list[str], model: str = None) -> list[list[float]]:
    """Batch embed using FastEmbed — local, ~20ms, no API quota."""
    if not texts:
        return []
    sanitized = [t if (t and t.strip()) else " " for t in texts]
    embedder = _get_embed_model()
    embeddings = list(embedder.embed(sanitized))
    return [list(e) for e in embeddings]


def ingest_documents(files, repo_id: str, commit_hash: str = "", visual_files: list = None, user_id: str = "default_user", branch: str = "main"):
    # Clear any stale cancellation from past attempts before starting a fresh run
    clear_ingestion_cancellation(repo_id, user_id)

    yield {"type": "status", "message": f"Starting ingestion for repository: {repo_id} (user: {user_id})"}

    visual_files = visual_files or []
    print(f"\n[INGEST] === Starting ingestion for repo_id: {repo_id}, user_id: {user_id}, commit_hash: {commit_hash} ===")
    print(f"[INGEST] Code files: {len(files)}, Visual assets: {len(visual_files)}")

    # Check for early cancellation
    if is_ingestion_cancelled(repo_id, user_id):
        print(f"[INGEST] Early cancellation signal received for {repo_id}. Aborting.")
        delete_repository_vectors(repo_id, user_id)
        yield {"type": "error", "error": "Ingestion cancelled."}
        return

    def get_doc_type(file_path):
        p = file_path.lower()
        if p.endswith((".md", ".txt", ".rst")) or "doc/" in p or "docs/" in p:
            return "documentation"
        return "code"

    # 1. Documents with strict multi-tenant isolation metadata
    documents = [
        {
            "page_content": redact_sensitive_content(f.get("content", "")),
            "metadata": {
                "source": f.get("path", ""),
                "path": f.get("path", ""),
                "filePath": f.get("path", ""),
                "filename": os.path.basename(f.get("path", "")),
                "language": get_language(f.get("path", "")),
                "repo_id": repo_id,
                "repoId": repo_id,
                "userId": user_id,
                "user_id": user_id,
                "branch": branch,
                "commitSHA": commit_hash,
                "commit_hash": commit_hash,
                "type": get_doc_type(f.get("path", ""))
            }
        }
        for f in files
        if not is_sensitive_file(f.get("path", ""))
    ]

    # 2. Text Chunks: optimal 1000-char blocks for complete function and class visibility
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000,
        chunk_overlap=100
    )

    chunks = splitter.create_documents(
        [d["page_content"] for d in documents],
        metadatas=[d["metadata"] for d in documents]
    )

    for i, chunk in enumerate(chunks):
        chunk.metadata["chunkId"] = i + 1
        path = chunk.metadata.get("path", "")
        lang = chunk.metadata.get("language", "")
        # Contextual header: prepends file path & language so BM25 and dense embeddings match code files directly
        header = f"// File: {path} | Language: {lang}\n"
        if not chunk.page_content.startswith("// File:"):
            chunk.page_content = header + chunk.page_content

    # Check for cancellation before visual processing
    if is_ingestion_cancelled(repo_id, user_id):
        print(f"[INGEST] Cancellation signal received before visual processing for {repo_id}. Aborting.")
        delete_repository_vectors(repo_id, user_id)
        yield {"type": "error", "error": "Ingestion cancelled."}
        return

    # 3. Visual Assets Processing with Gemini Vision
    visual_docs = []
    if visual_files:
        yield {"type": "status", "message": f"Analyzing {len(visual_files)} visual assets with Gemini Vision..."}
        current_chunk_id = len(chunks) + 1
        for idx, v_file in enumerate(visual_files):
            if is_ingestion_cancelled(repo_id, user_id):
                print(f"[INGEST] Cancellation received during visual processing. Aborting.")
                delete_repository_vectors(repo_id, user_id)
                yield {"type": "error", "error": "Ingestion cancelled."}
                return

            try:
                vis_result = analyze_visual_asset(v_file, repo_id=repo_id)
                if vis_result:
                    vis_result["metadata"]["chunkId"] = current_chunk_id
                    vis_result["metadata"]["commitSHA"] = commit_hash
                    vis_result["metadata"]["commit_hash"] = commit_hash
                    vis_result["metadata"]["userId"] = user_id
                    vis_result["metadata"]["user_id"] = user_id
                    vis_result["metadata"]["repoId"] = repo_id
                    vis_result["metadata"]["repo_id"] = repo_id
                    vis_result["metadata"]["branch"] = branch
                    vis_result["metadata"]["filePath"] = v_file.get("path", "")
                    vis_result["metadata"]["filename"] = os.path.basename(v_file.get("path", ""))
                    current_chunk_id += 1
                    doc = Document(
                        page_content=vis_result["page_content"],
                        metadata=vis_result["metadata"]
                    )
                    visual_docs.append(doc)
            except Exception as e:
                print(f"[ERROR] Failed to process visual asset {v_file.get('path')}: {e}")

    # Combine all chunks (code + visual assets)
    all_chunks = list(chunks) + visual_docs

    if not all_chunks:
        print(f"[INGEST] No indexable chunks found for {repo_id}")
        yield {
            "type": "complete",
            "message": "No indexable content found in repository.",
            "chunks": 0,
            "codeChunks": 0,
            "visualAssets": 0,
            "percent": 100
        }
        return

    # Check cancellation before BM25 creation
    if is_ingestion_cancelled(repo_id, user_id):
        print(f"[INGEST] Cancellation received before BM25 for {repo_id}. Aborting.")
        delete_repository_vectors(repo_id, user_id)
        yield {"type": "error", "error": "Ingestion cancelled."}
        return

    yield {
        "type": "status", 
        "message": f"Prepared {len(all_chunks)} chunks ({len(chunks)} code, {len(visual_docs)} visual) for {repo_id}"
    }
    print(f"[INGEST] Created {len(all_chunks)} total chunks ({len(chunks)} code, {len(visual_docs)} visual) for {repo_id}")

    # 4. BM25 — user and repo isolated index
    user_sanitized = sanitize_user_id(user_id)
    repo_sanitized = sanitize_repo_id(repo_id)
    bm25_path = os.path.join(BM25_DIR, f"bm25-{user_sanitized}__{repo_sanitized}.pkl")
    save_bm25_index(
        create_bm25_index(all_chunks),
        bm25_path
    )
    print(f"[INGEST] Saved isolated BM25 index to {bm25_path}")

    # Check cancellation before Qdrant operations
    if is_ingestion_cancelled(repo_id, user_id):
        print(f"[INGEST] Cancellation received before Qdrant setup for {repo_id}. Aborting.")
        delete_repository_vectors(repo_id, user_id)
        yield {"type": "error", "error": "Ingestion cancelled."}
        return

    # 5. Qdrant — collection setup with payload indexes
    qdrant = QdrantClient(
        url=os.getenv("QDRANT_URL"),
        api_key=os.getenv("QDRANT_API_KEY"),
        timeout=60.0
    )

    for retry_attempt in range(5):
        try:
            existing_collections = [c.name for c in qdrant.get_collections().collections]

            if COLLECTION in existing_collections:
                # Auto-detect vector size mismatch (e.g. old 3072-dim Gemini vs new 384-dim FastEmbed)
                info = qdrant.get_collection(COLLECTION)
                current_size = info.config.params.vectors.size
                if current_size != VECTOR_SIZE:
                    print(f"[INGEST] Vector size mismatch: collection has {current_size}-dim, need {VECTOR_SIZE}-dim. Recreating collection...")
                    qdrant.delete_collection(COLLECTION)
                    existing_collections = []  # fall through to create below

            if COLLECTION not in existing_collections:
                print(f"[INGEST] Creating new Qdrant collection: {COLLECTION} (size={VECTOR_SIZE})")
                qdrant.create_collection(
                    collection_name=COLLECTION,
                    vectors_config=VectorParams(
                        size=VECTOR_SIZE,
                        distance=Distance.COSINE
                    )
                )
            break
        except Exception as e:
            if retry_attempt == 4:
                raise
            print(f"Qdrant collection setup error ({str(e)}). Retrying {retry_attempt + 1}/5...")
            time.sleep(5)

    # Payload indexes for multi-tenant isolation
    for field in ["userId", "user_id", "repoId", "repo_id", "filePath", "path", "source", "branch", "commitSHA", "commit_hash", "language", "type"]:
        try:
            qdrant.create_payload_index(
                COLLECTION,
                field_name=f"metadata.{field}",
                field_schema="keyword"
            )
        except Exception:
            pass

    # Delete existing points scoped strictly to this (userId, repoId)
    try:
        delete_conditions = [
            FieldCondition(
                key="metadata.repo_id",
                match=MatchValue(value=repo_id)
            )
        ]
        if user_id:
            delete_conditions.append(
                FieldCondition(
                    key="metadata.userId",
                    match=MatchValue(value=user_id)
                )
            )
        print(f"[INGEST] Deleting existing points for repo_id={repo_id}, userId={user_id}")
        qdrant.delete(
            collection_name=COLLECTION,
            points_selector=Filter(must=delete_conditions)
        )
        print(f"[INGEST] Deleted old points for repo_id={repo_id}, userId={user_id}")
    except Exception as e:
        print(f"[INGEST] No existing points to delete (or delete failed: {e})")

    # 6. High-speed batch embedding and Qdrant batch upsert with immediate cancellation checks
    total_chunks = len(all_chunks)
    print(f"[INGEST] Indexing {total_chunks} chunks in batches of {BATCH_SIZE} using FastEmbed ({FASTEMBED_MODEL})...")

    for i in range(0, total_chunks, BATCH_SIZE):
        # CRITICAL: Check if repository was purged or cancelled before starting next batch
        if is_ingestion_cancelled(repo_id, user_id):
            print(f"[INGEST] Ingestion for {repo_id} (user: {user_id}) was CANCELLED/PURGED at batch {i//BATCH_SIZE + 1} ({i}/{total_chunks} chunks). Aborting immediately!")
            # Purge any partial points and BM25 index that were already created
            delete_repository_vectors(repo_id, user_id)
            clear_ingestion_cancellation(repo_id, user_id)
            yield {
                "type": "error",
                "error": f"Ingestion for repository '{repo_id}' was cancelled and purged."
            }
            return

        batch = all_chunks[i:i + BATCH_SIZE]
        batch_texts = [c.page_content for c in batch]
        
        vectors = embed_batch(batch_texts)

        if len(vectors) != len(batch):
            print(f"[INGEST WARN] Embeddings mismatch ({len(vectors)} vs {len(batch)}). Running direct concurrent fallback.")
            with ThreadPoolExecutor(max_workers=min(10, len(batch_texts))) as pool:
                vectors = list(pool.map(lambda t: embed_single(t), batch_texts))

        if len(vectors) != len(batch):
            raise ValueError(f"Embedding count ({len(vectors)}) does not match chunk count ({len(batch)}).")

        points = [
            PointStruct(
                id=str(uuid.uuid4()),
                vector=vector,
                payload={
                    "page_content": chunk.page_content,
                    "metadata": chunk.metadata
                }
            )
            for chunk, vector in zip(batch, vectors)
        ]

        # Double check cancellation before writing to Qdrant
        if is_ingestion_cancelled(repo_id, user_id):
            print(f"[INGEST] Ingestion for {repo_id} cancelled right before Qdrant upsert. Cleaning up and exiting.")
            delete_repository_vectors(repo_id, user_id)
            clear_ingestion_cancellation(repo_id, user_id)
            yield {
                "type": "error",
                "error": f"Ingestion for repository '{repo_id}' was cancelled and purged."
            }
            return

        for retry_attempt in range(5):
            try:
                qdrant.upsert(
                    collection_name=COLLECTION,
                    points=points,
                    wait=True
                )
                break
            except Exception as e:
                if retry_attempt == 4:
                    raise
                print(f"Qdrant network error ({str(e)}). Retrying {retry_attempt + 1}/5...")
                time.sleep(3)

        processed = min(i + len(batch), total_chunks)
        percent = min(100, int((processed / total_chunks) * 100))
        
        yield {
            "type": "progress",
            "totalChunks": total_chunks,
            "processedChunks": processed,
            "percent": percent
        }

        # Small 0.3s pacing to maintain steady RPM without triggering rate limits
        if i + BATCH_SIZE < total_chunks:
            time.sleep(0.3)

    print(f"[INGEST] === Ingestion complete for {repo_id} (user: {user_id}): {total_chunks} chunks indexed ===\n")

    yield {
        "type": "complete",
        "message": "Ingestion completed successfully.",
        "chunks": total_chunks,
        "codeChunks": len(chunks),
        "visualAssets": len(visual_docs),
        "percent": 100
    }


def delete_repository_vectors(repo_id: str, user_id: str = "default_user") -> bool:
    """Delete all Qdrant vectors and BM25 index for a specific user and repository, and abort any active run."""
    print(f"[CLEANUP] Deleting Qdrant vectors and BM25 for repo={repo_id}, user={user_id}")
    
    # 1. Immediately signal any running ingestion threads for this repo to stop
    cancel_ingestion(repo_id, user_id)

    # 2. Invalidate retrieval cache so stale results cannot be served after re-index/delete
    try:
        from redis_cache import invalidate_retrieval_cache
        invalidate_retrieval_cache(repo_id, user_id)
    except Exception as e:
        print(f"[CLEANUP WARN] Retrieval cache invalidation failed (non-fatal): {e}")

    # 2. Delete points from Qdrant
    try:
        qdrant = QdrantClient(
            url=os.getenv("QDRANT_URL"),
            api_key=os.getenv("QDRANT_API_KEY"),
            timeout=60.0
        )
        delete_conditions = [
            FieldCondition(
                key="metadata.repo_id",
                match=MatchValue(value=repo_id)
            )
        ]
        if user_id and user_id not in ("all", "*"):
            delete_conditions.append(
                FieldCondition(
                    key="metadata.userId",
                    match=MatchValue(value=user_id)
                )
            )
        qdrant.delete(
            collection_name=COLLECTION,
            points_selector=Filter(must=delete_conditions)
        )
        print(f"[CLEANUP] Deleted Qdrant points for {repo_id} ({user_id})")
    except Exception as e:
        print(f"[CLEANUP WARN] Failed deleting Qdrant vectors: {e}")

    # 3. Remove BM25 file
    try:
        bm25_file = get_bm25_path(repo_id, user_id)
        if os.path.exists(bm25_file):
            os.remove(bm25_file)
            print(f"[CLEANUP] Removed BM25 index file: {bm25_file}")
    except Exception as e:
        print(f"[CLEANUP WARN] Failed removing BM25 index: {e}")

    return True
