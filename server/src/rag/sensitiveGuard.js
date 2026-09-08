/**
 * Security Guardrail Module for RAG Chatbot
 * Protects against fetching or leaking sensitive information (API keys, DB URLs, credentials, tokens, secrets).
 */

// List of filenames or patterns that must be completely excluded from RAG ingestion
const SENSITIVE_FILENAMES = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".env.test",
    ".env.staging",
    "credentials.json",
    "secrets.json",
    "secrets.yml",
    "secrets.yaml",
    "id_rsa",
    "id_rsa.pub",
    "id_ed25519",
    "id_ed25519.pub",
    "server.key",
    "service-account.json",
    "serviceAccountKey.json"
];

const SENSITIVE_EXTENSIONS = [
    ".pem",
    ".key",
    ".p12",
    ".crt",
    ".pfx",
    ".keystore",
    ".jks"
];

// Regex rules for sanitizing secret patterns in code and output
const SECRET_REGEX_PATTERNS = [
    // Database URLs (PostgreSQL, MongoDB, MySQL, Redis, MSSQL, etc.)
    /(?:postgres|postgresql|mongodb|mongodb\+srv|mysql|redis|mssql|oracle|sqlite):\/\/[^\s"'<>\`]+/gi,
    
    // Google API Keys
    /AIzaSy[A-Za-z0-9_-]{30,40}/g,
    
    // OpenAI / Anthropic API Keys
    /sk-[A-Za-z0-9-_]{20,}/g,
    
    // GitHub Personal Access Tokens & OAuth Tokens
    /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{35,}/g,
    
    // AWS Access Key ID
    /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g,
    
    // Slack tokens
    /xox[baprs]-[0-9a-zA-Z]{10,}/g,
    
    // JWT Tokens
    /eyJ[A-Za-z0-9-_=]+\.eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]+/g,
    
    // Bearer Tokens
    /Bearer\s+[A-Za-z0-9-_=.\+]{20,}/gi,
    
    // Private Key blocks
    /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PRIVATE) KEY-----[\s\S]*?-----END (?:RSA|EC|DSA|OPENSSH|PRIVATE) KEY-----/g,
    
    // Key/Password/Secret hardcoded string assignments (e.g. API_KEY = "...", DB_PASSWORD = "...")
    /(?:api_?key|secret|password|passwd|db_?pass|auth_?token|client_?secret|access_?token)\s*[:=]\s*["']([^"']{4,})["']/gi
];

/**
 * Checks whether a given file path is classified as a sensitive file.
 * @param {string} filePath 
 * @returns {boolean}
 */
export function isSensitiveFile(filePath) {
    if (!filePath) return false;

    const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
    const fileName = normalizedPath.split("/").pop();

    // Check exact sensitive filenames or starting patterns (e.g., .env, .env.local)
    if (SENSITIVE_FILENAMES.includes(fileName) || fileName.startsWith(".env")) {
        return true;
    }

    // Check sensitive file extensions
    const extIndex = fileName.lastIndexOf(".");
    if (extIndex !== -1) {
        const ext = fileName.substring(extIndex);
        if (SENSITIVE_EXTENSIONS.includes(ext)) {
            return true;
        }
    }

    // Check path components
    if (
        normalizedPath.includes("/.env") ||
        normalizedPath.includes("/secrets/") ||
        normalizedPath.includes("/credentials/")
    ) {
        return true;
    }

    return false;
}

/**
 * Redacts potential sensitive data/secrets from text content.
 * @param {string} text 
 * @returns {string} Redacted text
 */
export function redactSensitiveContent(text) {
    if (!text || typeof text !== "string") return text;

    let sanitized = text;

    for (const pattern of SECRET_REGEX_PATTERNS) {
        sanitized = sanitized.replace(pattern, (match, p1) => {
            if (p1 && typeof p1 === "string") {
                return match.replace(p1, "[REDACTED_SECRET]");
            }
            return "[REDACTED_SECRET]";
        });
    }

    return sanitized;
}

/**
 * Checks if a user's question is trying to fetch sensitive information.
 * @param {string} question 
 * @returns {{ isSensitive: boolean, reason?: string }}
 */
export function detectSensitiveQueryIntent(question) {
    if (!question || typeof question !== "string") {
        return { isSensitive: false };
    }

    const q = question.toLowerCase();

    // Direct sensitive keywords/phrases
    const sensitiveKeywords = [
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
    ];

    for (const keyword of sensitiveKeywords) {
        if (q.includes(keyword)) {
            return {
                isSensitive: true,
                reason: `Request for sensitive information related to '${keyword}' is prohibited.`
            };
        }
    }

    // Pattern matching for intent verbs + sensitive nouns
    const intentPattern = /(?:give|show|get|find|what is|where is|tell me|display|print|fetch|return|expose|share|leak|provide|extract)\s+.*(?:api\s*key|db\s*url|database\s*url|conn(?:ection)?\s*string|password|passwd|secret|credential|token|private\s*key|\.env)/i;

    if (intentPattern.test(question)) {
        return {
            isSensitive: true,
            reason: "Request asking for credentials, keys, database connection strings, or secrets is prohibited."
        };
    }

    return { isSensitive: false };
}
