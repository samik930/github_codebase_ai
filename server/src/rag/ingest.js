import "dotenv/config";

import fs from "fs";
import path from "path";
import crypto from "crypto";

import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { GoogleGenAI } from "@google/genai";
import { QdrantClient } from "@qdrant/js-client-rest";

// ============================================================
// CONFIGURATION
// ============================================================

const COLLECTION_NAME = "codebase_documents";

const VECTOR_SIZE = 3072;

// Tune this based on your Gemini quota.
// Start with 50 and benchmark 25 / 50 / 100.
const EMBEDDING_BATCH_SIZE = 50;

// Maximum number of retries for transient Gemini errors.
const MAX_RETRIES = 8;

// Initial retry delay.
const INITIAL_BACKOFF_MS = 2000;

// Maximum retry delay.
const MAX_BACKOFF_MS = 60000;

// Local checkpoint file.
// Add this file to .gitignore.
const STATE_FILE = path.resolve(
    ".rag-ingestion-state.json"
);

const ai = new GoogleGenAI({
    apiKey: process.env.GOOGLE_API_KEY
});


// ============================================================
// IGNORED FILES / DIRECTORIES
// ============================================================

const IGNORED_DIRECTORIES = [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    ".cache",
    ".turbo"
];

const IGNORED_FILES = [
    ".env",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    ".DS_Store"
];


// ============================================================
// LANGUAGE DETECTION
// ============================================================

function getLanguage(file) {

    const extension =
        path.extname(file).toLowerCase();

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
        ".php": "php",
        ".rb": "ruby",
        ".swift": "swift",
        ".kt": "kotlin",
        ".sql": "sql",
        ".html": "html",
        ".css": "css",
        ".scss": "scss",
        ".md": "markdown",
        ".json": "json"
    };

    return languages[extension] || "text";
}


// ============================================================
// FILE DISCOVERY
// ============================================================

export function getFilesRecursively(directory) {

    const entries = fs.readdirSync(
        directory,
        {
            withFileTypes: true
        }
    );

    const files = [];

    for (const entry of entries) {

        const fullPath =
            path.join(
                directory,
                entry.name
            );

        if (entry.isDirectory()) {

            if (
                IGNORED_DIRECTORIES.includes(
                    entry.name
                )
            ) {
                continue;
            }

            files.push(
                ...getFilesRecursively(
                    fullPath
                )
            );

        } else {

            if (
                IGNORED_FILES.includes(
                    entry.name
                )
            ) {
                continue;
            }

            files.push(fullPath);
        }
    }

    return files;
}


// ============================================================
// HASHING
// ============================================================

function hashContent(content) {

    return crypto
        .createHash("sha256")
        .update(content)
        .digest("hex");
}


// ============================================================
// DETERMINISTIC UUID
//
// Qdrant accepts UUID point IDs.
// We generate the same UUID for the same
// source + chunk index.
//
// This makes ingestion idempotent.
// ============================================================

function createPointId(source, chunkIndex) {

    const hash = crypto
        .createHash("sha256")
        .update(
            `${source}:${chunkIndex}`
        )
        .digest();

    // Take first 16 bytes.
    const bytes = Buffer.from(
        hash.subarray(0, 16)
    );

    // Set UUID version = 4.
    bytes[6] =
        (bytes[6] & 0x0f) | 0x40;

    // Set UUID variant.
    bytes[8] =
        (bytes[8] & 0x3f) | 0x80;

    const hex =
        bytes.toString("hex");

    return [
        hex.substring(0, 8),
        hex.substring(8, 12),
        hex.substring(12, 16),
        hex.substring(16, 20),
        hex.substring(20, 32)
    ].join("-");
}


// ============================================================
// STATE MANAGEMENT
// ============================================================

function loadState() {

    if (!fs.existsSync(STATE_FILE)) {

        return {
            version: 1,
            files: {},
            inProgress: null
        };
    }

    try {

        const raw =
            fs.readFileSync(
                STATE_FILE,
                "utf8"
            );

        return JSON.parse(raw);

    } catch (error) {

        console.warn(
            "[WARN] Could not read state file."
        );

        console.warn(
            "[WARN] Starting with a fresh state."
        );

        return {
            version: 1,
            files: {},
            inProgress: null
        };
    }
}


function saveState(state) {

    const tempFile =
        `${STATE_FILE}.tmp`;

    fs.writeFileSync(
        tempFile,
        JSON.stringify(
            state,
            null,
            2
        )
    );

    // Atomic replacement.
    fs.renameSync(
        tempFile,
        STATE_FILE
    );
}


// ============================================================
// SLEEP
// ============================================================

function sleep(ms) {

    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}


// ============================================================
// RETRY-AFTER EXTRACTION
// ============================================================

function getRetryAfterMs(error) {

    const retryAfter =
        error?.headers?.["retry-after"] ??
        error?.headers?.get?.(
            "retry-after"
        );

    if (!retryAfter) {
        return null;
    }

    const seconds =
        Number(retryAfter);

    if (
        Number.isFinite(seconds) &&
        seconds > 0
    ) {
        return seconds * 1000;
    }

    return null;
}


// ============================================================
// TRANSIENT ERROR DETECTION
// ============================================================

function isRetryableError(error) {

    const status =
        Number(error?.status);

    if (
        status === 408 ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504
    ) {
        return true;
    }

    const message =
        error?.message || "";

    return (
        message.includes("429") ||
        message.includes("RESOURCE_EXHAUSTED") ||
        message.includes("503") ||
        message.includes("UNAVAILABLE") ||
        message.includes("504") ||
        message.includes("DEADLINE_EXCEEDED")
    );
}


// ============================================================
// GEMINI EMBEDDING WITH EXPONENTIAL BACKOFF
// ============================================================

async function embedBatch(
    texts,
    retries = MAX_RETRIES
) {

    for (
        let attempt = 1;
        attempt <= retries;
        attempt++
    ) {

        try {

            const response =
                await ai.models.embedContent({

                    model:
                        "gemini-embedding-001",

                    contents: texts
                });

            if (
                !response?.embeddings
            ) {

                throw new Error(
                    "Gemini returned no embeddings."
                );
            }

            return response.embeddings.map(
                embedding =>
                    embedding.values
            );

        } catch (error) {

            if (
                !isRetryableError(error)
            ) {

                throw error;
            }

            if (
                attempt === retries
            ) {

                throw new Error(
                    `Gemini embedding failed after ` +
                    `${retries} attempts. ` +
                    `Last error: ${error.message}`
                );
            }

            // Respect server-provided retry delay
            // when available.
            const retryAfter =
                getRetryAfterMs(error);

            let delay;

            if (retryAfter) {

                delay = Math.min(
                    retryAfter,
                    MAX_BACKOFF_MS
                );

            } else {

                const exponential =
                    INITIAL_BACKOFF_MS *
                    Math.pow(
                        2,
                        attempt - 1
                    );

                const capped =
                    Math.min(
                        exponential,
                        MAX_BACKOFF_MS
                    );

                // Add random jitter.
                const jitter =
                    Math.random() * 1000;

                delay =
                    capped + jitter;
            }

            console.warn(
                `[WARN] Gemini request failed. ` +
                `Attempt ${attempt}/${retries}. ` +
                `Retrying in ${Math.round(delay / 1000)}s...`
            );

            console.warn(
                `[WARN] ${error.message}`
            );

            await sleep(delay);
        }
    }

    throw new Error(
        "Unexpected embedding failure."
    );
}


// ============================================================
// QDRANT COLLECTION
// ============================================================

async function ensureCollection(qdrant) {

    const collections =
        await qdrant.getCollections();

    const exists =
        collections.collections.some(
            collection =>
                collection.name ===
                COLLECTION_NAME
        );

    if (!exists) {

        console.log(
            `Creating Qdrant collection: ${COLLECTION_NAME}`
        );

        await qdrant.createCollection(
            COLLECTION_NAME,
            {
                vectors: {
                    size: VECTOR_SIZE,
                    distance: "Cosine"
                }
            }
        );

        console.log(
            "Qdrant collection created."
        );

    } else {

        console.log(
            `Qdrant collection "${COLLECTION_NAME}" already exists.`
        );
    }
}


// ============================================================
// DELETE OLD POINTS FOR A FILE
// ============================================================

async function deletePoints(
    qdrant,
    pointIds
) {

    if (
        !pointIds ||
        pointIds.length === 0
    ) {
        return;
    }

    console.log(
        `Removing ${pointIds.length} old chunks...`
    );

    await qdrant.delete(
        COLLECTION_NAME,
        {
            wait: true,
            points: pointIds
        }
    );
}


// ============================================================
// CREATE CHUNKS FOR ONE FILE
// ============================================================

async function createChunks(
    file
) {

    const document =
        new Document({

            pageContent:
                file.content,

            metadata: {

                source:
                    file.path,

                path:
                    file.path,

                language:
                    getLanguage(
                        file.path
                    )
            }
        });


    const splitter =
        new RecursiveCharacterTextSplitter({

            // Slightly larger than your
            // original 500 character chunks.
            chunkSize: 1000,

            chunkOverlap: 100
        });


    return await splitter.splitDocuments([
        document
    ]);
}


// ============================================================
// PROCESS ONE FILE
// ============================================================

async function processFile({
    file,
    qdrant,
    state
}) {

    const source =
        file.path;

    const fileHash =
        hashContent(
            file.content
        );

    const previous =
        state.files[source];


    // --------------------------------------------------------
    // UNCHANGED FILE
    // --------------------------------------------------------

    if (
        previous &&
        previous.hash === fileHash &&
        previous.status === "completed"
    ) {

        console.log(
            `[SKIP] ${source}`
        );

        return;
    }


    console.log(
        `\n[PROCESS] ${source}`
    );


    // --------------------------------------------------------
    // CREATE CHUNKS
    // --------------------------------------------------------

    const chunks =
        await createChunks(file);


    console.log(
        `Created ${chunks.length} chunks.`
    );


    const chunkIds =
        chunks.map(
            (_, index) =>
                createPointId(
                    source,
                    index
                )
        );


    // --------------------------------------------------------
    // RESUME INFORMATION
    // --------------------------------------------------------

    let progress =
        state.inProgress;


    const canResume =
        progress &&
        progress.source === source &&
        progress.hash === fileHash;


    if (!canResume) {

        progress = {

            source,

            hash:
                fileHash,

            chunkIds,

            completedIds: []
        };

        state.inProgress =
            progress;

        saveState(state);

    } else {

        console.log(
            `[RESUME] Continuing ${source}`
        );
    }


    const completed =
        new Set(
            progress.completedIds
        );


    // --------------------------------------------------------
    // PROCESS EMBEDDING BATCHES
    // --------------------------------------------------------

    for (
        let start = 0;
        start < chunks.length;
        start += EMBEDDING_BATCH_SIZE
    ) {

        const end =
            Math.min(
                start +
                EMBEDDING_BATCH_SIZE,
                chunks.length
            );


        const batch =
            chunks.slice(
                start,
                end
            );


        const batchIds =
            chunkIds.slice(
                start,
                end
            );


        // ----------------------------------------------------
        // SKIP ALREADY COMPLETED BATCH ITEMS
        // ----------------------------------------------------

        const pendingIndexes = [];

        for (
            let i = 0;
            i < batch.length;
            i++
        ) {

            if (
                !completed.has(
                    batchIds[i]
                )
            ) {

                pendingIndexes.push(i);
            }
        }


        if (
            pendingIndexes.length === 0
        ) {

            console.log(
                `[RESUME] Batch ` +
                `${start + 1}-${end} ` +
                `already completed.`
            );

            continue;
        }


        const pendingChunks =
            pendingIndexes.map(
                index =>
                    batch[index]
            );


        console.log(
            `Embedding chunks ` +
            `${start + 1}-${end} ` +
            `of ${chunks.length}...`
        );


        // ----------------------------------------------------
        // EMBEDDING
        // ----------------------------------------------------

        const texts =
            pendingChunks.map(
                chunk =>
                    chunk.pageContent
            );


        const vectors =
            await embedBatch(texts);


        if (
            vectors.length !==
            pendingChunks.length
        ) {

            throw new Error(
                `Expected ` +
                `${pendingChunks.length} embeddings ` +
                `but received ` +
                `${vectors.length}.`
            );
        }


        // ----------------------------------------------------
        // VALIDATE + CREATE QDRANT POINTS
        // ----------------------------------------------------

        const points = [];


        for (
            let i = 0;
            i < vectors.length;
            i++
        ) {

            const vector =
                vectors[i];


            if (
                !vector ||
                vector.length === 0
            ) {

                throw new Error(
                    `Empty embedding returned.`
                );
            }


            if (
                vector.length !==
                VECTOR_SIZE
            ) {

                throw new Error(
                    `Unexpected vector size: ` +
                    `${vector.length}. ` +
                    `Expected ${VECTOR_SIZE}.`
                );
            }


            const originalIndex =
                pendingIndexes[i];


            const chunk =
                batch[originalIndex];


            const pointId =
                batchIds[originalIndex];


            points.push({

                id:
                    pointId,

                vector,

                payload: {

                    page_content:
                        chunk.pageContent,

                    source,

                    path:
                        chunk.metadata.path,

                    language:
                        chunk.metadata.language,

                    chunk_index:
                        start +
                        originalIndex,

                    file_hash:
                        fileHash,

                    metadata:
                        chunk.metadata
                }
            });
        }


        // ----------------------------------------------------
        // QDRANT UPSERT
        // ----------------------------------------------------

        console.log(
            `Uploading ${points.length} points...`
        );


        await qdrant.upsert(
            COLLECTION_NAME,
            {
                wait: true,
                points
            }
        );


        // ----------------------------------------------------
        // CHECKPOINT
        //
        // This is what makes the ingestion resumable.
        // ----------------------------------------------------

        for (
            const point of points
        ) {

            completed.add(
                point.id
            );
        }


        state.inProgress.completedIds =
            Array.from(completed);


        saveState(state);


        console.log(
            `[CHECKPOINT] ` +
            `${completed.size}/${chunks.length} ` +
            `chunks completed.`
        );
    }


    // --------------------------------------------------------
    // VERIFY ALL CHUNKS COMPLETED
    // --------------------------------------------------------

    if (
        completed.size !==
        chunks.length
    ) {

        throw new Error(
            `File processing incomplete for ${source}.`
        );
    }


    // --------------------------------------------------------
    // DELETE OLD CHUNKS
    //
    // Do this AFTER new chunks have been uploaded.
    // This prevents losing the old version if
    // embedding fails halfway through.
    // --------------------------------------------------------

    if (
        previous &&
        previous.chunkIds
    ) {

        const newIds =
            new Set(chunkIds);


        const obsoleteIds =
            previous.chunkIds.filter(
                id =>
                    !newIds.has(id)
            );


        if (
            obsoleteIds.length > 0
        ) {

            await deletePoints(
                qdrant,
                obsoleteIds
            );
        }
    }


    // --------------------------------------------------------
    // FILE COMPLETE
    // --------------------------------------------------------

    state.files[source] = {

        hash:
            fileHash,

        status:
            "completed",

        chunkIds,

        chunkCount:
            chunks.length,

        updatedAt:
            new Date().toISOString()
    };


    state.inProgress = null;


    saveState(state);


    console.log(
        `[DONE] ${source}`
    );
}


// ============================================================
// REMOVE FILES THAT NO LONGER EXIST
// ============================================================

async function removeDeletedFiles({
    files,
    qdrant,
    state
}) {

    const currentSources =
        new Set(
            files.map(
                file =>
                    file.path
            )
        );


    for (
        const source
        of Object.keys(state.files)
    ) {

        if (
            currentSources.has(source)
        ) {
            continue;
        }


        const fileState =
            state.files[source];


        console.log(
            `[DELETE] File no longer exists: ${source}`
        );


        if (
            fileState.chunkIds
        ) {

            await deletePoints(
                qdrant,
                fileState.chunkIds
            );
        }


        delete state.files[source];


        saveState(state);
    }
}


// ============================================================
// MAIN INGESTION FUNCTION
// ============================================================

export async function ingestDocuments(
    files
) {

    console.log(
        "\n================================"
    );

    console.log(
        "Starting RAG ingestion..."
    );

    console.log(
        "================================\n"
    );


    if (
        !files ||
        files.length === 0
    ) {

        console.log(
            "No files to ingest."
        );

        return;
    }


    // --------------------------------------------------------
    // LOAD STATE
    // --------------------------------------------------------

    const state =
        loadState();


    console.log(
        `Loaded ingestion state.`
    );

    console.log(
        `Previously indexed files: ` +
        `${Object.keys(state.files).length}`
    );


    // --------------------------------------------------------
    // QDRANT
    // --------------------------------------------------------

    const qdrant =
        new QdrantClient({

            url:
                process.env.QDRANT_URL,

            apiKey:
                process.env.QDRANT_API_KEY
        });


    await ensureCollection(qdrant);


    // --------------------------------------------------------
    // REMOVE DELETED FILES
    // --------------------------------------------------------

    await removeDeletedFiles({

        files,

        qdrant,

        state
    });


    // --------------------------------------------------------
    // PROCESS FILES
    // --------------------------------------------------------

    let processed = 0;
    let skipped = 0;


    for (
        const file of files
    ) {

        const previous =
            state.files[file.path];


        const currentHash =
            hashContent(
                file.content
            );


        if (
            previous &&
            previous.hash === currentHash &&
            previous.status === "completed"
        ) {

            skipped++;

            console.log(
                `[SKIP] ${file.path}`
            );

            continue;
        }


        await processFile({

            file,

            qdrant,

            state
        });


        processed++;
    }


    // --------------------------------------------------------
    // FINAL SUMMARY
    // --------------------------------------------------------

    console.log(
        "\n================================"
    );

    console.log(
        "RAG ingestion completed"
    );

    console.log(
        "================================"
    );

    console.log(
        `Files processed: ${processed}`
    );

    console.log(
        `Files skipped: ${skipped}`
    );

    console.log(
        `Total indexed files: ` +
        `${Object.keys(state.files).length}`
    );

    console.log(
        "================================\n"
    );
}