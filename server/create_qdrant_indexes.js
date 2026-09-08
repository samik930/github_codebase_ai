import "dotenv/config";
import { QdrantClient } from "@qdrant/js-client-rest";

const COLLECTION_NAME = "codebase_documents";

const qdrant = new QdrantClient({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY
});

console.log("Qdrant URL:", process.env.QDRANT_URL);

console.log("\nBefore:");
console.dir(
    await qdrant.getCollection(COLLECTION_NAME),
    { depth: null }
);

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

console.log("\nAfter:");
console.dir(
    await qdrant.getCollection(COLLECTION_NAME),
    { depth: null }
);