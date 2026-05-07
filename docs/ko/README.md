# sap-rag-integration

프로덕션 수준의 RAG + SAP 에이전틱 워크플로우입니다. 단일 Google ADK
`LlmAgent`(Python, 8200 포트)가 다섯 개의 도구 — 멀티모달 코퍼스에 대한
벡터 검색과 네 개의 SAP OData 도구 — 를 소유하며, Next.js 16 앱은 채팅 UI와
인제스션 파이프라인을 제공합니다. Next.js 계층에는 **에이전트 로직이 없으며**,
모든 채팅 턴은 SSE를 통해 ADK 에이전트로 프록시됩니다.

## 구성 요소

| 구성 요소 | 스택 | 포트 | 역할 |
|----------|------|------|------|
| Next.js 앱 | Next 16 + React 19 + Tailwind 4 | 3000 | 채팅 UI, 관리자 파이프라인 UI, ADK 프록시, GCS 파일 프록시, iron-session 인증 |
| ADK 에이전트 | Python 3.11+ / google-adk + FastAPI | 8200 | LlmAgent + 도구 5개 (RAG + SAP) + 선택적 Pub/Sub MCP toolset |
| PostgreSQL | 17+ with pgvector / halfvec(3072) | 5432 | RAG 임베딩, 대화, 메시지 |
| Google Cloud Storage | — | — | 업로드된 원본 파일 (`/api/files/...`로 다시 서빙됨) |
| Google Cloud Pub/Sub MCP (선택) | `pubsub.googleapis.com/mcp` HTTP MCP | — | 토픽/구독/발행 작업을 LLM에 allowlist로 노출 |

이전의 독립 실행형 `sap-service/` FastAPI 사이드카는 커밋 `822a49f`에서
제거되었습니다. SAP 통합은 이제 ADK 에이전트 안에서, 벤더링된
`adk_agent/sap_gw_connector` 패키지를 통해 인프로세스로 발생합니다.

## 다섯 개의 LLM 도구

`adk_agent/tools/` 아래에 정의되어 있고
[`adk_agent/agent.py`](../../adk_agent/agent.py)에서 등록됩니다.

| 도구 | 용도 | 인증 게이트 |
|------|------|------------|
| `search_documents(query, top_k=8)` | `embeddings` 테이블에 대한 pgvector 코사인 검색; `{id, file_name, chunk_text, score}` 반환 | 없음 |
| `sap_authenticate(method, …)` | 게이트. Basic은 성공 + `sap_user`를 반환. OAuth Step 1은 `action_required: "sap_login"` + `login_url`을 반환하며, LLM은 이를 그대로 노출하도록 지시받음 | 해당 없음 (이것이 게이트) |
| `sap_list_services()` | `adk_agent/services.yaml`을 읽어 서비스 카탈로그 (id, path, entities, key fields) 반환 | 없음 |
| `sap_query(service_id, entity_set, filter?, select?, top?, skip?)` | `sap_gw_connector.SAPClient`를 통해 SAP OData v2/v4 호출, `d.results`와 `value` 두 envelope 모두 정규화 | `tool_context.state["sap_credentials"]` 필요 |
| `sap_get_entity(service_id, entity_set, key)` | 키로 단일 엔티티 가져오기 | `sap_credentials` 필요 |

`setup_pubsub_mcp()`이 유효한 `.mcp.json` 항목을 발견하면 추가
`McpToolset`이 도구 목록에 추가되고, deny-by-default
`before_tool_callback`이 allowlist에 없는 토픽/구독을 거부합니다.

## 빠른 시작

사전 요구 사항: Node 20+, pnpm, Python 3.11+, `uv`, pgvector를 갖춘
PostgreSQL 17+, GCS 버킷이 있는 Google Cloud 프로젝트, Gemini API 키.

AI 에이전트가 실행하도록 의도된 단계별 지침은
[`installation.md`](../../installation.md)을 참조하세요. 단축 버전:

```bash
# 1. 클론 및 설치
git clone https://github.com/midasol/sap-rag-integration.git
cd sap-rag-integration
pnpm install
uv venv && uv sync

# 2. 두 env 파일 모두 구성
cp .env.local.example .env.local         # Next.js
cp adk_agent/.env.example adk_agent/.env # ADK 에이전트
#   채울 항목: GEMINI_API_KEY, DATABASE_URL, GCS_BUCKET_NAME, GCS_PROJECT_ID,
#              SAP_SESSION_SECRET (openssl rand -base64 48),
#              SAP_HOST + SAP_AUTH_TYPE, SAP_CRED_ENCRYPTION_KEY (Fernet)

# 3. 데이터베이스
createdb gemini_rag
pnpm db:setup    # pgvector 확장 + 테이블 3개 + HNSW halfvec 인덱스

# 4. 두 프로세스 모두 실행
uv run python -m adk_agent.server    # 터미널 1 — 8200 포트
pnpm dev                              # 터미널 2 — 3000 포트 (predev가 ADK /healthz 핑)
```

<http://localhost:3000>을 열면 `/chat`으로 리다이렉트됩니다. `sap_session`
쿠키가 없으면 채팅 사이드바에 인라인 SAP 로그인 폼이 표시됩니다.

## 프로젝트 구조

```
adk_agent/
├── agent.py                 # root_agent: 5개 도구를 연결하는 LlmAgent (+ 선택적 Pub/Sub MCP)
├── server.py                # google.adk.cli.fast_api.get_fast_api_app으로 만든 FastAPI 앱
├── settings.py              # 동결된 dataclass env 로더
├── probes.py                # 시작 프로브 (yaml, db, embed model, secret manager)
├── mcp_pubsub.py            # Pub/Sub MCP toolset + deny-by-default 리소스 게이트
├── oauth.py                 # SAP OAuth2 PKCE 헬퍼
├── crypto.py                # 패스워드 at-rest용 Fernet 래퍼
├── services.yaml            # SAP OData 서비스 카탈로그 (4개 서비스 번들)
├── rag/
│   ├── db.py                # asyncpg 풀 + pgvector 코사인 검색
│   └── embedding.py         # genai.Client embed_content(model=EMBED_MODEL)
├── tools/
│   ├── rag_tool.py          # search_documents
│   ├── auth_tool.py         # sap_authenticate (basic + oauth Step1/Step2)
│   ├── service_tool.py      # sap_list_services
│   ├── query_tool.py        # sap_query
│   └── entity_tool.py       # sap_get_entity
└── sap_gw_connector/        # 벤더링된 SAP Gateway 클라이언트 (auth, sap_client, transports)

src/
├── app/
│   ├── chat/page.tsx
│   ├── admin/pipeline/page.tsx
│   └── api/
│       ├── chat/route.ts                # ADK /run_sse로의 SSE 프록시
│       ├── conversations/                # sap_user_id로 스코프된 CRUD
│       ├── embed/                        # 단일 파일 임베딩 (multipart)
│       ├── pipeline/{start,status,upload}/
│       ├── files/[...path]/              # traversal 가드를 갖춘 GCS 파일 프록시
│       └── sap/
│           ├── auth/                     # POST {method:"basic"} → ADK /sap/auth/basic, 쿠키 설정
│           ├── oauth/callback/           # OAuth round-trip (현재는 stub)
│           └── services/                 # GET → ADK function_call: sap_list_services
├── lib/
│   ├── adk-client.ts        # SSE 파서 + runSse + createSession + authBasic
│   ├── session.ts           # iron-session, sap_session 쿠키, 8h TTL
│   ├── oauth-pending.ts     # sap_oauth_pending 쿠키, 10m TTL
│   ├── db.ts + schema.ts    # Drizzle: embeddings, conversations, messages
│   ├── embedding-ingest.ts  # text/pdf/image/audio/video 인제스션
│   ├── gemini.ts, gcs.ts, file-parser.ts, env.ts, …
│   └── pipeline-state.ts    # 인메모리 인제스션 진행 상황
├── components/              # ChatWindow / ChatSidebar / ChatInput / SAPDataView / PipelineDashboard / ui/*
├── proxy.ts                 # Next 16 proxy.ts — REQUIRE_AUTH=true일 때 보호된 라우트 게이트
└── scripts/                 # setup-db.ts, migrate-sap-user-id.ts, pipeline.ts (CLI)

.mcp.json                    # 프로젝트 스코프 MCP 설정: Pub/Sub HTTP MCP + allowlists
docker-compose.yml           # nextjs + adk 서비스 (sap-service 없음)
```

## API 표면 (Next.js)

| 메서드 | 경로 | 설명 |
|--------|------|-----|
| `POST` | `/api/chat` | ADK `/run_sse`로의 SSE 프록시. 메시지 영구 저장, 자동 제목. `sap_session` 필요 |
| `GET / POST / DELETE` | `/api/conversations` | `sap_user_id`로 스코프된 CRUD |
| `GET` | `/api/conversations/[id]/messages` | 대화의 정렬된 메시지 |
| `POST` | `/api/embed` | Multipart 업로드 + `embedFile` (≤100 MB) |
| `POST` | `/api/pipeline/start` | 로컬 디렉터리 또는 `gs://…` 접두어의 백그라운드 인제스션 |
| `GET` | `/api/pipeline/status` | 인메모리 파이프라인 상태 스냅샷 |
| `POST` | `/api/pipeline/upload` | Multipart `files[]` 인제스션 |
| `GET` | `/api/files/[...path]` | GCS 파일 프록시 (path-traversal 가드) |
| `GET / POST / DELETE` | `/api/sap/auth` | GET = 세션 프로브; POST `{method:"basic"}` → ADK `/sap/auth/basic`, `sap_session` 설정; DELETE는 클리어 |
| `GET` | `/api/sap/oauth/callback` | OAuth code/state 랜딩 — Step-2 와이어링까지 현재는 fail closed |
| `GET` | `/api/sap/services` | ADK에서 `sap_list_services` 포워딩 |

ADK 에이전트 자체는 `/run_sse` (`get_fast_api_app`이 제공), `/healthz`,
`/sap/auth/basic` (Next.js가 프록시)을 노출합니다.

전체 페이로드와 SSE 이벤트 모양은 [API.md](./API.md)를 참조하세요.

## 설정 개요

프로세스 당 하나씩, 두 개의 env 파일:

- **Next.js** — `.env.local` (템플릿: `.env.local.example`)
  - 필수: `GEMINI_API_KEY`, `DATABASE_URL`, `GCS_BUCKET_NAME`, `GCS_PROJECT_ID`, `SAP_SESSION_SECRET`
  - ADK 링크: `ADK_BASE_URL` (기본 `http://localhost:8200`)
  - 선택: `GOOGLE_APPLICATION_CREDENTIALS`, `GEMINI_*_MODEL`, `LOG_*`, `REQUIRE_AUTH`
- **ADK 에이전트** — `adk_agent/.env` (템플릿: `adk_agent/.env.example`)
  - 필수: `DATABASE_URL`, `SAP_HOST`, `EMBED_MODEL`, `EMBED_OUTPUT_DIM`, `SAP_CRED_ENCRYPTION_KEY` (Fernet)
  - SAP: `SAP_AUTH_TYPE` (기본 `basic`), `SAP_PORT`, `SAP_CLIENT`, `SAP_VERIFY_SSL`, `SAP_AUTH_TYPE=sap_oauth`일 때는 5개의 `SAP_OAUTH_*` 변수
  - 서버: `ADK_HOST=0.0.0.0`, `ADK_PORT=8200`, `ADK_SESSION_BACKEND=memory|vertex`
  - 모델: `SAP_AGENT_MODEL` (기본 `gemini-3.1-pro-preview`)

전체 레퍼런스와 프로덕션 가이드는 [DEPLOYMENT.md](./DEPLOYMENT.md)를 참조하세요.

## Pub/Sub MCP (선택)

`.mcp.json`이 `mcpServers.pubsub` HTTP MCP 항목을 정의하면 ADK 에이전트는
시작 시 이를 LlmAgent에 연결합니다 (`adk_agent/mcp_pubsub.py`). 체크인된
설정은 `https://pubsub.googleapis.com/mcp`을 대상으로 하며,
`x-goog-user-project: sap-advanced-workshop-gck`와 도구·토픽·구독에 대한
**deny-by-default** allowlist를 사용합니다.

호출자는 `roles/mcp.toolUser`와 `roles/pubsub.editor` (또는 더 세분화된
Pub/Sub 역할) 모두를 보유해야 하며, ADC가 사용 가능해야 합니다
(`gcloud auth application-default login`). 자세한 내용은 프로젝트 루트
[`CLAUDE.md`](../../CLAUDE.md)의 "MCP servers" 섹션과
[ARCHITECTURE.md](./ARCHITECTURE.md#9-pub-sub-mcp-toolset)를 참조하세요.

## 개발 스크립트

| 명령 | 동작 |
|------|------|
| `pnpm dev` | `predev` (parent-workspace 가드 + ADK `/healthz` 프로브) → `--max-old-space-size=4096`로 `next dev` |
| `pnpm build` / `pnpm start` | 프로덕션 Next 빌드 + 서빙 |
| `pnpm db:setup` | pgvector 확장 + 테이블 + HNSW halfvec 인덱스 생성 |
| `pnpm db:migrate:sap-user-id` | 레거시 DB용 idempotent ALTER |
| `pnpm pipeline -- ./data` | CLI 배치 인제스션 (로컬 디렉터리 또는 `gs://…`) |
| `pnpm gcp:setup` | GCP 서비스 계정 + GCS 버킷 + 키 생성, `.env.local`에 기록 |
| `pnpm test` / `pnpm test:run` / `pnpm test:coverage` | Vitest |
| `pnpm e2e` | Playwright (Next + ADK가 이미 실행 중이라고 가정) |
| `uv run python -m adk_agent.server` | ADK 에이전트 실행 (8200 포트) |
| `uv run pytest` | ADK 에이전트 단위 테스트 |

## 관련 문서

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 런타임 토폴로지, 데이터 흐름 다이어그램, 시퀀스 다이어그램
- [API.md](./API.md) — 전체 Next.js + ADK 엔드포인트 레퍼런스, SSE 이벤트 모양
- [DEPLOYMENT.md](./DEPLOYMENT.md) — env 변수, 데이터베이스 스키마, GCS 설정, Cloud Run / Vertex Agent Engine, Docker Compose
- [SAP_QUERY_EXAMPLES.md](./SAP_QUERY_EXAMPLES.md) — 번들된 4개 서비스 전체에 걸친 자연어 프롬프트와 OData 호출 매핑
- 프로젝트 루트 [`CLAUDE.md`](../../CLAUDE.md) — 알려진 개발 트랩 (parent-workspace Turbopack 버그), MCP 와이어링 노트
- 영문 번역은 [`docs/en/`](../en/)에 있습니다
