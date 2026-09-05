import "dotenv/config";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";

const COLLECTION_NAME = "codebase_documents";

export async function retrieveDocuments(question) {
    console.log(`\n[DEBUG] --- Starting Retrieval for query: "${question}" ---`);

    const embeddings = new GoogleGenerativeAIEmbeddings({
        model: "gemini-embedding-001",
        apiKey: process.env.GOOGLE_API_KEY
    });

    const queryVector = await embeddings.embedQuery(question);
    console.log(`[DEBUG] Query embedding dimension: ${queryVector.length}`);

    const vectorStore = await QdrantVectorStore.fromExistingCollection(
        embeddings,
        {
            url: process.env.QDRANT_URL,
            apiKey: process.env.QDRANT_API_KEY,
            collectionName: COLLECTION_NAME,
            contentPayloadKey: "page_content",
            metadataPayloadKey: "metadata"
        }
    );

    const k = 8;
    const results = await vectorStore.similaritySearchWithScore(question, k);
    console.log(`[DEBUG] Number of Qdrant results retrieved: ${results.length}`);

    if (results.length === 0) {
        console.warn("[WARN] Qdrant returned 0 results! Check if Qdrant collection 'codebase_documents' has points stored.");
    }

    const documents = [];
    results.forEach(([doc, score], index) => {
        console.log(`\n[DEBUG] Result ${index + 1}:`);
        console.log(`  Similarity Score: ${score}`);
        console.log(`  Source Path: ${doc.metadata?.path || doc.metadata?.source || "N/A"}`);
        console.log(`  Page Content Preview: ${doc.pageContent ? doc.pageContent.slice(0, 150) + "..." : "EMPTY/UNDEFINED"}`);
        documents.push(doc);
    });

    return documents;
}