/**
 * Helper utility for executing Gemini API operations with robust 429 / RESOURCE_EXHAUSTED retry handling,
 * exponential backoff with full jitter, API RetryInfo parsing, and structured logging.
 */

function parseRetryDelayMs(error) {
    // Check errorDetails array if returned by @google/genai or LangChain
    if (Array.isArray(error?.errorDetails)) {
        const retryInfo = error.errorDetails.find(
            d => d['@type']?.includes('RetryInfo')
        );
        if (retryInfo && retryInfo.retryDelay) {
            // Parses strings like "35s" or "24.5s" or numbers
            const seconds = parseFloat(retryInfo.retryDelay);
            if (!isNaN(seconds) && seconds > 0) {
                // Add 500ms safety buffer to ensure we cross the window boundary
                return Math.ceil(seconds * 1000) + 500;
            }
        }
    }

    // Check Retry-After header if available on response object
    if (error?.response?.headers) {
        const retryAfterHeader =
            error.response.headers.get?.('retry-after') ||
            error.response.headers['retry-after'];
        if (retryAfterHeader) {
            const seconds = parseFloat(retryAfterHeader);
            if (!isNaN(seconds) && seconds > 0) {
                return Math.ceil(seconds * 1000) + 500;
            }
        }
    }

    return null;
}

function is429Error(error) {
    if (!error) return false;

    const status = error.status || error.statusCode || error.response?.status;
    if (status === 429) return true;

    const message = (error.message || "") + " " + (error.stack || "");
    if (
        message.includes("429") ||
        message.includes("RESOURCE_EXHAUSTED") ||
        message.includes("QuotaExhausted") ||
        message.includes("RateLimitQuotaExhausted") ||
        message.includes("Too Many Requests")
    ) {
        return true;
    }

    if (Array.isArray(error.errorDetails)) {
        const hasQuotaInfo = error.errorDetails.some(
            d =>
                d['@type']?.includes('QuotaFailure') ||
                d['@type']?.includes('RetryInfo')
        );
        if (hasQuotaInfo) return true;
    }

    return false;
}

export async function callGeminiWithRetry(operationName, apiFn, options = {}) {
    const {
        maxRetries = 4,
        baseDelayMs = 2000,
        maxDelayMs = 60000,
        jitter = true
    } = options;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        console.log(`[Gemini API] Executing operation: "${operationName}" (Attempt ${attempt}/${maxRetries + 1})`);

        try {
            return await apiFn();
        } catch (error) {
            const isRateLimit = is429Error(error);

            // Non-429 errors should throw immediately without retry
            if (!isRateLimit) {
                console.error(`[Gemini API] Non-429 error during operation "${operationName}":`, error.message || error);
                throw error;
            }

            // Exceeded maximum retries
            if (attempt > maxRetries) {
                console.error(
                    `[Gemini API ERROR] Operation "${operationName}" failed after ${maxRetries} retry attempts due to 429 quota exhaustion.`
                );
                throw new Error(
                    `Gemini API rate limit/quota exhausted for operation "${operationName}". Please wait a moment and try again.`
                );
            }

            // Calculate delay: try API-provided RetryInfo first, fallback to exponential backoff + jitter
            const apiProvidedDelayMs = parseRetryDelayMs(error);
            let calculatedDelayMs = 0;

            if (apiProvidedDelayMs) {
                calculatedDelayMs = apiProvidedDelayMs;
                console.warn(
                    `[Gemini API 429] "${operationName}" hit rate limit. API requested Retry-After delay of ${Math.round(apiProvidedDelayMs / 1000)}s.`
                );
            } else {
                const expBackoff = baseDelayMs * Math.pow(2, attempt - 1);
                const cappedBackoff = Math.min(expBackoff, maxDelayMs);
                const jitterValue = jitter ? Math.floor(Math.random() * 1000) : 0;
                calculatedDelayMs = cappedBackoff + jitterValue;
            }

            console.warn(
                `[Gemini API 429] "${operationName}" hit 429 RESOURCE_EXHAUSTED. Retry attempt ${attempt}/${maxRetries}. Waiting ${calculatedDelayMs}ms...`
            );

            await new Promise(resolve => setTimeout(resolve, calculatedDelayMs));
        }
    }
}
