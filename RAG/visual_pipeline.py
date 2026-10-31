import os
import base64
import time
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))

MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml"
}

def get_mime_type(file_path: str) -> str:
    ext = os.path.splitext(file_path)[1].lower()
    return MIME_TYPES.get(ext, "image/png")

def analyze_visual_asset(file_info: dict, repo_id: str = "") -> dict:
    """
    Analyzes a visual asset (diagram, flowchart, schema, screenshot) using Gemini Vision.
    Extracts structured technical descriptions, components, flows, and relationships.
    """
    file_path = file_info.get("path", "")
    base64_content = file_info.get("content", "")
    raw_url = file_info.get("raw_url", "")
    filename = os.path.basename(file_path)

    print(f"[VISION] Analyzing visual asset: {file_path} (repo: {repo_id})")

    if not base64_content:
        print(f"[WARN] No content found for visual asset: {file_path}")
        return None

    mime_type = get_mime_type(file_path)

    try:
        # Decode base64 to binary bytes
        image_bytes = base64.b64decode(base64_content)
    except Exception as e:
        print(f"[ERROR] Failed to base64-decode visual asset {file_path}: {e}")
        return None

    prompt = f"""
You are an expert software engineer and systems architect analyzing a visual asset from repository '{repo_id}'.
File Path: {file_path}
File Name: {filename}

Analyze this image (architecture diagram, system flowchart, sequence diagram, UML class diagram, database ERD schema, UI screenshot, or technical visual).

Provide a thorough, structured, technical markdown summary:

### 1. SUMMARY
Provide a clear, high-level summary of what this visual asset portrays.

### 2. VISUAL ASSET TYPE
Identify whether this is an Architecture Diagram, Flowchart, Sequence Diagram, UML Diagram, Database ERD/Schema, UI Screenshot, or Other.

### 3. IDENTIFIED COMPONENTS & SERVICES
List all distinct entities shown, including microservices, frontend clients, API gateways, databases, message queues (e.g. Kafka/RabbitMQ), caches (e.g. Redis), third-party services, and storage systems.

### 4. DATA FLOWS, RELATIONSHIPS & PROTOCOLS
Detail all connections, directional arrows, communication protocols (HTTP/REST, gRPC, WebSocket, GraphQL, AMQP, SQL), event subscriptions, and step-by-step transaction sequences.

### 5. TECHNICAL LABELS & ANNOTATIONS
List any exact function names, API endpoints, table/column names, environment variables, ports, or code references visible in the diagram.

Be accurate and objective. Do not hallucinate components not visible in the image.
"""

    description_text = ""
    for attempt in range(5):
        try:
            image_part = types.Part.from_bytes(data=image_bytes, mime_type=mime_type)
            response = client.models.generate_content(
                model="gemini-3.6-flash",
                contents=[image_part, prompt],
                config={
                    "temperature": 0.1
                }
            )
            description_text = response.text.strip()
            break
        except Exception as e:
            err_str = str(e)
            if "429" in err_str or "RESOURCE_EXHAUSTED" in err_str:
                print(f"[VISION] Rate limit on {file_path}. Retry {attempt + 1}/5 in 10s...")
                time.sleep(10)
            else:
                print(f"[ERROR] Vision analysis failed for {file_path}: {err_str}")
                break

    if not description_text:
        # Fallback if vision analysis failed
        description_text = f"Visual Asset: {filename}\nPath: {file_path}\n(Vision analysis unavailable for this asset)."

    # Format document content suitable for semantic search and BM25 indexing
    searchable_content = f"""[VISUAL ASSET: {file_path}]
Filename: {filename}
Repository: {repo_id}
Image Reference: {raw_url}

{description_text}
"""

    return {
        "page_content": searchable_content,
        "metadata": {
            "type": "visual_asset",
            "source": file_path,
            "path": file_path,
            "filename": filename,
            "raw_url": raw_url,
            "repo_id": repo_id,
            "language": "diagram"
        }
    }
