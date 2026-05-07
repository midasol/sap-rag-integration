# Gemini AI Assistant — RAG + SAP 에이전틱 워크플로우

Google Gemini와 Google ADK로 구동되는 AI 에이전틱 워크플로우로, 두 가지 데이터 소스에 쿼리를 지능적으로 라우팅합니다:
- **문서 검색 (RAG)**: 임베딩된 텍스트, PDF, 이미지, 오디오 및 비디오 파일에 대한 다중 모드 벡터 검색
- **SAP 엔터프라이즈 데이터**: SAP Product Master에 대한 라이브 OData 쿼리 (자재, 플랜트, 판매, 평가, 측정 단위)

단일 Google ADK `LlmAgent`가 다섯 개의 도구를 제공하며, 어느 데이터 소스를 쿼리할지(또는 둘 다) 결정하여 통합된 답변을 합성합니다. Next.js는 채팅 UI와 인제스천 파이프라인을 제공하고, 모든 에이전트 로직은 ADK Python 백엔드에 있습니다.

---

## 아키텍처

### 시스템 개요

```mermaid
graph TB
    User([👤 사용자])

    subgraph NextJS["Next.js 앱 (포트 3000)"]
        ChatUI["Chat UI<br/><small>React 19 + Tailwind</small>"]
        ChatAPI["POST /api/chat"]
        EmbedAPI["POST /api/embed"]
        PipelineAPI["POST /api/pipeline"]
        OAuthCB["GET /api/sap/oauth/callback<br/><small>OAuth Step 2 프록시</small>"]
    end

    subgraph ADK["ADK FastAPI (포트 8200)"]
        LlmAgent["LlmAgent<br/><small>adk_agent/agent.py</small>"]

        subgraph Tools["기본 도구 5개 + 선택적 MCP 토올셋 1개"]
            T1["search_documents<br/><small>pgvector RAG</small>"]
            T2["sap_authenticate<br/><small>Basic / OAuth PKCE</small>"]
            T3["sap_list_services<br/><small>services.yaml 카탈로그</small>"]
            T4["sap_query<br/><small>OData $filter/$orderby</small>"]
            T5["sap_get_entity<br/><small>단일 엔티티 조회</small>"]
            T6["Pub/Sub MCP 토올셋<br/><small>list_topics · publish · …<br/>deny-by-default 게이트</small>"]
        end

        MCPCfg[".mcp.json<br/><small>tool/topic/sub allowlist</small>"]
    end

    subgraph DataSources["데이터 소스"]
        PG[("PostgreSQL<br/>+ pgvector<br/><small>3072차원 임베딩</small>")]
        GCS[("Google Cloud<br/>Storage<br/><small>문서 · 미디어</small>")]
        SAP[("SAP Gateway<br/><small>OData v2/v4</small>")]
    end

    subgraph AI["Google AI"]
        Gemini["Gemini LLM<br/><small>스트리밍 · 도구 사용</small>"]
        EmbModel["Gemini Embedding 2<br/><small>3072 차원</small>"]
    end

    subgraph MCP["MCP 서버 (HTTP)"]
        PubsubMCP["pubsub.googleapis.com/mcp<br/><small>Cloud Pub/Sub<br/>(ADC + roles/mcp.toolUser)</small>"]
    end

    User --> ChatUI
    ChatUI --> ChatAPI
    ChatAPI --> LlmAgent
    LlmAgent --> Gemini
    Gemini -.->|도구 호출| LlmAgent
    LlmAgent --> T1 & T2 & T3 & T4 & T5
    LlmAgent -.->|".mcp.json이 있으면"| T6
    MCPCfg -.->|구성| T6
    T1 --> PG
    T1 --> EmbModel
    T2 & T4 & T5 --> SAP
    T6 --> PubsubMCP
    EmbedAPI --> EmbModel
    EmbedAPI --> GCS
    EmbedAPI --> PG
    PipelineAPI --> EmbModel
    PipelineAPI --> GCS
    PipelineAPI --> PG
    OAuthCB --> LlmAgent

    style NextJS fill:#e8f5e9,stroke:#2e7d32
    style ADK fill:#e3f2fd,stroke:#1565c0
    style DataSources fill:#fff3e0,stroke:#e65100
    style AI fill:#fce4ec,stroke:#c62828
    style Tools fill:#f3e5f5,stroke:#7b1fa2
    style MCP fill:#e0f7fa,stroke:#00838f
    style T6 stroke-dasharray: 5 5
    style MCPCfg fill:#fff8e1,stroke:#f57f17
```

### 요청 흐름

```mermaid
sequenceDiagram
    actor 사용자
    participant UI as Chat UI
    participant API as /api/chat (Next.js)
    participant ADK as ADK FastAPI :8200
    participant Gemini as Gemini LLM
    participant SAP as SAP Gateway

    사용자->>UI: "FERT 타입의 제품을 보여줘"
    UI->>API: POST {message, conversationId}
    API->>API: DB에서 채팅 이력 로드
    API->>ADK: POST /run (message, session_id)
    ADK->>Gemini: LlmAgent.run(message, tools)

    Note over Gemini: 의도 분석 →<br/>결정: sap_query

    Gemini-->>ADK: tool_call: sap_query<br/>{service: "API_PRODUCT_SRV",<br/>entity_set: "A_Product"}
    ADK->>SAP: OData GET A_Product?$filter=...
    SAP-->>ADK: {results: [...], count: N}
    ADK-->>Gemini: tool_result

    Note over Gemini: 응답을<br/>마크다운 테이블로 포맷

    Gemini-->>ADK: 스트리밍된 텍스트 응답
    ADK-->>API: SSE / 스트리밍 청크
    API-->>UI: SSE 스트림
    UI-->>사용자: 렌더링된 마크다운 테이블

    API->>API: DB에 메시지 저장
```

### SAP OAuth 흐름

```mermaid
sequenceDiagram
    actor 사용자
    participant UI as Chat UI
    participant Next as Next.js API :3000
    participant ADK as ADK FastAPI :8200
    participant SAP_GW as SAP Gateway

    사용자->>UI: SAP 로그인 요청
    UI->>Next: POST /api/sap/auth {method: "oauth"}
    Next->>ADK: sap_authenticate Step 1
    ADK->>ADK: PKCE 생성<br/>(code_verifier + code_challenge)
    ADK-->>Next: {login_url, state}
    Next-->>UI: login_url (+ sap_oauth_pending 쿠키 설정)
    UI->>UI: 팝업에서 login_url 열기

    사용자->>SAP_GW: 팝업에서 인증
    SAP_GW-->>Next: GET /api/sap/oauth/callback?code=&state=
    Next->>Next: sap_oauth_pending 쿠키로 state 검증
    Next->>ADK: sap_authenticate Step 2 (코드 교환)
    ADK->>SAP_GW: 코드 + code_verifier를 토큰으로 교환
    SAP_GW-->>ADK: access_token
    ADK-->>Next: {success: true}
    Next-->>Next: sap_session 쿠키 설정 (iron-session)
    Next-->>UI: 팝업 postMessage → 오프너 알림, 팝업 닫힘
    UI-->>사용자: SAP 연결됨

    Note over ADK: 자격 증명은<br/>ADK 세션 상태에 저장 (인-프로세스)
```

### 컴포넌트

| 컴포넌트 | 스택 | 목적 |
|----------|------|------|
| **Next.js 앱** | TypeScript, Next.js 16, React 19 | Chat UI, API 라우트, 인제스천 파이프라인 |
| **ADK 에이전트** | Python, Google ADK, FastAPI, 포트 8200 | 단일 LlmAgent — 기본 도구 5개 + 선택적 MCP 토올셋 1개, SAP + RAG 로직 |
| **벡터 DB** | PostgreSQL + pgvector | 문서 검색을 위한 3072차원 Gemini 임베딩 |
| **파일 스토리지** | Google Cloud Storage | 업로드된 문서 및 미디어 파일 |
| **Pub/Sub MCP** *(선택)* | `pubsub.googleapis.com/mcp` HTTP MCP | `.mcp.json`의 deny-by-default allowlist로 게이트되어 LLM에 노출되는 토픽 / 구독 / publish 작업 |

### ADK 도구

ADK 에이전트(`adk_agent/agent.py`)는 다섯 개의 기본 도구와, 레포 루트에
`.mcp.json`이 있을 때 연결되는 선택적 여섯 번째 슬롯을 가진 단일 `LlmAgent`를
제공합니다:

| 도구 | 설명 |
|------|------|
| `search_documents` | pgvector RAG — Gemini로 쿼리를 임베딩하고 `embeddings` 테이블(vector(3072))을 검색 |
| `sap_authenticate` | SAP 로그인 — Basic(사용자명/비밀번호) 또는 OAuth 2.0 PKCE; 성공 시 `sap_session` 쿠키 설정 |
| `sap_list_services` | 사용 가능한 SAP OData 서비스의 services.yaml 카탈로그 반환 |
| `sap_query` | SAP Gateway 대상 `$filter`, `$orderby`, `$top`을 지원하는 OData 엔티티셋 쿼리 |
| `sap_get_entity` | 키 필드로 단일 OData 엔티티 조회 |
| **Pub/Sub MCP 토올셋** *(선택)* | `list_topics`, `get_topic`, `list_subscriptions`, `get_subscription`, `publish` 도구를 추가하며, 도구·토픽·구독에 대한 deny-by-default allowlist로 게이트됩니다. [docs/ko/MCP.md](./docs/ko/MCP.md) 참조. |

---

## 사전 준비

설치 전에 Next.js 앱과 ADK 에이전트 모두에서 필요한 API 키를 발급받으세요.

### Gemini API 키

두 서비스 모두 Gemini API 키가 필요합니다 — Next.js 앱은 `GEMINI_API_KEY`, ADK 에이전트는 `GOOGLE_API_KEY`로 저장합니다. **동일한 키**이며 변수명만 다릅니다.

1. [Google AI Studio](https://aistudio.google.com/apikey) 접속
2. Google 계정으로 로그인
3. **"API 키 만들기"** 클릭
4. 기존 Google Cloud 프로젝트를 선택하거나 새로 만들기
5. 생성된 키 복사 (`AIza...`로 시작)

> **무료 티어 제공.** Google AI Studio는 개발 및 테스트에 충분한 무료 할당량을 제공합니다. 시작하는 데 결제 계정이 필요하지 않습니다.

두 env 파일에 키를 설정하세요:

```env
# .env.local  (Next.js)
GEMINI_API_KEY=AIza...

# adk_agent/.env  (ADK Python 에이전트)
GOOGLE_API_KEY=AIza...
```

> 두 변수에는 **동일한 키 값**이 들어가야 합니다. 변수명이 다른 이유는 각 SDK의 관례 때문입니다 — Next.js는 `@google/genai`, Python ADK는 `google-genai`를 사용합니다.

### Google Cloud 프로젝트 (GCS 및 선택적 기능에 필요)

파일 업로드용 Google Cloud Storage와 선택적 기능 (Vertex AI Agent Engine, Cloud SQL, Pub/Sub MCP)에는 Google Cloud 프로젝트가 필요합니다.

1. [Google Cloud Console](https://console.cloud.google.com/) 접속
2. 상단 프로젝트 선택기 클릭 → **"새 프로젝트"**
3. 프로젝트 이름을 입력하고 **프로젝트 ID** 메모 (예: `my-project-123`)
4. GCS, Cloud SQL, Vertex AI 사용 계획이 있다면 결제 활성화
5. `gcloud` CLI를 설치하고 인증:
   ```bash
   # 설치: https://cloud.google.com/sdk/docs/install
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```

> **GCS는 파일 업로드에 필수입니다.** 프로젝트가 있으면 `pnpm gcp:setup` 스크립트 (옵션 B, 5단계)가 서비스 계정과 버킷을 자동으로 생성합니다.

---

## 설치

이 프로젝트를 설치하는 방법은 **두 가지**입니다. 둘 중 하나만 선택하세요 — 둘 다 할 필요 없습니다.

| 옵션 | 누구를 위한 것인가? | 노력 | 권장 여부 |
|------|----------------------|------|-----------|
| **A. AI 코딩 도구로 설치** | Gemini CLI, Antigravity, Cursor, Codex, Claude Code 등을 사용 중인 사람 | 한 번 붙여넣고 프롬프트에 답하기만 하면 됨 | ⭐ **권장** — 더 빠르고, 실수가 적음 |
| **B. 수동 설치** | AI 도구가 없거나, 직접 명령을 실행하고 싶은 사람 | 약 15~30분의 읽기와 입력 | 옵션 A가 불가능할 때만 |

---

### 옵션 A: AI 코딩 도구로 설치 (권장)

> **AI 도구는 사람보다 이 프로젝트를 더 잘 설치합니다.** OS를 감지하고, 누락된 의존성을 설치하고,
> 리포지토리를 복제하고, 환경 변수를 대화형으로 구성하고, 데이터베이스를 초기화하고, 선택적으로
> SAP 서비스를 설정한 다음, 모든 단계가 통과한 뒤에야 다음 단계로 넘어갑니다. 전체 설치 플레이북은
> AI 에이전트가 위에서 아래로 실행할 수 있도록 작성된 [`installation.md`](./installation.md)에 있습니다.

AI 코딩 도구(Gemini CLI, Antigravity, Cursor, Codex, Claude Code)에 다음 한 줄을 붙여넣으세요:

```
Install and configure sap-rag-integration by following the instruction here:
https://raw.githubusercontent.com/midasol/sap-rag-integration/main/installation.md
```

AI 에이전트가 Gemini API 키, 데이터베이스 URL, (선택적으로) SAP 자격 증명을 묻고 — 나머지는 모두 자동으로 처리합니다.

> ✅ **옵션 A를 사용했다면 설치는 끝났습니다. 옵션 B는 통째로 건너뛰고 [사용 가이드](#사용-가이드)로 바로 이동하세요.**

---

### 옵션 B: 수동 설치 (사람이 직접)

<details>
<summary>📖 <strong>수동 설치 단계를 펼치려면 클릭</strong> — 위의 옵션 A를 사용하지 않은 경우에만</summary>

<br>

> **옵션 A를 사용하지 않은 경우에만 이 섹션을 보세요.** 위의 AI 도구 경로로 설치했다면
> 아래의 모든 단계는 이미 완료된 상태이므로 — 더 할 일이 없습니다. [사용 가이드](#사용-가이드)로
> 건너뛰세요.

이 섹션의 나머지 부분은 각 단계를 수동으로 안내합니다. 필수 조건을 설치하고, 리포지토리를 복제하고, 환경 변수를 구성하고, 데이터베이스를 초기화하고, 두 서비스를 직접 시작하게 됩니다.

#### 필수 조건

> 🛑 **수동 설치 전용.** 여기부터 아래에 나오는 모든 항목 — 필수 조건, 환경 설정, 데이터베이스 초기화,
> 서비스 시작 — 은 **직접** 손으로 설치하는 사용자를 위한 것입니다. 이미 위의 옵션 A 한 줄짜리
> 명령을 AI 코딩 도구로 실행했다면, **아래 단계 중 어떤 것도 다시 실행하지 마세요**. AI 에이전트가
> 이미 모두 처리했습니다. 바로 [사용 가이드](#사용-가이드)로 건너뛰세요.

##### 1. Node.js

Node.js **24.14.0 이상**이 필요합니다.

```bash
node -v   # v24.14.0 이상이어야 함

# 설치 (macOS - Homebrew)
brew install node

# 또는 nvm을 통해
nvm install 24 && nvm use 24
```

##### 2. pnpm

```bash
npm install -g pnpm
```

##### 3. Python 3.11+

SAP 서비스에 필요합니다.

```bash
python3 --version   # 3.11+ 이어야 함

# 설치 (macOS - Homebrew)
brew install python@3.11
```

##### 4. PostgreSQL + pgvector

```bash
# macOS - Homebrew
brew install postgresql@17 pgvector
brew services start postgresql@17

# 데이터베이스 생성
createdb gemini_rag
```

> pgvector 확장은 `pnpm db:setup` 실행 시 자동으로 활성화됩니다.

##### 5. Google Cloud 계정 및 API 키

###### Gemini API 키

1. [Google AI Studio](https://aistudio.google.com/apikey)로 이동
2. "API 키 만들기" 클릭
3. API 키 복사 및 저장

###### Google Cloud Storage (GCS) 설정

1. [Google Cloud Console](https://console.cloud.google.com/)로 이동
2. 프로젝트 생성 또는 선택
3. **Cloud Storage** > "버킷 만들기"로 이동

###### 서비스 계정 및 자격 증명 (GOOGLE_APPLICATION_CREDENTIALS)

GCS 파일 업로드/다운로드에 서비스 계정 JSON 키가 필요합니다.

**경로 1 (권장): 자동화 스크립트**

```bash
pnpm gcp:setup
```

이 스크립트는 서비스 계정을 생성하고, `roles/storage.objectAdmin` 역할을 부여하고, GCS 버킷이 없으면 새로 만들고, JSON 키 파일을 생성한 뒤 `GCS_PROJECT_ID`, `GCS_BUCKET_NAME`, `GOOGLE_APPLICATION_CREDENTIALS`를 `.env.local`에 자동으로 기록합니다. 멱등성이 보장되어 동일한 입력으로 여러 번 실행해도 안전합니다.

전제 조건:
- `gcloud` CLI 설치: https://cloud.google.com/sdk/docs/install
- 인증됨: `gcloud auth login`

`.env.local`에 값이 비어 있으면 스크립트가 **GCP Project ID** 와 **GCS Bucket Name** 을 직접 묻습니다. 기본값은 환경 변수(`GCP_SA_NAME`, `GCP_KEY_FILE`, `GCP_BUCKET_LOCATION`)로 덮어쓸 수 있으며 자세한 내용은 스크립트 헤더를 참조하세요.

**경로 2: Google Cloud Console (UI)**

1. [Google Cloud Console](https://console.cloud.google.com/) > **IAM 및 관리** > **서비스 계정**으로 이동
2. **"+ 서비스 계정 만들기"** 클릭
3. 이름 입력(예: `gemini-rag-storage`) → **만들기 및 계속**
4. 역할 선택: **Storage Object Admin** → **계속** → **완료**
5. 생성된 서비스 계정 클릭 → **키** 탭
6. **키 추가** → **새 키 만들기** → **JSON** → **만들기**
7. JSON 파일이 자동으로 다운로드됨
8. 프로젝트 루트로 이동:
   ```bash
   mv ~/Downloads/your-project-xxxxxx.json ./service-account.json
   ```
9. `.env.local`에 경로 설정:
   ```env
   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
   ```

**경로 3: 수동 gcloud 명령**

```bash
# 서비스 계정 생성
gcloud iam service-accounts create gemini-rag-storage \
  --display-name="Gemini RAG Storage"

# Storage Object Admin 역할 부여
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:gemini-rag-storage@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

# JSON 키 다운로드
gcloud iam service-accounts keys create ./service-account.json \
  --iam-account=gemini-rag-storage@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

> `service-account.json`은 이미 `.gitignore`에 있으므로 git에 커밋되지 않습니다.
> `GOOGLE_APPLICATION_CREDENTIALS`를 설정하지 않으면 SDK는 [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials)로 폴백됩니다.

##### 6. SAP 시스템 액세스 (선택 사항)

SAP 데이터 쿼리에만 필요:
- OData 서비스가 노출된 SAP Gateway 호스트
- SAP에서 구성된 OAuth 2.0 클라이언트(트랜잭션 SOAUTH2)
- SAP 시스템에 대한 네트워크 액세스

#### 빠른 시작 (수동 단계)

> 🛑 **수동 설치 전용.** 이 단계들은 옵션 B의 일부입니다. 옵션 A의 AI 도구 한 줄짜리 명령을
> 사용했다면, 에이전트가 이미 리포지토리 복제, `.env.local` 작성, `pnpm db:setup` 실행, 두 서비스
> 시작까지 모두 마친 상태입니다 — 다시 실행해도 도움이 되지 않습니다. [사용 가이드](#사용-가이드)로
> 이동하세요.

##### 1단계: 복제 및 설치

```bash
git clone https://github.com/midasol/sap-rag-integration.git
cd sap-rag-integration
pnpm install
```

##### 2단계: 환경 구성

```bash
cp .env.local.example .env.local
```

`.env.local` 편집:

```env
# === 필수 ===
GEMINI_API_KEY=your-gemini-api-key
DATABASE_URL=postgresql://username:password@localhost:5432/gemini_rag
GCS_BUCKET_NAME=your-bucket-name
GCS_PROJECT_ID=your-gcp-project-id
SAP_SESSION_SECRET=<32자 이상 비밀키 — openssl rand -base64 48>

# === 선택 사항 ===
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
# GEMINI_EMBEDDING_MODEL=gemini-embedding-2-preview
# GEMINI_CHAT_MODEL=gemini-3.1-pro-preview

# === ADK 백엔드 ===
ADK_BASE_URL=http://localhost:8200
```

##### 3단계: 데이터베이스 초기화

```bash
pnpm db:setup
```

##### 4단계: ADK 백엔드 시작

```bash
# 프로젝트 루트에서
cp adk_agent/.env.example adk_agent/.env   # SAP + DB 자격 증명으로 편집
uv venv && uv sync
uv run python -m adk_agent.server          # 포트 8200에서 시작

# 확인:
curl http://localhost:8200/healthz         # → {"status":"ok"}
```

##### 5단계: Next.js 앱 시작

```bash
pnpm dev
```

[http://localhost:3000](http://localhost:3000)을 열면 `/chat` 페이지로 리다이렉트됩니다.

</details>

---

## 사용 가이드

[http://localhost:3000/chat](http://localhost:3000/chat)를 열어 시작하세요. 하단 상태 표시줄에서 활성 데이터 소스를 표시합니다:
- **SAP 연결됨** (녹색) / **연결 안 됨** (황색)
- **문서** (녹색) — pgvector에 임베딩된 데이터가 있을 때 사용 가능

---

### 시나리오 1: 문서 임베딩 및 검색

벡터 데이터베이스에 파일을 임베딩한 후, 그에 대해 질문하세요.

**1단계 — 채팅에서 파일 임베딩**

클립 아이콘을 클릭하고, 파일(PDF, 이미지, 비디오 등)을 첨부하고, "embedding"을 포함하는 메시지를 입력하세요:

```
사용자: [첨부: annual-report-2025.pdf] embedding this file
어시스턴트: 파일 'annual-report-2025.pdf'가 성공적으로 임베딩되었습니다. (12개 청크 생성)
```

**2단계 — 문서에 대한 질문**

```
사용자: 연간 보고서에서 Q3 수익에 대해 뭐라고 하나요?
어시스턴트: 연간 보고서에 따르면(유사도: 92.3%), Q3 수익은...
         [파일: annual-report-2025.pdf, 유사도: 92.3%]
```

**배치 임베딩 (한 번에 여러 파일)**

```bash
# CLI — 폴더의 모든 파일 임베딩
pnpm pipeline -- ./data

# 또는 관리자 UI 사용
open http://localhost:3000/admin/pipeline
```

---

### 시나리오 2: SAP 데이터 쿼리

자연어를 사용하여 라이브 SAP 엔터프라이즈 데이터를 쿼리하세요.

**사용 가능한 SAP 데이터 검색**

```
사용자: 어떤 SAP 데이터에 액세스할 수 있나요?
어시스턴트: 다음 SAP 서비스를 사용할 수 있습니다:
         | 모듈 | 서비스 | 설명 |
         | Product Master | API_PRODUCT_SRV | 제품(자재) 마스터, 플랜트, 판매, 평가, 단위 |
```

**필터가 있는 쿼리**

```
사용자: FERT 타입의 첫 5개 제품을 보여줘
어시스턴트: | 제품 | 타입 | 전사 상태 | 생성 |
         | MZ-FG-R100 | FERT | 활성 | 2024-08-12 |
         | MZ-FG-R101 | FERT | 활성 | 2024-08-12 |
         ...
```

**특정 레코드 가져오기**

```
사용자: 제품 MZ-FG-R100의 세부 정보를 보여줘
어시스턴트: **제품 MZ-FG-R100**
         - 제품 유형: FERT (완제품)
         - 전사 상태: 활성
         - 생성: 2024-08-12, USER01에 의해
         - 마지막 변경: 2025-01-04
         ...
```

**교차 엔티티 쿼리**

```
사용자: 어떤 플랜트가 제품 MZ-FG-R100을 재고로 가지고 있나요?
사용자: 제품 MZ-FG-R100의 영문 설명을 보여줘
사용자: 제품 MZ-FG-R100의 표준 가격과 평가 클래스는 무엇인가요?
```

#### API_PRODUCT_SRV 테스트 쿼리 모음

Product Master 서비스의 모든 엔티티를 검증할 수 있는 즉시 사용 가능한 프롬프트 모음입니다.
예시 ID(`MZ-FG-R100`, 플랜트 `1010`, 영업 조직 `1010`)는 실제 SAP 시스템의 값으로 교체하세요.

**`A_Product` — 헤더 (cross-plant)**
```
타입이 FERT인 제품 10개를 보여줘
2024-01-01 이후에 생성된 제품을 생성일 순으로 보여줘
CrossPlantStatus가 활성인 제품은 몇 개인가요?
제품 MZ-FG-R100의 전체 세부 정보를 보여줘
```

**`A_ProductDescription` — 다국어 설명**
```
제품 MZ-FG-R100의 영문 설명을 보여줘
제품 MZ-FG-R100의 모든 언어 설명을 나열해줘
```

**`A_ProductPlant` — 플랜트별 마스터 데이터**
```
제품 MZ-FG-R100은 어떤 플랜트에 존재하나요?
플랜트 1010의 제품 MZ-FG-R100에 대한 구매 그룹과 원산지를 보여줘
플랜트 1010에서 생산 재고로 관리되는 제품은?
```

**`A_ProductSales` — 영업 상태 및 세금**
```
제품 MZ-FG-R100의 판매 상태와 세금 분류는?
타입이 FERT인 처음 5개 제품의 운송 그룹을 보여줘
```

**`A_ProductSalesDelivery` — 영업 조직 / 유통 채널**
```
영업 조직 1010의 제품 MZ-FG-R100에 대한 최소 주문 수량과 공급 플랜트는?
유통 채널 10의 제품에 대한 계정 결정 제품 그룹을 나열해줘
```

**`A_ProductStorage` — 보관 및 위험물**
```
제품 MZ-FG-R100의 보관 조건과 최소 잔여 유통기한을 보여줘
위험물 번호가 설정된 제품은?
```

**`A_ProductValuation` — 평가 영역별 가격**
```
평가 영역 1010의 제품 MZ-FG-R100에 대한 표준 가격과 평가 클래스는?
제품 MZ-FG-R100의 평가 유형과 재고 평가 절차를 보여줘
```

**`A_ProductUnitsOfMeasure` — 대체 단위**
```
제품 MZ-FG-R100의 대체 단위(UoM)를 보여줘
제품 MZ-FG-R100의 총 중량과 자재 부피는?
```

**필터, 정렬, 집계**
```
가장 최근에 변경된 제품 5개를 보여줘
지난 30일 동안 USER01이 생성한 제품을 나열해줘
ProductType별로 제품을 그룹화하고 개수를 세어줘
```

---

### 시나리오 3: 결합된 쿼리 (문서 + SAP)

임베딩된 문서와 라이브 SAP 데이터가 모두 필요한 질문을 하세요. ADK 에이전트가 `search_documents`, `sap_query` 등 여러 도구를 자동으로 호출합니다.

```
사용자: 제품 마스터 스냅샷 문서와 라이브 SAP 제품 데이터를 비교해줘
어시스턴트: **문서 분석** (product-master-snapshot.pdf에서):
         스냅샷에는 12개의 완제품(타입 FERT)이 나열되었습니다...

         **실제 SAP 데이터** (API_PRODUCT_SRV / A_Product에서):
         | 제품 | 타입 | 전사 상태 | 마지막 변경 |
         | MZ-FG-R100 | FERT | 활성 | 2025-01-04 |
         | MZ-FG-R101 | FERT | 활성 | 2025-01-04 |
         | MZ-FG-R102 | FERT | 비활성 | 2024-11-22 |

         Q1 실제 매출은 예상 $2.1M 대비 $2.15M(+2.4%)였습니다.
```

```
사용자: 조달 보고서에 언급된 재고가 부족한 자재가 있나요?
어시스턴트: 조달 보고서는 5개의 중요 자재를 언급합니다...
         SAP 재고 수준 확인 중:
         | 자재 | 보고서 우선순위 | 현재 재고 | 상태 |
         | M-1001   | 높음           | 23개     | 낮음   |
         | M-2045   | 중간         | 150개   | 정상   |
         ...
```

---

### 시나리오 4: SAP 인증

#### 기본 인증 (SAP_AUTH_TYPE=basic)

`SAP_AUTH_TYPE=basic`이 구성되면, 채팅 페이지에 인라인 로그인 양식이 나타납니다:

1. 인라인 양식에 SAP 사용자 ID와 비밀번호 입력
2. **로그인** 클릭
3. 상태 표시줄이 "SAP 연결됨"(녹색)으로 변경
4. SAP 쿼리가 즉시 사용 가능

> 자격 증명은 세션 동안 메모리에 저장됩니다. SAP 서비스를 다시 시작하여 지우세요.

#### OAuth 2.0 (SAP_AUTH_TYPE=sap_oauth)

`SAP_AUTH_TYPE=sap_oauth`가 구성되면:

1. 채팅 상태 표시줄에 "SAP 연결 안 됨"(황색)이 표시
2. 어시스턴트에게 SAP 데이터에 대해 질문하면 OAuth 로그인 URL을 제공
3. URL을 브라우저에서 열고 SAP로 인증
4. 인증 코드가 액세스 토큰으로 자동 교환
5. 토큰이 만료되면 자동으로 새로고침

---

### 시나리오 5: 다중 모드 문서 검색

다양한 파일 유형(텍스트, PDF, 이미지, 오디오, 비디오)에 걸쳐 임베딩하고 검색하세요.

**이미지 검색**

```
사용자: [첨부: architecture-diagram.png] embedding
어시스턴트: 파일 'architecture-diagram.png'가 성공적으로 임베딩되었습니다. (1개 청크 생성)

사용자: 아키텍처 다이어그램에 어떤 컴포넌트가 표시되나요?
어시스턴트: 아키텍처 다이어그램(유사도: 88.5%)을 기반으로, 시스템은...
         [파일: architecture-diagram.png, 유사도: 88.5%]
```

**비디오 검색**

```
사용자: [첨부: product-demo.mp4] embedding this video
어시스턴트: 파일 'product-demo.mp4'가 성공적으로 임베딩되었습니다. (1개 청크 생성)

사용자: 제품 데모 비디오에서 어떤 기능이 시연되나요?
어시스턴트: 제품 데모 비디오는 세 가지 주요 기능을 보여줍니다...
         [파일: product-demo.mp4, 유사도: 85.2%]
```

**교차 형식 검색**

```
사용자: "클라우드 마이그레이션"과 관련된 모든 문서 찾기
어시스턴트: 다양한 파일 유형에서 4개의 관련 결과 발견:
         1. cloud-migration-plan.pdf (94.1%) — 12페이지 마이그레이션 로드맵...
         2. infrastructure-diagram.png (87.3%) — 대상 클라우드 아키텍처 표시...
         3. migration-meeting.mp3 (82.5%) — 타임라인 및 위험 논의...
         4. project-notes.txt (79.8%) — 마이그레이션 종속성 주석...
```

---

## ADK 에이전트

ADK Python 에이전트(`adk_agent/`)는 포트 8200에서 실행되는 Google ADK FastAPI 애플리케이션입니다. 모든 SAP 및 RAG 도구 로직을 담당합니다. Next.js는 `ADK_BASE_URL`을 통해 에이전트 호출을 프록시합니다.

### 지원되는 SAP 모듈

| 모듈 | 서비스 ID | 엔티티 집합 | 핵심 필드 |
|-------|-----------|------------|---------|
| Product Master | API_PRODUCT_SRV | A_Product, A_ProductDescription, A_ProductPlant, A_ProductSales, A_ProductSalesDelivery, A_ProductStorage, A_ProductValuation, A_ProductUnitsOfMeasure | Product |

### ADK 에이전트 구성

`adk_agent/.env.example`에서 생성:

```bash
cp adk_agent/.env.example adk_agent/.env
```

```env
# === 데이터베이스 / RAG ===
DATABASE_URL=postgresql://username:password@localhost:5432/gemini_rag
EMBED_MODEL=gemini-embedding-2-preview
EMBED_OUTPUT_DIM=3072
EMBED_NORMALIZE=false

# === SAP 연결 ===
SAP_HOST=your-sap-host.example.com
SAP_AUTH_TYPE=basic   # 옵션: basic, sap_oauth

# === 자격 증명 암호화 (Fernet 키) ===
# 생성: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
SAP_CRED_ENCRYPTION_KEY=your-fernet-key

# === 기본 인증 (SAP_AUTH_TYPE=basic) ===
# SAP_USER=your-sap-username
# SAP_PASSWORD=your-sap-password

# === OAuth 2.0 (SAP_AUTH_TYPE=sap_oauth) ===
# SAP_OAUTH_CLIENT_ID=your-oauth-client-id
# SAP_OAUTH_CLIENT_SECRET=your-oauth-client-secret
# SAP_OAUTH_AUTHORIZE_URL=https://your-sap-host:44300/sap/bc/sec/oauth2/authorize?sap-client=100
# SAP_OAUTH_TOKEN_URL=https://your-sap-host:44300/sap/bc/sec/oauth2/token?sap-client=100
# SAP_OAUTH_REDIRECT_URI=http://localhost:3000/api/sap/oauth/callback

# === 서버 ===
ADK_HOST=0.0.0.0
ADK_PORT=8200
SESSION_BACKEND=memory   # memory (개발) | vertex (프로덕션)
```

#### `SAP_AUTH_TYPE` 옵션

| 값 | 설명 | 필수 변수 |
|----|------|-----------|
| `basic` | **HTTP 기본 인증** (기본값). 인라인 로그인 모달 또는 `SAP_USER`/`SAP_PASSWORD` 환경 변수로 자격 증명 제공. 개발, 데모, 서비스 간 호출에 적합. | `SAP_USER`, `SAP_PASSWORD` (또는 런타임 입력) |
| `sap_oauth` | **OAuth 2.0 Authorization Code + PKCE**. 사용자가 브라우저 팝업으로 인증; SAP가 Next.js `/api/sap/oauth/callback`으로 리다이렉트(Cloud Run 사이드카 불필요). 프로덕션 권장. | `SAP_OAUTH_CLIENT_ID`, `SAP_OAUTH_CLIENT_SECRET`, `SAP_OAUTH_AUTHORIZE_URL`, `SAP_OAUTH_TOKEN_URL`, `SAP_OAUTH_REDIRECT_URI` |

### ADK API 엔드포인트

| 메서드 | 엔드포인트 | 설명 |
|--------|----------|------|
| GET | `/healthz` | 헬스 체크 |
| POST | `/run` | LlmAgent에 메시지 전송 (스트리밍) |
| POST | `/api/sap/auth` | SAP 인증 트리거 (Basic 또는 OAuth Step 1) |
| GET | `/api/sap/oauth/callback` | OAuth Step 2 — Next.js 콜백 라우트에서 프록시 |

---

## Docker Compose (로컬 개발)

단일 명령으로 두 서비스를 실행:

```bash
# 먼저 env 파일 생성
cp .env.local.example .env.local
cp adk_agent/.env.example adk_agent/.env
# 자격 증명으로 둘 다 편집

docker compose up
```

이것은 다음을 시작합니다:
- **adk** 포트 8200 (`adk_agent/Dockerfile`에서 빌드)
- **nextjs** 포트 3000 (`ADK_BASE_URL=http://adk:8200`; `adk`에 의존)

---

## 프로덕션 배포

스크립트로 제공되는 두 가지 배포 토폴로지가 있으며, 둘 다 **하나의 공유
Cloud SQL Postgres + pgvector** 인스턴스로 백업됩니다:

- **모드 A — Cloud Run × 2.** `nextjs` + `adk_agent`를 두 Cloud Run
  서비스로 배포. 커스텀 Next.js 채팅 UI가 최종 사용자 화면.
- **모드 B — Vertex AI Agent Engine 단독.** `adk_agent`만 배포한 뒤
  **Gemini Enterprise**에 등록하여 사용자가 Gemini 채팅 화면에서 직접
  대화하도록 구성.

```bash
# 모드 A
./deploy/setup-cloud-sql.sh <PROJECT_ID>
./deploy/deploy-cloud-run.sh <PROJECT_ID>

# 모드 B
MODE=agent-engine VPC_NETWORK=<vpc> ./deploy/setup-cloud-sql.sh <PROJECT_ID>
./deploy/setup-agent-engine.sh <PROJECT_ID>
gcloud run deploy sap-oauth-callback --source ./cloud-run-oauth-callback \
  --region us-central1 --allow-unauthenticated \
  --set-env-vars=GOOGLE_CLOUD_PROJECT=<PROJECT_ID>
uv run python deploy/deploy-agent-engine.py --project <PROJECT_ID>
# → Resource Name: projects/.../reasoningEngines/...
# 그 이름을 Gemini Enterprise에 등록 (Agents → Register agent)
```

결정 매트릭스, 사전 요구 사항, 네트워크 토폴로지 다이어그램,
단계별 절차는 [`deploy/README.md`](./deploy/README.md) 참조.

---

## MCP (Model Context Protocol)

ADK 에이전트는 MCP를 통해 **Google Cloud Pub/Sub**에 대한 선택적 접근을
제공합니다 — Claude Code가 프로젝트 스코프 MCP 등록에 사용하는 동일한
`.mcp.json`이 에이전트 시작 시에도 읽힙니다 (`adk_agent/mcp_pubsub.py`).
이 파일이 있으면 LLM은 `list_topics`, `get_topic`, `list_subscriptions`,
`get_subscription`, `publish` 도구를 갖게 되며, 모두 도구/토픽/구독에 대한
**deny-by-default allowlist**로 게이트됩니다.

```jsonc
// .mcp.json (발췌)
{
  "mcpServers": {
    "pubsub": {
      "type": "http",
      "url": "https://pubsub.googleapis.com/mcp",
      "headers": { "x-goog-user-project": "<your-gcp-project>" },
      "allowedTools":         ["list_topics", "publish", ...],
      "allowedTopics":        ["sapphire-demo"],
      "allowedSubscriptions": ["sapphire-demo-sub"]
    }
  }
}
```

Pub/Sub **없이** 실행하려면 `.mcp.json`을 삭제하거나 이름을 변경하세요 —
에이전트는 6개가 아닌 5개의 기본 도구(RAG + 4 SAP)로 로드되고 시작 시
`mcp.pubsub.not_configured`를 한 번 로깅합니다. 다른 변경 사항은 없습니다.

전체 내용 — 이 프로젝트에서 MCP의 역할, deny-by-default 의미론, 모드별
`.mcp.json` 전달 방식 (모드 A: Dockerfile COPY, 모드 B: `extra_packages`
번들), IAM 요건, 새 MCP 서버 추가 방법 — 은
[`docs/ko/MCP.md`](./docs/ko/MCP.md) ([English](./docs/en/MCP.md)) 참조.

---

## 프로젝트 구조

```
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── page.tsx                  # / → /chat 리다이렉트
│   │   ├── chat/page.tsx             # SAP 상태가 있는 Chat UI
│   │   ├── admin/pipeline/page.tsx   # 배치 임베딩 대시보드
│   │   └── api/
│   │       ├── chat/route.ts         # 채팅 프록시 → ADK /run
│   │       ├── embed/route.ts        # 단일 파일 임베딩
│   │       ├── conversations/        # 대화 CRUD
│   │       ├── pipeline/             # 배치 파이프라인
│   │       ├── files/[...path]/      # GCS 파일 프록시
│   │       └── sap/                  # SAP 프록시 라우트
│   │           ├── auth/route.ts     # SAP 인증 (Basic + OAuth Step 1)
│   │           ├── oauth/callback/   # OAuth Step 2 프록시 → ADK
│   │           └── services/route.ts # SAP 서비스 목록
│   ├── lib/
│   │   ├── adk-client.ts            # ADK 에이전트용 HTTP 클라이언트
│   │   ├── gemini.ts                 # Gemini API 클라이언트 (인제스천)
│   │   ├── embedding.ts             # 임베딩 생성
│   │   ├── db.ts                     # PostgreSQL 연결
│   │   ├── schema.ts                # DB 스키마 (Drizzle)
│   │   ├── file-parser.ts           # 파일 파싱/청킹
│   │   ├── gcs.ts                    # GCS 업로드/다운로드
│   │   └── env.ts                    # 환경 변수
│   ├── components/
│   │   ├── ChatSidebar.tsx           # 대화 목록
│   │   ├── ChatWindow.tsx            # 메시지 표시
│   │   ├── ChatInput.tsx             # 입력 + 파일 첨부
│   │   ├── SAPDataView.tsx           # SAP 데이터 테이블 렌더러
│   │   └── PipelineDashboard.tsx     # 파이프라인 대시보드
│   └── scripts/
│       ├── setup-db.ts               # DB 초기화
│       └── pipeline.ts               # 배치 임베딩 CLI
├── adk_agent/                        # Google ADK Python 에이전트
│   ├── agent.py                      # LlmAgent + 5개 도구 정의
│   ├── server.py                     # FastAPI 엔트리포인트 (포트 8200)
│   ├── sap_gw_connector/             # 벤더드 SAP OData 커넥터
│   ├── .env.example                  # ADK 환경 변수 템플릿
│   ├── Dockerfile
│   └── pyproject.toml
├── scripts/
│   ├── check-parent-workspace.mjs    # predev: 부모 워크스페이스 감지
│   └── check-adk-health.mjs         # predev: ADK :8200 동작 확인
├── tests/e2e/                        # Playwright E2E 테스트
├── docker-compose.yml
└── docs/
```

---

## npm 스크립트

| 명령 | 설명 |
|------|------|
| `pnpm dev` | 개발 서버 시작 (http://localhost:3000) — predev에서 ADK 헬스 체크 |
| `pnpm build` | 프로덕션 빌드 |
| `pnpm start` | 프로덕션 서버 시작 |
| `pnpm lint` | ESLint 실행 |
| `pnpm db:setup` | PostgreSQL 테이블 및 인덱스 초기화 |
| `pnpm pipeline -- <path>` | 폴더에서 파일 배치 임베딩 |
| `pnpm e2e` | Playwright E2E 테스트 실행 (`tests/e2e/README.md` 참조) |
| `uv run python -m adk_agent.server` | 포트 8200에서 ADK 백엔드 시작 |

---

## 지원되는 파일 형식

> [Gemini Embedding 2 문서](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/embedding-2)를 기반으로 합니다.

| 카테고리 | MIME 유형 | 제한 사항 | 처리 방법 |
|----------|-----------|---------|----------|
| Text | 일반 텍스트 | 최대 8,192개 토큰 | 청킹(2000개 문자, 200 오버랩) |
| PDF | `application/pdf` | 요청당 최대 6페이지 | 6페이지 청크로 분할 + 다중 모드 임베딩 |
| Image | `image/png`, `image/jpeg` | 요청당 최대 6개 이미지 | Base64 → 다중 모드 임베딩 + AI 요약 |
| Audio | `audio/mp3`, `audio/wav` | 최대 80초 | Base64 → 다중 모드 임베딩 + AI 요약 |
| Video | `video/mpeg`, `video/mp4` | 최대 80초(오디오 포함) / 120초(무음) | Base64 → 다중 모드 임베딩 + AI 요약 |

추가 형식(`.txt`, `.md`, `.csv`, `.json`, `.xml`, `.html`, `.gif`, `.webp`, `.ogg`, `.flac`, `.m4a`, `.webm`, `.avi`, `.mov`)이 업로드되어 텍스트로 처리되거나 참조용으로 저장됩니다.

---

## 문제 해결

### pgvector 설치 오류

```
ERROR: could not open extension control file "vector"
```

```bash
# macOS
brew install pgvector

# Ubuntu
sudo apt install postgresql-17-pgvector

# Docker
docker run -p 5432:5432 pgvector/pgvector:pg16
```

### DATABASE_URL 연결 실패

```bash
brew services list | grep postgresql
brew services start postgresql@17
psql postgresql://username:password@localhost:5432/gemini_rag
```

### GCS 인증 오류

```
ERROR: Could not load the default credentials
```

`.env.local`의 `GOOGLE_APPLICATION_CREDENTIALS`를 확인하고 파일이 존재하는지 확인하세요.

### ADK 에이전트 미실행

```
pnpm dev 실패: ADK health check failed — http://localhost:8200/healthz returned no response
```

1. ADK 백엔드를 먼저 시작: `uv run python -m adk_agent.server`
2. 확인: `curl http://localhost:8200/healthz` → `{"status":"ok"}`
3. `.env.local`의 `ADK_BASE_URL` 확인 (기본값 `http://localhost:8200`)
4. `adk_agent/.env`의 필수 변수 확인 (`DATABASE_URL`, `SAP_CRED_ENCRYPTION_KEY` 등)

### SAP 연결 실패

```
SAP 연결 안 됨 (채팅의 황색 점)
```

1. Basic 인증: 채팅 UI의 인라인 SAP 로그인 양식에 자격 증명 입력
2. OAuth: SAP 로그인 버튼 클릭 — 팝업이 SAP 인증 URL을 열고, 인증 후 팝업이 자동으로 닫힘
3. `adk_agent/.env`의 `SAP_HOST` 및 `SAP_AUTH_TYPE` 확인

### SAP OAuth 콜백 문제

OAuth 팝업이 닫히지 않거나 세션이 설정되지 않는 경우:
1. `adk_agent/.env`의 `SAP_OAUTH_REDIRECT_URI`가 `http://localhost:3000/api/sap/oauth/callback`과 일치하는지 확인
2. `.env.local`에 `SAP_SESSION_SECRET`이 설정되어 있는지 확인
3. SAP Gateway에서 트랜잭션 `SOAUTH2`에 리다이렉트 URI가 구성되어 있는지 확인

### Gemini API 429 (속도 제한)

배치 파이프라인은 속도 제한이 발생하면 즉시 실패합니다. 속도 제한 처리(백오프를 사용한 재시도)는 호출자의 책임입니다.

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| 채팅 UI / 인제스천 | Next.js 16 (App Router), TypeScript, React 19 |
| 에이전트 프레임워크 | Google ADK (Python), 단일 LlmAgent |
| 에이전트 API | FastAPI, 포트 8200 |
| Embedding Model | gemini-embedding-2-preview (3072 차원) |
| LLM | Gemini (스트리밍, 도구 사용) |
| Vector DB | PostgreSQL + pgvector |
| ORM | Drizzle ORM |
| File Storage | Google Cloud Storage |
| AI Streaming | Vercel AI SDK v6 |
| SAP 인증 | Basic + OAuth 2.0 Authorization Code + PKCE |
| SAP Protocol | OData v2/v4 |
| UI | Tailwind CSS v4 + shadcn/ui |
| E2E 테스트 | Playwright |

> 자세한 아키텍처 및 코드 분석은 [docs/GUIDE.md](./docs/GUIDE.md)를 참조하세요.
