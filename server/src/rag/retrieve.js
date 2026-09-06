import "dotenv/config";

import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";

const COLLECTION_NAME = "codebase_documents";

/*
 * ---------------------------------------------------------
 * 1. Extract metadata constraints from the user's query
 * ---------------------------------------------------------
 *
 * This function is intentionally separate from Qdrant.
 *
 * Its job:
 *
 * User query
 *      ↓
 * Detect metadata-related information
 *      ↓
 * Return structured metadata constraints
 *
 * Example:
 *
 * "Show me the Python authentication code"
 *
 * becomes:
 *
 * {
 *     language: "python"
 * }
 *
 * "Show me authController.js"
 *
 * becomes:
 *
 * {
 *     path: "authController.js"
 * }
 *
 * If no metadata constraint is present:
 *
 * {}
 *
 * NOTE:
 * This is the first/simple version.
 * Later, this can be replaced by an LLM-based
 * structured metadata extraction step.
 */

function extractMetadataFilters(question) {
    const query = question.toLowerCase();

    const filters = {};


    /*
     * -------------------------
     * Language detection
     * -------------------------
     */

    const languages = {
        javascript: ["javascript", "js"],
        typescript: ["typescript", "ts"],
        python: ["python", "py"],
        java: ["java"],
        cpp: ["c++", "cpp"],
        csharp: ["c#", "csharp"],
        go: ["golang"],
        rust: ["rust"],
        php: ["php"]
    };

    for (const [language, keywords] of Object.entries(languages)) {
        const found = keywords.some((keyword) => {
            if (keyword.length <= 2) {
                return new RegExp(`\\b${keyword}\\b`, "i").test(query);
            }

            return query.includes(keyword);
        });

        if (found) {
            filters.language = language;
            break;
        }
    }


    /*
     * -------------------------
     * File/path detection
     * -------------------------
     *
     * This is deliberately conservative.
     *
     * We only try to detect a path/file constraint
     * when the user explicitly refers to a file/path.
     */

    const pathPatterns = [
        /(?:file|filename|path)\s+(?:is|called|named)?\s*["']?([^"'?]+)["']?/i,
        /(?:inside|in|under)\s+(?:the\s+)?(?:folder|directory)\s+["']?([^"'?]+)["']?/i
    ];

    for (const pattern of pathPatterns) {
        const match = question.match(pattern);

        if (match?.[1]) {
            filters.path = match[1].trim();
            break;
        }
    }


    return filters;
}


/*
 * ---------------------------------------------------------
 * 2. Build Qdrant filter from metadata constraints
 * ---------------------------------------------------------
 *
 * This function does NOT know anything about the user's
 * natural-language query.
 *
 * It only converts structured metadata into Qdrant syntax.
 */

function buildQdrantFilter(metadataFilters) {
    const conditions = [];


    /*
     * Language filter
     */

    if (metadataFilters.language) {
        conditions.push({
            key: "metadata.language",
            match: {
                value: metadataFilters.language
            }
        });
    }


    /*
     * Path filter
     *
     * NOTE:
     * Exact matching is used here for now.
     * We can improve this later for folder/path
     * substring matching.
     */

    if (metadataFilters.path) {
        conditions.push({
            key: "metadata.path",
            match: {
                value: metadataFilters.path
            }
        });
    }


    /*
     * No metadata constraints
     */

    if (conditions.length === 0) {
        return undefined;
    }


    /*
     * Multiple metadata conditions use AND.
     */

    return {
        must: conditions
    };
}


/*
 * ---------------------------------------------------------
 * 3. Main retrieval function
 * ---------------------------------------------------------
 */

export async function retrieveDocuments(question) {

    console.log(
        `\n[DEBUG] --- Starting Retrieval for query: "${question}" ---`
    );


    /*
     * ---------------------------------------------------------
     * Step 1: Extract metadata constraints
     * ---------------------------------------------------------
     */

    const metadataFilters = extractMetadataFilters(question);

    console.log(
        "[DEBUG] Extracted metadata constraints:",
        metadataFilters
    );


    /*
     * ---------------------------------------------------------
     * Step 2: Convert metadata constraints into Qdrant filter
     * ---------------------------------------------------------
     */

    const qdrantFilter = buildQdrantFilter(metadataFilters);

    console.log(
        "[DEBUG] Qdrant filter:",
        qdrantFilter ?? "NONE"
    );


    /*
     * ---------------------------------------------------------
     * Step 3: Create embedding model
     * ---------------------------------------------------------
     */

    const embeddings = new GoogleGenerativeAIEmbeddings({
        model: "gemini-embedding-001",
        apiKey: process.env.GOOGLE_API_KEY
    });


    /*
     * ---------------------------------------------------------
     * Step 4: Connect to existing Qdrant collection
     * ---------------------------------------------------------
     */

    const vectorStore =
        await QdrantVectorStore.fromExistingCollection(
            embeddings,
            {
                url: process.env.QDRANT_URL,
                apiKey: process.env.QDRANT_API_KEY,
                collectionName: COLLECTION_NAME,

                contentPayloadKey: "page_content",
                metadataPayloadKey: "metadata"
            }
        );


    /*
     * ---------------------------------------------------------
     * Step 5: Retrieve documents
     * ---------------------------------------------------------
     *
     * If metadata constraints exist:
     *
     *     vector search + metadata filter
     *
     * Otherwise:
     *
     *     normal vector search
     */

    const k = 8;

    const results =
        await vectorStore.similaritySearchWithScore(
            question,
            k,
            qdrantFilter
        );


    console.log(
        `[DEBUG] Number of Qdrant results retrieved: ${results.length}`
    );


    /*
     * ---------------------------------------------------------
     * Step 6: Handle empty results
     * ---------------------------------------------------------
     */

    if (results.length === 0) {

        console.warn(
            "[WARN] Qdrant returned 0 results!"
        );

        if (qdrantFilter) {
            console.warn(
                "[WARN] Metadata filtering was applied. " +
                "No documents matched the detected constraints."
            );
        }
    }


    /*
     * ---------------------------------------------------------
     * Step 7: Debug retrieved documents
     * ---------------------------------------------------------
     */

    const documents = [];

    results.forEach(([doc, score], index) => {

        console.log(`\n[DEBUG] Result ${index + 1}:`);

        console.log(
            `  Similarity Score: ${score}`
        );

        console.log(
            `  Source Path: ${
                doc.metadata?.path ??
                doc.metadata?.source ??
                "N/A"
            }`
        );

        console.log(
            `  Language: ${
                doc.metadata?.language ??
                "N/A"
            }`
        );

        console.log(
            `  Page Content Preview: ${
                doc.pageContent
                    ? doc.pageContent.slice(0, 150) + "..."
                    : "EMPTY/UNDEFINED"
            }`
        );

        documents.push(doc);
    });


    return documents;
}