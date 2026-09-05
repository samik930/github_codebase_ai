import "dotenv/config";

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

export async function generateAnswer(question, documents) {
    console.log(`\n[DEBUG] --- Starting Answer Generation ---`);
    console.log(`[DEBUG] Received ${documents.length} documents for context`);

    const context = documents
        .map(doc => {
            const filePath = doc.metadata?.path || doc.metadata?.source || "File";
            return `--- File: ${filePath} ---\n${doc.pageContent}`;
        })
        .filter(Boolean)
        .join("\n\n");

    const isContextEmpty = !context || context.trim() === "";
    console.log(`[DEBUG] Is context empty? ${isContextEmpty}`);
    if (!isContextEmpty) {
        console.log(`[DEBUG] Context Total Length: ${context.length} characters`);
        console.log(`[DEBUG] Context Snippet:\n${context.slice(0, 300)}...`);
    } else {
        console.warn("[WARN] Context is empty! Gemini will report that information could not be found.");
    }

    const model = new ChatGoogleGenerativeAI({
        model: "gemini-3.6-flash",
        apiKey: process.env.GOOGLE_API_KEY,
        temperature: 0
    });

    const prompt = `
You are an expert AI assistant for analyzing software codebases.

Your task is to answer the user's question by thoroughly analyzing the provided codebase context (source code files, functions, resolvers, configurations, and exports).

Instructions:
1. Carefully analyze the provided code snippets and files to answer the user's question.
2. If the user asks what the project does, explain and infer its functionality, tech stack, endpoints, and purpose directly from the provided code, resolvers, and functions (e.g. user operations, server setup, GraphQL resolvers).
3. Provide a clear, concise, and professional answer based on the code provided.
4. Only state that you could not find the information if the provided context is completely empty or completely unrelated.

Context:

${context}

Question:

${question}
`;

    const response = await model.invoke(prompt);

    // Deduplicate sources by path
    const uniqueSourcesMap = new Map();
    documents.forEach(doc => {
        const pathKey = doc.metadata?.path || doc.metadata?.source;
        if (pathKey && !uniqueSourcesMap.has(pathKey)) {
            uniqueSourcesMap.set(pathKey, {
                source: doc.metadata?.source,
                path: doc.metadata?.path,
                language: doc.metadata?.language
            });
        }
    });

    return {
        answer: response.content,
        sources: Array.from(uniqueSourcesMap.values())
    };
}