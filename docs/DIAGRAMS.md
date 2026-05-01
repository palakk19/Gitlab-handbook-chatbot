# System Diagrams

These diagrams explain how the GitLab Handbook Chatbot processes a user question, retrieves evidence, optionally uses an LLM, and keeps its knowledge base reviewable.

## 1. High-Level System Architecture

```mermaid
flowchart LR
  User["Employee / Candidate"] --> Browser["Browser Chat UI"]
  Browser --> Server["Node.js HTTP Server"]
  Server --> Guardrails["Query Analysis + Guardrails"]
  Guardrails --> Retrieval["Hybrid RAG Retrieval"]
  Retrieval --> Index["In-Memory Search Index"]
  Index --> KB["Curated GitLab Sources JSON"]
  Retrieval --> Answerability["Answerability Check"]
  Answerability --> Generator["Deterministic Answer Builder"]
  Generator --> OptionalLLM["Optional Gemini / OpenAI Rewording"]
  OptionalLLM --> Server
  Server --> Browser

  Ingest["Controlled Ingestion Script"] --> Generated["Generated Review Sources"]
  Generated --> Review["Human Review"]
  Review --> KB
```

## 2. User Question Sequence

```mermaid
sequenceDiagram
  participant U as User
  participant UI as Browser UI
  participant API as Node API
  participant QA as Query Analysis
  participant RAG as Retrieval Engine
  participant KB as Curated Source Index
  participant LLM as Optional LLM

  U->>UI: Type question and press Enter
  UI->>API: POST /api/chat with question + recent history
  API->>QA: Sanitize input and analyze intent

  alt Prompt injection detected
    QA-->>API: Block unsafe request
    API-->>UI: Safe refusal response
  else Vague keyword-only prompt
    QA-->>API: Needs clarification
    API-->>UI: Clarifying question
  else Answerable GitLab question
    QA->>RAG: Normalized query + topic hints
    RAG->>KB: Search source chunks
    KB-->>RAG: Ranked evidence chunks
    RAG-->>API: Sources + confidence + diagnostics

    alt Optional LLM key configured
      API->>LLM: Retrieved evidence only
      LLM-->>API: Grounded final wording
    else No key or timeout
      API->>API: Deterministic grounded answer
    end

    API-->>UI: Answer + citations + mode + confidence
  end
```

## 3. RAG Processing Pipeline

```mermaid
flowchart TD
  Q["Raw User Question"] --> S["Sanitize + Length Limit"]
  S --> H["Attach Recent History Only When Useful"]
  H --> I["Intent + Topic Detection"]
  I --> G{"Safe and Specific Enough?"}
  G -- "No: prompt injection" --> Block["Return Safe Refusal"]
  G -- "No: vague keyword" --> Clarify["Ask Clarifying Question"]
  G -- "Yes" --> N["Normalize Tokens + Expand Synonyms"]
  N --> B["BM25 Exact-Term Scoring"]
  N --> V["TF-IDF Cosine Similarity"]
  N --> T["Tag, Title, Intent, and Topic Boosts"]
  B --> R["Rerank + Diversify Sources"]
  V --> R
  T --> R
  R --> A{"Enough Evidence?"}
  A -- "No" --> Fallback["Low-Confidence Retrieval Fallback"]
  A -- "Yes" --> Compose["Compose Grounded Answer"]
  Compose --> Label["Attach Source Label, Confidence, and Citations"]
```

## 4. Knowledge Base and Index Structure

```mermaid
flowchart LR
  Source["Source Card in data/sources.json"] --> Fields["title, category, url, summary, highlights, tags, employeeUseCase"]
  Fields --> Overview["Overview Chunk"]
  Fields --> Evidence["Evidence Chunks"]
  Fields --> UseCase["Employee Use Case Chunk"]
  Overview --> Tokens["Tokens + Term Frequency"]
  Evidence --> Tokens
  UseCase --> Tokens
  Tokens --> Index["In-Memory Retrieval Index"]
  Index --> Result["Ranked Sources Returned to UI"]
```

## 5. Controlled Data Refresh Pipeline

```mermaid
flowchart TD
  Seeds["GitLab Public Seed URLs"] --> Crawler["Controlled Crawler"]
  Crawler --> Filter["Allowed Hosts + URL Filters"]
  Filter --> Fetch["Fetch HTML Pages"]
  Fetch --> Clean["Remove Navigation, Scripts, Styles, Footer"]
  Clean --> Extract["Extract Title, Summary, Highlights, Tags"]
  Extract --> Generated["data/sources.generated.json"]
  Extract --> Report["data/ingestion-report.json"]
  Generated --> Review["Manual Review"]
  Report --> Review
  Review --> Curated["Copy Approved Cards to data/sources.json"]
  Curated --> Eval["npm run verify"]
  Eval --> Deploy["Push to GitHub + Render Deploy"]
```

## 6. Deployment Flow

```mermaid
flowchart LR
  Dev["Local Project"] --> Git["GitHub Repository"]
  Git --> Render["Render Web Service"]
  Render --> Node["npm run start"]
  Env["Render Environment Variables"] --> Render
  Node --> PublicURL["Public Chatbot URL"]

  Env --> GeminiKey["GEMINI_API_KEY"]
  Env --> GeminiModel["GEMINI_MODEL"]
  Env --> Timeout["LLM_TIMEOUT_MS"]
  Env --> Host["HOST / PORT"]
```

## 7. Runtime Modes

```mermaid
stateDiagram-v2
  [*] --> RetrievalOnly
  RetrievalOnly --> LLMRAG: API key configured and provider responds
  LLMRAG --> RetrievalOnly: Provider timeout or error
  RetrievalOnly --> Clarification: Query is too vague
  RetrievalOnly --> LowConfidence: Evidence is too weak
  LLMRAG --> LowConfidence: Evidence is too weak
  Clarification --> RetrievalOnly: User asks a clearer follow-up
  LowConfidence --> RetrievalOnly: User asks supported GitLab question
```

## Recommended Placement

- Put diagrams 1, 2, and 3 in the Google Doc write-up.
- Keep diagrams 4, 5, 6, and 7 in the GitHub repository for technical reviewers.
- If the Google Doc becomes too long, include diagram 1 only in the main write-up and link to `docs/DIAGRAMS.md` for the full set.
