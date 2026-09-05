import { Document } from "@langchain/core/documents";
# Document is a LangChain data structure used to represent a piece of information along with its metadata.
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
# It breaks large text into smaller chunks. It tries to split text intelligently using progressively smaller separators rather than simply cutting at an arbitrary character position.
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
# This is used to convert text into numerical vectors. That's what allows us to perform semantic search.
import { QdrantVectorStore } from "@langchain/qdrant";
# This connects LangChain to Qdrant, our vector database.

