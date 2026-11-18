"""
Evaluation Dataset for Codebase Copilot RAG Evaluation.
Contains 25 comprehensive test cases categorized by technical domain,
including positive ground-truth questions and negative (out-of-scope) control questions.
"""

AIRPROOF_EVALUATION_DATASET = [
    # 1. Repository Understanding
    {
        "id": "repo_01",
        "category": "repository_understanding",
        "question": "What is the purpose of the Airproof-x402 repository and what problem does it solve?",
        "expected_files": ["README.md", "src/App.jsx"],
        "reference_answer": "Airproof-x402 is an environmental attestation and sensor telemetry platform designed to monitor air quality, manage attestation policies, and verify environmental data compliance using smart contracts or backend services."
    },
    {
        "id": "repo_02",
        "category": "repository_understanding",
        "question": "What are the core modules and pages provided in the Airproof-x402 frontend?",
        "expected_files": ["src/App.jsx", "src/pages/OverviewPage.jsx", "src/pages/TelemetryPage.jsx", "src/pages/AttestationPage.jsx"],
        "reference_answer": "The core frontend pages include OverviewPage, TelemetryPage, SensorsPage, AttestationPage, PolicyPage, SettlementsPage, AgentPage, AuditPage, and LoginPage."
    },
    {
        "id": "repo_03",
        "category": "repository_understanding",
        "question": "Explain the high-level architecture of Airproof-x402 from frontend to backend.",
        "expected_files": ["README.md", "backend/main.py", "src/App.jsx"],
        "reference_answer": "The application consists of a React/Vite single-page application frontend displaying environmental telemetry and attestations, communicating with a Python FastAPI backend that manages OTP authentication and database storage."
    },

    # 2. Database and Technology Identification
    {
        "id": "db_01",
        "category": "database_and_tech_stack",
        "question": "What database technology and ORM/driver are configured in the backend?",
        "expected_files": ["backend/database.py", "backend/main.py"],
        "reference_answer": "The backend uses Python database connectivity defined in backend/database.py to persist user records, OTP tokens, and application state."
    },
    {
        "id": "db_02",
        "category": "database_and_tech_stack",
        "question": "What frontend libraries, frameworks, and build tools are used in this project?",
        "expected_files": ["package.json", "src/main.jsx", "src/App.jsx"],
        "reference_answer": "The frontend is built using React, Vite as the build tool/bundler, Lucide React for icons, React Router for navigation, and Tailwind/CSS for styling."
    },
    {
        "id": "db_03",
        "category": "database_and_tech_stack",
        "question": "What backend framework is used to serve the API endpoints?",
        "expected_files": ["backend/main.py"],
        "reference_answer": "The backend API is implemented using FastAPI in Python with Uvicorn as the ASGI web server."
    },

    # 3. Authentication and Authorization
    {
        "id": "auth_01",
        "category": "authentication",
        "question": "How does the OTP generation and verification service work in backend/otp_service.py?",
        "expected_files": ["backend/otp_service.py", "backend/main.py"],
        "reference_answer": "backend/otp_service.py implements functions to generate temporary numeric OTP codes, associate them with a recipient identifier, and verify submitted OTPs against stored values with expiry/validity checks."
    },
    {
        "id": "auth_02",
        "category": "authentication",
        "question": "What API endpoints handle login and OTP dispatch in the backend?",
        "expected_files": ["backend/main.py", "backend/otp_service.py"],
        "reference_answer": "backend/main.py defines endpoints for requesting OTP generation and verifying OTP tokens during the authentication handshake."
    },
    {
        "id": "auth_03",
        "category": "authentication",
        "question": "How does the frontend LoginPage.jsx authenticate users and handle the OTP verification step?",
        "expected_files": ["src/pages/LoginPage.jsx", "src/App.jsx"],
        "reference_answer": "LoginPage.jsx provides input fields for the user identifier (email/phone), requests an OTP from the backend API, prompts the user to enter the code, and updates the authenticated user state upon success."
    },

    # 4. Multi-File Code Flow
    {
        "id": "flow_01",
        "category": "multi_file_flow",
        "question": "Trace the code flow from user OTP submission on the frontend to validation in backend/otp_service.py.",
        "expected_files": ["src/pages/LoginPage.jsx", "backend/main.py", "backend/otp_service.py"],
        "reference_answer": "User inputs OTP in LoginPage.jsx -> frontend triggers POST request to the backend OTP verification route in backend/main.py -> backend invokes verification logic in backend/otp_service.py -> verification result is returned to frontend to grant access."
    },
    {
        "id": "flow_02",
        "category": "multi_file_flow",
        "question": "How does telemetry simulation in src/simulation.js connect to the UI display in src/pages/TelemetryPage.jsx?",
        "expected_files": ["src/simulation.js", "src/pages/TelemetryPage.jsx"],
        "reference_answer": "src/simulation.js generates mock sensor telemetry readings (such as PM2.5, temperature, AQI) which are imported and consumed by TelemetryPage.jsx to render live charts and status indicators."
    },
    {
        "id": "flow_03",
        "category": "multi_file_flow",
        "question": "How does src/App.jsx manage active page routing and navigation across different pages?",
        "expected_files": ["src/App.jsx", "src/pages/OverviewPage.jsx"],
        "reference_answer": "src/App.jsx maintains top-level state for the active route/page, renders the header/sidebar navigation components, and conditionally displays pages like OverviewPage, TelemetryPage, and AttestationPage."
    },

    # 5. API Routes and Endpoints
    {
        "id": "api_01",
        "category": "api_endpoints",
        "question": "List the HTTP endpoints and route handlers implemented in backend/main.py.",
        "expected_files": ["backend/main.py"],
        "reference_answer": "backend/main.py defines FastAPI route handlers including health checks, OTP generation endpoints, and OTP verification endpoints."
    },
    {
        "id": "api_02",
        "category": "api_endpoints",
        "question": "What request parameters and payload structure are expected by the OTP verification endpoint?",
        "expected_files": ["backend/main.py", "backend/otp_service.py"],
        "reference_answer": "The OTP verification route expects a JSON payload containing the user identifier (e.g. email or mobile) and the OTP code to validate."
    },

    # 6. Architecture and Service Communication
    {
        "id": "arch_01",
        "category": "architecture",
        "question": "How does the frontend application communicate with backend API services?",
        "expected_files": ["src/pages/LoginPage.jsx", "backend/main.py"],
        "reference_answer": "The frontend uses fetch or HTTP client requests to communicate with the FastAPI backend endpoints, passing JSON payloads and receiving status responses."
    },
    {
        "id": "arch_02",
        "category": "architecture",
        "question": "What is the purpose of AttestationPage.jsx and how does it relate to environmental compliance?",
        "expected_files": ["src/pages/AttestationPage.jsx", "src/pages/PolicyPage.jsx"],
        "reference_answer": "AttestationPage.jsx displays proofs and records of environmental compliance, allowing users to verify that sensor telemetry met specified threshold policies."
    },
    {
        "id": "arch_03",
        "category": "architecture",
        "question": "What data and metrics are displayed on src/pages/OverviewPage.jsx?",
        "expected_files": ["src/pages/OverviewPage.jsx", "src/simulation.js"],
        "reference_answer": "OverviewPage.jsx presents high-level summary dashboard cards including active sensors, recent telemetry averages, attestation status, and system health."
    },

    # 7. Security Analysis
    {
        "id": "sec_01",
        "category": "security",
        "question": "Are database credentials and secrets hardcoded, or are they loaded via environment variables in backend/database.py?",
        "expected_files": ["backend/database.py", "backend/main.py"],
        "reference_answer": "The backend loads configuration and sensitive settings dynamically using python-dotenv and environment variables rather than hardcoding static secrets."
    },
    {
        "id": "sec_02",
        "category": "security",
        "question": "How does the backend prevent replay attacks or brute forcing of OTP tokens in backend/otp_service.py?",
        "expected_files": ["backend/otp_service.py"],
        "reference_answer": "backend/otp_service.py enforces expiration timestamps on generated OTPs and invalidates tokens once successfully used or after maximum retry attempts."
    },
    {
        "id": "sec_03",
        "category": "security",
        "question": "Does backend/main.py configure CORS middleware to allow secure cross-origin requests from the frontend?",
        "expected_files": ["backend/main.py"],
        "reference_answer": "backend/main.py configures FastAPI CORSMiddleware to control allowed origins, methods, and headers for requests originating from the frontend."
    },

    # 8. Scalability Recommendations
    {
        "id": "scale_01",
        "category": "scalability",
        "question": "How can the sensor telemetry simulation in src/simulation.js be scaled to ingest real-time data from thousands of physical IoT devices?",
        "expected_files": ["src/simulation.js", "backend/main.py"],
        "reference_answer": "To scale to thousands of physical IoT devices, the simulated generator should be replaced with an MQTT or Kafka message broker, ingesting data through a streaming ingestion service with time-series database storage."
    },
    {
        "id": "scale_02",
        "category": "scalability",
        "question": "Where can an AI anomaly detection model be integrated into the telemetry pipeline?",
        "expected_files": ["src/simulation.js", "src/pages/TelemetryPage.jsx", "backend/main.py"],
        "reference_answer": "An AI anomaly detection model can be deployed as an asynchronous worker or FastAPI middleware processing incoming sensor metrics before they are written to the database, flagging anomalous spikes in AQI or sensor drift."
    },
    {
        "id": "scale_03",
        "category": "scalability",
        "question": "What caching or database optimizations would improve query performance for telemetry history?",
        "expected_files": ["backend/database.py", "src/pages/TelemetryPage.jsx"],
        "reference_answer": "Adding indexing on timestamp and sensor_id fields in backend/database.py, along with Redis caching for recent 24-hour telemetry aggregations, would significantly reduce query latency."
    },

    # 9. Out-of-Scope / Negative Test Cases (Must NOT Hallucinate)
    {
        "id": "neg_01",
        "category": "out_of_scope",
        "question": "What AWS S3 bucket name is configured in the repository for storing uploaded video recordings?",
        "expected_files": [],
        "reference_answer": "The repository does not contain AWS S3 configuration or video recording upload functionality; the system should clearly state this information is not found in the codebase."
    },
    {
        "id": "neg_02",
        "category": "out_of_scope",
        "question": "How is Stripe payment gateway and webhook verification implemented in this project for user subscriptions?",
        "expected_files": [],
        "reference_answer": "The codebase does not integrate Stripe payment gateway or handle subscription billing webhooks; the system should state that no Stripe integration exists in the repository."
    }
]

MED_APPT_EVALUATION_DATASET = [
    {
        "id": "med_db_01",
        "category": "database_and_tech_stack",
        "question": "examine the backend folder and tell me which database is used here",
        "expected_files": ["backend/config.py", "backend/models/__init__.py", "backend/requirements.txt", "README.md"],
        "reference_answer": "The backend uses SQLite as the database engine with SQLAlchemy/Flask-SQLAlchemy as the ORM, configured dynamically in backend/config.py and backend/models/__init__.py."
    },
    {
        "id": "med_auth_01",
        "category": "authentication",
        "question": "what type of authentication is used here? examine the backend folder and answer",
        "expected_files": ["backend/app.py", "backend/routes/auth_routes.py", "backend/config.py"],
        "reference_answer": "The backend uses JSON Web Token (JWT) authentication via Flask-JWT-Extended and password hashing using werkzeug.security in backend/routes/auth_routes.py."
    },
    {
        "id": "med_db_02",
        "category": "database_and_tech_stack",
        "question": "give the code of the database configuration",
        "expected_files": ["backend/config.py", "backend/models/__init__.py", "backend/app.py"],
        "reference_answer": "The database configuration is in backend/config.py (Config class with SQLALCHEMY_DATABASE_URI), backend/models/__init__.py (db = SQLAlchemy()), and backend/app.py (db.init_app(app))."
    },
    {
        "id": "med_flow_01",
        "category": "code_flow",
        "question": "how are doctor availability and appointments represented in backend models?",
        "expected_files": ["backend/models/doctor.py", "backend/models/appointment.py", "backend/models/availability.py"],
        "reference_answer": "Doctor models in backend/models/doctor.py and availability in backend/models/availability.py define available time slots, while backend/models/appointment.py links patients, doctors, and appointment dates/statuses."
    },
    {
        "id": "med_neg_01",
        "category": "out_of_scope",
        "question": "is there any Stripe or PayPal payment gateway integration in this repository?",
        "expected_files": [],
        "reference_answer": "There is no Stripe or PayPal payment gateway integration in this repository; appointments are scheduled without online payment processing."
    }
]


def get_evaluation_dataset(repo_id: str = None, category: str = None, limit: int = None) -> list[dict]:
    """
    Retrieve evaluation samples with optional filtering by repository, category, and limiting count.
    """
    if repo_id and "med_appt" in repo_id.lower():
        data = MED_APPT_EVALUATION_DATASET
    else:
        data = AIRPROOF_EVALUATION_DATASET

    if category:
        data = [d for d in data if d.get("category") == category]
    if limit and limit > 0:
        data = data[:limit]
    return data

