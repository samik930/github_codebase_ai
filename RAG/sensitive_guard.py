import re

SENSITIVE_FILENAMES = [
    ".env", ".env.local", ".env.production", ".env.development",
    ".env.test", ".env.staging", "credentials.json", "secrets.json",
    "secrets.yml", "secrets.yaml", "id_rsa", "id_rsa.pub",
    "id_ed25519", "id_ed25519.pub", "server.key", "service-account.json",
    "serviceAccountKey.json"
]

SENSITIVE_EXTENSIONS = [
    ".pem", ".key", ".p12", ".crt", ".pfx", ".keystore", ".jks"
]

SECRET_REGEX_PATTERNS = [
    # Database URLs
    re.compile(r"(?:postgres|postgresql|mongodb|mongodb\+srv|mysql|redis|mssql|oracle|sqlite)://[^\s\"'<>\`]+", re.IGNORECASE),
    # Google API Keys
    re.compile(r"AIzaSy[A-Za-z0-9_-]{30,40}"),
    # OpenAI / Anthropic API Keys
    re.compile(r"sk-[A-Za-z0-9-_]{20,}"),
    # GitHub Tokens
    re.compile(r"(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{35,}"),
    # AWS Access Key ID
    re.compile(r"(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}"),
    # Slack tokens
    re.compile(r"xox[baprs]-[0-9a-zA-Z]{10,}"),
    # JWT Tokens
    re.compile(r"eyJ[A-Za-z0-9-_=]+\.eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]+"),
    # Bearer Tokens
    re.compile(r"Bearer\s+[A-Za-z0-9-_=.\+]{20,}", re.IGNORECASE),
    # Private Key blocks
    re.compile(r"-----BEGIN (?:RSA|EC|DSA|OPENSSH|PRIVATE) KEY-----[\s\S]*?-----END (?:RSA|EC|DSA|OPENSSH|PRIVATE) KEY-----"),
    # Key/Password assignments
    re.compile(r"(?:api_?key|secret|password|passwd|db_?pass|auth_?token|client_?secret|access_?token)\s*[:=]\s*[\"']([^\"']{4,})[\"']", re.IGNORECASE)
]

def is_sensitive_file(file_path: str) -> bool:
    if not file_path:
        return False
        
    normalized_path = file_path.replace("\\", "/").lower()
    file_name = normalized_path.split("/")[-1]
    
    if file_name in SENSITIVE_FILENAMES or file_name.startswith(".env"):
        return True
        
    ext_index = file_name.rfind(".")
    if ext_index != -1:
        ext = file_name[ext_index:]
        if ext in SENSITIVE_EXTENSIONS:
            return True
            
    if "/.env" in normalized_path or "/secrets/" in normalized_path or "/credentials/" in normalized_path:
        return True
        
    return False

def redact_sensitive_content(text: str) -> str:
    if not text or not isinstance(text, str):
        return text
        
    sanitized = text
    for pattern in SECRET_REGEX_PATTERNS:
        def replacer(match):
            if match.groups():
                return match.group(0).replace(match.group(1), "[REDACTED_SECRET]")
            return "[REDACTED_SECRET]"
        sanitized = pattern.sub(replacer, sanitized)
        
    return sanitized

def detect_sensitive_query_intent(question: str) -> dict:
    if not question or not isinstance(question, str):
        return {"isSensitive": False}
        
    q = question.lower()
    
    sensitive_keywords = [
        "api key", "apikey", "api_key", "apikeys",
        "db url", "db_url", "database url", "database_url",
        "connection string", "connection_string", "db connection",
        "db password", "database password", "db_pass", "db_password",
        "secret key", "secret_key", "app_secret", "client_secret",
        "private key", "private_key",
        "access token", "auth token", "jwt token", "bearer token",
        "admin password", "user password",
        "show me .env", "give me .env", "read .env", "what is in .env",
        "github token", "aws key", "google api key", "openai key"
    ]
    
    for keyword in sensitive_keywords:
        if keyword in q:
            return {
                "isSensitive": True,
                "reason": f"Request for sensitive information related to '{keyword}' is prohibited."
            }
            
    intent_pattern = re.compile(
        r"(?:give|show|get|find|what is|where is|tell me|display|print|fetch|return|expose|share|leak|provide|extract)\s+.*(?:api\s*key|db\s*url|database\s*url|conn(?:ection)?\s*string|password|passwd|secret|credential|token|private\s*key|\.env)",
        re.IGNORECASE
    )
    
    if intent_pattern.search(question):
        return {
            "isSensitive": True,
            "reason": "Request asking for credentials, keys, database connection strings, or secrets is prohibited."
        }
        
    return {"isSensitive": False}
