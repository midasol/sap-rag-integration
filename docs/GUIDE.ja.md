# sap-rag-integration — 開発者ガイド

> コードベースの現状に基づくウォークスルーです。Google ADK Python `LlmAgent`（ポート 8200）が 5 つのツール — pgvector RAG と 4 つの SAP OData ツール — を保有し、Next.js 16 チャット UI とインジェスションパイプライン（ポート 3000）がフロントエンドを担います。Next.js レイヤーは**エージェントロジックを持ちません**。すべてのチャットターンは SSE を通じて ADK エージェントへプロキシされます。レガシーの `sap-service/` Python サイドカーはコミット `822a49f` で削除されました。

> インストール手順をお探しの場合は [`installation.md`](../installation.md) から始めてください。個別のトピックについては [`docs/en/`](./en/) のロケール別ドキュメントセット（`README`、`ARCHITECTURE`、`API`、`DEPLOYMENT`、`SAP_QUERY_EXAMPLES`）を参照してください。本ガイドはコードベースを初めて上から下まで読む方に向けて、これらを統合して説明します。

## 目次

1. [プロジェクト概要](#1-プロジェクト概要)
2. [技術スタック](#2-技術スタック)
3. [プロジェクト構成](#3-プロジェクト構成)
4. [環境セットアップ](#4-環境セットアップ)
5. [ADK エージェント](#5-adk-エージェント)
6. [5 つの LLM ツール](#6-5-つの-llm-ツール)
7. [オプションの Pub/Sub MCP ツールセット](#7-オプションの-pubsub-mcp-ツールセット)
8. [Next.js API サーフェス](#8-nextjs-api-サーフェス)
9. [フロントエンドコンポーネント](#9-フロントエンドコンポーネント)
10. [データベーススキーマ](#10-データベーススキーマ)
11. [インジェスションパイプライン](#11-インジェスションパイプライン)
12. [認証モデル](#12-認証モデル)
13. [可観測性](#13-可観測性)
14. [テスト](#14-テスト)
15. [運用上の落とし穴](#15-運用上の落とし穴)

---

## 1. プロジェクト概要

本プロダクトは以下の機能を持つチャットアシスタントです:

1. pgvector に埋め込まれたマルチモーダルコーパス（テキスト、PDF、画像、音声、動画）に対する質問に回答します。
2. 4 つの型付きツール（製品マスター、資材在庫、プラントマスター、資材伝票）経由で**ライブ SAP** OData サービスに対する質問に回答します。
3. 同一ターン内で両方を組み合わせます — 例えば「FERT 製品についてスナップショットドキュメントが記載している内容と今日 SAP にある内容を比較して」— エージェントがターンごとに複数のツールを呼び出せるようにすることで実現します。

エージェントは**単一の** ADK `LlmAgent`（マルチエージェントオーケストレーションなし、LangGraph なし）です。ツール選択、フォールバック、レスポンス整形はすべてシステムプロンプト経由で行われます。Next.js レイヤーは:

- チャットと管理 UI をホストします。
- SSE 経由でエージェントにチャットターンをプロキシします。
- インジェスションパイプラインを所有します（エージェントは pgvector に対して読み取り専用です）。
- SAP ユーザーごとに会話をスコープする iron-session ログインクッキーを所有します。

この分割により、Python ADK ランタイムはエージェント実行に集中し、ユーザー向けサーフェスは Web 開発者に最も馴染みのあるフレームワークに置かれます。

## 2. 技術スタック

| 層 | 選択 | 備考 |
|-------|--------|-------|
| Web フレームワーク | Next.js 16（App Router、Turbopack） | `runtime='nodejs'`; ストリーミング/インジェスションルートで `maxDuration=300` |
| UI | React 19 + Tailwind 4 + shadcn/ui | チャットに `react-markdown` + `remark-gfm`; `lucide-react` アイコン |
| エージェントランタイム | `google-adk>=1.27`（Python 3.11+） | `LlmAgent` + `McpToolset`; `get_fast_api_app` が FastAPI サーフェスをビルド |
| エージェントトランスポート | FastAPI（uvicorn） | `/run_sse` 上の SSE; `predev` が `/healthz` をヘルスプローブ |
| LLM | `gemini-3.1-pro-preview` | `SAP_AGENT_MODEL` で上書き可 |
| 埋め込み | `gemini-embedding-2` | 3072 次元（RAG パスで `task_type=RETRIEVAL_QUERY`） |
| ベクトルストア | PostgreSQL 17 + `pgvector` `halfvec(3072)` | HNSW インデックス; コサイン距離 |
| ORM | Drizzle（Next 側）+ asyncpg（ADK 側） | コネクションプールを共有しない |
| ファイルストレージ | Google Cloud Storage | トラバーサルガード付き `/api/files/[...path]` で配信 |
| 認証 | `iron-session`（`sap_session`、`sap_oauth_pending`）+ SAP 認証情報の Fernet 暗号化 | |
| オプション MCP | Google Cloud Pub/Sub HTTP MCP | `.mcp.json` のデフォルト拒否許可リスト |
| ロギング | `pino`（Next）+ `structlog`（ADK） | `LOG_LEVEL`、`LOG_PAYLOAD`、`LOG_FORMAT` 共有 |

## 3. プロジェクト構成

```
sap-rag-integration/
├── adk_agent/                    # Python: LlmAgent + ツール + MCP
│   ├── agent.py                  # root_agent の配線
│   ├── server.py                 # FastAPI ブートストラップ（build_app + main）
│   ├── settings.py               # フローズンデータクラスの env ローダー
│   ├── probes.py                 # 4 つの起動プローブ
│   ├── mcp_pubsub.py             # Pub/Sub MCP ツールセット + リソースゲート
│   ├── oauth.py                  # SAP OAuth2 PKCE ヘルパー
│   ├── crypto.py                 # パスワード保存用 Fernet ラッパー
│   ├── sap_auth_config.py        # ADK AuthConfig ビルダー（現在未使用）
│   ├── services.yaml             # SAP カタログ（4 サービス）
│   ├── rag/
│   │   ├── db.py                 # asyncpg プール + コサイン検索
│   │   └── embedding.py          # genai embed_content（RETRIEVAL_QUERY）
│   ├── tools/
│   │   ├── rag_tool.py           # search_documents
│   │   ├── auth_tool.py          # sap_authenticate
│   │   ├── service_tool.py       # sap_list_services
│   │   ├── query_tool.py         # sap_query
│   │   └── entity_tool.py        # sap_get_entity
│   ├── sap_gw_connector/         # ベンダリングされた SAP Gateway クライアント
│   ├── tests/                    # pytest ユニットテスト
│   ├── Dockerfile                # python:3.12-slim + uv sync、EXPOSE 8200
│   └── .env.example
│
├── src/                          # TypeScript: Next.js アプリ
│   ├── app/
│   │   ├── layout.tsx, page.tsx（redirect → /chat）
│   │   ├── chat/page.tsx
│   │   ├── admin/pipeline/page.tsx
│   │   └── api/
│   │       ├── chat/route.ts
│   │       ├── conversations/{[…],[id]/messages/}
│   │       ├── embed/route.ts
│   │       ├── pipeline/{start,status,upload}/route.ts
│   │       ├── files/[...path]/route.ts
│   │       └── sap/{auth,oauth/callback,services}/route.ts
│   ├── components/               # ChatWindow、ChatSidebar、ChatInput、SAPDataView、PipelineDashboard、ui/*
│   ├── lib/
│   │   ├── adk-client.ts         # SSE パーサー + runSse + createSession + authBasic
│   │   ├── session.ts            # iron-session sap_session クッキー（8 時間）
│   │   ├── oauth-pending.ts      # iron-session sap_oauth_pending クッキー（10 分）
│   │   ├── db.ts + schema.ts     # Drizzle: embeddings、conversations、messages
│   │   ├── embedding-ingest.ts   # テキスト/PDF/画像/音声/動画のインジェスション
│   │   ├── gemini.ts             # GoogleGenAI クライアントラッパー
│   │   ├── gcs.ts                # uploadToGCS + downloadFromGCS（トラバーサルガード）
│   │   ├── file-parser.ts        # カテゴリ、MIME、EMBEDDING_LIMITS、chunkText
│   │   ├── env.ts                # 必須 vs オプションガード
│   │   ├── pipeline-state.ts     # インメモリのインジェスション進捗シングルトン
│   │   ├── request-context.ts    # {requestId, conversationId} 用 AsyncLocalStorage
│   │   ├── concurrency.ts        # mapWithLimit（境界付き並列マッパー）
│   │   ├── logger.ts             # リダクション付き pino
│   │   └── utils.ts
│   ├── proxy.ts                  # Next 16 proxy.ts — REQUIRE_AUTH ゲート
│   └── scripts/                  # setup-db、migrate-sap-user-id、pipeline（CLI）
│
├── scripts/                      # リポジトリ全体のスクリプト
│   ├── check-parent-workspace.mjs（predev）
│   ├── check-adk-health.mjs       （predev）
│   ├── setup-gcp-service-account.sh
│   ├── test_pubsub_mcp_live.py
│   ├── fetch_sap_metadata.py
│   ├── list_sap_services.py
│   ├── benchmark-rag.ts
│   └── migration-parity-check.py + parity-targets.yaml（廃止済み）
│
├── tests/e2e/                    # Playwright スモークテスト
├── docs/                         # このディレクトリ
├── .mcp.json                     # プロジェクトスコープの Pub/Sub MCP 設定
├── docker-compose.yml            # nextjs + adk（sap-service なし）
├── next.config.ts                # CSP、turbopack.root、image remotePatterns
├── drizzle.config.ts, vitest.config.ts, playwright.config.ts, eslint.config.mjs
├── package.json + pnpm-lock.yaml + pnpm-workspace.yaml
├── pyproject.toml + uv.lock
├── README.md, README.ko.md, README.ja.md, installation.md, CLAUDE.md
└── .env.local.example, adk_agent/.env.example
```

## 4. 環境セットアップ

プロセスごとに 1 つずつ、合計 2 つの env ファイルがあります。テンプレートは `.env.local.example` と `adk_agent/.env.example` にあります。完全なリファレンスは [DEPLOYMENT.md §1](./ja/DEPLOYMENT.md#1-環境変数) にあります。短縮版:

| ファイル | 必須設定 |
|------|----------|
| `.env.local` | `GEMINI_API_KEY`、`DATABASE_URL`、`GCS_BUCKET_NAME`、`GCS_PROJECT_ID`、`SAP_SESSION_SECRET` |
| `adk_agent/.env` | `DATABASE_URL`、`SAP_HOST`、`EMBED_MODEL`、`EMBED_OUTPUT_DIM`、`SAP_CRED_ENCRYPTION_KEY` |

`SAP_SESSION_SECRET` は 32 文字以上の iron-session 署名キーです（`openssl rand -base64 48`）。`SAP_CRED_ENCRYPTION_KEY` は Fernet キーです（`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`）。

Next.js プロセスは、ADK エージェントが `${ADK_BASE_URL}/healthz` に応答していない場合、`pnpm dev` 経由での起動を拒否します（`scripts/check-adk-health.mjs` の predev ガード）。また、親ディレクトリにワークスペースマーカーファイル（`package.json`、`pnpm-workspace.yaml`、`*-lock.*`）が存在する場合も起動を拒否します — これは CLAUDE.md に記載されている Turbopack CSS リゾルバーバグです。

起動順序:

```bash
# ターミナル 1
uv run python -m adk_agent.server   # /healthz が green になるまで待機

# ターミナル 2
pnpm dev                            # predev が ADK をプローブし、next dev を起動
```

## 5. ADK エージェント

### 5.1 `agent.py` — ルートエージェント

`adk_agent/agent.py` は以下を持つ単一の `Agent`（`LlmAgent` のエイリアス）をビルドします:

- `name="sapphire26_agent"`
- `model = os.getenv("SAP_AGENT_MODEL", "gemini-3.1-pro-preview")`
- 以下を LLM に指示する短いシステムプロンプト:
  - ドキュメントの質問は `search_documents` に、SAP の質問は `sap_query` / `sap_get_entity` にルーティングする。
  - `action_required` エンベロープをそのまま提示する（`login_url` がある場合はフロントエンドがログイン UI をレンダリングできるよう含める）。
  - SAP の結果をマークダウンテーブルとしてレンダリングし、RAG の `source` フィールドを引用する。
- 以下の順序で登録されたツール:
  1. `search_documents`
  2. `sap_authenticate`
  3. `sap_list_services`
  4. `sap_query`
  5. `sap_get_entity`
  6. *（オプション）* `McpToolset(pubsub …)` — `setup_pubsub_mcp()` がバンドルを返す場合。
- `before_tool_callback = _pubsub.gate` は Pub/Sub が配線されている場合のみ。

エージェントは独自の会話メモリ層を維持しません — それは ADK セッションバックエンドの仕事です。`ADK_SESSION_BACKEND=memory`（デフォルト）では状態はレプリカごとです。マルチレプリカデプロイでは `vertex` に切り替えて Vertex AI Agent Engine セッションストアを使用してください。

### 5.2 `server.py` — FastAPI ブートストラップ

`build_app(run_probes=True)`:

1. 設定をロードします（`adk_agent/settings.py`）。
2. 4 つの起動プローブをすべて実行します（yaml、db、埋め込みモデル、Secret Manager）。
3. `google.adk.cli.fast_api.get_fast_api_app(agents_dir, session_service_uri, allow_origins=["http://localhost:3000"], web=False)` を呼び出します — `/run`、`/run_sse`、標準 ADK コントロールサーフェスを提供します。
4. 2 つのカスタムルートを追加します:
   - `GET /healthz` — `pnpm predev` が使用。
   - `POST /sap/auth/basic` — `sap_authenticate(method="basic", …)` の直接呼び出し。LLM を介さずに iron-session クッキーに Fernet 暗号化された認証情報をシードできます。
5. `main()` はプローブを同期的に実行し、次に `uvicorn.run(app, host=ADK_HOST, port=ADK_PORT)` を実行します。

### 5.3 `settings.py` — env ローダー

フローズンデータクラス。`[DATABASE_URL, SAP_HOST, EMBED_MODEL, EMBED_OUTPUT_DIM, SAP_CRED_ENCRYPTION_KEY]` のいずれかが未設定の場合、起動時に `RuntimeError("missing env: …")` を発生させます。設定ミスを LLM の実行中の不可解なエラーから排除します。

### 5.4 `probes.py` — 起動プローブ

4 つのプローブ（すべて `asyncio.run` 経由で実行）:

1. `_probe_services_yaml` — `services.yaml` をロード、空の場合は失敗。
2. `_probe_db` — asyncpg で接続し、`embeddings` テーブルが存在することを確認。
3. `_probe_embed_model` — `"ping"` を埋め込み、次元 = `EMBED_OUTPUT_DIM` であることを確認。
4. `_probe_secret_manager` — `GOOGLE_CLOUD_PROJECT` が設定されている場合のみ実行。

プローブが失敗すると FastAPI アプリの起動を妨げるため、前提条件が満たされていない場合 `/healthz` は green を報告しません。

### 5.5 `crypto.py` — Fernet ラッパー

`SAP_CRED_ENCRYPTION_KEY` から遅延初期化されるシングルトン。`sap_authenticate` が ADK プロセスを離れる前に SAP の Basic 認証パスワードを暗号化するために使用し、OData 呼び出しの瞬間に `_client_for`（`query_tool` / `entity_tool` 内）が復号するために使用します。平文のパスワードはどこにも永続化されません — iron-session クッキーも暗号化されたブロブを保持します。

## 6. 5 つの LLM ツール

各ツールは `adk_agent/tools/*.py` の `async def` callable です。`tool_context` 引数は ADK が呼び出し時に提供し、チャットルートによってシードされたセッション状態を公開します。

### 6.1 `search_documents`

```python
search_documents(query: str, top_k: int = 8) -> dict
```

`EMBED_MODEL`（`task_type=RETRIEVAL_QUERY`）でクエリを埋め込み、pgvector コサイン検索を実行します:

```sql
SELECT id, file_name, chunk_text, 1 - (embedding <=> $1::vector) AS score
FROM embeddings
ORDER BY embedding <=> $1::vector
LIMIT $2
```

`{results: [{id, file_name, chunk_text, score}], count}` を返します。埋め込みモデルの失敗や DB 不可用時は、チャットが継続できるよう `{results: [], count: 0, warning: "embedding_unavailable" | "vector_db_unavailable"}` のソフトエンベロープを返します。

### 6.2 `sap_authenticate`

単一の SAP 認証ゲート。3 つの呼び出し形式:

| 形式 | 意味 |
|-------|---------|
| `method="basic", username, password` | Basic ヘッダーで SAP をプローブし、`{success, sap_user, credentials:{...encrypted}}` を返す |
| `method="oauth", user_id` | Step 1: `oauth.build_login_url` を呼び出し、`{success:false, action_required:"sap_login", login_url, oauth_state}` を返す |
| `method="oauth", code, state, user_id` | Step 2: `oauth.exchange_code` を呼び出し、`{success, access_token, refresh_token, sap_user, expires_at}` を返す |

システムプロンプトは `action_required` エンベロープをそのまま転送し、`ChatWindow.tsx` は `action_required: "sap_login"` を認識してインラインログインフォーム（basic）または OAuth `login_url` を表示します。

### 6.3 `sap_list_services`

`adk_agent/services.yaml` の同期読み取り。実行時にエラーは発生しません（YAML が空の場合は起動プローブが既に失敗しています）。

バンドルされたカタログは 4 つのサービスをカバーします:

- `API_PRODUCT_SRV` — 製品マスター（主力; 約 32 エンティティセット）
- `API_MATERIAL_STOCK_SRV` — 資材在庫
- `API_PLANT_SRV` — プラントマスター
- `API_MATERIAL_DOCUMENT_SRV` — 資材伝票

各エンティティは `name`、`key_field`、`description`、`navigations`、`default_select` を保持しているため、エージェントはトライアルアンドエラーなしに非trivial な `sap_query` 呼び出しを構築できます。

### 6.4 `sap_query`

呼び出しごとに新しい `SAPClient` をビルドして SAP を呼び出します（`async with` ブロック内）。v2（`d.results`）と v4（`value`）の両方のレスポンスエンベロープが `_transform` によって正規化されます。

```python
sap_query(
    service_id: str,
    entity_set: str,
    filter: str | None = None,    # OData $filter 句
    select: str | None = None,    # OData $select 句
    top: int | None = None,
    skip: int | None = None,
) -> dict
```

認証ゲート: `tool_context.state["sap_credentials"]` がない場合、`{success:false, action_required:"sap_login", error:"not_authenticated"}` を返してネットワークには接触しません。`SAPAuthenticationError`（例: トークン期限切れ）では、フロントエンドがユーザーに再ログインを促せるよう `action_required: "re_authenticate"` にアップグレードされます。

### 6.5 `sap_get_entity`

`sap_query` と同じ認証モデル。キーによる単一エンティティ取得:

```python
sap_get_entity(service_id: str, entity_set: str, key: str) -> dict
```

`{success: true, entity: {…}}` を返します。

## 7. オプションの Pub/Sub MCP ツールセット

リポジトリルートの `.mcp.json` は `mcpServers.pubsub` HTTP MCP エントリ（`https://pubsub.googleapis.com/mcp`）を定義します。ADK 起動時、`adk_agent/mcp_pubsub.py:setup_pubsub_mcp()` は:

1. `.mcp.json` を解析し、`type=="http"`、URL、必須の `x-goog-user-project` ヘッダーを検証します。
2. `https://www.googleapis.com/auth/pubsub` スコープの ADC を取得します。
3. `McpToolset(StreamableHTTPConnectionParams, tool_filter=allowed_tools, header_provider=…)` をビルドします。`header_provider` は **HTTP 交換ごとに**呼び出されるため、トークンリフレッシュは透過的に行われます。
4. 許可されたツール/トピック/サブスクリプションと引数形式ヒントを列挙する `instruction_block`（エージェントプロンプトに追加）をビルドします。
5. `gate`（`before_tool_callback`）をビルドします。ゲートはツール引数で `topicId / topic / topicName / topic_name`（およびサブスクリプションバリアント）のいずれかを検査し、一致しない値を `{"isError": true, "content":[{"type":"text","text":"Access denied: …"}]}` で拒否します。

デフォルトポリシーは**デフォルト拒否**です:

| `.mcp.json` フィールド | 欠如/空の場合の効果 |
|-------------------|---------------------------|
| `allowedTools` | 0 個の Pub/Sub ツールが公開される |
| `allowedTopics` | すべての `topicId` 引数が拒否される |
| `allowedSubscriptions` | すべての `subscriptionId` 引数が拒否される |

呼び出し元プリンシパルは `roles/mcp.toolUser` と `roles/pubsub.editor` の両方を持つ必要があります。ローカル開発では `gcloud auth application-default login` を 1 回実行するだけで十分です。

エンドツーエンドの配線を確認するには:

```bash
uv run python scripts/test_pubsub_mcp_live.py
```

## 8. Next.js API サーフェス

すべてのルートは `src/app/api/**/route.ts` にあります。`runtime='nodejs'` を使用し、ほとんどが `maxDuration=300` を固定します。`sap_session` クッキーが正規の認証シグナルです。`requireSession()` は欠如時に `401 NOT_AUTHENTICATED` を返します。

| パス | メソッド | 役割 |
|------|-----------|------|
| `/api/chat` | POST | ADK `/run_sse` への SSE プロキシ; ユーザー + アシスタントメッセージを永続化; 最初のターンで自動タイトル付け |
| `/api/conversations` | GET / POST / DELETE | `conversations.sap_user_id` にスコープされた CRUD |
| `/api/conversations/[id]/messages` | GET | 会話の順序付きメッセージ |
| `/api/embed` | POST | 1 ファイルのマルチパートアップロード（≤100 MB）→ `embedFile` |
| `/api/pipeline/start` | POST | バックグラウンドバッチインジェスション（`./data` / `./uploads` 配下のローカル、または `gs://…`） |
| `/api/pipeline/upload` | POST | マルチパート `files[]` インジェスション |
| `/api/pipeline/status` | GET | インメモリ `pipeline-state` のスナップショット |
| `/api/files/[...path]` | GET | トラバーサルガード付き GCS ファイルプロキシ |
| `/api/sap/auth` | GET / POST / DELETE | ログイン / プローブ / ログアウト。POST `{method:"basic"}` は ADK `/sap/auth/basic` にプロキシし `sap_session` を設定 |
| `/api/sap/oauth/callback` | GET | OAuth `?code&state` ランディング — Step-2 配線が未完のため現在は失敗クローズ |
| `/api/sap/services` | GET | ADK `/run` から `sap_list_services` を転送 |

詳細なペイロード、ステータスコード、SSE イベント形式は [API.md](./ja/API.md) にあります。注目すべき 2 点:

- **チャットルート** は各 SSE チャンクを `src/lib/adk-client.ts:normalizeAdkEvent` で解析します。Gemini `parts[]` を `{type: text_delta | tool_call | tool_result | error}` にフラット化し、組み立てられたメッセージが二重表示されないよう `partial:false` 集計テキストフレームを**ドロップ**します。
- **OAuth コールバック** はスタブです。Step-2 トークン交換は `adk_agent/oauth.exchange_code` にありますが、Next.js ルートはまだそれを呼び出していません。[`docs/followups/post-migration.md`](./followups/post-migration.md) でトラッキングされています。

## 9. フロントエンドコンポーネント

```
src/components/
├── ChatSidebar.tsx        # 会話リスト、新規/選択/削除、セッションユーザーヘッダー、ログアウト
├── ChatWindow.tsx         # remark-gfm 付き markdown ストリーム、コピーボタン、添付ファイルグリッド、インライン SAP ログインフォーム
├── ChatInput.tsx          # テキストエリア + ペーパークリップファイルピッカー + 送信
├── PipelineDashboard.tsx  # ソースパス入力 + フォルダアップロード + ステータスポーリング
├── SAPDataView.tsx        # 汎用レコード配列 → テーブルレンダラー（チャット内で使用）
└── ui/                    # shadcn プリミティブ（button、card、dialog、input、…）
```

`src/app/chat/page.tsx` のチャットシェルは `ChatSidebar + ChatWindow + ChatInput` のシンプルなコンポジションです。クライアント側の状態マネージャーはありません — ローカル状態はコンポーネントフックに、サーバー状態は API ルートへの `fetch()` で取得されます。

## 10. データベーススキーマ

3 つのテーブル。`src/lib/schema.ts` で定義され、`pnpm db:setup` で作成されます:

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

`sap_user_id` は `sap_authenticate` が返す SAP ログイン名です。すべての conversations CRUD エンドポイントがそれでフィルタリングします — iron-session クッキーが Web ユーザーを SAP ユーザーにバインドし、他の SAP ユーザーが所有する行は不可視です。

`sap_user_id` カラムを持たないレガシー DB の場合は `pnpm db:migrate:sap-user-id` が冪等に追加します。

## 11. インジェスションパイプライン

エントリ: `src/lib/embedding-ingest.ts:embedFile(buffer, fileName)`。

1. `file-parser.getFileCategory(fileName)` → `text | pdf | image | audio | video`。
2. `src/lib/gcs.ts:uploadToGCS` 経由でバッファを GCS の `uploads/{uuid}{ext}` にアップロードします。
3. カテゴリに基づいて分岐:
   - **テキスト** — `chunkText(content, 2000, 200)` して各チャンクを並列で埋め込み（`mapWithLimit` で並行数 3）。
   - **PDF** — `pdf-lib` が 6 ページスライスに分割; 各スライスはマルチモーダル埋め込みのために `application/pdf` inlineData として送信され、`pdf-parse` がテキストを抽出し `gemini.ts:generateContentSummary` が AI サマリーを生成します。
   - **画像 / 音声 / 動画** — ファイルを `inlineData` とする単一マルチモーダル埋め込みと AI サマリー。
4. 3072 次元ベクトルと `metadata` jsonb（MIME タイプ、サイズ、ページインデックス等）を `embeddings` に INSERT します。

`/api/pipeline/start`（ローカルディレクトリまたは `gs://…` プレフィックス）と `/api/pipeline/upload`（複数ファイルのブラウザアップロード）の両方がこのループをバックグラウンドタスクでラップします。進捗はインメモリの `pipeline-state` シングルトンに保存されます。管理 UI は `/api/pipeline/status` をポーリングします。**永続化はありません** — Next.js プロセスを再起動するとインフライトの状態がクリアされます。

ワンオフ CLI 使用:

```bash
pnpm pipeline -- ./data
pnpm pipeline -- gs://my-bucket/documents
```

## 12. 認証モデル

### 12.1 Web セッション

`iron-session` クッキー `sap_session`、`SAP_SESSION_SECRET` で署名。TTL 8 時間。`httpOnly`、`sameSite=lax`、本番環境のみ `secure`。ボディ: `{sapUserId, loggedInAt, sapCredentials?}`。`src/lib/session.ts` で定義。

別の `sap_oauth_pending` クッキー（10 分 TTL、同じシークレット）がインフライトの OAuth 状態を保持し、`/api/sap/oauth/callback` が返された `state` パラメータを検証できるようにします（`src/lib/oauth-pending.ts`）。

### 12.2 SAP 認証情報

Basic 認証: パスワードは `sap_authenticate` レスポンスが ADK プロセスを離れる前に Fernet 暗号化（`crypto.encrypt`）されます。暗号化されたブロブが Next.js を通じて iron-session クッキーに往復し、次のチャットターンで ADK セッション状態に戻され、OData 呼び出しの瞬間に `_client_for` 内でのみ復号されます。

OAuth + PKCE: `oauth.build_login_url` と `oauth.exchange_code` は PKCE を使用します。チャット駆動のフローは [ARCHITECTURE.md §4.2](./ja/ARCHITECTURE.md#42-oauth-20--pkce) に記載されています。Next.js コールバックからエージェントへの Step-2 配線はオープンなフォローアップです。

### 12.3 プロキシゲート

`src/proxy.ts`（Next 16 の名称変更されたミドルウェア）は `REQUIRE_AUTH=true` でない限り無操作です。有効の場合、`/api/chat`、`/api/embed`、`/api/conversations`、`/api/pipeline/*`、`/api/files/*`、`/api/sap/services` を各ハンドラーの `requireSession()` チェックに加えてプロキシ層でゲートします。ユーザーがログインできるよう `/api/sap/auth` は意図的に除外されています。

### 12.4 Pub/Sub 許可リスト

`before_tool_callback` ゲート（§7 参照）は、アップストリーム MCP サーバーがより多くを公開していても、LLM がキュレートされたセット外のトピックやサブスクリプションに触れることを防ぎます。

## 13. 可観測性

両プロセスが構造化 JSON をログ出力します。尊重される環境変数:

- `LOG_LEVEL` — `debug | info | warn | error`
- `LOG_PAYLOAD` — `meta`（ステータス + カウント）または `full`（レスポンスボディ）。本番環境ではアクティブなデバッグ中でない限り `meta` を維持してください — `full` は未リダクトの SAP レスポンスを書き込みます。
- `LOG_FORMAT`（Next のみ）— `pretty` は stdout pino-pretty ターゲットを追加; ファイル出力は常に JSON。
- `LOG_DIR`（Next のみ）— ファイル出力ディレクトリ、デフォルト `./logs`。

`src/lib/logger.ts` はリダクションリストを定義します: `Authorization`、`Set-Cookie`、`Cookie`、`access_token`、`refresh_token`、`password`。

`src/lib/request-context.ts` は `AsyncLocalStorage` を使用して、単一のチャットターン中に発行されるすべてのログ行に `{requestId, conversationId}` を付加します — 本番ログでユーザーの会話を grep するときに便利です。

ADK エージェントは `structlog` を使用します; ログは Cloud Run / Docker が収集する stdout に出力されます。

## 14. テスト

| サーフェス | ツール | コマンド |
|---------|---------|---------|
| Next.js ユニット | Vitest + v8 カバレッジ | `pnpm test` / `pnpm test:run` / `pnpm test:coverage` |
| Next.js e2e | Playwright（単一 chromium プロジェクト） | `pnpm e2e`（Next + ADK が既に起動していることが前提） |
| ADK ユニット | pytest + pytest-asyncio + pytest-cov | `uv run pytest` |
| Pub/Sub MCP ライブ | Python スクリプト | `uv run python scripts/test_pubsub_mcp_live.py` |

カバレッジゲートはプロジェクトごとにトラッキングされます。ADK 側はマイグレーション時点で 80%+ のユニットカバレッジを備えています（MCP 固有テストは `uv run python -m pytest adk_agent/tests/unit/test_mcp_pubsub_*`）。

Vitest 設定（`vitest.config.ts`）: `node` 環境、`src/**/__tests__/**/*.test.ts` を含む、セットアップ `./src/lib/__tests__/_support/setup.ts`、エイリアス `@` → `./src`。

## 15. 運用上の落とし穴

長いデバッグセッションの前に覚えておく価値のある注意点です。

### 15.1 親ワークスペース Turbopack バグ

`pnpm dev` が最初のリクエストでハングしたり、ホストのメモリを使い切ったり、`posix_spawn EAGAIN` エラーをスパムしたりする場合:

- 原因: Turbopack の CSS `@import` リゾルバーは `next.config.ts` の `turbopack.root` を**尊重しません**。ワークスペースマーカーファイル（`package.json`、`*-lock.*`、`pnpm-workspace.yaml`）が親ディレクトリに存在すると、Turbopack はその親をワークスペースルートとして扱い、`globals.css` の `@import "tailwindcss"` の解決に失敗し、CSS チャンクごとにコンパイルごとに約 30 KB の解決トレースエラーを macOS のフォークプールが枯渇するまで吐き出します。
- 修正: 問題のある親ファイルを削除し、`rm -rf .next` してから再起動します。
- 防衛: `scripts/check-parent-workspace.mjs` が `predev` として実行され、早期に失敗します; `dev` スクリプトは `NODE_OPTIONS=--max-old-space-size=4096` を設定して OS フォークプールが枯渇する前に Node が OOM になるようにします。
- アップストリームドラフト: [`docs/issues/2026-04-29-nextjs-turbopack-css-resolver-bug.md`](./issues/2026-04-29-nextjs-turbopack-css-resolver-bug.md)。

### 15.2 `pnpm dev` の前に ADK が起動している必要がある

`scripts/check-adk-health.mjs` が `predev` として実行され、`${ADK_BASE_URL}/healthz` が green でない場合は 1 で終了します。`predev` をバイパスすると、チャットルートはすべてのターンで 503 を返します。

### 15.3 HMR シングルトンの蓄積

`db.ts`、`logger.ts`、`gemini.ts`、`gcs.ts` は HMR モードでモジュールの再評価時に再インスタンス化されます。長い開発セッションでは Postgres プールとログストリームが蓄積されます。CLAUDE.md で計画されたクリーンアップとしてトラッキングされています。

### 15.4 インメモリ状態

`pipeline-state.ts` とデフォルトの ADK セッションバックエンド（`memory`）はどちらもプロセス再起動でリセットされます。マルチレプリカ本番環境では ADK を `ADK_SESSION_BACKEND=vertex` に切り替えて Vertex AI Agent Engine セッションストアを使用してください。

### 15.5 埋め込みモデル

インジェスションパス（Next 側）と RAG クエリパス（ADK 側）はどちらも `gemini-embedding-2` を使用し、`vector(3072)` をターゲットとします。モデルを変更する場合は `GEMINI_EMBEDDING_MODEL` と `EMBED_MODEL` の両方を更新し、`EMBED_OUTPUT_DIM` がカラム型と一致することを確認してください — `vector(N)` カラムはインプレースで ALTER できません。

### 15.6 廃止されたアーティファクト

- `sap-service/` — コミット `822a49f` で空にされました; `__pycache__` と `stray .env` のみ残っています。削除しても安全です。
- `scripts/migration-parity-check.py` と `scripts/parity-targets.yaml` — 旧 `sap-service` の `/query` と新しい ADK の `sap_query` を比較していました; レガシーサービスが削除されたため不要になりました。

---

## 参照

- [`README.md`](../README.md) — トップレベル README（英語）
- [`README.ko.md`](../README.ko.md) — トップレベル README（韓国語）
- [`README.ja.md`](../README.ja.md) — トップレベル README（日本語）
- [`installation.md`](../installation.md) — エージェント実行可能なインストール手順
- [`docs/en/`](./en/) — ロケール別ドキュメントセット（英語）
- [`docs/ko/`](./ko/) — ロケール別ドキュメントセット（韓国語）
- [`docs/ja/`](./ja/) — ロケール別ドキュメントセット（日本語）
- [`docs/superpowers/specs/2026-04-29-adk-migration-design.md`](./superpowers/specs/2026-04-29-adk-migration-design.md) — 元のマイグレーション設計ドキュメント
- [`docs/followups/post-migration.md`](./followups/post-migration.md) — オープンなフォローアップ項目
