# API 레퍼런스

이 문서는 Next.js HTTP 표면(3000 포트)과 ADK 에이전트의 HTTP 표면
(8200 포트), 그리고 에이전트가 노출하는 다섯 개의 LLM 도구를 다룹니다.

레거시 `sap-service/` FastAPI 사이드카는 제거되었습니다 — 8100 포트에는
이제 **어떤** 엔드포인트도 없습니다.

## 목차

- [Next.js API 라우트](#nextjs-api-라우트)
  - [`POST /api/chat`](#post-apichat)
  - [`GET / POST / DELETE /api/conversations`](#대화-crud)
  - [`GET /api/conversations/[id]/messages`](#get-apiconversationsidmessages)
  - [`POST /api/embed`](#post-apiembed)
  - [`POST /api/pipeline/start`](#post-apipipelinestart)
  - [`POST /api/pipeline/upload`](#post-apipipelineupload)
  - [`GET /api/pipeline/status`](#get-apipipelinestatus)
  - [`GET /api/files/[...path]`](#get-apifilespath)
  - [`POST /api/sap/auth`](#post-apisapauth)
  - [`GET /api/sap/oauth/callback`](#get-apisapoauthcallback)
  - [`GET /api/sap/services`](#get-apisapservices)
- [ADK 에이전트 엔드포인트](#adk-에이전트-엔드포인트)
- [LLM 도구 (에이전트 자체가 호출)](#llm-도구-에이전트-자체가-호출)
- [SSE 이벤트 모양](#sse-이벤트-모양)
- [인증과 에러 모델](#인증과-에러-모델)

---

## Next.js API 라우트

모든 라우트는 `runtime='nodejs'`로 설정되며 대부분 `maxDuration = 300`
(5분)을 고정합니다. `sap_session` 쿠키 (iron-session, 8시간 TTL)가 표준
인증 지표이며, 누락 시 `requireSession()`은 `{error:"NOT_AUTHENTICATED"}`와
함께 401을 반환합니다.

### `POST /api/chat`

ADK 채팅 응답을 Server-Sent Events로 스트리밍합니다. ADK 호출 전에 사용자
메시지를 영구 저장하고, 스트림 종료 후 어시스턴트 메시지를 영구 저장하며,
첫 턴에 대화 제목을 자동 생성합니다.

**요청**

```json
{
  "conversationId": "uuid",
  "content": "string",
  "attachments": [{ "fileName": "string", "mimeType": "string", "url": "string" }]
}
```

**인증**: `sap_session` 쿠키 필수. 핸들러는 호출자가 `conversationId`를
소유하는지도 검증합니다 (`conversations.sap_user_id` 일치).

**응답**: `text/event-stream`. 각 이벤트 페이로드는 JSON이며, 아래
[SSE 이벤트 모양](#sse-이벤트-모양)을 참조하세요.

**상태 코드**

| 상태 | 의미 |
|------|------|
| 200 | 스트림이 즉시 시작됨 |
| 401 | `NOT_AUTHENTICATED` (없거나 만료된 `sap_session`) |
| 403 | 다른 SAP 사용자에게 속한 대화 |
| 404 | 대화가 존재하지 않음 |
| 502 | ADK 업스트림 오류 (요청 ID와 함께 로깅됨) |
| 503 | ADK 도달 불가 (predev / health probe 실패) |

### 대화 CRUD

`/api/conversations`

| 메서드 | Body / params | 반환 | 비고 |
|--------|---------------|------|------|
| `GET` | — | `[{id, title, updatedAt, …}]` | `conversations.sap_user_id`로 필터링 |
| `POST` | `{title?: string}` | `{id, title, …}` | 현재 `sapUserId`로 row 생성 |
| `DELETE` | `?id=<uuid>` | `{deleted: true}` | 안전을 위해 `sapUserId`로 필터링하여 DELETE |

모두 `sap_session` 필요.

### `GET /api/conversations/[id]/messages`

대화의 정렬된 메시지 반환:
`[{id, role, content, fileName, attachments, createdAt}]`. 소유권을
검증하며, 그에 따라 `401 / 403 / 404`을 반환합니다.

### `POST /api/embed`

단일 파일의 multipart 업로드. Body: `multipart/form-data`에 `file` 필드.
서버 측에서 최대 100 MB 강제.

`embedFile(buffer, fileName)`을 동기적으로 실행: GCS에 업로드한 다음
카테고리에 따라 임베딩 — 텍스트(청킹), pdf(6페이지 슬라이스),
image/audio/video(멀티모달 임베딩 + AI 요약).

**반환**: `{success: true, fileName, chunks: number, gcsUrl}`.

### `POST /api/pipeline/start`

백그라운드 배치 인제스션을 시작합니다. Body:
`{sourcePath: "./data" | "gs://bucket/prefix"}`. 로컬 경로는 `./data`
또는 `./uploads` 아래여야 합니다.

파일당 동시성 3, 재시도 3회. 인메모리 `pipeline-state` singleton을
업데이트합니다; `/api/pipeline/status`로 폴링하세요.

**반환**: `{started: true}` (이미 실행 중이면 `409`).

### `POST /api/pipeline/upload`

Multipart `files[]` 업로드. 각 파일을 버퍼링한 후 백그라운드 배치 3개씩
`embedFile`을 실행합니다.

### `GET /api/pipeline/status`

singleton 스냅샷 반환:

```json
{
  "running": boolean,
  "total": number,
  "succeeded": number,
  "failed": number,
  "currentFile": "string | null",
  "logs": [{ "ts": "iso", "level": "info|warn|error", "msg": "string" }]
}
```

상태는 인메모리이며 프로세스 재시작 시 리셋됩니다. 영구 저장 없음.

### `GET /api/files/[...path]`

GCS에서 파일을 스트리밍합니다. 경로는 버킷 루트에 추가되며 **반드시**
`uploads/` 아래에 있어야 합니다. `..`가 있으면 400을 트리거합니다.

**캐시**: `Cache-Control: public, max-age=86400`.

### `POST /api/sap/auth`

모든 SAP 인증 작업을 위한 단일 엔드포인트.

| Body | 동작 |
|------|------|
| `{method: "basic", username, password}` | ADK `/sap/auth/basic`으로 포워드. 성공 시 `sap_session` 쿠키를 설정하고 `{success:true, sap_user, method:"basic"}` 반환 |
| `{method: "oauth"}` | `501 not_implemented` 반환 — OAuth 흐름은 이 엔드포인트가 아니라 채팅 도중 LLM이 `sap_authenticate` 도구를 통해 시작 |

`GET`은 현재 세션 probe 반환 (`{authenticated, sapUserId}`).
`DELETE`는 쿠키를 클리어하고 `{loggedOut: true}` 반환.

### `GET /api/sap/oauth/callback`

사용자가 SAP OAuth 흐름을 완료한 후 `?code&state`을 받습니다. `state`을
`sap_oauth_pending` 쿠키와 비교 검증합니다. **현재는 fail closed** —
부모 윈도우에 실패 메시지를 포스트하는 팝업 HTML을 반환합니다. Step-2
(ADK를 통한 토큰 교환)는 `adk_agent/oauth.exchange_code`에 와이어링되어
있지만 아직 이 라우트에서 호출되지 않습니다.
[`docs/followups/post-migration.md`](../followups/post-migration.md)에
추적됩니다.

### `GET /api/sap/services`

ADK `/run`을 `function_call: sap_list_services`로 호출하고 JSON을
포워딩합니다. `sap_session` 필요. `maxDuration = 60`.

```json
{
  "services": [
    {
      "id": "API_PRODUCT_SRV",
      "name": "Product",
      "path": "/sap/opu/odata/sap/API_PRODUCT_SRV",
      "version": "v2",
      "entities": [
        { "name": "A_Product", "key_field": "Product", "description": "..." }
      ]
    }
  ]
}
```

---

## ADK 에이전트 엔드포인트

ADK 에이전트는 `google.adk.cli.fast_api.get_fast_api_app`이 빌드한 두
개의 커스텀 라우트와 함께 구성됩니다. Base URL: `${ADK_BASE_URL}` (기본
`http://localhost:8200`).

| 메서드 | 경로 | 설명 |
|--------|------|-----|
| `GET` | `/healthz` | 시작 프로브가 통과하면 `{status:"ok"}`; `predev`가 이를 요구 |
| `POST` | `/sap/auth/basic` | 직접적인 `sap_authenticate(method="basic", …)` 호출. LLM/`/run` envelope을 우회하므로 Next.js 로그인 라우트가 암호화된 자격증명을 iron-session 쿠키에 시드할 수 있음 |
| `POST` | `/run` | 표준 ADK function-call 진입점. `/api/sap/services`가 `sap_list_services`를 직접 호출하기 위해 사용 |
| `POST` | `/run_sse` | 표준 ADK SSE 엔드포인트. `/api/chat`이 채팅 스트리밍에 사용 |

`/run`과 `/run_sse`는 ADK 런타임 자체가 문서화합니다
(<https://google.github.io/adk-docs/>); 둘 다 `app_name: "adk_agent"`와
Next.js 계층이 `sap_credentials` 전달에 사용하는 `state` blob을 기대합니다.

CORS는 기본적으로 `http://localhost:3000`로 제한됩니다 (`adk_agent/server.py`
참조).

---

## LLM 도구 (에이전트 자체가 호출)

이들은 HTTP 엔드포인트가 아니라 — `LlmAgent`에 등록된 Python callable입니다.
결정론적 테스트를 작성하고 LLM이 보게 될 것을 추론할 수 있도록 여기에
문서화합니다.

### `search_documents`

```python
search_documents(query: str, top_k: int = 8) -> dict
```

`embeddings` 테이블에 대한 pgvector 코사인 검색.

**반환**

```json
{
  "results": [
    { "id": "...", "file_name": "...", "chunk_text": "...", "score": 0.81 }
  ],
  "count": N
}
```

Soft-fail envelope: 임베딩 모델이나 DB가 다운됐을 때
`{"results": [], "count": 0, "warning": "embedding_unavailable"}` 또는
`"vector_db_unavailable"`. 에이전트는 이를 에러가 아닌 "결과 없음"으로
처리합니다.

### `sap_authenticate`

```python
sap_authenticate(
    method: str | None = None,   # "basic" | "oauth", 기본은 env SAP_AUTH_TYPE
    username: str | None = None,
    password: str | None = None,
    code: str | None = None,
    state: str | None = None,
    user_id: str | None = None,
) -> dict
```

| 시나리오 | 반환 |
|----------|------|
| Basic, OK | `{success:true, sap_user, method:"basic", credentials:{...encrypted}}` |
| Basic, 잘못된 비밀번호 | `{success:false, error:"invalid_credentials"}` |
| OAuth Step 1 | `{success:false, action_required:"sap_login", login_url, oauth_state, method:"oauth"}` |
| OAuth Step 2, OK | `{success:true, sap_user, method:"oauth"}` |
| OAuth state 불일치 | `{success:false, error:"oauth_state_mismatch"}` |
| OAuth env 불완전 | `{success:false, error:"oauth_config_incomplete: missing […]"}` |
| OAuth 교환 실패 | `{success:false, error:"oauth_exchange_failed: <detail>"}` |

에이전트의 시스템 프롬프트는 `action_required: "sap_login"` envelope을
그대로 노출하고 `login_url`을 사용자에게 제시하도록 지시합니다.

### `sap_list_services`

```python
sap_list_services() -> dict
```

`adk_agent/services.yaml`의 동기 읽기. 서비스 카탈로그를 반환합니다 (위
`/api/sap/services` 예시 참조). 절대 에러를 발생시키지 않음 — YAML이 비어
있으면 시작 프로브가 이미 실패했을 것입니다.

### `sap_query`

```python
sap_query(
    service_id: str,
    entity_set: str,
    filter: str | None = None,
    select: str | None = None,
    top: int | None = None,
    skip: int | None = None,
) -> dict
```

`sap_gw_connector.SAPClient`를 통해 SAP OData를 호출합니다. v2
(`d.results`)와 v4 (`value`) 응답 envelope 모두 정규화됩니다.

| 시나리오 | 반환 |
|----------|------|
| OK | `{success:true, results:[…], count}` |
| 세션에 `sap_credentials` 없음 | `{success:false, action_required:"sap_login", error:"not_authenticated"}` |
| `SAPAuthenticationError` (예: 만료) | `{success:false, action_required:"re_authenticate", error:"<detail>"}` |
| `SAPRequestError` | `{success:false, error:{message:"<detail>"}}` |
| 기타 | `{success:false, error:"internal_error", detail:"<repr>"}` |

각 호출마다 `async with` 블록 안에서 새 `SAPClient`를 빌드합니다 — 턴
간에 클라이언트 상태가 공유되지 않습니다.

### `sap_get_entity`

```python
sap_get_entity(service_id: str, entity_set: str, key: str) -> dict
```

`sap_query`와 동일한 인증 게이팅과 에러 envelope. 성공 시
`{success:true, entity:{…}}` 반환.

### Pub/Sub MCP 도구 (선택)

`.mcp.json`이 유효한 `mcpServers.pubsub` 항목을 정의하면 `McpToolset`이
해당 allowlist의 도구를 노출합니다. 기본 설정은 다음을 허용합니다:
`list_topics`, `get_topic`, `list_subscriptions`, `get_subscription`,
`publish` — 그리고 `sapphire-demo` 토픽과 `sapphire-demo-sub` 구독에 한해
서만. 인자:

- `projectId` — `projects/` 접두어 없는 평문 프로젝트 문자열
- `topicId` / `subscriptionId` — 평문 이름; 게이트는 allowlist 확인 전에
  `projects/X/topics/`와 `topics/` 접두어를 벗김
- `data` (publish) — base64 인코딩된 메시지 본문

거부된 호출은 `{"isError": true, "content":[{"type":"text","text":"Access denied: …"}]}`을
반환하며 절대 Pub/Sub에 도달하지 않습니다.

---

## SSE 이벤트 모양

`/api/chat`은 `text/event-stream` 청크를 스트리밍하며, 각 `data:` 페이로드는
원시 ADK 프레임을 파싱한 후 `src/lib/adk-client.ts:normalizeAdkEvent`이
방출하는 JSON입니다.

```json
{ "type": "text_delta", "delta": "Hello" }
{ "type": "tool_call", "name": "sap_query", "args": { "service_id": "API_PRODUCT_SRV", "entity_set": "A_Product", "top": 5 } }
{ "type": "tool_result", "name": "sap_query", "result": { "success": true, "results": [...], "count": 5 } }
{ "type": "error", "error": "string" }
```

기저 ADK 런타임의 `partial:false` 집계 텍스트 프레임은 조립된 메시지의
중복을 피하기 위해 **드롭**됩니다.

전형적인 채팅 턴은: 다수의 `text_delta`, 선택적으로 한 개 이상의
`tool_call`/`tool_result` 쌍, 그리고 0개 또는 1개의 종료 `error`를
산출합니다. 프론트엔드 (`src/components/ChatWindow.tsx`)는 텍스트 델타를
인라인으로 렌더링하고 도구 결과를 접을 수 있는 details로 첨부합니다.

---

## 인증과 에러 모델

| 실패 | HTTP 상태 | JSON 본문 |
|------|-----------|-----------|
| `sap_session` 쿠키 누락 | 401 | `{error:"NOT_AUTHENTICATED"}` |
| 다른 사용자가 소유한 대화 | 403 | `{error:"FORBIDDEN"}` |
| 리소스 누락 | 404 | `{error:"NOT_FOUND"}` |
| 파이프라인 이미 실행 중 | 409 | `{error:"PIPELINE_BUSY"}` |
| ADK가 non-2xx 반환 | 502 | `{error:"ADK_UPSTREAM", detail:"…"}` |
| ADK 도달 불가 | 503 | `{error:"ADK_UNAVAILABLE"}` |
| `REQUIRE_AUTH=true`일 때 `proxy.ts`가 차단 | 401 | empty body |

LLM 도구 에러 envelope (SSE `tool_result` 이벤트 **안에** 반환되며 HTTP
상태는 200 유지)은 위 도구별 패턴을 따릅니다. `action_required`는 에이전트가
사용자에게 로그인 또는 재인증을 요청하기 위한 표준 핸드셰이크입니다.
시스템 프롬프트가 이를 그대로 포워드하며, 채팅 UI는 `"sap_login"`을 특별
처리해 인라인 SAP 로그인 폼을 렌더링합니다.

---

## 관련

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 런타임 토폴로지와 시퀀스 다이어그램
- [DEPLOYMENT.md](./DEPLOYMENT.md) — env 변수, 스키마, GCS, Cloud Run / Vertex Agent Engine
- [SAP_QUERY_EXAMPLES.md](./SAP_QUERY_EXAMPLES.md) — 자연어 프롬프트 → OData 호출
