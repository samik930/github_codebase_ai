import os
import sys
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

from ingest import sanitize_repo_id, sanitize_user_id, get_bm25_path
from retrieve import build_qdrant_filter, reciprocal_rank_fusion

def test_isolation():
    print("==================================================================")
    print("           RAG & QDRANT MULTI-TENANT ISOLATION TESTS              ")
    print("==================================================================\n")

    # 1. Test BM25 Path Isolation
    print("--- [TEST 1] BM25 Index Path Isolation ---")
    alice_path = get_bm25_path("shared/repo", user_id="user_alice_101")
    bob_path = get_bm25_path("shared/repo", user_id="user_bob_202")

    print(f"Alice's BM25 index path: {alice_path}")
    print(f"Bob's BM25 index path:   {bob_path}")

    assert alice_path != bob_path, "FAIL: BM25 index paths for different users must be isolated!"
    assert "user_alice_101" in alice_path, "FAIL: Alice's identifier missing from index path!"
    assert "user_bob_202" in bob_path, "FAIL: Bob's identifier missing from index path!"
    print(" PASS: BM25 sparse index is strictly isolated per user.\n")

    # 2. Test Qdrant Payload Filter Isolation
    print("--- [TEST 2] Qdrant Dense Retrieval Payload Filter ---")
    filter_alice = build_qdrant_filter({"language": "python"}, repo_id="alice/repo", user_id="user_alice_101")
    
    conditions = filter_alice.must
    keys_and_values = {}
    for c in conditions:
        keys_and_values[c.key] = c.match.value

    print(f"Generated Qdrant Filter conditions: {keys_and_values}")

    assert keys_and_values.get("metadata.repo_id") == "alice/repo", "FAIL: repo_id condition missing!"
    assert keys_and_values.get("metadata.userId") == "user_alice_101", "FAIL: userId condition missing!"
    assert keys_and_values.get("metadata.language") == "python", "FAIL: language condition missing!"
    print(" PASS: Qdrant vector payload filter enforces both repo_id AND userId isolation.\n")

    # 3. Test RRF (Reciprocal Rank Fusion)
    print("--- [TEST 3] Reciprocal Rank Fusion on Authorized Results ---")
    mock_dense = [
        type("Point", (), {
            "payload": {
                "page_content": "def auth(): pass",
                "metadata": {"chunkId": 1, "repo_id": "alice/repo", "userId": "user_alice_101"}
            }
        })()
    ]
    mock_sparse = [
        {
            "document": {
                "pageContent": "def auth(): pass",
                "metadata": {"chunkId": 1, "repo_id": "alice/repo", "userId": "user_alice_101"}
            }
        }
    ]

    fused = reciprocal_rank_fusion(mock_dense, mock_sparse)
    assert len(fused) == 1, "FAIL: RRF fusion should return fused document"
    assert fused[0]["metadata"]["userId"] == "user_alice_101", "FAIL: RRF output metadata mismatch!"
    print(f"Fused chunk ID: {fused[0]['metadata']['chunkId']}, User: {fused[0]['metadata']['userId']}")
    print(" PASS: RRF combines authorized results with metadata integrity preserved.\n")

    print("==================================================================")
    print("             ALL RAG ISOLATION TESTS PASSED (100%)                ")
    print("==================================================================")

if __name__ == "__main__":
    test_isolation()

