import os
import re
import time
import uuid
from dotenv import load_dotenv
from langchain_text_splitters import RecursiveCharacterTextSplitter
from google import genai
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, Filter, FieldCondition, MatchValue

from sensitive_guard import is_sensitive_file, redact_sensitive_content
from bm25 import create_bm25_index, save_bm25_index
from visual_pipeline import analyze_visual_asset
from langchain_core.documents import Document

load_dotenv()

client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))

COLLECTION = "codebase_documents"
VECTOR_SIZE = 3072
BATCH_SIZE = 20
BM25_DIR = "data"


def sanitize_repo_id(repo_id: str) -> str:
    """Convert 'owner/repo' into a safe filename component like 'owner__repo'."""
    return re.sub(r'[^\w\-.]', '__', repo_id)


def get_bm25_path(repo_id: str) -> str:
    """Return the BM25 index path for a specific repository."""
    return os.path.join(BM25_DIR, f"bm25-{sanitize_repo_id(repo_id)}.pkl")


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


import concurrent.futures

def embed_single(text):
    for attempt in range(10):
        try:
            response = client.models.embed_content(
                model="gemini-embedding-2",
                contents=text
            )
            return response.embeddings[0].values if isinstance(response.embeddings, list) else response.embeddings
        except Exception as e:
            if "429" not in str(e) and "RESOURCE_EXHAUSTED" not in str(e):
                raise
            if attempt == 9:
                raise Exception("Exceeded maximum retries.")
            print(f"Rate limit. Retry {attempt + 1}/10...")
            time.sleep(20)

def embed_batch(texts):
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        return list(executor.map(embed_single, texts))


def ingest_documents(files, repo_id: str, commit_hash: str = "", visual_files: list = None):
    yield {"type": "status", "message": f"Starting ingestion for repository: {repo_id}"}

    visual_files = visual_files or []
    print(f"\n[INGEST] === Starting ingestion for repo_id: {repo_id}, commit_hash: {commit_hash} ===")
    print(f"[INGEST] Code files: {len(files)}, Visual assets: {len(visual_files)}")

    # 1. Documents
    documents = [
        {
            "page_content": redact_sensitive_content(f.get("content", "")),
            "metadata": {
                "source": f.get("path", ""),
                "path": f.get("path", ""),
                "language": get_language(f.get("path", "")),
                "repo_id": repo_id,
                "commit_hash": commit_hash,
                "type": "code"
            }
        }
        for f in files
        if not is_sensitive_file(f.get("path", ""))
    ]

    # 2. Text Chunks
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=500,
        chunk_overlap=50
    )

    chunks = splitter.create_documents(
        [d["page_content"] for d in documents],
        metadatas=[d["metadata"] for d in documents]
    )

    for i, chunk in enumerate(chunks):
        chunk.metadata["chunkId"] = i + 1

    # 3. Visual Assets Processing with Gemini Vision
    visual_docs = []
    if visual_files:
        yield {"type": "status", "message": f"Analyzing {len(visual_files)} visual assets with Gemini Vision..."}
        current_chunk_id = len(chunks) + 1
        for idx, v_file in enumerate(visual_files):
            try:
                vis_result = analyze_visual_asset(v_file, repo_id=repo_id)
                if vis_result:
                    vis_result["metadata"]["chunkId"] = current_chunk_id
                    vis_result["metadata"]["commit_hash"] = commit_hash
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

    yield {
        "type": "status", 
        "message": f"Prepared {len(all_chunks)} chunks ({len(chunks)} code, {len(visual_docs)} visual) for {repo_id}"
    }
    print(f"[INGEST] Created {len(all_chunks)} total chunks ({len(chunks)} code, {len(visual_docs)} visual) for {repo_id}")

    # 4. BM25 — per-repo index (indexes both code and visual descriptions)
    bm25_path = get_bm25_path(repo_id)
    save_bm25_index(
        create_bm25_index(all_chunks),
        bm25_path
    )
    print(f"[INGEST] Saved BM25 index to {bm25_path}")

    # 5. Qdrant — create collection only if it doesn't exist, then delete only this repo's points
    qdrant = QdrantClient(
        url=os.getenv("QDRANT_URL"),
        api_key=os.getenv("QDRANT_API_KEY"),
        timeout=60.0
    )

    for retry_attempt in range(5):
        try:
            existing_collections = [c.name for c in qdrant.get_collections().collections]

            if COLLECTION not in existing_collections:
                # First-time: create the collection
                print(f"[INGEST] Creating new Qdrant collection: {COLLECTION}")
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

    # Metadata indexes — MUST be created BEFORE any filtered operations
    # (idempotent — safe to call even if they already exist)
    for field in ["language", "path", "source", "repo_id", "commit_hash", "type"]:
        try:
            qdrant.create_payload_index(
                COLLECTION,
                field_name=f"metadata.{field}",
                field_schema="keyword"
            )
        except Exception:
            pass  # Index already exists

    # Delete only this repo's old points (now safe because repo_id index exists)
    try:
        print(f"[INGEST] Deleting existing points for repo_id: {repo_id}")
        qdrant.delete(
            collection_name=COLLECTION,
            points_selector=Filter(
                must=[
                    FieldCondition(
                        key="metadata.repo_id",
                        match=MatchValue(value=repo_id)
                    )
                ]
            )
        )
        print(f"[INGEST] Deleted old points for {repo_id}")
    except Exception as e:
        print(f"[INGEST] No existing points to delete for {repo_id} (or delete failed: {e})")

    # 6. Embeddings + Qdrant upsert with UUID point IDs
    for i in range(0, len(all_chunks), BATCH_SIZE):

        batch = all_chunks[i:i + BATCH_SIZE]
        vectors = embed_batch([c.page_content for c in batch])

        if len(vectors) != len(batch):
            raise ValueError("Embedding count does not match chunk count.")

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
                time.sleep(5)

        processed = min(i + BATCH_SIZE, len(all_chunks))
        
        yield {
            "type": "progress",
            "totalChunks": len(all_chunks),
            "processedChunks": processed,
            "percent": min(100, int((processed / len(all_chunks)) * 100))
        }

        if i + BATCH_SIZE < len(all_chunks):
            time.sleep(5)

    print(f"[INGEST] === Ingestion complete for {repo_id}: {len(all_chunks)} chunks indexed ===\n")

    yield {
        "type": "complete",
        "message": "Ingestion completed successfully.",
        "chunks": len(all_chunks),
        "codeChunks": len(chunks),
        "visualAssets": len(visual_docs),
        "percent": 100
    }