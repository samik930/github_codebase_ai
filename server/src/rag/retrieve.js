import "dotenv/config";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import {
    loadBM25Index,
    searchBM25
} from "./bm25.js";
import { callGeminiWithRetry } from "../utils/geminiRetry.js";
import { rewriteQuery } from "./queryRewriter.js"

const COLLECTION_NAME = "codebase_documents";

const BM25_INDEX_PATH = path.join(
    process.cwd(),
    "data",
    "bm25-index.json"
);

const ai = new GoogleGenAI({
    apiKey: process.env.GOOGLE_API_KEY
});


/*
 * =========================================================
 * 1. EXTRACT METADATA FROM USER QUERY
 * =========================================================
 *
 * We let Gemini understand whether the user's query contains
 * any information related to the metadata stored in Qdrant.
 *
 * Current metadata:
 *
 * {
 *     source: file.path,
 *     path: file.path,
 *     language: getLanguage(file.path)
 * }
 *
 * Example:
 *
 * "Show me the authentication code written in Python"
 *
 * =>
 *
 * {
 *     language: "python",
 *     path: null,
 *     source: null
 * }
 *
 *
 * "Show me authController.js"
 *
 * =>
 *
 * {
 *     language: null,
 *     path: "authController.js",
 *     source: null
 * }
 *
 *
 * "How does authentication work?"
 *
 * =>
 *
 * {
 *     language: null,
 *     path: null,
 *     source: null
 * }
 */

async function extractMetadata(question) {

    // Fast heuristic pre-check to reduce unnecessary Gemini API calls on general questions
    const METADATA_KEYWORDS = [
        ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".cpp", ".c", ".cs", ".go", ".rs", ".php",
        ".json", ".yml", ".yaml", ".md", ".html", ".css", ".env", ".sql", ".docker",
        "javascript", "js", "typescript", "ts", "python", "py", "java", "cpp", "c++",
        "csharp", "c#", "golang", "go", "rust", "php", "path", "file", "controller",
        "route", "service", "model", "config", "src/", "server/", "client/", "/"
    ];
    const lowerQ = question.toLowerCase();
    const hasMetadataKeyword = METADATA_KEYWORDS.some(kw => lowerQ.includes(kw));

    if (!hasMetadataKeyword) {
        console.log("[DEBUG] Query contains no file/language/path metadata indicators. Skipping Gemini call for metadata extraction.");
        return {
            language: null,
            path: null,
            source: null
        };
    }

    const prompt = `
You are a metadata extraction system for a codebase RAG system.

The indexed documents contain these metadata fields:

- language: programming language of the file
- path: file path
- source: source file path

Analyze the user's query and extract ONLY metadata constraints
that are explicitly stated or strongly implied by the query.

Rules:

1. Do NOT answer the user's question.
2. Do NOT invent metadata.
3. If the user does not specify a metadata constraint, return null.
4. For language, normalize common names, for example:
   - JS / JavaScript -> javascript
   - TS / TypeScript -> typescript
   - Py / Python -> python
   - C++ / cpp -> cpp
   - C# / csharp -> csharp
   - Golang -> go
5. If a filename or path is explicitly mentioned, return it.
6. Keep path/source values exactly as they appear in the query as much as possible.
7. Metadata extraction should be conservative.
User query:
"${question}"
`;

    try {

        const response = await callGeminiWithRetry(
            "Metadata Extraction",
            () => ai.models.generateContent({
                model: "gemini-3.6-flash",
                contents: prompt,

                config: {
                    responseMimeType: "application/json",

                    responseSchema: {
                        type: "object",

                        properties: {
                            language: {
                                type: ["string", "null"]
                            },

                            path: {
                                type: ["string", "null"]
                            },

                            source: {
                                type: ["string", "null"]
                            }
                        },

                        required: [
                            "language",
                            "path",
                            "source"
                        ]
                    }
                }
            })
        );


        const metadata = JSON.parse(response.text);

        console.log(
            "[DEBUG] Extracted metadata:",
            metadata
        );

        return metadata;

    } catch (error) {

        console.error(
            "[ERROR] Metadata extraction failed:",
            error.message
        );

        /*
         * If metadata extraction fails, don't break retrieval.
         *
         * Fall back to normal vector search.
         */

        return {
            language: null,
            path: null,
            source: null
        };
    }
}


/*
 * =========================================================
 * 2. BUILD QDRANT FILTER
 * =========================================================
 *
 * Convert extracted metadata into a Qdrant filter.
 *
 * Example:
 *
 * {
 *     language: "python"
 * }
 *
 * =>
 *
 * {
 *     must: [
 *         {
 *             key: "metadata.language",
 *             match: {
 *                 value: "python"
 *             }
 *         }
 *     ]
 * }
 */

function buildQdrantFilter(metadata) {

    const conditions = [];

    /*
     * Language
     */

    if (metadata.language) {

        conditions.push({
            key: "metadata.language",

            match: {
                value: metadata.language
            }
        });
    }


    /*
     * Path
     */

    if (metadata.path) {

        conditions.push({
            key: "metadata.path",

            match: {
                value: metadata.path
            }
        });
    }


    /*
     * Source
     */

    if (metadata.source) {

        conditions.push({
            key: "metadata.source",

            match: {
                value: metadata.source
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
     * Multiple conditions use AND.
     */

    return {
        must: conditions
    };
}


/*
 * =========================================================
 * 3. MAIN RETRIEVAL FUNCTION
 * =========================================================
 */

function reciprocalRankFusion(
    denseResults,
    sparseResults
) {

    const scores = new Map();
    const documents = new Map();

    const RRF_K = 60;

    // -----------------------------
    // Dense results
    // -----------------------------

    denseResults.forEach(
        ([doc, score], index) => {

            const id =
                doc.metadata?.chunkId;

            if (!id) {
                return;
            }

            const rank = index + 1;

            const rrfScore =
                1 / (RRF_K + rank);

            scores.set(
                id,
                (scores.get(id) || 0) +
                rrfScore
            );

            documents.set(
                id,
                doc
            );
        }
    );


    // -----------------------------
    // Sparse results
    // -----------------------------

    sparseResults.forEach(
        ({ document }, index) => {

            const id =
                document.metadata?.chunkId;

            if (!id) {
                return;
            }

            const rank = index + 1;

            const rrfScore =
                1 / (RRF_K + rank);

            scores.set(
                id,
                (scores.get(id) || 0) +
                rrfScore
            );

            documents.set(
                id,
                document
            );
        }
    );


    // -----------------------------
    // Sort by RRF score
    // -----------------------------

    return [...scores.entries()]
        .sort(
            (a, b) => b[1] - a[1]
        )
        .map(
            ([id]) => documents.get(id)
        );
}

export async function retrieveDocuments(question) {

    console.log(
        `\n[DEBUG] --- Starting Retrieval for query: "${question}" ---`
    );


    /*
     * ---------------------------------------------------------
     * Step 1: Extract metadata from query
     * ---------------------------------------------------------
     */
    const rewrittenQuery = await rewriteQuery(question);
    const metadata = await extractMetadata(question);


    /*
     * ---------------------------------------------------------
     * Step 2: Build Qdrant filter
     * ---------------------------------------------------------
     */

    const qdrantFilter = buildQdrantFilter(metadata);

    console.log(
        "[DEBUG] Qdrant filter:",
        qdrantFilter ?? "NONE"
    );

    const bm25Index =
        loadBM25Index(
            BM25_INDEX_PATH
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
     * Step 4: Connect to Qdrant
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
     * Step 5: Vector retrieval + metadata filtering
     * ---------------------------------------------------------
     */

    const denseResults =
        await callGeminiWithRetry(
            "Query Vector Embedding",
            () => vectorStore.similaritySearchWithScore(
                rewrittenQuery,
                10,
                qdrantFilter
            )
        );

    const sparseResults =  searchBM25(
            bm25Index,
            rewrittenQuery,
            metadata,
            10
        );

    console.log(
        `[DEBUG] Dense results length: ${denseResults.length}`
    );

    console.log(
        `[DEBUG] Sparse results length: ${sparseResults.length}`
    );

    const finalDocuments =
        reciprocalRankFusion(
            denseResults,
            sparseResults
        );

    const documents = finalDocuments.slice(0,8)

    console.log(
        `[DEBUG] Final hybrid results: ${documents.length}`
    );


    /*
     * ---------------------------------------------------------
     * Step 6: Process retrieved documents
     * ---------------------------------------------------------
     */

    documents.forEach(
        (doc, index) => {

            console.log(
                `\n[DEBUG] Hybrid Result ${index + 1}:`
            );

            console.log(
                `  Chunk ID: ${
                    doc.metadata?.chunkId
                }`
            );

            console.log(
                `  Source: ${
                    doc.metadata?.source
                }`
            );

            console.log(
                `  Language: ${
                    doc.metadata?.language
                }`
            );

            console.log(
                `  Preview: ${
                    doc.pageContent
                        ?.slice(0, 150)
                }...`
            );
        }
    );


    return documents;
}