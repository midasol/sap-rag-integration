# デプロイガイド

本ガイドは、両プロセス（Next.js + ADK エージェント）の環境変数リファレンス、データベースセットアップ、Google Cloud 統合、および本番環境での考慮事項を網羅しています。

レガシーの `sap-service/` FastAPI サイドカーは削除されました — デプロイすべき**第三のプロセスはありません**。

## 1. 環境変数

プロセスごとに 1 つずつ、合計 2 つの env ファイルがあります。テンプレートは [`.env.local.example`](../../.env.local.example) と [`adk_agent/.env.example`](../../adk_agent/.env.example) にあります。

### 1.1 Next.js (`.env.local`)

| 変数 | 必須 | デフォルト | 備考 |
|-----|----------|---------|-------|
| `GEMINI_API_KEY` | yes | — | <https://aistudio.google.com/apikey> |
| `DATABASE_URL` | yes | — | `postgresql://user:pass@host:5432/db`。ADK エージェントと同じ DB。 |
| `GCS_BUCKET_NAME` | yes | — | `GCS_PROJECT_ID` 配下に存在する必要がある |
| `GCS_PROJECT_ID` | yes | — | バケットとサービスアカウントを所有する |
| `SAP_SESSION_SECRET` | yes | — | iron-session 署名キー。≥ 32 文字。`openssl rand -base64 48` |
| `ADK_BASE_URL` | yes | `http://localhost:8200` | `process.env` 経由で直接読み取られる。`pnpm predev` はこの URL をヘルスプローブする |
| `GOOGLE_APPLICATION_CREDENTIALS` | no | — | サービスアカウント JSON の絶対パス。未設定の場合は ADC にフォールバック。`pnpm gcp:setup` がこれを設定する。 |
| `GEMINI_EMBEDDING_MODEL` | no | `gemini-embedding-2-preview` | インジェスション中に使用される 3072 次元埋め込みモデル |
| `GEMINI_CHAT_MODEL` | no | `gemini-3.1-pro-preview` | コンテンツサマリーに `src/lib/gemini.ts` が使用する。エージェントが使用するチャットモデルは `adk_agent/.env`（`SAP_AGENT_MODEL`）で設定される |
| `LOG_LEVEL` | no | `info` | `debug | info | warn | error` |
| `LOG_PAYLOAD` | no | `meta` | `meta`（ステータス + カウント）または `full`（レスポンスボディ） |
| `LOG_FORMAT` | no | `pretty` | `pretty` は stdout pino-pretty ターゲットを追加。ファイル出力は常に JSON |
| `LOG_DIR` | no | `./logs` | 起動時に存在しない場合は作成される |
| `REQUIRE_AUTH` | no | 未設定 | `true` の場合、`src/proxy.ts` が各ハンドラーの `requireSession()` に加えてプロキシ層で保護されたルートをゲートする |

### 1.2 ADK エージェント (`adk_agent/.env`)

| 変数 | 必須 | デフォルト | 備考 |
|-----|----------|---------|-------|
| `DATABASE_URL` | yes | — | Next.js と同じ DB |
| `SAP_HOST` | yes | — | SAP Gateway ホスト名（スキームなし） |
| `EMBED_MODEL` | yes | `gemini-embedding-001` | RAG **クエリ**パスに使用される。`EMBED_OUTPUT_DIM` の次元のベクトルを生成する必要がある |
| `EMBED_OUTPUT_DIM` | yes | `3072` | カラム型 `vector(3072)` と一致する必要がある |
| `SAP_CRED_ENCRYPTION_KEY` | yes | — | Fernet キー。`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` で生成 |
| `GOOGLE_API_KEY` | conditional | — | ADC が利用可能でない場合に必要 |
| `GOOGLE_CLOUD_PROJECT` | conditional | — | オプションの Secret Manager プローブに必要 |
| `SAP_AGENT_MODEL` | no | `gemini-3.1-pro-preview` | エージェントが使用する LLM |
| `SAP_AUTH_TYPE` | no | `basic` | `basic` または `sap_oauth` |
| `SAP_PORT` | no | `44300` | |
| `SAP_CLIENT` | no | `100` | |
| `SAP_VERIFY_SSL` | no | `false` | 本番環境では `true` にすべき |
| `SAP_OAUTH_CLIENT_ID` | conditional | — | `SAP_AUTH_TYPE=sap_oauth` の場合に必要 |
| `SAP_OAUTH_CLIENT_SECRET` | conditional | — | 同上 |
| `SAP_OAUTH_TOKEN_URL` | conditional | — | 同上 |
| `SAP_OAUTH_AUTHORIZE_URL` | conditional | — | 同上 |
| `SAP_OAUTH_REDIRECT_URI` | conditional | — | 同上。開発環境では通常 `http://localhost:3000/api/sap/oauth/callback` |
| `EMBED_NORMALIZE` | no | `true` | クエリ埋め込みを L2 正規化する |
| `RAG_TABLE` | no | `embeddings` | コーパスをパーティション分割する場合のみ上書き |
| `ADK_HOST` | no | `0.0.0.0` | |
| `ADK_PORT` | no | `8200` | |
| `ADK_SESSION_BACKEND` | no | `memory` | `memory` または `vertex`（Vertex AI Agent Engine セッションストア） |

`adk_agent/settings.py` は必須変数が未設定の場合に `RuntimeError("missing env: …")` を起動時に発生させるため、設定ミスは LLM の実行中に不可解なエラーを起こすのではなく、早期に失敗します。

### 1.3 `.env.local` の例

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

### 1.4 `adk_agent/.env` の例

```env
GOOGLE_API_KEY=AIza...
SAP_AGENT_MODEL=gemini-3.1-pro-preview

EMBED_MODEL=gemini-embedding-001
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

## 2. データベースセットアップ

### 2.1 前提条件

- PostgreSQL 17+（16 も動作しますが、HNSW halfvec パフォーマンスは 17 でチューニングされています）
- `pgvector` ≥ 0.7.0（`halfvec` と HNSW サポートのため）

### 2.2 pgvector のインストール

macOS（Homebrew）:
```bash
brew install pgvector
```

Debian/Ubuntu:
```bash
sudo apt install postgresql-17-pgvector
```

ソースから:
```bash
git clone https://github.com/pgvector/pgvector.git
cd pgvector && make && sudo make install
```

### 2.3 データベースの作成とスキーマの適用

```bash
createdb gemini_rag
pnpm db:setup
```

`pnpm db:setup`（`src/scripts/setup-db.ts`）:
1. `CREATE EXTENSION IF NOT EXISTS vector;`
2. `embeddings`、`conversations`、`messages` を作成（完全なスキーマは [ARCHITECTURE.md §6](./ARCHITECTURE.md#6-データベーススキーマ) 参照）
3. `embeddings.embedding` に HNSW halfvec インデックスを作成
4. `conversations` にユーザーごとの複合インデックスを作成

ユーザーごとのスコープ以前のレガシー DB の場合は `pnpm db:migrate:sap-user-id` を 1 回実行してください — `sap_user_id` と複合インデックスを追加するために `conversations` を冪等に ALTER します。

### 2.4 コネクションプーリング

両プロセスが独自のプールを保有します:

- Next.js: Drizzle でラップされた単一の `postgres()` クライアント（`src/lib/db.ts`）。HMR シングルトンガードはまだ — 長い開発セッションでプールが蓄積されます（CLAUDE.md でトラッキング）。
- ADK エージェント: `asyncpg.create_pool`（`adk_agent/rag/db.py`）、ワーカープロセスごとに 1 プール。

複数レプリカでデプロイする場合は、両プロセスの前に PgBouncer のようなコネクションプーラーを使用してください。

## 3. Google Cloud Storage

### 3.1 バケットレイアウト

```
gs://<GCS_BUCKET_NAME>/
└── uploads/
    ├── 9f23...a1.pdf
    ├── 1c08...b3.png
    └── ...
```

ファイルは `src/lib/gcs.ts:uploadToGCS` によって `uploads/{uuid}{ext}` に書き込まれ、`/api/files/<path>` 経由で配信されます。`downloadFromGCS` のパストラバーサルガードは `uploads/` プレフィックスを強制し、`..` を含むパスを拒否します。

### 3.2 サービスアカウント

最も簡単な方法は `pnpm gcp:setup`（`scripts/setup-gcp-service-account.sh`）です:

1. `GCS_PROJECT_ID` にサービスアカウントを作成する
2. バケットに `roles/storage.objectAdmin` を付与する
3. JSON キーを生成し `./service-account.json` に書き込む
4. `.env.local` を `GOOGLE_APPLICATION_CREDENTIALS`、`GCS_PROJECT_ID`、`GCS_BUCKET_NAME` で更新する

Cloud Run の場合は JSON キーより**ワークロード ID** を推奨します — リビジョンにサービスアカウントを付加し、`GOOGLE_APPLICATION_CREDENTIALS` を省略します。SDK が Application Default Credentials を自動的に取得します。

### 3.3 キャッシュ

`/api/files/[...path]` は `Cache-Control: public, max-age=86400` で配信します。`uploads/` 内のファイルは不変（UUID 名）のため、長いキャッシュは安全です。

## 4. Gemini API

### 4.1 モデル

| 用途 | デフォルトモデル | 設定箇所 |
|-----|--------------|-----------|
| 埋め込み（インジェスション） | `gemini-embedding-2-preview` | `GEMINI_EMBEDDING_MODEL`（Next.js） |
| 埋め込み（エージェントの RAG クエリ） | `gemini-embedding-001` | `EMBED_MODEL`（ADK） |
| チャット / エージェント | `gemini-3.1-pro-preview` | `SAP_AGENT_MODEL`（ADK） |
| コンテンツサマリー | `gemini-3.1-pro-preview` | `GEMINI_CHAT_MODEL`（Next.js） |

両埋め込みモデルは 3072 次元ベクトルを出力し、同じ `embeddings.embedding` カラムをターゲットとします。別の次元に切り替える場合は `EMBED_OUTPUT_DIM` を更新し、新しい DB に対して `pnpm db:setup` を再実行してください（`vector(N)` カラムはインプレースで変更できません）。

### 4.2 フォーマット制限（インジェスション）

| カテゴリ | 制限 |
|----------|--------|
| テキスト | 8,192 トークン; 2000 文字 / 200 オーバーラップでチャンク |
| PDF | リクエストあたり 6 ページ（`pdf-lib` で自動分割） |
| 画像 | `image/png`、`image/jpeg`; リクエストあたり ≤ 6 |
| 音声 | `audio/mp3`、`audio/wav`; ≤ 80 秒 |
| 動画 | `video/mpeg`、`video/mp4`; 音声あり ≤ 80 秒、音声なし ≤ 120 秒 |

アップストリームの制限については [公式 Gemini Embedding 2 ドキュメント](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/embedding-2) を参照してください。その他の拡張子（`.gif`、`.webp`、`.flac`、`.mov` など）はアップロードと配信は可能ですが、埋め込み API には送信されません — GCS にのみ保存されます。

### 4.3 タスクタイプ

ADK クエリは `task_type: "RETRIEVAL_QUERY"` を設定します（`adk_agent/rag/embedding.py` 参照）。インジェスションは `RETRIEVAL_DOCUMENT` を使用します。2 つを混在させるとこのコーパスのリコールが半減します。

## 5. Pub/Sub MCP（オプション）

> **完全ガイド:** [MCP.md](./MCP.md) — このプロジェクトにおける MCP の概要、デフォルト拒否セマンティクス、デプロイモードごとの配送方法、新しい MCP サーバーの追加方法。

リポジトリルートの `.mcp.json` で設定します。チェックインされた設定は `https://pubsub.googleapis.com/mcp` をターゲットとし、`sapphire-demo` トピックと `sapphire-demo-sub` サブスクリプションが許可リストに含まれています。

前提条件:

```bash
gcloud services enable pubsub.googleapis.com --project sap-advanced-workshop-gck
gcloud auth application-default login   # ローカル開発
```

呼び出し元プリンシパルは以下の両方を持つ必要があります:

- `roles/mcp.toolUser`（`mcp.tools.call` をゲート）
- `roles/pubsub.editor`（またはより細粒度の Pub/Sub ロール）

Cloud Run の場合はランタイムサービスアカウントに両方を付与してください。エンドツーエンドの配線を確認するには:

```bash
uv run python scripts/test_pubsub_mcp_live.py
```

スクリプトは MCP ツールセット経由でメッセージをパブリッシュします。到達確認は `gcloud pubsub subscriptions pull` で帯域外で行います。

## 6. 本番環境での考慮事項

### 6.1 並行性とレート制限

| サーフェス | デフォルト |
|---------|---------|
| インジェスション（`/api/pipeline/start`） | 3 ファイル並行、3 回リトライ |
| 埋め込み（`/api/embed`） | HTTP 接続ごとに 1 リクエスト |
| チャット（`/api/chat`） | ADK セッションバックエンドに依存。`memory` の場合、スコープは単一レプリカ |

Gemini API クォータはプロジェクト層によって異なります。埋め込みリクエストが最も頻繁であり、クォータ上限に最初に達する可能性があります。HTTP 429 を監視し、バッチジョブのエッジでバックオフを実装してください（組み込みのインジェスションは既に 3 回リトライします）。

### 6.2 本番環境でのロギング

- `LOG_FORMAT=json` と `LOG_LEVEL=info` を設定してください。
- `LOG_DIR` を永続ボリュームにマウントするか stdout にストリームしてください（Cloud Run / GKE は自動的に Cloud Logging に収集します）。
- `LOG_PAYLOAD=meta` を維持してください。`full` は機密性の高い製品/パートナーデータを含む可能性がある未リダクトの SAP レスポンスボディを書き込みます。

機密フィールド（`Authorization`、`Set-Cookie`、`Cookie`、`access_token`、`refresh_token`、`password`）は `src/lib/logger.ts` によってリダクトされます。

### 6.3 デプロイターゲット

| ターゲット | ステータス |
|--------|--------|
| ローカル Docker Compose | サポート済み。[`docker-compose.yml`](../../docker-compose.yml) 参照 — 2 サービス（`nextjs` + `adk`） |
| モード A — Cloud Run × 2 + Cloud SQL | **スクリプト済み。** [`deploy/README.md`](../../deploy/README.md) 参照。`./deploy/setup-cloud-sql.sh` 後に `./deploy/deploy-cloud-run.sh`。 |
| モード B — Vertex AI Agent Engine + Cloud SQL | **スクリプト済み。** [`deploy/README.md`](../../deploy/README.md) 参照。`MODE=agent-engine ./deploy/setup-cloud-sql.sh`、`./deploy/setup-agent-engine.sh`、`python deploy/deploy-agent-engine.py`。次に **Gemini Enterprise** でリソース名を登録。 |

両マネージドターゲットモードは 1 つの Cloud SQL インスタンスを共有します。モード A は `--add-cloudsql-instances` でマウントされる Unix ソケット経由で接続します。モード B は PSA ピアリング経由でプライベート IP への TCP で接続します。

#### モード A トポロジー（Cloud Run × 2）

```
Cloud Run サービス: sap-rag-web      → Next.js（ポート 3000、パブリック）
Cloud Run サービス: sap-rag-agent    → ADK    （ポート 8200、プライベート）
Secret Manager:    SAP_CRED_ENCRYPTION_KEY, SAP_SESSION_SECRET, GEMINI_API_KEY
Cloud SQL:         PostgreSQL 17 + pgvector
GCS:               <GCS_BUCKET_NAME>
VPC コネクタ:     adk_agent → SAP S/4HANA プライベート IP（自動検出）
```

Web サービスはエージェントサービスの URL を `ADK_BASE_URL` としてマウントし、`--allow-unauthenticated` が必要な唯一のサービスです。エージェントサービスはプライベートで、`roles/run.invoker` 経由で Web サービスのランタイム SA のみがアクセスできます。

#### モード B トポロジー（Agent Engine + Gemini Enterprise）

```
Gemini Enterprise UI ─→ Agent Engine: adk_agent.root_agent
                            │
                            │ PSC インターフェース + ネットワークアタッチメント
                            ▼
                       VPC ─┬─→ Cloud SQL Postgres（プライベート IP）
                            └─→ SAP S/4HANA（ポート 44300）

Cloud Run サービス: sap-oauth-callback     → SAP リダイレクトを受け取り →
                                             code/state を Secret Manager に書き込む
                                             (sap-oauth-pending-<state>)
Secret Manager:    sap-credentials, sap-cred-encryption-key
サービスアカウント:   agent-engine-sa
```

モード B では Next.js 側は**デプロイされません**。インジェスションパイプラインはローカルで一度（または Cloud Run 上でワンショットで）実行して `embeddings` テーブルをシードします。Agent Engine 上のエージェントは RAG のためにのみそれを読み取ります。

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

現在の [`docker-compose.yml`](../../docker-compose.yml) はこの形状と一致しています。`sap-service` サービスはありません。

### 6.5 モニタリング

アラートを設定することを推奨するシグナル:

- Next: `/api/chat` リクエストの `502 ADK_UPSTREAM` レート > 1%
- Next: ファイルごとの `/api/pipeline/start` 失敗レート
- ADK: `/healthz` が 200 以外
- ADK: ログライン `event=tool_error tool=sap_query` レートの急増
- DB: pgvector クエリ p95 レイテンシ
- GCS: `/api/files` プロキシの 4xx レート

### 6.6 セキュリティチェックリスト

サービスを公開する前に:

- [ ] `SAP_SESSION_SECRET` と `SAP_CRED_ENCRYPTION_KEY` をローテーションし Secret Manager に格納する
- [ ] Next サービスに `REQUIRE_AUTH=true` を設定する
- [ ] ADK サービスに `SAP_VERIFY_SSL=true` を設定する
- [ ] `.mcp.json` の Pub/Sub 許可リストが本番のトピック/サブスクリプションセットと一致する（git にチェックインされているため、本番固有の値はデプロイ時のオーバーライドが必要な場合がある）
- [ ] `adk_agent/server.py` の CORS リストに本番 Web ホストが含まれる
- [ ] `next.config.ts` の CSP 許可リストに本番 GCS バケットオリジンが含まれる
- [ ] Cloud Run リビジョンが JSON キーではなくワークロード ID を使用する
- [ ] DB ユーザーが最小限の必要権限を持つ（スーパーユーザーなし）

完全なアーキテクチャコンテキストについては [ARCHITECTURE.md](./ARCHITECTURE.md) を参照してください。エンドポイントペイロードについては [API.md](./API.md) を参照してください。
