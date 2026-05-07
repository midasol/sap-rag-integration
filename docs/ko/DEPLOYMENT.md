# 배포 가이드

이 가이드는 두 프로세스 (Next.js + ADK 에이전트) 모두에 대한 환경 변수
레퍼런스, 데이터베이스 설정, Google Cloud 통합, 프로덕션 고려사항을 다룹니다.

레거시 `sap-service/` FastAPI 사이드카는 제거되었습니다 — 배포할 세 번째
프로세스는 **없습니다**.

## 1. 환경 변수

프로세스당 하나씩, 두 개의 env 파일이 있습니다. 템플릿은
[`.env.local.example`](../../.env.local.example)과
[`adk_agent/.env.example`](../../adk_agent/.env.example)로 제공됩니다.

### 1.1 Next.js (`.env.local`)

| 변수 | 필수 | 기본값 | 비고 |
|------|------|--------|------|
| `GEMINI_API_KEY` | 예 | — | <https://aistudio.google.com/apikey> |
| `DATABASE_URL` | 예 | — | `postgresql://user:pass@host:5432/db`. ADK 에이전트와 동일한 DB |
| `GCS_BUCKET_NAME` | 예 | — | `GCS_PROJECT_ID` 아래에 존재해야 함 |
| `GCS_PROJECT_ID` | 예 | — | 버킷과 서비스 계정의 소유자 |
| `SAP_SESSION_SECRET` | 예 | — | iron-session 서명 키. ≥ 32자. `openssl rand -base64 48` |
| `ADK_BASE_URL` | 예 | `http://localhost:8200` | `process.env`로 직접 읽음; `pnpm predev`가 이 URL을 health-probe |
| `GOOGLE_APPLICATION_CREDENTIALS` | 아니오 | — | 서비스 계정 JSON의 절대 경로. 미설정 시 ADC로 폴백. `pnpm gcp:setup`이 채움 |
| `GEMINI_EMBEDDING_MODEL` | 아니오 | `gemini-embedding-2` | 인제스션에 사용되는 3072차원 임베딩 모델 |
| `GEMINI_CHAT_MODEL` | 아니오 | `gemini-3.1-pro-preview` | `src/lib/gemini.ts`가 콘텐츠 요약용으로 사용; 에이전트가 사용하는 채팅 모델은 `adk_agent/.env`의 `SAP_AGENT_MODEL`에서 설정 |
| `LOG_LEVEL` | 아니오 | `info` | `debug | info | warn | error` |
| `LOG_PAYLOAD` | 아니오 | `meta` | `meta` (상태 + 카운트) 또는 `full` (응답 본문) |
| `LOG_FORMAT` | 아니오 | `pretty` | `pretty`는 stdout pino-pretty 타깃 추가; 파일 출력은 항상 JSON |
| `LOG_DIR` | 아니오 | `./logs` | 누락 시 시작 시 생성되는 디렉터리 |
| `REQUIRE_AUTH` | 아니오 | unset | `true`면 `src/proxy.ts`가 핸들러별 `requireSession()`에 추가로 프록시 계층에서 보호된 라우트를 게이트 |

### 1.2 ADK 에이전트 (`adk_agent/.env`)

| 변수 | 필수 | 기본값 | 비고 |
|------|------|--------|------|
| `DATABASE_URL` | 예 | — | Next.js와 동일한 DB |
| `SAP_HOST` | 예 | — | SAP Gateway 호스트명 (스킴 없음) |
| `EMBED_MODEL` | 예 | `gemini-embedding-2` | RAG **쿼리** 경로에 사용. 차원 `EMBED_OUTPUT_DIM`의 벡터를 생성해야 함 |
| `EMBED_OUTPUT_DIM` | 예 | `3072` | 컬럼 타입 `vector(3072)`와 일치해야 함 |
| `SAP_CRED_ENCRYPTION_KEY` | 예 | — | Fernet 키. `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`로 생성 |
| `GOOGLE_API_KEY` | 조건부 | — | ADC가 없으면 필수 |
| `GOOGLE_CLOUD_PROJECT` | 조건부 | — | 선택적 Secret Manager probe에 필요 |
| `SAP_AGENT_MODEL` | 아니오 | `gemini-3.1-pro-preview` | 에이전트가 사용하는 LLM |
| `SAP_AUTH_TYPE` | 아니오 | `basic` | `basic` 또는 `sap_oauth` |
| `SAP_PORT` | 아니오 | `44300` | |
| `SAP_CLIENT` | 아니오 | `100` | |
| `SAP_VERIFY_SSL` | 아니오 | `false` | 프로덕션에서는 `true`여야 함 |
| `SAP_OAUTH_CLIENT_ID` | 조건부 | — | `SAP_AUTH_TYPE=sap_oauth`일 때 필수 |
| `SAP_OAUTH_CLIENT_SECRET` | 조건부 | — | 동일 |
| `SAP_OAUTH_TOKEN_URL` | 조건부 | — | 동일 |
| `SAP_OAUTH_AUTHORIZE_URL` | 조건부 | — | 동일 |
| `SAP_OAUTH_REDIRECT_URI` | 조건부 | — | 동일. dev에서는 일반적으로 `http://localhost:3000/api/sap/oauth/callback` |
| `EMBED_NORMALIZE` | 아니오 | `true` | 쿼리 임베딩을 L2 정규화 |
| `RAG_TABLE` | 아니오 | `embeddings` | 코퍼스를 분할할 때만 오버라이드 |
| `ADK_HOST` | 아니오 | `0.0.0.0` | |
| `ADK_PORT` | 아니오 | `8200` | |
| `ADK_SESSION_BACKEND` | 아니오 | `memory` | `memory` 또는 `vertex` (Vertex AI Agent Engine 세션 저장소) |

`adk_agent/settings.py`는 시작 시 필수 변수 중 어느 것이라도 설정되지
않으면 `RuntimeError("missing env: …")`을 발생시키므로, 잘못된 설정은
턴 도중의 모호한 LLM 에러가 아니라 빠르게 실패합니다.

### 1.3 `.env.local` 예시

```env
GEMINI_API_KEY=AIza...
DATABASE_URL=postgresql://localhost:5432/gemini_rag
GCS_BUCKET_NAME=gemini-rag-uploads
GCS_PROJECT_ID=my-gcp-project
SAP_SESSION_SECRET=<openssl rand -base64 48>

GOOGLE_APPLICATION_CREDENTIALS=./service-account.json

ADK_BASE_URL=http://localhost:8200
LOG_LEVEL=info
LOG_FORMAT=pretty
```

### 1.4 `adk_agent/.env` 예시

```env
GOOGLE_API_KEY=AIza...
SAP_AGENT_MODEL=gemini-3.1-pro-preview

EMBED_MODEL=gemini-embedding-2
EMBED_OUTPUT_DIM=3072
EMBED_NORMALIZE=true

DATABASE_URL=postgresql://localhost:5432/gemini_rag

SAP_AUTH_TYPE=basic
SAP_HOST=sap.example.com
SAP_PORT=44300
SAP_CLIENT=100
SAP_VERIFY_SSL=false

SAP_CRED_ENCRYPTION_KEY=<Fernet.generate_key()>

ADK_HOST=0.0.0.0
ADK_PORT=8200
ADK_SESSION_BACKEND=memory
```

## 2. 데이터베이스 설정

### 2.1 사전 요구 사항

- PostgreSQL 17+ (16도 작동하지만, HNSW halfvec 성능은 17에서 튜닝됨)
- `pgvector` ≥ 0.7.0 (`halfvec`와 HNSW 지원용)

### 2.2 pgvector 설치

macOS (Homebrew):
```bash
brew install pgvector
```

Debian/Ubuntu:
```bash
sudo apt install postgresql-17-pgvector
```

소스에서:
```bash
git clone https://github.com/pgvector/pgvector.git
cd pgvector && make && sudo make install
```

### 2.3 데이터베이스 생성 및 스키마 적용

```bash
createdb gemini_rag
pnpm db:setup
```

`pnpm db:setup` (`src/scripts/setup-db.ts`):
1. `CREATE EXTENSION IF NOT EXISTS vector;`
2. `embeddings`, `conversations`, `messages` 생성 (전체 스키마는
   [ARCHITECTURE.md §6](./ARCHITECTURE.md#6-데이터베이스-스키마))
3. `embeddings.embedding`에 HNSW halfvec 인덱스 생성
4. `conversations`에 사용자별 합성 인덱스 생성

per-user 스코프 이전의 레거시 DB의 경우 `pnpm db:migrate:sap-user-id`를
한 번 실행하세요 — `conversations`를 ALTER하여 `sap_user_id`와 합성
인덱스를 idempotent하게 추가합니다.

### 2.4 커넥션 풀링

두 프로세스 모두 자체 풀을 보유합니다:

- Next.js: Drizzle이 래핑한 단일 `postgres()` 클라이언트
  (`src/lib/db.ts`). HMR singleton 가드는 아직 없음 — 긴 dev 세션은 풀을
  누적합니다 (CLAUDE.md에 추적됨).
- ADK 에이전트: `asyncpg.create_pool` (`adk_agent/rag/db.py`), 워커
  프로세스당 하나의 풀.

다중 복제본으로 배포할 때는 두 프로세스 앞에 PgBouncer 같은 커넥션 풀러를
사용하세요.

## 3. Google Cloud Storage

### 3.1 버킷 레이아웃

```
gs://<GCS_BUCKET_NAME>/
└── uploads/
    ├── 9f23...a1.pdf
    ├── 1c08...b3.png
    └── ...
```

파일은 `src/lib/gcs.ts:uploadToGCS`가 `uploads/{uuid}{ext}` 아래에 쓰며
`/api/files/<path>`를 통해 다시 서빙됩니다. `downloadFromGCS`의 path
traversal 가드는 강제로 `uploads/` 접두어를 적용하고 `..`를 포함하는 모든
경로를 거부합니다.

### 3.2 서비스 계정

가장 간단한 경로는 `pnpm gcp:setup`
(`scripts/setup-gcp-service-account.sh`)입니다:

1. `GCS_PROJECT_ID`에 서비스 계정 생성
2. 버킷에 `roles/storage.objectAdmin` 부여
3. JSON 키 생성하고 `./service-account.json`에 기록
4. `.env.local`에 `GOOGLE_APPLICATION_CREDENTIALS`, `GCS_PROJECT_ID`,
   `GCS_BUCKET_NAME` 업데이트

Cloud Run의 경우 JSON 키보다 **workload identity**를 선호하세요 — 리비전에
서비스 계정을 부착하고 `GOOGLE_APPLICATION_CREDENTIALS`을 완전히 생략하면
SDK가 Application Default Credentials을 자동으로 사용합니다.

### 3.3 캐시

`/api/files/[...path]`는 `Cache-Control: public, max-age=86400`로 서빙합니다.
`uploads/`의 파일은 불변 (UUID 이름)이므로 긴 캐시가 안전합니다.

## 4. Gemini API

### 4.1 모델

| 용도 | 기본 모델 | 설정 위치 |
|------|----------|----------|
| 임베딩 | `gemini-embedding-2` | `GEMINI_EMBEDDING_MODEL` (Next.js) / `EMBED_MODEL` (ADK) |
| 채팅 / 에이전트 | `gemini-3.1-pro-preview` | `SAP_AGENT_MODEL` (ADK) |
| 콘텐츠 요약 | `gemini-3.1-pro-preview` | `GEMINI_CHAT_MODEL` (Next.js) |

임베딩 모델은 3072차원 벡터를 출력하고 `embeddings.embedding`
컬럼을 대상으로 합니다. 다른 차원으로 전환하려면 `EMBED_OUTPUT_DIM`을
업데이트하고 새 DB에 대해 `pnpm db:setup`을 다시 실행하세요 (또는
마이그레이션 — `vector(N)` 컬럼은 in-place로 변경할 수 없습니다).

### 4.2 형식 제한 (인제스션)

| 카테고리 | 제한 |
|----------|------|
| 텍스트 | 8,192 토큰; 2000자 / 200 overlap으로 청킹 |
| PDF | 요청당 6페이지 (`pdf-lib`로 자동 분할) |
| 이미지 | `image/png`, `image/jpeg`; ≤ 6 / 요청 |
| 오디오 | `audio/mp3`, `audio/wav`; ≤ 80초 |
| 비디오 | `video/mpeg`, `video/mp4`; 오디오 포함 ≤ 80초, 미포함 ≤ 120초 |

업스트림 제한은 [공식 Gemini Embedding 2 문서](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/embedding-2)를
참조하세요. 다른 확장자 (`.gif`, `.webp`, `.flac`, `.mov`, …)는 업로드되고
서빙될 수 있지만 임베딩 API에 **전송되지 않습니다** — GCS에만 저장됩니다.

### 4.3 Task type

ADK 쿼리는 `task_type: "RETRIEVAL_QUERY"`을 설정합니다
(`adk_agent/rag/embedding.py` 참조); 인제스션은 `RETRIEVAL_DOCUMENT`을
사용합니다. 둘을 섞으면 이 코퍼스에서 recall이 절반으로 줄어듭니다.

## 5. Pub/Sub MCP (선택)

> **전체 가이드:** [MCP.md](./MCP.md) — 이 프로젝트에서 MCP의 역할,
> deny-by-default 의미론, 모드별 전달 방식, 새 MCP 서버 추가 방법.

레포 루트의 `.mcp.json`을 통해 구성됩니다. 체크인된 설정은
`x-goog-user-project: sap-advanced-workshop-gck`와 함께
`https://pubsub.googleapis.com/mcp`을 대상으로 하며, allowlist에
`sapphire-demo` 토픽 / `sapphire-demo-sub` 구독이 있습니다.

사전 요구 사항:

```bash
gcloud services enable pubsub.googleapis.com --project sap-advanced-workshop-gck
gcloud auth application-default login   # 로컬 개발
```

호출자 principal은 다음 모두를 보유해야 합니다:

- `roles/mcp.toolUser` (`mcp.tools.call` 게이트)
- `roles/pubsub.editor` (또는 더 세분화된 Pub/Sub 역할)

Cloud Run의 경우 둘 다 런타임 서비스 계정에 부착하세요. end-to-end
와이어링을 검증하려면:

```bash
uv run python scripts/test_pubsub_mcp_live.py
```

스크립트는 MCP toolset을 통해 메시지를 발행하고, 도착은
`gcloud pubsub subscriptions pull`로 외부에서 확인합니다.

## 6. 프로덕션 고려사항

### 6.1 동시성과 rate limit

| 표면 | 기본 |
|------|------|
| 인제스션 (`/api/pipeline/start`) | 동시 파일 3개, 재시도 3회 |
| Embed (`/api/embed`) | HTTP 연결당 한 번에 한 요청 |
| 채팅 (`/api/chat`) | ADK 세션 백엔드에 의해 제한; `memory`에서는 단일 복제본 스코프 |

Gemini API 할당량은 프로젝트 티어에 따라 다양합니다; 임베딩 요청이 가장
빈번하며 가장 먼저 할당량 벽에 도달해야 합니다. HTTP 429를 감시하고
배치 작업의 가장자리에 백오프를 구현하세요 (내장 인제스션은 이미 3회
재시도합니다).

### 6.2 프로덕션에서의 로깅

- `LOG_FORMAT=json`과 `LOG_LEVEL=info`을 설정.
- `LOG_DIR`을 영구 볼륨에 마운트하거나 stdout으로 스트리밍
  (Cloud Run / GKE가 Cloud Logging으로 자동 수집).
- 적극적으로 디버깅하지 않는 한 `LOG_PAYLOAD=meta` 유지 — `full`은
  리덕션되지 않은 SAP 응답 본문을 작성하며, 민감한 제품 / 파트너 데이터를
  포함할 수 있습니다.

민감한 필드 (`Authorization`, `Set-Cookie`, `Cookie`, `access_token`,
`refresh_token`, `password`)는 `src/lib/logger.ts`로 리덕션됩니다.

### 6.3 배포 타깃

| 타깃 | 상태 |
|------|------|
| 로컬 Docker Compose | 지원됨. [`docker-compose.yml`](../../docker-compose.yml) — 두 서비스 (`nextjs` + `adk`) 참조 |
| 모드 A — Cloud Run × 2 + Cloud SQL | **스크립트 제공.** [`deploy/README.md`](../../deploy/README.md) 참조. `./deploy/setup-cloud-sql.sh` 실행 후 `./deploy/deploy-cloud-run.sh` 실행. |
| 모드 B — Vertex AI Agent Engine + Cloud SQL | **스크립트 제공.** [`deploy/README.md`](../../deploy/README.md) 참조. `MODE=agent-engine ./deploy/setup-cloud-sql.sh`, `./deploy/setup-agent-engine.sh`, `python deploy/deploy-agent-engine.py` 순으로 실행. 그 후 리소스 이름을 **Gemini Enterprise**에 등록. |

두 관리형 모드는 동일한 Cloud SQL 인스턴스를 공유합니다. 모드 A는
`--add-cloudsql-instances`가 마운트하는 Unix 소켓으로 연결하고, 모드 B는
PSA 피어링을 통해 Private IP에 TCP로 연결합니다.

#### 모드 A 토폴로지 (Cloud Run × 2)

```
Cloud Run service: sap-rag-web      → Next.js (3000 포트, 공개)
Cloud Run service: sap-rag-agent    → ADK    (8200 포트, 비공개)
Secret Manager:    SAP_CRED_ENCRYPTION_KEY, SAP_SESSION_SECRET, GEMINI_API_KEY
Cloud SQL:         PostgreSQL 17 + pgvector
GCS:               <GCS_BUCKET_NAME>
VPC Connector:     adk_agent → SAP S/4HANA private IP (자동 감지)
```

웹 서비스는 에이전트 서비스 URL을 `ADK_BASE_URL`로 마운트하며 유일하게
`--allow-unauthenticated`가 필요한 서비스입니다. 에이전트 서비스는
비공개이며 웹 서비스의 런타임 SA만 `roles/run.invoker`로 호출할 수
있습니다.

#### 모드 B 토폴로지 (Agent Engine + Gemini Enterprise)

```
Gemini Enterprise UI ─→ Agent Engine: adk_agent.root_agent
                            │
                            │ PSC interface + network attachment
                            ▼
                       VPC ─┬─→ Cloud SQL Postgres (Private IP)
                            └─→ SAP S/4HANA (port 44300)

Cloud Run service: sap-oauth-callback     → SAP 리다이렉트 수신 → code/state를
                                             Secret Manager에 저장
                                             (sap-oauth-pending-<state>)
Secret Manager:    sap-credentials, sap-cred-encryption-key
Service account:   agent-engine-sa
```

모드 B에서는 Next.js 측이 **배포되지 않습니다**. 인제스션 파이프라인은
로컬에서 한 번 (또는 Cloud Run에서 일회성으로) 실행하여 `embeddings`
테이블을 시드하고, Agent Engine의 에이전트는 RAG 용도로 그 테이블을
**읽기**만 합니다.

### 6.4 docker-compose

```yaml
services:
  nextjs:
    build: .
    ports: ["3000:3000"]
    env_file: .env.local
    environment:
      ADK_BASE_URL: http://adk:8200
    depends_on: [adk]

  adk:
    build:
      context: .
      dockerfile: adk_agent/Dockerfile
    ports: ["8200:8200"]
    env_file: adk_agent/.env
    restart: unless-stopped
```

현재 [`docker-compose.yml`](../../docker-compose.yml)은 정확히 이 모양과
일치합니다. `sap-service` 서비스는 없습니다.

### 6.5 모니터링

알림 대상으로 권장되는 시그널:

- Next: `502 ADK_UPSTREAM` 비율 > `/api/chat` 요청의 1%
- Next: 파일당 `/api/pipeline/start` 실패율
- ADK: `/healthz` non-200
- ADK: `event=tool_error tool=sap_query` 로그 라인 비율 급증
- DB: pgvector 쿼리 p95 지연
- GCS: `/api/files` 프록시의 4xx 비율

### 6.6 보안 체크리스트

서비스를 노출하기 전에:

- [ ] `SAP_SESSION_SECRET`과 `SAP_CRED_ENCRYPTION_KEY` 회전 후 Secret Manager에 저장
- [ ] Next 서비스에 `REQUIRE_AUTH=true` 설정
- [ ] ADK 서비스에 `SAP_VERIFY_SSL=true` 설정
- [ ] `.mcp.json`의 Pub/Sub allowlist가 프로덕션 토픽/구독 집합과 일치 (git에 체크인되어 있으므로 prod 전용 값은 배포 시 오버라이드 필요할 수 있음)
- [ ] `adk_agent/server.py`의 CORS 목록에 프로덕션 웹 호스트 포함
- [ ] `next.config.ts`의 CSP allowlist에 프로덕션 GCS 버킷 origin 포함
- [ ] Cloud Run 리비전이 JSON 키가 아닌 workload identity 사용
- [ ] DB 사용자가 최소 필수 권한만 보유 (superuser 아님)

전체 아키텍처 컨텍스트는 [ARCHITECTURE.md](./ARCHITECTURE.md);
엔드포인트 페이로드는 [API.md](./API.md)를 참조하세요.
