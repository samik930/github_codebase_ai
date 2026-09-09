import fs from "fs";
import path from "path";

const BM25_K1 = 1.5;
const BM25_B = 0.75;

function tokenize(text) {
    return text
        .toLowerCase()
        .match(/[a-zA-Z0-9_]+/g) || [];
}

export function createBM25Index(chunks) {

    const documents = [];
    const documentFrequency = {};

    let totalLength = 0;

    for (let i = 0; i < chunks.length; i++) {

        const chunk = chunks[i];

        const tokens = tokenize(chunk.pageContent);

        const termFrequency = {};

        for (const token of tokens) {
            termFrequency[token] =
                (termFrequency[token] || 0) + 1;
        }

        const uniqueTerms = new Set(tokens);

        for (const term of uniqueTerms) {
            documentFrequency[term] =
                (documentFrequency[term] || 0) + 1;
        }

        documents.push({
            id: i + 1,
            pageContent: chunk.pageContent,
            metadata: {
                ...chunk.metadata,
                chunkId: i + 1
            },
            termFrequency,
            length: tokens.length
        });

        totalLength += tokens.length;
    }

    return {
        documents,
        documentFrequency,
        totalDocuments: documents.length,
        averageDocumentLength:
            documents.length > 0
                ? totalLength / documents.length
                : 0
    };
}


export function saveBM25Index(index, filePath) {

    const directory = path.dirname(filePath);

    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, {
            recursive: true
        });
    }

    fs.writeFileSync(
        filePath,
        JSON.stringify(index),
        "utf-8"
    );
}


export function loadBM25Index(filePath) {

    if (!fs.existsSync(filePath)) {
        throw new Error(
            `BM25 index not found: ${filePath}`
        );
    }

    return JSON.parse(
        fs.readFileSync(filePath, "utf-8")
    );
}


function matchesMetadata(document, metadata) {

    if (!metadata) {
        return true;
    }

    if (
        metadata.language &&
        document.metadata.language !== metadata.language
    ) {
        return false;
    }

    if (
        metadata.path &&
        document.metadata.path !== metadata.path
    ) {
        return false;
    }

    if (
        metadata.source &&
        document.metadata.source !== metadata.source
    ) {
        return false;
    }

    return true;
}


export function searchBM25(
    index,
    query,
    metadata,
    limit = 10
) {

    const queryTokens = tokenize(query);

    if (queryTokens.length === 0) {
        return [];
    }

    const results = [];

    for (const document of index.documents) {

        // Apply the SAME metadata filtering
        // that we apply to Qdrant.
        if (!matchesMetadata(document, metadata)) {
            continue;
        }

        let score = 0;

        for (const term of queryTokens) {

            const tf =
                document.termFrequency[term] || 0;

            if (tf === 0) {
                continue;
            }

            const df =
                index.documentFrequency[term] || 0;

            const N = index.totalDocuments;

            // BM25 IDF
            const idf =
                Math.log(
                    1 +
                    (N - df + 0.5) /
                    (df + 0.5)
                );

            const numerator =
                tf * (BM25_K1 + 1);

            const denominator =
                tf +
                BM25_K1 *
                (
                    1 -
                    BM25_B +
                    BM25_B *
                    (
                        document.length /
                        index.averageDocumentLength
                    )
                );

            score +=
                idf *
                (numerator / denominator);
        }

        if (score > 0) {

            results.push({
                document,
                score
            });
        }
    }

    results.sort(
        (a, b) => b.score - a.score
    );

    return results.slice(0, limit);
}