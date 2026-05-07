# sap-rag-integration — 개발자 가이드

> 오늘 실제로 존재하는 코드베이스를 따라가는 워크스루입니다: Google ADK
> Python `LlmAgent` (8200 포트)가 다섯 개의 도구 — pgvector RAG와 네 개의
> SAP OData 도구 — 를 소유하고, Next.js 16 채팅 UI와 인제스션 파이프라인
> (3000 포트)이 그 앞에 있습니다. Next.js 계층에는 **에이전트 로직이 없으며**,
> 모든 채팅 턴은 SSE를 통해 ADK 에이전트로 프록시됩니다. 레거시
> `sap-service/` Python 사이드카는 커밋 `822a49f`에서 제거되었습니다.

> 설치 단계를 찾는 경우 [`installation.md`](../installation.md)부터
> 시작하세요. 더 좁은 주제를 찾는 경우, [`docs/ko/`](./ko/) 아래의 로케일별
> 문서 세트 — `README`, `ARCHITECTURE`, `API`, `DEPLOYMENT`,
> `SAP_QUERY_EXAMPLES` — 가 각각을 분리해서 다룹니다. 이 가이드는 코드베이스를
> 처음 위에서 아래로 읽는 사람을 위해 그것들을 함께 묶습니다.

## 목차

1. [프로젝트 개요](#1-프로젝트-개요)
2. [기술 스택](#2-기술-스택)
3. [프로젝트 구조](#3-프로젝트-구조)
4. [환경 설정](#4-환경-설정)
5. [ADK 에이전트](#5-adk-에이전트)
6. [다섯 개의 LLM 도구](#6-다섯-개의-llm-도구)
7. [선택적 Pub/Sub MCP toolset](#7-선택적-pub-sub-mcp-toolset)
8. [Next.js API 표면](#8-nextjs-api-표면)
9. [프론트엔드 컴포넌트](#9-프론트엔드-컴포넌트)
10. [데이터베이스 스키마](#10-데이터베이스-스키마)
11. [인제스션 파이프라인](#11-인제스션-파이프라인)
12. [인증 모델](#12-인증-모델)
13. [Observability](#13-observability)
14. [테스트](#14-테스트)
15. [운영상의 함정](#15-운영상의-함정)

---

## 1. 프로젝트 개요

이 제품은 다음을 수행하는 채팅 어시스턴트입니다:

1. pgvector에 임베딩된 멀티모달 코퍼스 (텍스트, PDF, 이미지, 오디오,
   비디오)에 대한 질문에 답변.
2. **라이브 SAP** OData 서비스 (Product Master, Material Stock, Plant
   Master, Material Documents)에 대한 질문에 네 개의 타입화된 도구로
   답변.
3. 동일 턴 안에서 둘을 혼합 — 예: "스냅샷 문서가 FERT 제품에 대해
   말하는 것을 오늘의 SAP 데이터와 비교해" — 에이전트가 턴당 여러 도구를
   호출하도록 허용함으로써.

에이전트는 **단일** ADK `LlmAgent`입니다 (멀티 에이전트 오케스트레이션 없음,
LangGraph 없음). 도구 선택, 폴백, 응답 형성은 모두 시스템 프롬프트를 통해
일어납니다. Next.js 계층은:

- 채팅과 관리자 UI를 호스팅합니다.
- SSE를 통해 채팅 턴을 에이전트로 프록시합니다.
- 인제스션 파이프라인을 소유합니다 (에이전트는 pgvector에 대해 read-only).
- SAP 사용자별로 대화를 스코프하는 iron-session 로그인 쿠키를 소유합니다.

이 분리는 Python ADK 런타임을 에이전트 실행에 집중시키고, 사용자 대상
표면을 웹 개발자에게 가장 익숙한 프레임워크에 유지합니다.

## 2. 기술 스택

| 계층 | 선택 | 비고 |
|------|------|------|
| 웹 프레임워크 | Next.js 16 (App Router, Turbopack) | 모든 곳에서 `runtime='nodejs'`; 스트리밍/인제스션 라우트에 `maxDuration=300` |
| UI | React 19 + Tailwind 4 + shadcn/ui | 채팅용 `react-markdown` + `remark-gfm`; `lucide-react` 아이콘 |
| 에이전트 런타임 | `google-adk>=1.27` (Python 3.11+) | `LlmAgent` + `McpToolset`; `get_fast_api_app`이 FastAPI 표면 빌드 |
| 에이전트 트랜스포트 | FastAPI (uvicorn) | `/run_sse`의 SSE; `predev`가 `/healthz` health-probe |
| LLM | `gemini-3.1-pro-preview` | `SAP_AGENT_MODEL`로 오버라이드 |
| 임베딩 (인제스션) | `gemini-embedding-2-preview` | 3072차원 |
| 임베딩 (RAG 쿼리) | `gemini-embedding-001` | 3072차원, `task_type=RETRIEVAL_QUERY` |
| 벡터 저장소 | PostgreSQL 17 + `pgvector` `halfvec(3072)` | HNSW 인덱스; 코사인 거리 |
| ORM | Drizzle (Next 측) + asyncpg (ADK 측) | 커넥션 풀을 공유하지 않음 |
| 파일 저장소 | Google Cloud Storage | traversal 가드를 갖춘 `/api/files/[...path]`로 서빙 |
| 인증 | `iron-session` (`sap_session`, `sap_oauth_pending`) + SAP 자격증명용 Fernet | |
| 선택적 MCP | Google Cloud Pub/Sub HTTP MCP | `.mcp.json`에 deny-by-default allowlist |
| 로깅 | `pino` (Next) + `structlog` (ADK) | `LOG_LEVEL`, `LOG_PAYLOAD`, `LOG_FORMAT` 공유 |

## 3. 프로젝트 구조

```
sap-rag-integration/
├── adk_agent/                    # Python: LlmAgent + 도구 + MCP
│   ├── agent.py                  # root_agent 와이어링
│   ├── server.py                 # FastAPI 부트스트랩 (build_app + main)
│   ├── settings.py               # 동결된 dataclass env 로더
│   ├── probes.py                 # 4개의 시작 프로브
│   ├── mcp_pubsub.py             # Pub/Sub MCP toolset + 리소스 게이트
│   ├── oauth.py                  # SAP OAuth2 PKCE 헬퍼
│   ├── crypto.py                 # 패스워드 at-rest용 Fernet 래퍼
│   ├── sap_auth_config.py        # ADK AuthConfig 빌더 (현재 미사용)
│   ├── services.yaml             # SAP 카탈로그 (4개 서비스)
│   ├── rag/
│   │   ├── db.py                 # asyncpg 풀 + 코사인 검색
│   │   └── embedding.py          # genai embed_content (RETRIEVAL_QUERY)
│   ├── tools/
│   │   ├── rag_tool.py           # search_documents
│   │   ├── auth_tool.py          # sap_authenticate
│   │   ├── service_tool.py       # sap_list_services
│   │   ├── query_tool.py         # sap_query
│   │   └── entity_tool.py        # sap_get_entity
│   ├── sap_gw_connector/         # 벤더링된 SAP Gateway 클라이언트
│   ├── tests/                    # pytest 단위 테스트
│   ├── Dockerfile                # python:3.12-slim + uv sync, EXPOSE 8200
│   └── .env.example
│
├── src/                          # TypeScript: Next.js 앱
│   ├── app/
│   │   ├── layout.tsx, page.tsx (redirect → /chat)
│   │   ├── chat/page.tsx
│   │   ├── admin/pipeline/page.tsx
│   │   └── api/
│   │       ├── chat/route.ts
│   │       ├── conversations/{[…],[id]/messages/}
│   │       ├── embed/route.ts
│   │       ├── pipeline/{start,status,upload}/route.ts
│   │       ├── files/[...path]/route.ts
│   │       └── sap/{auth,oauth/callback,services}/route.ts
│   ├── components/               # ChatWindow, ChatSidebar, ChatInput, SAPDataView, PipelineDashboard, ui/*
│   ├── lib/
│   │   ├── adk-client.ts         # SSE 파서 + runSse + createSession + authBasic
│   │   ├── session.ts            # iron-session sap_session 쿠키 (8h)
│   │   ├── oauth-pending.ts      # iron-session sap_oauth_pending 쿠키 (10m)
│   │   ├── db.ts + schema.ts     # Drizzle: embeddings, conversations, messages
│   │   ├── embedding-ingest.ts   # text/pdf/image/audio/video 인제스션
│   │   ├── gemini.ts             # GoogleGenAI 클라이언트 래퍼
│   │   ├── gcs.ts                # uploadToGCS + downloadFromGCS (traversal 가드)
│   │   ├── file-parser.ts        # category, MIME, EMBEDDING_LIMITS, chunkText
│   │   ├── env.ts                # 필수 vs 선택 가드
│   │   ├── pipeline-state.ts     # 인메모리 인제스션 진행 singleton
│   │   ├── request-context.ts    # {requestId, conversationId}용 AsyncLocalStorage
│   │   ├── concurrency.ts        # mapWithLimit (제한된 병렬 매퍼)
│   │   ├── logger.ts             # 리덕션을 갖춘 pino
│   │   └── utils.ts
│   ├── proxy.ts                  # Next 16 proxy.ts — REQUIRE_AUTH 게이트
│   └── scripts/                  # setup-db, migrate-sap-user-id, pipeline (CLI)
│
├── scripts/                      # 레포 전체 스크립트
│   ├── check-parent-workspace.mjs (predev)
│   ├── check-adk-health.mjs       (predev)
│   ├── setup-gcp-service-account.sh
│   ├── test_pubsub_mcp_live.py
│   ├── fetch_sap_metadata.py
│   ├── list_sap_services.py
│   ├── benchmark-rag.ts
│   └── migration-parity-check.py + parity-targets.yaml  # 폐기됨; sap-service가 사라짐
│
├── tests/e2e/                    # Playwright 스모크 테스트
├── docs/                         # 이 디렉터리
├── .mcp.json                     # 프로젝트 스코프 Pub/Sub MCP 설정
├── docker-compose.yml            # nextjs + adk (sap-service 없음)
├── next.config.ts                # CSP, turbopack.root, image remotePatterns
├── drizzle.config.ts, vitest.config.ts, playwright.config.ts, eslint.config.mjs
├── package.json + pnpm-lock.yaml + pnpm-workspace.yaml
├── pyproject.toml + uv.lock
├── README.md, README.ko.md, installation.md, CLAUDE.md
└── .env.local.example, adk_agent/.env.example
```

## 4. 환경 설정

env 파일이 두 개 있습니다 — 프로세스당 하나씩. 템플릿은
`.env.local.example`과 `adk_agent/.env.example`로 제공됩니다. 필수 및
선택 키의 전체 레퍼런스는
[DEPLOYMENT.md §1](./ko/DEPLOYMENT.md#1-환경-변수)에 있고, 단축 버전은:

| 파일 | 반드시 설정 |
|------|------------|
| `.env.local` | `GEMINI_API_KEY`, `DATABASE_URL`, `GCS_BUCKET_NAME`, `GCS_PROJECT_ID`, `SAP_SESSION_SECRET` |
| `adk_agent/.env` | `DATABASE_URL`, `SAP_HOST`, `EMBED_MODEL`, `EMBED_OUTPUT_DIM`, `SAP_CRED_ENCRYPTION_KEY` |

`SAP_SESSION_SECRET`은 32자 이상의 iron-session 서명 키
(`openssl rand -base64 48`). `SAP_CRED_ENCRYPTION_KEY`는 Fernet 키
(`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`).

ADK 에이전트가 `${ADK_BASE_URL}/healthz`에서 응답하지 않으면 Next.js
프로세스는 `pnpm dev`를 통해 부팅을 거부합니다 (predev 가드는
`scripts/check-adk-health.mjs`). 또한 부모 디렉터리에 workspace marker
파일 (`package.json`, `pnpm-workspace.yaml`, `*-lock.*`)이 나타나면
부팅을 거부합니다 — 이는 CLAUDE.md에 문서화된 Turbopack CSS 리졸버
버그입니다.

부팅 순서:

```bash
# 터미널 1
uv run python -m adk_agent.server   # /healthz green에서 블록

# 터미널 2
pnpm dev                            # predev가 ADK probe, 그다음 next dev
```

## 5. ADK 에이전트

### 5.1 `agent.py` — 루트 에이전트

`adk_agent/agent.py`는 다음을 갖춘 단일 `Agent` (`LlmAgent`의 별칭)을
빌드합니다:

- `name="sapphire26_agent"`
- `model = os.getenv("SAP_AGENT_MODEL", "gemini-3.1-pro-preview")`
- LLM에 다음을 지시하는 짧은 시스템 프롬프트:
  - 문서 질문은 `search_documents`로 라우팅.
  - SAP 질문은 `sap_query` / `sap_get_entity`로 라우팅.
  - 모든 `action_required` envelope을 그대로 노출 — `login_url`이
    있으면 포함 — 프론트엔드가 로그인 affordance를 렌더링할 수 있도록.
  - SAP 결과는 마크다운 테이블로 렌더링하고 RAG `source` 필드 인용.
- 다음 순서로 등록된 도구:
  1. `search_documents`
  2. `sap_authenticate`
  3. `sap_list_services`
  4. `sap_query`
  5. `sap_get_entity`
  6. *(선택)* `setup_pubsub_mcp()`이 번들을 반환하면 `McpToolset(pubsub …)`.
- Pub/Sub이 와이어링된 경우에만 `before_tool_callback = _pubsub.gate`.

에이전트는 자체 대화 메모리 계층을 유지하지 **않습니다** — 이는 ADK
세션 백엔드의 일입니다. `ADK_SESSION_BACKEND=memory` (기본)에서는 상태가
복제본별로 저장됩니다; 다중 복제본 배포에서는 `vertex`로 전환해 Vertex
AI Agent Engine 세션 저장소를 사용하세요.

### 5.2 `server.py` — FastAPI 부트스트랩

`build_app(run_probes=True)`:

1. 설정 로드 (`adk_agent/settings.py`).
2. 네 개의 시작 프로브 모두 실행 (yaml, db, embed model, secret manager).
3. `google.adk.cli.fast_api.get_fast_api_app(agents_dir, session_service_uri, allow_origins=["http://localhost:3000"], web=False)` 호출 — 이는 `/run`, `/run_sse`, 그리고 표준 ADK 컨트롤 표면을 제공합니다.
4. 두 개의 커스텀 라우트 추가:
   - `GET /healthz` — `pnpm predev`가 사용.
   - `POST /sap/auth/basic` — `sap_authenticate(method="basic", …)`의 직접 호출. Next.js 로그인 라우트가 LLM을 거치지 않고 Fernet 암호화된 자격증명으로 iron-session 쿠키를 시드할 수 있도록.
5. `main()`은 동기적으로 프로브를 실행한 다음 `uvicorn.run(app, host=ADK_HOST, port=ADK_PORT)`.

### 5.3 `settings.py` — env 로더

동결된 dataclass; `[DATABASE_URL, SAP_HOST, EMBED_MODEL,
EMBED_OUTPUT_DIM, SAP_CRED_ENCRYPTION_KEY]` 중 어느 것이라도 설정되지
않으면 시작 시 `RuntimeError("missing env: …")`을 발생시킵니다. 잘못된
설정을 LLM 핫 패스에서 제외합니다.

### 5.4 `probes.py` — 시작 프로브

네 개의 프로브 (모두 `asyncio.run`으로 실행):

1. `_probe_services_yaml` — `services.yaml` 로드, 비어 있으면 실패.
2. `_probe_db` — asyncpg로 연결, `embeddings` 테이블 존재 확인.
3. `_probe_embed_model` — `"ping"` 임베드, 차원 = `EMBED_OUTPUT_DIM` 확인.
4. `_probe_secret_manager` — `GOOGLE_CLOUD_PROJECT`이 설정된 경우에만 실행.

실패한 프로브는 FastAPI 앱 시작을 방지하므로, 어떤 전제조건이든 깨졌을
때 `/healthz`는 절대 green을 보고하지 않습니다.

### 5.5 `crypto.py` — Fernet 래퍼

`SAP_CRED_ENCRYPTION_KEY`에서 lazy하게 초기화되는 singleton.
`sap_authenticate`가 SAP basic-auth 비밀번호를 ADK 프로세스 외부로
나가기 전에 암호화하는 데 사용되며, OData 호출의 순간에 (`query_tool` /
`entity_tool`의) `_client_for`가 복호화하는 데 사용됩니다. 어디에도 평문
비밀번호가 영구 저장되지 않습니다 — iron-session 쿠키조차 암호화된
blob을 운반합니다.

## 6. 다섯 개의 LLM 도구

각 도구는 `adk_agent/tools/*.py`의 `async def` callable입니다.
`tool_context` 인자는 호출 시점에 ADK가 제공하며, 채팅 라우트가 시드한
세션 상태를 노출합니다.

### 6.1 `search_documents`

```python
search_documents(query: str, top_k: int = 8) -> dict
```

`EMBED_MODEL` (`task_type=RETRIEVAL_QUERY`)로 쿼리를 임베드하고
pgvector 코사인 검색을 실행합니다:

```sql
SELECT id, file_name, chunk_text, 1 - (embedding <=> $1::vector) AS score
FROM embeddings
ORDER BY embedding <=> $1::vector
LIMIT $2
```

`{results: [{id, file_name, chunk_text, score}], count}`을 반환합니다.
embed-model 실패나 DB 사용 불가 시 soft envelope
`{results: [], count: 0, warning: "embedding_unavailable" | "vector_db_unavailable"}`을
반환합니다 — 에이전트는 이를 에러가 아닌 "결과 없음"으로 처리하므로
채팅이 계속 흐릅니다.

### 6.2 `sap_authenticate`

단일 SAP 인증 게이트. 세 가지 호출 모양:

| 모양 | 의미 |
|------|------|
| `method="basic", username, password` | Basic 헤더로 SAP probe, `{success, sap_user, credentials:{...encrypted}}` 반환 |
| `method="oauth", user_id` | Step 1: `oauth.build_login_url` 호출, `{success:false, action_required:"sap_login", login_url, oauth_state}` 반환 |
| `method="oauth", code, state, user_id` | Step 2: `oauth.exchange_code` 호출, `{success, access_token, refresh_token, sap_user, expires_at}` 반환 |

시스템 프롬프트는 `action_required` envelope을 그대로 포워딩하며,
`ChatWindow.tsx`는 `action_required: "sap_login"`을 인식해 인라인 로그인
폼 (basic) 또는 OAuth `login_url` (oauth)을 렌더링합니다.

### 6.3 `sap_list_services`

`adk_agent/services.yaml`의 동기 읽기. 런타임에 절대 에러를 발생시키지
않음 (YAML이 비어 있다면 시작 프로브가 이미 실패했을 것).

번들된 카탈로그는 네 개의 서비스를 다룹니다:

- `API_PRODUCT_SRV` — Product Master (주력; ~32개 entity set)
- `API_MATERIAL_STOCK_SRV` — Material Stock
- `API_PLANT_SRV` — Plant Master
- `API_MATERIAL_DOCUMENT_SRV` — Material Documents

각 entity는 `name`, `key_field`, `description`, `navigations`,
`default_select`을 가지므로 에이전트가 시행착오 없이 사소하지 않은
`sap_query` 호출을 구성하기에 충분한 메타데이터가 있습니다.

### 6.4 `sap_query`

호출당 새로 빌드된 `SAPClient`를 통해 SAP를 호출합니다 (`async with`
블록 안에서). v2 (`d.results`)와 v4 (`value`) 응답 envelope 모두
`_transform`이 정규화합니다.

```python
sap_query(
    service_id: str,
    entity_set: str,
    filter: str | None = None,    # OData $filter 절
    select: str | None = None,    # OData $select 절
    top: int | None = None,
    skip: int | None = None,
) -> dict
```

인증 게이팅: `tool_context.state["sap_credentials"]`이 누락되면
`{success:false, action_required:"sap_login", error:"not_authenticated"}`을
반환하고 절대 네트워크에 닿지 않습니다. `SAPAuthenticationError` (예:
대화 도중 만료된 토큰) 발생 시 envelope이 `action_required:
"re_authenticate"`로 업그레이드되어 프론트엔드가 사용자에게 재로그인을
요청할 수 있습니다.

### 6.5 `sap_get_entity`

`sap_query`와 동일한 인증 모델. 키로 단일 엔티티 fetch:

```python
sap_get_entity(service_id: str, entity_set: str, key: str) -> dict
```

`{success: true, entity: {…}}`을 반환합니다.

## 7. 선택적 Pub/Sub MCP toolset

레포 루트의 `.mcp.json`이 `mcpServers.pubsub` HTTP MCP 항목
(`https://pubsub.googleapis.com/mcp`)을 정의합니다. ADK가 부팅하면
`adk_agent/mcp_pubsub.py:setup_pubsub_mcp()`은:

1. `.mcp.json`을 파싱하고 `type=="http"`, URL, 필수
   `x-goog-user-project` 헤더를 검증.
2. `https://www.googleapis.com/auth/pubsub` 스코프의 ADC를 획득.
3. `McpToolset(StreamableHTTPConnectionParams, tool_filter=allowed_tools, header_provider=…)`을 빌드. 헤더 제공자는 **HTTP 교환마다** 호출되므로 토큰 갱신은 투명하게 일어납니다 — toolset 객체를 절대 다시 빌드할 필요가 없습니다.
4. (에이전트 프롬프트에 추가되는) `instruction_block`을 빌드해서
   허용된 도구/토픽/구독과 인자 모양 힌트 (평문 `projectId`, publish의
   base64 인코딩된 `data`)를 나열.
5. `gate` (`before_tool_callback`)을 빌드. 게이트는 도구 인자에서
   `topicId / topic / topicName / topic_name` (및 subscription 변형) 중
   어느 것이든 검사하고, `_extract_bare_name`을 통해 `projects/X/topics/`와
   `topics/` 접두어를 벗긴 후, 매칭되지 않는 값은
   `{"isError": true, "content":[{"type":"text","text":"Access denied: …"}]}`로
   거부합니다.

기본 정책은 **deny-by-default**입니다:

| `.mcp.json` 필드 | 누락/비어 있을 때 효과 |
|------------------|----------------------|
| `allowedTools` | Pub/Sub 도구 0개 노출 |
| `allowedTopics` | 모든 `topicId` 인자 거부 |
| `allowedSubscriptions` | 모든 `subscriptionId` 인자 거부 |

호출자 principal은 `roles/mcp.toolUser` (`mcp.tools.call` 권한 게이트)와
`roles/pubsub.editor` 모두를 보유해야 합니다. 로컬 개발에서는
`gcloud auth application-default login` 한 번이면 충분합니다.

end-to-end 와이어링 검증:

```bash
uv run python scripts/test_pubsub_mcp_live.py
```

## 8. Next.js API 표면

모든 라우트는 `src/app/api/**/route.ts` 아래에 있습니다. `runtime='nodejs'`을
사용하며 대부분 `maxDuration=300`을 고정합니다. `sap_session` 쿠키가
표준 인증 시그널이며, 누락 시 `requireSession()`은 `401 NOT_AUTHENTICATED`을
반환합니다.

| 경로 | 메서드 | 역할 |
|------|--------|------|
| `/api/chat` | POST | ADK `/run_sse`로의 SSE 프록시; 사용자 + 어시스턴트 메시지 영구 저장; 첫 턴에 자동 제목 |
| `/api/conversations` | GET / POST / DELETE | `conversations.sap_user_id`로 스코프된 CRUD |
| `/api/conversations/[id]/messages` | GET | 대화의 정렬된 메시지 |
| `/api/embed` | POST | 단일 파일 multipart 업로드 (≤100 MB) → `embedFile` |
| `/api/pipeline/start` | POST | 백그라운드 배치 인제스션 (`./data` / `./uploads` 아래 로컬, 또는 `gs://…`) |
| `/api/pipeline/upload` | POST | Multipart `files[]` 인제스션 |
| `/api/pipeline/status` | GET | 인메모리 `pipeline-state`의 스냅샷 |
| `/api/files/[...path]` | GET | traversal 가드를 갖춘 GCS 파일 프록시 |
| `/api/sap/auth` | GET / POST / DELETE | 로그인 / probe / 로그아웃. POST `{method:"basic"}`은 ADK `/sap/auth/basic`으로 프록시되어 `sap_session` 설정 |
| `/api/sap/oauth/callback` | GET | OAuth `?code&state` 랜딩 — Step-2 와이어링까지 현재는 fail closed |
| `/api/sap/services` | GET | ADK `/run`에서 `sap_list_services` 포워딩 |

자세한 페이로드, 상태 코드, SSE 이벤트 모양은 [API.md](./ko/API.md)에
있습니다. 두 가지 자명하지 않은 부분을 강조할 가치가 있습니다:

- **채팅 라우트**는 각 SSE 청크를
  `src/lib/adk-client.ts:normalizeAdkEvent`을 통해 파싱하며, 이는 Gemini
  `parts[]`를 `{type: text_delta | tool_call | tool_result | error}`로
  평탄화하고 `partial:false` 집계 텍스트 프레임을 **드롭**합니다. 이
  드롭이 없으면 채팅이 조립된 메시지를 두 번 렌더링합니다.
- **OAuth 콜백**은 stub입니다. Step-2 토큰 교환은
  `adk_agent/oauth.exchange_code`에 있지만, Next.js 라우트가 아직
  이를 호출하지 않습니다; 대신 부모 윈도우에 실패 메시지를 포스트하는
  팝업 HTML을 렌더링합니다. 이는
  [`docs/followups/post-migration.md`](./followups/post-migration.md)에
  추적됩니다.

## 9. 프론트엔드 컴포넌트

```
src/components/
├── ChatSidebar.tsx        # 대화 목록, new/select/delete, 세션 사용자 헤더, 로그아웃
├── ChatWindow.tsx         # remark-gfm을 갖춘 마크다운 스트림, 복사 버튼, 첨부 그리드, 인라인 SAP 로그인 폼
├── ChatInput.tsx          # 텍스트영역 + 클립 파일 픽커 + 전송
├── PipelineDashboard.tsx  # 소스 경로 입력 + 폴더 업로드 + 상태 폴링
├── SAPDataView.tsx        # 일반 record-array → 테이블 렌더러 (채팅 안에서 사용)
└── ui/                    # shadcn 프리미티브 (button, card, dialog, input, …)
```

`src/app/chat/page.tsx`의 채팅 셸은 `ChatSidebar + ChatWindow +
ChatInput`의 얇은 컴포지션입니다. 클라이언트 측 상태 관리자는 없으며 —
로컬 상태는 컴포넌트 훅에 살고 서버 상태는 API 라우트에 대해
`fetch()`로 가져옵니다.

## 10. 데이터베이스 스키마

세 개의 테이블, `src/lib/schema.ts`에 정의되고 `pnpm db:setup`이 생성:

```text
embeddings
  id              uuid pk
  file_name       text
  file_type       text
  file_path       text
  chunk_index     int
  chunk_text      text
  content_summary text
  embedding       vector(3072)
  metadata        jsonb
  created_at      timestamptz default now()

  index (file_name)
  index hnsw (embedding halfvec_cosine_ops)

conversations
  id              uuid pk
  sap_user_id     varchar(255) not null
  title           text
  created_at, updated_at

  index (sap_user_id, updated_at desc)

messages
  id              uuid pk
  conversation_id uuid references conversations(id) on delete cascade
  role            text
  content         text
  file_name       text
  attachments     jsonb
  created_at      timestamptz default now()

  index (conversation_id, created_at)
```

`sap_user_id`는 `sap_authenticate`이 반환한 SAP 로그인 이름입니다.
모든 conversations CRUD 엔드포인트는 이 값으로 필터링합니다 —
iron-session 쿠키가 웹 사용자를 SAP 사용자에 바인딩하며, 다른 SAP
사용자가 소유한 row는 보이지 않습니다.

`sap_user_id` 컬럼이 없는 레거시 DB의 경우 `pnpm db:migrate:sap-user-id`이
이를 idempotent하게 추가합니다.

## 11. 인제스션 파이프라인

진입점: `src/lib/embedding-ingest.ts:embedFile(buffer, fileName)`.

1. `file-parser.getFileCategory(fileName)` → `text | pdf | image | audio | video`.
2. `src/lib/gcs.ts:uploadToGCS`을 통해 `uploads/{uuid}{ext}`의 GCS에
   버퍼 업로드.
3. 카테고리에 따라 분기:
   - **text** — `chunkText(content, 2000, 200)`, 그다음 각 청크를
     병렬로 임베드 (`mapWithLimit`을 통한 동시성 3).
   - **pdf** — `pdf-lib`이 6페이지 슬라이스로 분할; 각 슬라이스는
     멀티모달 임베딩을 위해 `application/pdf` inlineData로 전송되며,
     `pdf-parse`가 텍스트를 추출하고
     `gemini.ts:generateContentSummary`이 AI 요약을 생성.
   - **image / audio / video** — 파일을 `inlineData`로 단일 멀티모달
     임베딩 + AI 요약.
4. 3072차원 벡터와 `metadata` jsonb (mime 타입, 크기, 페이지 인덱스 등)와
   함께 `embeddings`에 INSERT.

`/api/pipeline/start` (로컬 디렉터리 또는 `gs://…` 접두어)와
`/api/pipeline/upload` (다중 파일의 브라우저 업로드) 모두 이 루프를
백그라운드 작업으로 감쌉니다. 진행 상황은 인메모리 `pipeline-state`
singleton에 살며; 관리자 UI는 `/api/pipeline/status`을 폴링합니다.
**영구 저장 없음** — Next.js 프로세스를 재시작하면 in-flight 상태가
지워집니다.

일회성 CLI 사용:

```bash
pnpm pipeline -- ./data
pnpm pipeline -- gs://my-bucket/documents
```

## 12. 인증 모델

### 12.1 웹 세션

`SAP_SESSION_SECRET`로 서명된 `iron-session` 쿠키 `sap_session`. TTL
8시간. `httpOnly`, `sameSite=lax`, `secure`는 프로덕션에서만. Body:
`{sapUserId, loggedInAt, sapCredentials?}`. `src/lib/session.ts`에 정의.

별도의 `sap_oauth_pending` 쿠키 (10분 TTL, 동일 시크릿)는 in-flight
OAuth state를 보유해 `/api/sap/oauth/callback`이 반환된 `state`
파라미터를 검증할 수 있게 합니다 (`src/lib/oauth-pending.ts`).

### 12.2 SAP 자격증명

Basic 인증: 비밀번호는 `sap_authenticate` 응답이 에이전트를 떠나기 전에
ADK 프로세스에서 (`crypto.encrypt`로) Fernet 암호화됩니다. 암호화된
blob은 Next.js를 거쳐 iron-session 쿠키로 round-trip하고, 다음 채팅 턴에
ADK 세션 상태에 다시 시드되며, OData 호출의 순간에만 `_client_for`
안에서 복호화됩니다.

OAuth + PKCE: `oauth.build_login_url`과 `oauth.exchange_code`는 PKCE를
사용합니다; 채팅 주도 흐름은 [ARCHITECTURE.md §4.2](./ko/ARCHITECTURE.md#42-oauth-20--pkce)에
문서화되어 있습니다. Next.js 콜백에서 에이전트로의 Step-2 와이어링이
열린 후속 작업입니다.

### 12.3 프록시 게이트

`src/proxy.ts` (Next 16에서 미들웨어 이름 변경)는 `REQUIRE_AUTH=true`이
아닌 한 no-op입니다. 활성화되면 핸들러별 `requireSession()` 검사에
추가로 프록시 계층에서 `/api/chat`, `/api/embed`, `/api/conversations`,
`/api/pipeline/*`, `/api/files/*`, `/api/sap/services`을 게이트합니다.
사용자가 로그인할 수 있도록 `/api/sap/auth`는 의도적으로 제외됩니다.

### 12.4 Pub/Sub allowlist

`before_tool_callback` 게이트 (§7 참조)는 업스트림 MCP 서버가 더 많이
노출하더라도 LLM이 큐레이션된 집합 외부의 토픽이나 구독에 접근하는
것을 차단합니다.

## 13. Observability

두 프로세스 모두 구조화된 JSON을 로깅합니다. 따르는 env 변수:

- `LOG_LEVEL` — `debug | info | warn | error`
- `LOG_PAYLOAD` — `meta` (상태 + 카운트) 또는 `full` (응답 본문).
  적극적으로 디버깅하지 않는 한 프로덕션에서는 `meta` 유지 — `full`은
  리덕션되지 않은 SAP 응답을 작성합니다.
- `LOG_FORMAT` (Next 전용) — `pretty`는 stdout pino-pretty 타깃 추가;
  파일 출력은 항상 JSON.
- `LOG_DIR` (Next 전용) — 파일 출력 디렉터리, 기본 `./logs`.

`src/lib/logger.ts`는 리덕션 목록을 정의합니다: `Authorization`,
`Set-Cookie`, `Cookie`, `access_token`, `refresh_token`, `password`.

`src/lib/request-context.ts`는 `AsyncLocalStorage`를 사용해 단일 채팅 턴
도중 발생한 모든 로그 라인에 `{requestId, conversationId}`를
부착합니다 — 사용자의 대화에 대해 프로덕션 로그를 grep할 때 유용합니다.

ADK 에이전트는 `structlog`를 사용합니다; 로그는 stdout으로 가며 Cloud
Run / Docker가 수집합니다.

## 14. 테스트

| 표면 | 도구 | 명령 |
|------|------|------|
| Next.js 단위 | Vitest + v8 coverage | `pnpm test` / `pnpm test:run` / `pnpm test:coverage` |
| Next.js e2e | Playwright (단일 chromium 프로젝트) | `pnpm e2e` (Next + ADK가 이미 실행 중이라고 가정) |
| ADK 단위 | pytest + pytest-asyncio + pytest-cov | `uv run pytest` |
| Pub/Sub MCP 라이브 | Python 스크립트 | `uv run python scripts/test_pubsub_mcp_live.py` |

커버리지 게이트는 프로젝트별로 추적됩니다. ADK 측은 마이그레이션 시점에
80%+ 단위 커버리지로 출시되었습니다 (MCP 전용 테스트는
`uv run python -m pytest adk_agent/tests/unit/test_mcp_pubsub_*`).

Vitest 설정 (`vitest.config.ts`): `node` env, `src/**/__tests__/**/*.test.ts`
포함, 셋업 `./src/lib/__tests__/_support/setup.ts`, alias `@` → `./src`.

## 15. 운영상의 함정

긴 디버깅 세션 전에 외울 가치가 있는 함정들입니다.

### 15.1 부모 워크스페이스 Turbopack 버그

`pnpm dev`가 첫 요청에서 멈추거나, 호스트 메모리를 다 잡아먹거나,
`posix_spawn EAGAIN` 에러를 스팸하면:

- 원인: Turbopack의 CSS `@import` 리졸버가 `next.config.ts`의
  `turbopack.root`를 따르지 **않습니다**. 부모 디렉터리에 workspace
  marker 파일 (`package.json`, `*-lock.*`, `pnpm-workspace.yaml`)이
  나타나면 Turbopack이 그 부모를 워크스페이스 루트로 취급하여
  `globals.css`의 `@import "tailwindcss"` 해석에 실패하고, OS fork 풀이
  소진될 때까지 컴파일당 CSS 청크당 ~30 KB의 resolve-trace 에러를
  덤프합니다.
- 수정: 문제의 부모 파일 제거, 그다음 `rm -rf .next` 후 재시작.
- 방어: `scripts/check-parent-workspace.mjs`이 `predev`로 실행되어 빠르게
  실패합니다; `dev` 스크립트는 OS fork 풀이 소진되기 전에 Node가 OOM
  하도록 `NODE_OPTIONS=--max-old-space-size=4096`을 설정합니다.
- 업스트림 드래프트:
  [`docs/issues/2026-04-29-nextjs-turbopack-css-resolver-bug.md`](./issues/2026-04-29-nextjs-turbopack-css-resolver-bug.md).

### 15.2 `pnpm dev` 전에 ADK가 떠 있어야 함

`scripts/check-adk-health.mjs`이 `predev`로 실행되며
`${ADK_BASE_URL}/healthz`이 green이 아니면 1로 종료됩니다. `predev`를
우회하면 채팅 라우트가 모든 턴에서 503을 반환합니다.

### 15.3 HMR singleton 누적

`db.ts`, `logger.ts`, `gemini.ts`, `gcs.ts`는 HMR 모드에서 모듈
재평가 시 재인스턴스화됩니다. 긴 dev 세션은 Postgres 풀과 쓰기
스트림을 누적합니다. CLAUDE.md에 계획된 정리 작업으로 추적됩니다.

### 15.4 인메모리 상태

`pipeline-state.ts`와 기본 ADK 세션 백엔드 (`memory`) 둘 다 프로세스
재시작 시 리셋됩니다. 다중 복제본 프로덕션에서는 ADK를
`ADK_SESSION_BACKEND=vertex`로 전환해 Vertex AI Agent Engine 세션
저장소를 사용하세요.

### 15.5 임베딩 모델 동등성

인제스션 경로는 `gemini-embedding-2-preview`을 사용합니다 (Next 측);
RAG 쿼리 경로는 `gemini-embedding-001`을 사용합니다 (ADK 측). 둘 다
`vector(3072)`을 대상으로 하며 호환되는 임베딩을 사용합니다. 둘 중
어느 것이라도 변경하면, 해당 env 변수 (`GEMINI_EMBEDDING_MODEL` 또는
`EMBED_MODEL`)을 업데이트하고 `EMBED_OUTPUT_DIM`이 여전히 컬럼 타입과
일치하는지 확인하세요 — `vector(N)` 컬럼은 in-place로 ALTER할 수
없습니다.

### 15.6 폐기된 아티팩트

- `sap-service/` — 커밋 `822a49f`에서 비워졌습니다; `__pycache__`와
  떠도는 `.env`만 남아 있습니다. 삭제해도 안전합니다.
- `scripts/migration-parity-check.py`와 `scripts/parity-targets.yaml`
  — 이전 `sap-service`의 `/query`를 새 ADK `sap_query`와 비교했습니다;
  레거시 서비스가 사라졌으므로 더 이상 유용하지 않습니다.

---

## 함께 보기

- [`README.md`](../README.md) — 최상위 README (영어)
- [`README.ko.md`](../README.ko.md) — 최상위 README (한국어)
- [`installation.md`](../installation.md) — 에이전트가 실행 가능한 설치 단계
- [`docs/en/`](./en/) — 로케일별 문서 세트 (영어)
- [`docs/ko/`](./ko/) — 로케일별 문서 세트 (한국어)
- [`docs/superpowers/specs/2026-04-29-adk-migration-design.md`](./superpowers/specs/2026-04-29-adk-migration-design.md) — 원래 마이그레이션 설계 문서
- [`docs/followups/post-migration.md`](./followups/post-migration.md) — 열린 후속 항목 (배포 타깃, Secret Manager, OAuth Step 2 와이어링)
