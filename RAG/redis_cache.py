import os
import time
import json
import hashlib
import redis
from dotenv import load_dotenv

load_dotenv()

EXPECTED_EMBEDDING_DIM = 384
DEFAULT_TTL_SECONDS = 7 * 24 * 3600  # 7 days = 604800 seconds

VERSION_PREFIX = "codebase:query-embedding:v1"

# ---------------------------------------------------------------------------
# Retrieval cache constants
# ---------------------------------------------------------------------------
RETRIEVAL_VERSION_PREFIX = "codebase:retrieval:v1"
DEFAULT_RETRIEVAL_TTL_SECONDS = int(os.getenv("RETRIEVAL_CACHE_TTL_SECONDS", "3600"))  # 1 hour default

# Config fingerprint — must change whenever retrieval settings change
# (top-k, BM25 limit, Qdrant limit, RRF K, diversity settings)
_RETRIEVAL_CONFIG = {
    "qdrant_limit": 30,
    "bm25_limit": 30,
    "rrf_k": 60,
    "max_total": 16,
    "max_per_file": 2,
}
_RETRIEVAL_CONFIG_HASH: str = hashlib.sha256(
    json.dumps(_RETRIEVAL_CONFIG, sort_keys=True).encode()
).hexdigest()[:16]

_redis_client: redis.Redis | None = None
_last_connect_failure_time: float = 0.0
CONNECT_RETRY_INTERVAL: float = 5.0  # seconds


def get_embedding_cache_ttl() -> int:
    """Retrieve cache TTL in seconds from environment, defaulting to 7 days."""
    try:
        return int(os.getenv("EMBEDDING_CACHE_TTL_SECONDS", str(DEFAULT_TTL_SECONDS)))
    except (ValueError, TypeError):
        return DEFAULT_TTL_SECONDS


def get_redis_client() -> redis.Redis | None:
    """
    Lazy-initialize and return a thread-safe Redis client.
    Returns None gracefully if Redis is unreachable.
    """
    global _redis_client, _last_connect_failure_time

    if _redis_client is not None:
        return _redis_client

    now = time.time()
    if now - _last_connect_failure_time < CONNECT_RETRY_INTERVAL:
        return None

    redis_url = os.getenv("REDIS_URL")
    if redis_url:
        redis_url = redis_url.strip().strip('"').strip("'")

    redis_host = os.getenv("REDIS_HOST", "localhost")
    redis_port = int(os.getenv("REDIS_PORT", "6379"))
    redis_password = os.getenv("REDIS_PASSWORD") or None
    redis_db = int(os.getenv("REDIS_DB", "0"))

    try:
        if redis_url:
            client = redis.Redis.from_url(
                redis_url,
                decode_responses=True,
                socket_timeout=3.0,
                socket_connect_timeout=3.0,
                retry_on_timeout=False,
            )
        else:
            client = redis.Redis(
                host=redis_host,
                port=redis_port,
                password=redis_password,
                db=redis_db,
                decode_responses=True,
                socket_timeout=3.0,
                socket_connect_timeout=3.0,
                retry_on_timeout=False,
            )
        client.ping()
        _redis_client = client
        print(f"[REDIS] Successfully connected to Redis ({redis_url or f'{redis_host}:{redis_port}'})")
        return _redis_client
    except Exception as e:
        _last_connect_failure_time = now
        print(f"[REDIS ERROR] Could not connect to Redis: {e}. Fallback to FastEmbed.")
        return None


def reset_redis_client():
    """Reset cached Redis client on connection failures so reconnect can be attempted."""
    global _redis_client, _last_connect_failure_time
    _redis_client = None
    _last_connect_failure_time = time.time()


def normalize_query(query: str) -> str:
    """
    Normalize query string by stripping leading and trailing whitespace.
    Query case is strictly preserved because code identifiers are case-sensitive.
    """
    return query.strip() if query and query.strip() else "codebase search query"


def get_query_embedding_cache_key(query: str, model_name: str) -> str:
    """
    Generate deterministic Redis key:
      {VERSION_PREFIX}:{model_name}:{sha256(normalized_query)}
    """
    normalized = normalize_query(query)
    query_hash = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return f"{VERSION_PREFIX}:{model_name}:{query_hash}"


def validate_cached_embedding(data: any, expected_dim: int = EXPECTED_EMBEDDING_DIM) -> list[float] | None:
    """
    Validate that cached embedding is a valid list of numbers with exact expected dimensions.
    Returns list[float] if valid, None otherwise.
    """
    if not isinstance(data, list):
        return None
    if len(data) != expected_dim:
        return None
    try:
        return [float(x) for x in data]
    except (ValueError, TypeError):
        return None


def get_cached_query_embedding(query: str, model_name: str) -> list[float] | None:
    """
    Retrieve cached query embedding from Redis if available and valid.
    Returns None on cache miss, corruption, or Redis failure.
    """
    client = get_redis_client()
    if client is None:
        return None

    key = get_query_embedding_cache_key(query, model_name)
    try:
        cached_str = client.get(key)
        if cached_str is None:
            print(f"[CACHE MISS] Query embedding not found in Redis: {key}")
            return None

        parsed = json.loads(cached_str)
        validated = validate_cached_embedding(parsed, EXPECTED_EMBEDDING_DIM)
        if validated is None:
            print(f"[WARN] Invalid/corrupted cached embedding for key: {key} (dimension != {EXPECTED_EMBEDDING_DIM}). Evicting.")
            try:
                client.delete(key)
            except Exception:
                pass
            return None

        print(f"[CACHE HIT] Query embedding retrieved from Redis: {key}")
        return validated
    except (redis.exceptions.ConnectionError, redis.exceptions.TimeoutError) as e:
        print(f"[REDIS ERROR] Connection lost while reading key '{key}': {e}. Evicting active client.")
        reset_redis_client()
        return None
    except Exception as e:
        print(f"[REDIS ERROR] Failed to retrieve cached query embedding for key '{key}': {e}")
        return None


def set_cached_query_embedding(query: str, model_name: str, embedding: list[float]) -> bool:
    """
    Store query embedding in Redis as compact JSON with configurable TTL.
    Returns True if successfully stored, False otherwise.
    """
    client = get_redis_client()
    if client is None:
        return False

    validated = validate_cached_embedding(embedding, EXPECTED_EMBEDDING_DIM)
    if validated is None:
        print(f"[WARN] Cannot cache invalid embedding: expected dimension {EXPECTED_EMBEDDING_DIM}, got {len(embedding) if isinstance(embedding, list) else type(embedding)}")
        return False

    key = get_query_embedding_cache_key(query, model_name)
    ttl = get_embedding_cache_ttl()

    try:
        compact_json = json.dumps(validated, separators=(',', ':'))
        client.set(key, compact_json, ex=ttl)
        print(f"[CACHE STORE] Query embedding stored in Redis (TTL={ttl}s): {key}")
        return True
    except (redis.exceptions.ConnectionError, redis.exceptions.TimeoutError) as e:
        print(f"[REDIS ERROR] Connection lost while storing key '{key}': {e}. Evicting active client.")
        reset_redis_client()
        return False
    except Exception as e:
        print(f"[REDIS ERROR] Failed to cache query embedding for key '{key}': {e}")
        return False



# ---------------------------------------------------------------------------
# Retrieval Result Caching
# ---------------------------------------------------------------------------

def get_retrieval_cache_ttl() -> int:
    """Retrieve TTL for retrieval cache in seconds (default: 1 hour)."""
    try:
        return int(os.getenv("RETRIEVAL_CACHE_TTL_SECONDS", str(DEFAULT_RETRIEVAL_TTL_SECONDS)))
    except (ValueError, TypeError):
        return DEFAULT_RETRIEVAL_TTL_SECONDS


def _get_bm25_mtime_version(bm25_path: str) -> str:
    """
    Derive a stable version token from the BM25 file modification time.
    Changes on every ingest, providing automatic invalidation without
    needing the commit hash to be plumbed into retrieve_documents().
    Returns a hex string of the mtime, or '0' if the file does not exist.
    """
    try:
        mtime = os.path.getmtime(bm25_path)
        # Round to 1-second granularity to avoid float precision jitter
        return format(int(mtime), 'x')
    except (OSError, ValueError):
        return '0'


def get_retrieval_cache_key(
    query: str,
    repo_id: str,
    user_id: str,
    bm25_path: str,
    metadata: dict | None = None,
) -> str:
    """
    Build deterministic retrieval cache key.

    Format:
      codebase:retrieval:v1:{user_id_hash}:{repo_id_hash}:{bm25_version}:{query_hash}:{config_hash}:{filter_hash}

    - user_id_hash  : prevents cross-user key collisions
    - repo_id_hash  : prevents cross-repo key collisions
    - bm25_version  : BM25 file mtime — changes on every ingest → auto-invalidation
    - query_hash    : SHA-256 of normalized, case-preserved query
    - config_hash   : fingerprint of retrieval settings (top-k, limits, RRF-K, etc.)
    - filter_hash   : fingerprint of Qdrant metadata filters (language, path, source)
                      so the same query with different filters gets its own entry
    """
    # Normalize but preserve case (code identifiers are case-sensitive)
    normalized_query = normalize_query(query)

    # Stable 12-char hashes for readability
    user_hash  = hashlib.sha256(user_id.encode()).hexdigest()[:12]
    repo_hash  = hashlib.sha256(repo_id.encode()).hexdigest()[:12]
    query_hash = hashlib.sha256(normalized_query.encode("utf-8")).hexdigest()[:32]

    # Derive version from BM25 mtime → automatic invalidation on re-index
    bm25_version = _get_bm25_mtime_version(bm25_path)

    # Fingerprint the metadata filter so "same query + different language filter" != same key
    filter_repr = json.dumps(metadata or {}, sort_keys=True, default=str)
    filter_hash = hashlib.sha256(filter_repr.encode()).hexdigest()[:12]

    return (
        f"{RETRIEVAL_VERSION_PREFIX}:"
        f"{user_hash}:{repo_hash}:{bm25_version}:"
        f"{query_hash}:{_RETRIEVAL_CONFIG_HASH}:{filter_hash}"
    )


def _validate_retrieval_results(data: list) -> list | None:
    """
    Validate that cached retrieval results are a non-empty list of dicts,
    each with 'pageContent' (str) and 'metadata' (dict) keys.
    Returns the list if valid, None otherwise.
    """
    if not isinstance(data, list) or len(data) == 0:
        return None
    for item in data:
        if not isinstance(item, dict):
            return None
        if "pageContent" not in item or "metadata" not in item:
            return None
        if not isinstance(item["metadata"], dict):
            return None
    return data


def get_cached_retrieval_results(
    query: str,
    repo_id: str,
    user_id: str,
    bm25_path: str,
    metadata: dict | None = None,
) -> list | None:
    """
    Attempt to retrieve cached retrieval results from Redis.

    Returns:
        list of document dicts on cache hit (validated).
        None on cache miss, corruption, or Redis failure.
    """
    client = get_redis_client()
    if client is None:
        return None

    key = get_retrieval_cache_key(query, repo_id, user_id, bm25_path, metadata)
    try:
        cached_str = client.get(key)
        if cached_str is None:
            print(f"[CACHE] Retrieval cache miss: {key}")
            return None

        parsed = json.loads(cached_str)
        validated = _validate_retrieval_results(parsed)
        if validated is None:
            print(f"[CACHE] Retrieval cache error: invalid/corrupted entry at {key}. Evicting.")
            try:
                client.delete(key)
            except Exception:
                pass
            return None

        print(f"[CACHE] Retrieval cache hit: {len(validated)} docs from {key}")
        return validated

    except (redis.exceptions.ConnectionError, redis.exceptions.TimeoutError) as e:
        print(f"[CACHE] Retrieval cache error: connection lost reading '{key}': {e}. Resetting client.")
        reset_redis_client()
        return None
    except Exception as e:
        print(f"[CACHE] Retrieval cache error: failed reading '{key}': {e}")
        return None


def set_cached_retrieval_results(
    query: str,
    repo_id: str,
    user_id: str,
    bm25_path: str,
    results: list,
    metadata: dict | None = None,
) -> bool:
    """
    Store retrieval results in Redis with configurable TTL.
    Safe for concurrent requests — uses atomic SET with EX.

    Returns True if stored successfully, False on failure.
    """
    client = get_redis_client()
    if client is None:
        return False

    if not results:
        return False  # Never cache empty result sets

    validated = _validate_retrieval_results(results)
    if validated is None:
        print(f"[CACHE] Retrieval cache error: cannot store invalid results for '{query[:60]}'")
        return False

    key = get_retrieval_cache_key(query, repo_id, user_id, bm25_path, metadata)
    ttl = get_retrieval_cache_ttl()

    try:
        payload = json.dumps(validated, separators=(',', ':'), ensure_ascii=False)
        # Guard against excessively large payloads (> 1MB is a warning sign)
        if len(payload) > 1_048_576:
            print(f"[CACHE] Retrieval cache warning: payload is {len(payload)} bytes for key '{key}'. Storing anyway.")
        client.set(key, payload, ex=ttl)
        print(f"[CACHE] Retrieval results stored: {len(validated)} docs, TTL={ttl}s, key={key}")
        return True

    except (redis.exceptions.ConnectionError, redis.exceptions.TimeoutError) as e:
        print(f"[CACHE] Retrieval cache error: connection lost storing '{key}': {e}. Resetting client.")
        reset_redis_client()
        return False
    except Exception as e:
        print(f"[CACHE] Retrieval cache error: failed storing '{key}': {e}")
        return False


def invalidate_retrieval_cache(repo_id: str, user_id: str) -> int:
    """
    Delete all retrieval cache entries for a specific (user_id, repo_id) pair.
    Called on repository re-index or deletion to prevent stale results.

    Uses Redis SCAN + DEL to avoid blocking the server.
    Returns the number of keys deleted, or -1 on failure.
    """
    client = get_redis_client()
    if client is None:
        print(f"[CACHE] Retrieval invalidation skipped (Redis unavailable) for repo={repo_id}, user={user_id}")
        return 0

    user_hash = hashlib.sha256(user_id.encode()).hexdigest()[:12]
    repo_hash = hashlib.sha256(repo_id.encode()).hexdigest()[:12]
    # Pattern matches all versions and queries for this user+repo combination
    pattern = f"{RETRIEVAL_VERSION_PREFIX}:{user_hash}:{repo_hash}:*"

    deleted = 0
    try:
        cursor = 0
        while True:
            cursor, keys = client.scan(cursor=cursor, match=pattern, count=100)
            if keys:
                client.delete(*keys)
                deleted += len(keys)
            if cursor == 0:
                break
        print(f"[CACHE] Retrieval cache invalidated: {deleted} keys deleted for repo={repo_id}, user={user_id}")
        return deleted
    except (redis.exceptions.ConnectionError, redis.exceptions.TimeoutError) as e:
        print(f"[CACHE] Retrieval cache error: invalidation failed for repo={repo_id}: {e}. Resetting client.")
        reset_redis_client()
        return -1
    except Exception as e:
        print(f"[CACHE] Retrieval cache error: invalidation failed for repo={repo_id}: {e}")
        return -1
