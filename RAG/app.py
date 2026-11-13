import os
import re
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
import json
import uvicorn
from fastapi.middleware.cors import CORSMiddleware
from ingest import ingest_documents, get_bm25_path, sanitize_repo_id, delete_repository_vectors, BM25_DIR
from retrieve import retrieve_documents
from generate import generate_answer
from sensitive_guard import detect_sensitive_query_intent

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class QueryRequest(BaseModel):
    question: str
    repo_id: str
    user_id: str = "default_user"

class DeleteRepoRequest(BaseModel):
    repo_id: str
    user_id: str = "default_user"

@app.post("/ingest")
async def ingest_endpoint(request: Request):
    data = await request.json()
    files = data.get("files", [])
    visual_files = data.get("visual_files", [])
    repo_id = data.get("repo_id", "")
    commit_hash = data.get("commit_hash", "")
    user_id = data.get("user_id") or data.get("userId") or "default_user"
    branch = data.get("branch", "main")
    
    if not repo_id:
        return JSONResponse(
            status_code=400,
            content={"type": "error", "error": "repo_id is required for ingestion."}
        )
    
    print(f"[API] Ingest request: repo_id={repo_id}, user_id={user_id}, branch={branch}, commit_hash={commit_hash}, code_files={len(files)}, visual_files={len(visual_files)}")
    
    def generate():
        try:
            for progress_data in ingest_documents(
                files, 
                repo_id=repo_id, 
                commit_hash=commit_hash, 
                visual_files=visual_files,
                user_id=user_id,
                branch=branch
            ):
                yield f"data: {json.dumps(progress_data)}\n\n"
        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            print("[ERROR] Ingestion Error:", tb)
            yield f"data: {json.dumps({'type': 'error', 'error': str(e) + ' | ' + tb})}\n\n"
            
    return StreamingResponse(generate(), media_type="text/event-stream")

@app.post("/query")
async def query_endpoint(request: QueryRequest):
    question = request.question
    repo_id = request.repo_id
    user_id = request.user_id or "default_user"
    
    if not repo_id or not repo_id.strip():
        return JSONResponse(
            status_code=400,
            content={"error": "repo_id is required. Select a repository before querying."}
        )
    
    print(f"\n[API] Query request: repo_id={repo_id}, user_id={user_id}, question=\"{question}\"")
    
    intent_check = detect_sensitive_query_intent(question)
    if intent_check.get("isSensitive"):
        print(f"[SECURITY GUARD] Blocked sensitive request for query: \"{question}\"")
        return {
            "answer": "For security reasons, I cannot disclose sensitive information, API keys, database connection strings, passwords, secrets, or credentials.",
            "sources": []
        }
    
    # Check if repo is indexed for this user
    bm25_path = get_bm25_path(repo_id, user_id=user_id)
    if not os.path.exists(bm25_path):
        print(f"[API] Repository not indexed for user '{user_id}': {repo_id}")
        return JSONResponse(
            status_code=404,
            content={"error": f"Repository '{repo_id}' is not indexed for your account. Please ingest it first."}
        )
    
    # 1. Retrieve (filtered strictly by repo_id and user_id)
    documents = retrieve_documents(question, repo_id=repo_id, user_id=user_id)
    
    if not documents:
        return {
            "answer": f"No relevant code chunks were found for repository '{repo_id}'. The repository may not contain information related to your question.",
            "sources": []
        }
    
    # 2. Generate (with repo boundary)
    result = generate_answer(question, documents, repo_id=repo_id)
    return result

@app.post("/delete-repo")
async def delete_repo_endpoint(req: DeleteRepoRequest):
    """Delete all indexed Qdrant points and BM25 index for a specific user and repository."""
    repo_id = req.repo_id
    user_id = req.user_id or "default_user"
    if not repo_id:
        return JSONResponse(status_code=400, content={"error": "repo_id is required"})
        
    print(f"[API] Deleting index vectors for repo_id={repo_id}, user_id={user_id}")
    success = delete_repository_vectors(repo_id, user_id=user_id)
    return {"success": success, "message": f"Vectors for {repo_id} deleted successfully."}

@app.get("/repositories")
async def list_repositories():
    """List all indexed repositories by scanning BM25 index files."""
    repos = []
    
    if not os.path.exists(BM25_DIR):
        return {"repositories": []}
    
    for filename in os.listdir(BM25_DIR):
        if filename.startswith("bm25-") and filename.endswith(".pkl"):
            sanitized = filename[5:-4]
            repo_id = sanitized.replace("__", "/", 1)
            repos.append({
                "repo_id": repo_id,
                "bm25_index": filename
            })
    
    return {"repositories": repos}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
