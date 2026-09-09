import "dotenv/config";

import fs from "fs";
import path from "path";

import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { GoogleGenAI } from "@google/genai";
import { QdrantClient } from "@qdrant/js-client-rest";
import { isSensitiveFile, redactSensitiveContent } from "./sensitiveGuard.js";
import { createBM25Index, saveBM25Index } from "./bm25.js";

const COLLECTION_NAME = "codebase_documents";
const VECTOR_SIZE = 3072;
const BATCH_SIZE = 20;

const ai = new GoogleGenAI({
    apiKey: process.env.GOOGLE_API_KEY
});

const BM25_INDEX_PATH =
    path.join(
        process.cwd(),
        "data",
        "bm25-index.json"
    );

const IGNORED_DIRECTORIES = [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage"
];

const IGNORED_FILES = [
    ".env",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml"
];

function getLanguage(file) {
    const extension = path.extname(file).toLowerCase();

    const languages = {
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
    };

    return languages[extension] || "text";
}

// --------------------------------
// Gemini batch embedding
// --------------------------------

async function embedBatch(texts, retries = 10) {

    for (let attempt = 1; attempt <= retries; attempt++) {

        try {
            //Gemini process the texts and generate embeddings
            const response = await ai.models.embedContent({
                model: "gemini-embedding-001",
                contents: texts
            });
            //maps only the embedding values 
            return response.embeddings.map(
                embedding => embedding.values
            );

        } catch (error) {

            const isRateLimit =
                error.status === 429 ||
                error.message?.includes("429") ||
                error.message?.includes("RESOURCE_EXHAUSTED");

            if (isRateLimit) {

                if (attempt === retries) {
                    throw new Error(
                        "Exceeded maximum retries for Gemini rate limit."
                    );
                }

                console.warn(
                    `[WARN] Gemini rate limit reached. ` +
                    `Attempt ${attempt}/${retries}. ` +
                    `Waiting 20 seconds...`
                );
                //current operation will finish after 20 seconds
                await new Promise(
                    resolve => setTimeout(resolve, 20000)
                );

            } else {

                throw error;

            }
        }
    }
}


// --------------------------------
// Main ingestion function
// --------------------------------

export async function ingestDocuments(files, onProgress) {

    console.log("Starting ingestion...");


    // --------------------------------
    // 1. Create LangChain documents
    // --------------------------------

    const safeFiles = files.filter(file => !isSensitiveFile(file.path));

    const documents = safeFiles.map(
        file =>
            new Document({
                pageContent: redactSensitiveContent(file.content),
                metadata: {
                    source: file.path,
                    path: file.path,
                    language: getLanguage(file.path)
                }
            })
    );


    // --------------------------------
    // 2. Split documents into chunks
    // --------------------------------

    const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 500,
        chunkOverlap: 50
    });

    const chunks = await splitter.splitDocuments(documents);

    // Give every chunk a stable ID.
    // This ID will be shared by Qdrant and BM25.
    chunks.forEach((chunk, index) => {
        chunk.metadata.chunkId = index + 1;
    });

    console.log(`Created ${chunks.length} chunks`);

    const bm25Index = createBM25Index(chunks);

    saveBM25Index(
        bm25Index,
        BM25_INDEX_PATH
    );

    console.log(
        `BM25 index created with ${chunks.length} documents`
    );

    const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);

    if (typeof onProgress === "function") {
        onProgress({
            type: "start",
            totalChunks: chunks.length,
            totalBatches,
            processedChunks: 0,
            currentBatch: 0,
            percent: 0
        });
    }


    // --------------------------------
    // 3. Connect to Qdrant
    // --------------------------------

    const qdrant = new QdrantClient({
        url: process.env.QDRANT_URL,
        apiKey: process.env.QDRANT_API_KEY
    });


    // --------------------------------
    // 4. Create Qdrant collection
    // --------------------------------

    const collections = await qdrant.getCollections();

    const collectionExists =
        collections.collections.some(
            collection =>
                collection.name === COLLECTION_NAME
        );

    if (collectionExists) {
        console.log(
            `Deleting old Qdrant collection "${COLLECTION_NAME}" to purge previous repository data...`
        );
        await qdrant.deleteCollection(COLLECTION_NAME);
    }

    console.log(
        `Creating fresh Qdrant collection: ${COLLECTION_NAME}`
    );

    await qdrant.createCollection(
        COLLECTION_NAME,
        {
            vectors: {
                size: VECTOR_SIZE,
                distance: "Cosine" //determining the similarity b/w two vectors
            }
        }
    );

    console.log("Qdrant collection created and reset for new repository");

    console.log("Creating payload indexes for metadata fields...");
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
        field_name: "metadata.language",
        field_schema: "keyword"
    });
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
        field_name: "metadata.path",
        field_schema: "keyword"
    });
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
        field_name: "metadata.source",
        field_schema: "keyword"
    });
    console.log("Payload indexes created successfully");


    // --------------------------------
    // 5. Process batches
    // --------------------------------

    let totalProcessed = 0;

    for (
        let i = 0;
        i < chunks.length;
        i += BATCH_SIZE
    ) {

        const batch = chunks.slice(
            i,
            i + BATCH_SIZE
        );

        const batchNumber =
            Math.floor(i / BATCH_SIZE) + 1;

        console.log(
            `\nProcessing batch ${batchNumber}`
        );

        console.log(
            `Chunks ${i + 1} - ` +
            `${i + batch.length} ` +
            `of ${chunks.length}`
        );


        // --------------------------------
        // 6. Generate embeddings
        // --------------------------------

        const texts = batch.map(
            chunk => chunk.pageContent
        );

        const batchVectors =
            await embedBatch(texts);


        // --------------------------------
        // 7. Validate embeddings
        // --------------------------------

        if (
            batchVectors.length !==
            batch.length
        ) {

            throw new Error(
                `Expected ${batch.length} embeddings ` +
                `but received ${batchVectors.length}`
            );
        }

        for (
            let j = 0;
            j < batchVectors.length;
            j++
        ) {

            const vector =
                batchVectors[j];

            if (
                !vector ||
                vector.length === 0
            ) {

                throw new Error(
                    `Empty embedding returned ` +
                    `for chunk ${i + j}`
                );
            }

            if (
                vector.length !==
                VECTOR_SIZE
            ) {

                throw new Error(
                    `Unexpected vector size ` +
                    `for chunk ${i + j}: ` +
                    `${vector.length}`
                );
            }
        }

        console.log(
            `Generated ${batchVectors.length} embeddings`
        );


        // --------------------------------
        // 8. Create Qdrant points
        // --------------------------------

        const points = batch.map(
            (chunk, index) => ({

                id: i + index + 1,

                vector:
                    batchVectors[index],

                payload: {

                    page_content:
                        chunk.pageContent,

                    metadata:
                        chunk.metadata

                }
            })
        );


        // --------------------------------
        // 9. Upload this batch to Qdrant
        // --------------------------------

        console.log(
            `Uploading ${points.length} points to Qdrant...`
        );

        await qdrant.upsert(
            COLLECTION_NAME,
            {
                wait: true,
                points
            }
        );


        // --------------------------------
        // 10. Batch completed
        // --------------------------------

        totalProcessed += batch.length;

        console.log(
            `Batch ${batchNumber} completed`
        );

        console.log(
            `Total processed: ` +
            `${totalProcessed}/${chunks.length}`
        );

        const percent = Math.min(100, Math.round((totalProcessed / chunks.length) * 100));

        if (typeof onProgress === "function") {
            onProgress({
                type: "progress",
                totalChunks: chunks.length,
                totalBatches,
                processedChunks: totalProcessed,
                currentBatch: batchNumber,
                percent
            });
        }


        // --------------------------------
        // 11. Pause before next batch
        // --------------------------------

        if (
            totalProcessed <
            chunks.length
        ) {

            console.log(
                "Waiting 5 seconds before next batch..."
            );

            await new Promise(
                resolve =>
                    setTimeout(resolve, 5000)
            );
        }
    }


    // --------------------------------
    // 12. Finished
    // --------------------------------

    console.log(
        "\n================================"
    );

    console.log(
        "Ingestion completed successfully"
    );

    console.log(
        `Total chunks processed: ${totalProcessed}`
    );

    console.log(
        "Documents stored in Qdrant successfully"
    );

    console.log(
        "================================"
    );

    return totalProcessed;
}
