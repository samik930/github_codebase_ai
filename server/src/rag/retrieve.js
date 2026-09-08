import "dotenv/config";

import { GoogleGenAI } from "@google/genai";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";

const COLLECTION_NAME = "codebase_documents";

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

        const response = await ai.models.generateContent({
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
        });


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

export async function retrieveDocuments(question) {

    console.log(
        `\n[DEBUG] --- Starting Retrieval for query: "${question}" ---`
    );


    /*
     * ---------------------------------------------------------
     * Step 1: Extract metadata from query
     * ---------------------------------------------------------
     */

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
     * Step 6: Handle no results
     * ---------------------------------------------------------
     */

    if (results.length === 0) {

        console.warn(
            "[WARN] Qdrant returned 0 results."
        );

        if (qdrantFilter) {

            console.warn(
                "[WARN] Metadata filtering was applied."
            );
        }
    }


    /*
     * ---------------------------------------------------------
     * Step 7: Process retrieved documents
     * ---------------------------------------------------------
     */

    const documents = [];

    results.forEach(([doc, score], index) => {

        console.log(
            `\n[DEBUG] Result ${index + 1}:`
        );

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