import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { callGeminiWithRetry } from "../utils/geminiRetry.js";

const ai = new GoogleGenAI({
    apiKey: process.env.GOOGLE_API_KEY
});

export async function rewriteQuery(question) {

    const prompt = `
You are a query rewriting system for a codebase RAG application.

Rewrite the user's question into a concise search query
that will help retrieve relevant code chunks.

Rules:
1. Preserve the original intent.
2. Extract important technical concepts, filenames,
   functions, classes, libraries, frameworks, and technologies.
3. Add useful related technical terms when strongly implied.
4. Do NOT answer the question.
5. Do NOT invent filenames, functions, or technologies.
6. Keep the rewritten query concise.
7. Return ONLY the rewritten query.

User question:
"${question}"
`;

    try {

        const response = await callGeminiWithRetry(
            "Query Rewriting",
            () => ai.models.generateContent({
                model: "gemini-3.6-flash",
                contents: prompt
            })
        );

        const rewrittenQuery =
            response.text.trim();

        console.log(
            "[DEBUG] Original query:",
            question
        );

        console.log(
            "[DEBUG] Rewritten query:",
            rewrittenQuery
        );

        return rewrittenQuery;

    } catch (error) {

        console.error(
            "[ERROR] Query rewriting failed:",
            error.message
        );

        // Important: if rewriting fails,
        // continue using the original query.
        return question;
    }
}