# sap-rag-integration

本番品質の RAG + SAP エージェントワークフローです。単一の Google ADK `LlmAgent`（Python、ポート 8200）が 5 つのツール — マルチモーダルコーパスに対するベクトル検索と 4 つの SAP OData ツール — を保有し、Next.js 16 アプリがチャット UI とインジェスションパイプラインを提供します。Next.js レイヤーは**エージェントロジックを持ちません**。すべてのチャットターンは SSE を通じて ADK エージェントへプロキシされます。

## コンポーネント

| コンポーネント | スタック | ポート | 責務 |
|-----------|-------|------|----------------|
| Next.js アプリ | Next 16 + React 19 + Tailwind 4 | 3000 | チャット UI、管理パイプライン UI、ADK プロキシ、GCS ファイルプロキシ、iron-session 認証 |
| ADK エージェント | Python 3.11+ / google-adk + FastAPI | 8200 | LlmAgent + 5 ツール（RAG + SAP）+ オプションの Pub/Sub MCP ツールセット |
| PostgreSQL | 17+ with pgvector / halfvec(3072) | 5432 | RAG 埋め込み、会話、メッセージ |
| Google Cloud Storage | — | — | アップロードされたソースファイル（`/api/files/...` 経由で配信） |
| Google Cloud Pub/Sub MCP（オプション） | `pubsub.googleapis.com/mcp` の HTTP MCP | — | 許可リスト制御のもとで LLM に公開されるトピック/サブスクリプション/パブリッシュ操作 |

レガシーのスタンドアロン `sap-service/` FastAPI サイドカーはコミット `822a49f` で削除されました。SAP 統合は現在、ベンダリングされた `adk_agent/sap_gw_connector` パッケージを通じて ADK エージェント内でインプロセスで行われます。

## 5 つの LLM ツール

`adk_agent/tools/` 配下で定義され、[`adk_agent/agent.py`](../../adk_agent/agent.py) に登録されています。

| ツール | 目的 | 認証ゲート |
|------|---------|-----------|
| `search_documents(query, top_k=8)` | `embeddings` テーブルに対する pgvector コサイン検索。`{id, file_name, chunk_text, score}` を返す | なし |
| `sap_authenticate(method, …)` | ゲート。Basic は成功 + `sap_user` を返す。OAuth Step 1 は `action_required: "sap_login"` + `login_url` を返す。LLM はこれをそのまま提示するよう指示される | 該当なし（これがゲート） |
| `sap_list_services()` | `adk_agent/services.yaml` を読み込み、サービスカタログ（id、path、エンティティ、キーフィールド）を返す | なし |
| `sap_query(service_id, entity_set, filter?, select?, top?, skip?)` | `sap_gw_connector.SAPClient` 経由で SAP OData v2/v4 を呼び出し、`d.results` と `value` エンベロープの両方を正規化する | `tool_context.state["sap_credentials"]` が必要 |
| `sap_get_entity(service_id, entity_set, key)` | キーで単一エンティティを取得する | `sap_credentials` が必要 |

`setup_pubsub_mcp()` が有効な `.mcp.json` エントリを検出した場合、追加の `McpToolset` がツールリストに追加され、デフォルト拒否の `before_tool_callback` が許可リスト外のトピック/サブスクリプションを拒否します。

## クイックスタート

前提条件: Node 20+、pnpm、Python 3.11+、`uv`、pgvector を有する PostgreSQL 17+、GCS バケットを持つ Google Cloud プロジェクト、および Gemini API キー。

AI エージェントが実行するためのステップバイステップの手順については [`installation.md`](../../installation.md) を参照してください。短縮版:

```bash
# 1. クローンとインストール
git clone https://github.com/midasol/sap-rag-integration.git
cd sap-rag-integration
pnpm install
uv venv && uv sync

# 2. 両方の env ファイルを設定
cp .env.local.example .env.local         # Next.js
cp adk_agent/.env.example adk_agent/.env # ADK エージェント
#   設定項目: GEMINI_API_KEY, DATABASE_URL, GCS_BUCKET_NAME, GCS_PROJECT_ID,
#            SAP_SESSION_SECRET (openssl rand -base64 48),
#            SAP_HOST + SAP_AUTH_TYPE, SAP_CRED_ENCRYPTION_KEY (Fernet)

# 3. データベース
createdb gemini_rag
pnpm db:setup    # pgvector 拡張 + 3 テーブル + HNSW halfvec インデックス

# 4. 両プロセスを起動
uv run python -m adk_agent.server    # ターミナル 1 — ポート 8200
pnpm dev                              # ターミナル 2 — ポート 3000（predev が ADK /healthz を確認）
```

<http://localhost:3000> を開くと `/chat` にリダイレクトされます。`sap_session` クッキーが存在しない場合、チャットサイドバーにインライン SAP ログインフォームが表示されます。

## プロジェクト構成

```
adk_agent/
├── agent.py                 # root_agent: 5 ツールを配線する LlmAgent（+ オプションの Pub/Sub MCP）
├── server.py                # google.adk.cli.fast_api.get_fast_api_app 経由の FastAPI アプリ
├── settings.py              # フローズンデータクラスの env ローダー
├── probes.py                # 起動プローブ（yaml、db、埋め込みモデル、Secret Manager）
├── mcp_pubsub.py            # Pub/Sub MCP ツールセット + デフォルト拒否リソースゲート
├── oauth.py                 # SAP OAuth2 PKCE ヘルパー
├── crypto.py                # パスワード保存用 Fernet ラッパー
├── services.yaml            # SAP OData サービスカタログ（4 サービスバンドル）
├── rag/
│   ├── db.py                # asyncpg プール + pgvector コサイン検索
│   └── embedding.py         # genai.Client embed_content(model=EMBED_MODEL)
├── tools/
│   ├── rag_tool.py          # search_documents
│   ├── auth_tool.py         # sap_authenticate (basic + oauth Step1/Step2)
│   ├── service_tool.py      # sap_list_services
│   ├── query_tool.py        # sap_query
│   └── entity_tool.py       # sap_get_entity
└── sap_gw_connector/        # ベンダリングされた SAP Gateway クライアント（auth、sap_client、transports）

src/
├── app/
│   ├── chat/page.tsx
│   ├── admin/pipeline/page.tsx
│   └── api/
│       ├── chat/route.ts                # ADK /run_sse への SSE プロキシ
│       ├── conversations/                # sap_user_id にスコープされた CRUD
│       ├── embed/                        # 単一ファイル埋め込み（マルチパート）
│       ├── pipeline/{start,status,upload}/
│       ├── files/[...path]/              # パストラバーサルガード付き GCS ファイルプロキシ
│       └── sap/
│           ├── auth/                     # POST {method:"basic"} → ADK /sap/auth/basic、クッキー設定
│           ├── oauth/callback/           # OAuth ラウンドトリップ（現在はスタブ）
│           └── services/                 # GET → ADK function_call: sap_list_services
├── lib/
│   ├── adk-client.ts        # SSE パーサー + runSse + createSession + authBasic
│   ├── session.ts           # iron-session、sap_session クッキー、8 時間 TTL
│   ├── oauth-pending.ts     # sap_oauth_pending クッキー、10 分 TTL
│   ├── db.ts + schema.ts    # Drizzle: embeddings、conversations、messages
│   ├── embedding-ingest.ts  # テキスト/PDF/画像/音声/動画のインジェスション
│   ├── gemini.ts, gcs.ts, file-parser.ts, env.ts, …
│   └── pipeline-state.ts    # インメモリのインジェスション進捗
├── components/              # ChatWindow / ChatSidebar / ChatInput / SAPDataView / PipelineDashboard / ui/*
├── proxy.ts                 # Next 16 proxy.ts — REQUIRE_AUTH=true の場合に保護されたルートをゲート
└── scripts/                 # setup-db.ts, migrate-sap-user-id.ts, pipeline.ts（CLI）

.mcp.json                    # プロジェクトスコープの MCP 設定: Pub/Sub HTTP MCP + 許可リスト
docker-compose.yml           # nextjs + adk サービス（sap-service なし）
```

## API サーフェス（Next.js）

| メソッド | パス | 説明 |
|--------|------|-------------|
| `POST` | `/api/chat` | ADK `/run_sse` への SSE プロキシ。メッセージを永続化し、自動タイトル付け。`sap_session` が必要。 |
| `GET / POST / DELETE` | `/api/conversations` | `sap_user_id` にスコープされた CRUD |
| `GET` | `/api/conversations/[id]/messages` | 会話の順序付きメッセージ |
| `POST` | `/api/embed` | マルチパートアップロード + `embedFile`（≤100 MB） |
| `POST` | `/api/pipeline/start` | ローカルディレクトリまたは `gs://…` プレフィックスのバックグラウンドインジェスション |
| `GET` | `/api/pipeline/status` | インメモリパイプライン状態のスナップショット |
| `POST` | `/api/pipeline/upload` | マルチパート `files[]` インジェスション |
| `GET` | `/api/files/[...path]` | GCS ファイルプロキシ（パストラバーサルガード付き） |
| `GET / POST / DELETE` | `/api/sap/auth` | GET = セッションプローブ; POST `{method:"basic"}` → ADK `/sap/auth/basic`、`sap_session` を設定; DELETE はクリア |
| `GET` | `/api/sap/oauth/callback` | OAuth code/state ランディング — Step-2 配線が未完のため現在は失敗クローズ |
| `GET` | `/api/sap/services` | ADK から `sap_list_services` を転送 |

ADK エージェント自体は `/run_sse`（`get_fast_api_app` が提供）、`/healthz`、`/sap/auth/basic`（Next.js からプロキシ）を公開します。

完全なペイロードと SSE イベント形式については [API.md](./API.md) を参照してください。

## 設定の概要

プロセスごとに 1 つずつ、合計 2 つの env ファイルがあります。

- **Next.js** — `.env.local`（テンプレート: `.env.local.example`）
  - 必須: `GEMINI_API_KEY`、`DATABASE_URL`、`GCS_BUCKET_NAME`、`GCS_PROJECT_ID`、`SAP_SESSION_SECRET`
  - ADK リンク: `ADK_BASE_URL`（デフォルト `http://localhost:8200`）
  - オプション: `GOOGLE_APPLICATION_CREDENTIALS`、`GEMINI_*_MODEL`、`LOG_*`、`REQUIRE_AUTH`
- **ADK エージェント** — `adk_agent/.env`（テンプレート: `adk_agent/.env.example`）
  - 必須: `DATABASE_URL`、`SAP_HOST`、`EMBED_MODEL`、`EMBED_OUTPUT_DIM`、`SAP_CRED_ENCRYPTION_KEY`（Fernet）
  - SAP: `SAP_AUTH_TYPE`（デフォルト `basic`）、`SAP_PORT`、`SAP_CLIENT`、`SAP_VERIFY_SSL`、`SAP_AUTH_TYPE=sap_oauth` 時の 5 つの `SAP_OAUTH_*` 変数
  - サーバー: `ADK_HOST=0.0.0.0`、`ADK_PORT=8200`、`ADK_SESSION_BACKEND=memory|vertex`
  - モデル: `SAP_AGENT_MODEL`（デフォルト `gemini-3.1-pro-preview`）

完全なリファレンスとプロダクション設定については [DEPLOYMENT.md](./DEPLOYMENT.md) を参照してください。

## Pub/Sub MCP（オプション）

`.mcp.json` が `mcpServers.pubsub` HTTP MCP エントリを定義している場合、ADK エージェントは起動時にそれを LlmAgent に接続します（`adk_agent/mcp_pubsub.py`）。チェックインされた設定は `https://pubsub.googleapis.com/mcp` をターゲットとし、ツール、トピック、サブスクリプションの**デフォルト拒否**許可リストが設定されています。

呼び出し元は `roles/mcp.toolUser` と `roles/pubsub.editor`（またはより細粒度の Pub/Sub ロール）の両方を持ち、ADC が利用可能である必要があります（`gcloud auth application-default login`）。詳細はプロジェクトルートの [`CLAUDE.md`](../../CLAUDE.md) の「MCP servers」セクションと [ARCHITECTURE.md](./ARCHITECTURE.md#pub-sub-mcp-toolset) を参照してください。

## 開発スクリプト

| コマンド | 動作 |
|---------|--------------|
| `pnpm dev` | `predev`（親ワークスペースガード + ADK `/healthz` プローブ）→ `--max-old-space-size=4096` 付き `next dev` |
| `pnpm build` / `pnpm start` | プロダクション Next ビルドとサーブ |
| `pnpm db:setup` | pgvector 拡張 + テーブル + HNSW halfvec インデックスを作成 |
| `pnpm db:migrate:sap-user-id` | レガシー DB 向けの冪等な ALTER |
| `pnpm pipeline -- ./data` | CLI バッチインジェスション（ローカルディレクトリまたは `gs://…`） |
| `pnpm gcp:setup` | GCP サービスアカウント + GCS バケット + キーを作成し、`.env.local` に書き込む |
| `pnpm test` / `pnpm test:run` / `pnpm test:coverage` | Vitest |
| `pnpm e2e` | Playwright（Next + ADK が既に起動していることが前提） |
| `uv run python -m adk_agent.server` | ADK エージェントを起動（ポート 8200） |
| `uv run pytest` | ADK エージェントのユニットテスト |

## 関連ドキュメント

- [ARCHITECTURE.md](./ARCHITECTURE.md) — ランタイムトポロジー、データフロー図、シーケンス図
- [API.md](./API.md) — 完全な Next.js + ADK エンドポイントリファレンス、SSE イベント形式
- [DEPLOYMENT.md](./DEPLOYMENT.md) — 環境変数、データベーススキーマ、GCS セットアップ、Cloud Run / Vertex Agent Engine、Docker Compose
- [SAP_QUERY_EXAMPLES.md](./SAP_QUERY_EXAMPLES.md) — 全 4 バンドルサービスにわたる自然言語プロンプトと OData 呼び出しのマッピング
- プロジェクトルートの [`CLAUDE.md`](../../CLAUDE.md) — 既知の開発トラップ（親ワークスペース Turbopack バグ）、MCP 配線メモ
- 韓国語翻訳は [`docs/ko/`](../ko/) を参照
