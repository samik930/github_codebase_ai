import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

import { ChatMessage } from './src/models/ChatMessage.js';

async function fetchChat() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected to MongoDB.");
    
    // Find messages matching med_appt_booking
    const messages = await ChatMessage.find({
      repoId: { $regex: /med_appt_booking/i }
    }).sort({ timestamp: 1 }).lean();

    console.log(`Found ${messages.length} messages for med_appt_booking.`);
    
    // Group by user question and assistant answer
    const pairs = [];
    let currentQ = null;

    for (const m of messages) {
      if (m.role === 'user') {
        currentQ = m;
      } else if (m.role === 'assistant' && currentQ) {
        pairs.push({
          question: currentQ.content,
          answer: m.content,
          sources: m.sources || [],
          timestamp: m.timestamp,
          userId: m.userId,
          repoId: m.repoId
        });
        currentQ = null;
      }
    }

    console.log(`Paired Q&A turns: ${pairs.length}`);
    for (let i = 0; i < pairs.length; i++) {
      console.log(`\n--- Turn ${i+1} ---`);
      console.log(`Q: ${pairs[i].question}`);
      console.log(`A: ${pairs[i].answer.slice(0, 150)}...`);
      console.log(`Sources: ${pairs[i].sources.map(s => s.path || s.source || s.filename || s).join(', ')}`);
    }

    // Save pairs to JSON for evaluation
    const outputPath = path.join(__dirname, '../RAG/evaluation/med_appt_chat_pairs.json');
    const fs = await import('fs');
    fs.writeFileSync(outputPath, JSON.stringify(pairs, null, 2));
    console.log(`\nSaved ${pairs.length} pairs to ${outputPath}`);
    process.exit(0);

  } catch (err) {
    console.error("Error fetching chats:", err.message);
    process.exit(1);
  }
}

fetchChat();
