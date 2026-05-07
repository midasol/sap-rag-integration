# Gemini AI アシスタント — RAG + SAP エージェンティック・ワークフロー

Google Gemini と Google ADK で動作する AI エージェンティック・ワークフローです。2 つのデータソースにクエリをインテリジェントにルーティングします:
- **ドキュメント検索 (RAG)**: テキスト・PDF・画像・音声・動画ファイルに対するマルチモーダルベクター検索
- **SAP エンタープライズデータ**: SAP Product Master (品目、プラント、販売、評価、単位) へのライブ OData クエリ

単一の Google ADK `LlmAgent` が 5 つのツールを提供し、どのデータソースにクエリするか（または両方）を自動判断して統合した回答を生成します。Next.js がチャット UI とインジェスチョンパイプラインを担当し、すべてのエージェントロジックは ADK Python バックエンドに存在します。

---

## アーキテクチャ

### システム概要

```mermaid
graph TB
    User([👤 ユーザー])

    subgraph NextJS["Next.js アプリ (ポート 3000)"]
        ChatUI["Chat UI<br/><small>React 19 + Tailwind</small>"]
        ChatAPI["POST /api/chat"]
        EmbedAPI["POST /api/embed"]
        PipelineAPI["POST /api/pipeline"]
        OAuthCB["GET /api/sap/oauth/callback<br/><small>OAuth Step 2 プロキシ</small>"]
    end

    subgraph ADK["ADK FastAPI (ポート 8200)"]
        LlmAgent["LlmAgent<br/><small>adk_agent/agent.py</small>"]

        subgraph Tools["基本ツール 5 本 + オプション MCP ツールセット 1 本"]
            T1["search_documents<br/><small>pgvector RAG</small>"]
            T2["sap_authenticate<br/><small>Basic / OAuth PKCE</small>"]
            T3["sap_list_services<br/><small>services.yaml カタログ</small>"]
            T4["sap_query<br/><small>OData $filter/$orderby</small>"]
            T5["sap_get_entity<br/><small>単一エンティティ取得</small>"]
            T6["Pub/Sub MCP ツールセット<br/><small>list_topics · publish · …<br/>deny-by-default ゲート</small>"]
        end

        MCPCfg[".mcp.json<br/><small>tool/topic/sub 許可リスト</small>"]
    end

    subgraph DataSources["データソース"]
        PG[("PostgreSQL<br/>+ pgvector<br/><small>3072 次元埋め込み</small>")]
        GCS[("Google Cloud<br/>Storage<br/><small>ドキュメント・メディア</small>")]
        SAP[("SAP Gateway<br/><small>OData v2/v4</small>")]
    end

    subgraph AI["Google AI"]
        Gemini["Gemini LLM<br/><small>ストリーミング · ツール使用</small>"]
        EmbModel["Gemini Embedding 2<br/><small>3072 次元</small>"]
    end

    subgraph MCP["MCP サーバー (HTTP)"]
        PubsubMCP["pubsub.googleapis.com/mcp<br/><small>Cloud Pub/Sub<br/>(ADC + roles/mcp.toolUser)</small>"]
    end

    User --> ChatUI
    ChatUI --> ChatAPI
    ChatAPI --> LlmAgent
    LlmAgent --> Gemini
    Gemini -.->|ツール呼び出し| LlmAgent
    LlmAgent --> T1 & T2 & T3 & T4 & T5
    LlmAgent -.->|".mcp.json が存在する場合"| T6
    MCPCfg -.->|設定| T6
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

### リクエストフロー

```mermaid
sequenceDiagram
    actor ユーザー
    participant UI as Chat UI
    participant API as /api/chat (Next.js)
    participant ADK as ADK FastAPI :8200
    participant Gemini as Gemini LLM
    participant SAP as SAP Gateway

    ユーザー->>UI: "FERT タイプの製品を表示して"
    UI->>API: POST {message, conversationId}
    API->>API: DB からチャット履歴を取得
    API->>ADK: POST /run (message, session_id)
    ADK->>Gemini: LlmAgent.run(message, tools)

    Note over Gemini: 意図を分析 →<br/>判断: sap_query

    Gemini-->>ADK: tool_call: sap_query<br/>{service: "API_PRODUCT_SRV",<br/>entity_set: "A_Product"}
    ADK->>SAP: OData GET A_Product?$filter=...
    SAP-->>ADK: {results: [...], count: N}
    ADK-->>Gemini: tool_result

    Note over Gemini: レスポンスを<br/>Markdown テーブルに整形

    Gemini-->>ADK: ストリーミングテキストレスポンス
    ADK-->>API: SSE / ストリーミングチャンク
    API-->>UI: SSE ストリーム
    UI-->>ユーザー: レンダリング済み Markdown テーブル

    API->>API: メッセージを DB に保存
```

### SAP OAuth フロー

```mermaid
sequenceDiagram
    actor ユーザー
    participant UI as Chat UI
    participant Next as Next.js API :3000
    participant ADK as ADK FastAPI :8200
    participant SAP_GW as SAP Gateway

    ユーザー->>UI: SAP ログインをリクエスト
    UI->>Next: POST /api/sap/auth {method: "oauth"}
    Next->>ADK: sap_authenticate Step 1
    ADK->>ADK: PKCE を生成<br/>(code_verifier + code_challenge)
    ADK-->>Next: {login_url, state}
    Next-->>UI: login_url (+ sap_oauth_pending クッキーを設定)
    UI->>UI: ポップアップで login_url を開く

    ユーザー->>SAP_GW: ポップアップで認証
    SAP_GW-->>Next: GET /api/sap/oauth/callback?code=&state=
    Next->>Next: sap_oauth_pending クッキーで state を検証
    Next->>ADK: sap_authenticate Step 2 (コード交換)
    ADK->>SAP_GW: コード + code_verifier をトークンと交換
    SAP_GW-->>ADK: access_token
    ADK-->>Next: {success: true}
    Next-->>Next: sap_session クッキーを設定 (iron-session)
    Next-->>UI: ポップアップ postMessage → オープナーに通知、ポップアップを閉じる
    UI-->>ユーザー: SAP 接続完了

    Note over ADK: 認証情報は<br/>ADK セッション状態に保存 (インプロセス)
```

### コンポーネント

| コンポーネント | スタック | 目的 |
|-----------|-------|---------|
| **Next.js アプリ** | TypeScript, Next.js 16, React 19 | チャット UI、API ルート、インジェスチョンパイプライン |
| **ADK エージェント** | Python, Google ADK, FastAPI, ポート 8200 | 単一 LlmAgent — 基本ツール 5 本 + オプション MCP ツールセット 1 本、SAP + RAG ロジック |
| **ベクター DB** | PostgreSQL + pgvector | ドキュメント検索用 3072 次元 Gemini 埋め込み |
| **ファイルストレージ** | Google Cloud Storage | アップロードされたドキュメントとメディアファイル |
| **Pub/Sub MCP** *(オプション)* | `pubsub.googleapis.com/mcp` の HTTP MCP | `.mcp.json` の deny-by-default 許可リストでゲートされた、LLM に公開されるトピック / サブスクリプション / publish 操作 |

### ADK ツール

ADK エージェント (`adk_agent/agent.py`) は、5 つの基本ツールと、リポジトリルートに
`.mcp.json` が存在する場合に有効になるオプションの第 6 スロットを持つ単一の `LlmAgent` を提供します:

| ツール | 説明 |
|------|-------------|
| `search_documents` | pgvector RAG — Gemini でクエリを埋め込み、`embeddings` テーブル (vector(3072)) を検索 |
| `sap_authenticate` | SAP ログイン — Basic (ユーザー名/パスワード) または OAuth 2.0 PKCE; 成功時に `sap_session` クッキーを設定 |
| `sap_list_services` | 利用可能な SAP OData サービスの services.yaml カタログを返す |
| `sap_query` | SAP Gateway に対して `$filter`、`$orderby`、`$top` をサポートする OData エンティティセットクエリ |
| `sap_get_entity` | キーフィールドで単一の OData エンティティを取得 |
| **Pub/Sub MCP ツールセット** *(オプション)* | `list_topics`、`get_topic`、`list_subscriptions`、`get_subscription`、`publish` ツールを追加。ツール・トピック・サブスクリプションに対する deny-by-default 許可リストでゲート。[docs/en/MCP.md](./docs/en/MCP.md) 参照。 |

---

## 事前準備

インストール前に、Next.js アプリと ADK エージェント両方で必要な API キーを取得してください。

### Gemini API キー

両方のサービスに Gemini API キーが必要です — Next.js アプリは `GEMINI_API_KEY`、ADK エージェントは `GOOGLE_API_KEY` として保存します。**同じキー**で変数名だけが異なります。

1. [Google AI Studio](https://aistudio.google.com/apikey) にアクセス
2. Google アカウントでログイン
3. **「API キーを作成」** をクリック
4. 既存の Google Cloud プロジェクトを選択するか、新しく作成
5. 生成されたキーをコピー (`AIza...` で始まる)

> **無料枠あり。** Google AI Studio は開発・テストに十分な無料クォータを提供しています。開始するのに請求アカウントは不要です。

両方の env ファイルにキーを設定してください:

```env
# .env.local  (Next.js)
GEMINI_API_KEY=AIza...

# adk_agent/.env  (ADK Python エージェント)
GOOGLE_API_KEY=AIza...
```

> 2 つの変数には**同じキー値**を入力する必要があります。変数名が異なる理由は各 SDK の規則によるものです — Next.js は `@google/genai`、Python ADK は `google-genai` を使用します。

### Google Cloud プロジェクト (GCS およびオプション機能に必要)

ファイルアップロード用の Google Cloud Storage と、オプション機能 (Vertex AI Agent Engine、Cloud SQL、Pub/Sub MCP) には Google Cloud プロジェクトが必要です。

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. 上部のプロジェクトセレクターをクリック → **「新しいプロジェクト」**
3. プロジェクト名を入力し、**プロジェクト ID** をメモ (例: `my-project-123`)
4. GCS、Cloud SQL、Vertex AI を使用する場合は請求を有効化
5. `gcloud` CLI をインストールして認証:
   ```bash
   # インストール: https://cloud.google.com/sdk/docs/install
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```

> **GCS はファイルアップロードに必須です。** プロジェクトがあれば `pnpm gcp:setup` スクリプト (オプション B、ステップ 5) がサービスアカウントとバケットを自動作成します。

---

## インストール

このプロジェクトのインストール方法は **2 通り** あります。どちらか一方を選んでください — 両方行う必要はありません。

| オプション | 対象 | 作業量 | 推奨 |
|--------|----------------|--------|--------------|
| **A. AI コーディングツールでインストール** | Gemini CLI、Antigravity、Cursor、Codex、Claude Code をお持ちの方 | 1 行貼り付けてプロンプトに答えるだけ | ⭐ **はい** — 速く、ミスが少ない |
| **B. 手動インストール** | AI ツールがない、または自分でコマンドを実行したい方 | 15〜30 分の作業 | オプション A が使えない場合のみ |

---

### オプション A: AI コーディングツールでインストール（推奨）

> **AI ツールは人間よりもこのプロジェクトを上手くインストールします。** OS を検出し、不足している
> 依存関係をインストールし、リポジトリをクローンし、環境変数を対話的に設定し、データベースを
> 初期化し、必要に応じて SAP サービスをセットアップし、すべてのステップを確認してから次に進みます。
> 完全なインストール手順は [`installation.md`](./installation.md) に記載されており、
> AI エージェントが上から下へ実行できるように書かれています。

AI コーディングツール (Gemini CLI、Antigravity、Cursor、Codex、Claude Code) に以下の 1 行を貼り付けてください:

```
Install and configure sap-rag-integration by following the instruction here:
https://raw.githubusercontent.com/midasol/sap-rag-integration/main/installation.md
```

AI エージェントが Gemini API キー、データベース URL、（オプションで）SAP 認証情報を尋ね、あとはすべて自動で処理します。

> ✅ **オプション A を使用した場合はインストール完了です。オプション B はすべてスキップして [使用ガイド](#使用ガイド) に進んでください。**

---

### オプション B: 手動インストール（上級者向け）

<details>
<summary>📖 <strong>手動インストール手順を展開するにはクリック</strong> — オプション A を使用しなかった場合のみ</summary>

<br>

> **このセクションはオプション A を使用しなかった場合にのみ参照してください。** AI ツールのパスで
> インストールした場合、以下のすべての手順はすでに完了しています — それ以上行うことはありません。
> [使用ガイド](#使用ガイド) に進んでください。

このセクションでは各ステップを手動で説明します。前提条件のインストール、リポジトリのクローン、環境変数の設定、データベースの初期化、2 つのサービスの起動を自分で行います。

#### 前提条件

> 🛑 **手動インストール専用。** ここから下のすべての内容 — 前提条件、環境設定、
> データベースの初期化、サービスの起動 — は **手動で** インストールするユーザー向けです。
> すでに AI コーディングツールでオプション A の 1 行コマンドを実行した場合は、
> **これらの手順を再実行しないでください**。AI エージェントがすでにすべて処理しています。
> [使用ガイド](#使用ガイド) に進んでください。

##### 1. Node.js

Node.js **24.14.0 以上** が必要です。

```bash
node -v   # v24.14.0 以上である必要があります

# インストール (macOS - Homebrew)
brew install node

# または nvm 経由
nvm install 24 && nvm use 24
```

##### 2. pnpm

```bash
npm install -g pnpm
```

##### 3. Python 3.11+

SAP サービスに必要です。

```bash
python3 --version   # 3.11 以上である必要があります

# インストール (macOS - Homebrew)
brew install python@3.11
```

##### 4. PostgreSQL + pgvector

```bash
# macOS - Homebrew
brew install postgresql@17 pgvector
brew services start postgresql@17

# データベースを作成
createdb gemini_rag
```

> pgvector 拡張機能は `pnpm db:setup` 実行時に自動的に有効化されます。

##### 5. Google Cloud アカウントと API キー

###### Gemini API キー

1. [Google AI Studio](https://aistudio.google.com/apikey) にアクセス
2. 「API キーを作成」をクリック
3. API キーをコピーして保存

###### Google Cloud Storage (GCS) のセットアップ

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. プロジェクトを作成または選択
3. **Cloud Storage** > 「バケットを作成」に移動

###### サービスアカウントと認証情報 (GOOGLE_APPLICATION_CREDENTIALS)

GCS ファイルのアップロード/ダウンロードにはサービスアカウントの JSON キーが必要です。

**方法 1 (推奨): 自動化スクリプト**

```bash
pnpm gcp:setup
```

このスクリプトはサービスアカウントを作成し、`roles/storage.objectAdmin` を付与し、GCS バケットが存在しない場合は作成し、JSON キーファイルを生成し、`GCS_PROJECT_ID`、`GCS_BUCKET_NAME`、`GOOGLE_APPLICATION_CREDENTIALS` を `.env.local` に書き込みます。べき等性があるので再実行しても安全です。

前提条件:
- `gcloud` CLI をインストール済み: https://cloud.google.com/sdk/docs/install
- 認証済み: `gcloud auth login`

`.env.local` に値が設定されていない場合、スクリプトが **GCP Project ID** と **GCS Bucket Name** を尋ねます。デフォルト値は環境変数 (`GCP_SA_NAME`、`GCP_KEY_FILE`、`GCP_BUCKET_LOCATION`) で上書きできます — 詳細はスクリプトのヘッダーを参照してください。

**方法 2: Google Cloud Console (UI)**

1. [Google Cloud Console](https://console.cloud.google.com/) > **IAM と管理** > **サービスアカウント** に移動
2. **「+ サービスアカウントを作成」** をクリック
3. 名前を入力 (例: `gemini-rag-storage`) → **作成して続行**
4. ロールを選択: **Storage Object Admin** → **続行** → **完了**
5. 作成したサービスアカウントをクリック → **キー** タブ
6. **キーを追加** → **新しいキーを作成** → **JSON** → **作成**
7. JSON ファイルが自動的にダウンロードされます
8. プロジェクトルートに移動:
   ```bash
   mv ~/Downloads/your-project-xxxxxx.json ./service-account.json
   ```
9. `.env.local` にパスを設定:
   ```env
   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
   ```

**方法 3: 手動 gcloud コマンド**

```bash
# サービスアカウントを作成
gcloud iam service-accounts create gemini-rag-storage \
  --display-name="Gemini RAG Storage"

# Storage Object Admin ロールを付与
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:gemini-rag-storage@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

# JSON キーをダウンロード
gcloud iam service-accounts keys create ./service-account.json \
  --iam-account=gemini-rag-storage@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

> `service-account.json` はすでに `.gitignore` に記載されています — git にコミットされることはありません。
> `GOOGLE_APPLICATION_CREDENTIALS` が設定されていない場合、SDK は [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials) にフォールバックします。

##### 6. SAP システムアクセス（オプション）

SAP データクエリにのみ必要:
- OData サービスが公開された SAP Gateway ホスト
- SAP で設定された OAuth 2.0 クライアント (トランザクション SOAUTH2)
- SAP システムへのネットワークアクセス

#### クイックスタート（手動手順）

> 🛑 **手動インストール専用。** これらの手順はオプション B の一部です。オプション A の
> AI ツールの 1 行コマンドを使用した場合、エージェントがすでにリポジトリのクローン、
> `.env.local` の作成、`pnpm db:setup` の実行、両サービスの起動をすべて完了しています —
> 再実行しても意味がありません。[使用ガイド](#使用ガイド) に進んでください。

##### ステップ 1: クローンとインストール

```bash
git clone https://github.com/midasol/sap-rag-integration.git
cd sap-rag-integration
pnpm install
```

##### ステップ 2: 環境設定

```bash
cp .env.local.example .env.local
```

`.env.local` を編集:

```env
# === 必須 ===
GEMINI_API_KEY=your-gemini-api-key
DATABASE_URL=postgresql://username:password@localhost:5432/gemini_rag
GCS_BUCKET_NAME=your-bucket-name
GCS_PROJECT_ID=your-gcp-project-id
SAP_SESSION_SECRET=<32 文字以上のシークレット — openssl rand -base64 48>

# === オプション ===
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
# GEMINI_EMBEDDING_MODEL=gemini-embedding-2-preview
# GEMINI_CHAT_MODEL=gemini-3.1-pro-preview

# === ADK バックエンド ===
ADK_BASE_URL=http://localhost:8200
```

##### ステップ 3: データベースの初期化

```bash
pnpm db:setup
```

##### ステップ 4: ADK バックエンドの起動

```bash
# プロジェクトルートから
cp adk_agent/.env.example adk_agent/.env   # SAP + DB の認証情報で編集
uv venv && uv sync
uv run python -m adk_agent.server          # ポート 8200 で起動

# 確認:
curl http://localhost:8200/healthz         # → {"status":"ok"}
```

##### ステップ 5: Next.js アプリの起動

```bash
pnpm dev
```

[http://localhost:3000](http://localhost:3000) を開くと `/chat` ページにリダイレクトされます。

</details>

---

## 使用ガイド

[http://localhost:3000/chat](http://localhost:3000/chat) を開いて始めましょう。下部のステータスバーでアクティブなデータソースを確認できます:
- **SAP 接続済み** (緑) / **未接続** (黄)
- **ドキュメント** (緑) — pgvector に埋め込みデータがある場合に利用可能

---

### シナリオ 1: ドキュメントの埋め込みと検索

ファイルをベクターデータベースに埋め込み、それについて質問します。

**ステップ 1 — チャットでファイルを埋め込む**

ペーパークリップアイコンをクリックしてファイル (PDF、画像、動画など) を添付し、「embedding」を含むメッセージを入力します:

```
ユーザー: [添付: annual-report-2025.pdf] embedding this file
アシスタント: ファイル 'annual-report-2025.pdf' が正常に埋め込まれました。(12 チャンク作成)
```

**ステップ 2 — ドキュメントについて質問する**

```
ユーザー: 年次報告書の Q3 売上について何と書いてありますか？
アシスタント: 年次報告書によると (類似度: 92.3%)、Q3 売上は...
         [ファイル: annual-report-2025.pdf、類似度: 92.3%]
```

**バッチ埋め込み（複数ファイルを一度に）**

```bash
# CLI — フォルダ内のすべてのファイルを埋め込む
pnpm pipeline -- ./data

# または管理者 UI を使用
open http://localhost:3000/admin/pipeline
```

---

### シナリオ 2: SAP データクエリ

自然言語を使用してライブ SAP エンタープライズデータをクエリします。

**利用可能な SAP データを確認**

```
ユーザー: どの SAP データにアクセスできますか？
アシスタント: 以下の SAP サービスが利用可能です:
         | モジュール | サービス | 説明 |
         | Product Master | API_PRODUCT_SRV | 製品 (品目) マスター、プラント、販売、評価、単位 |
```

**フィルターを使ったクエリ**

```
ユーザー: FERT タイプの最初の 5 つの製品を表示して
アシスタント: | 製品 | タイプ | クロスプラントステータス | 作成日 |
         | MZ-FG-R100 | FERT | 有効 | 2024-08-12 |
         | MZ-FG-R101 | FERT | 有効 | 2024-08-12 |
         ...
```

**特定レコードの取得**

```
ユーザー: 製品 MZ-FG-R100 の詳細を表示して
アシスタント: **製品 MZ-FG-R100**
         - 製品タイプ: FERT (完成品)
         - クロスプラントステータス: 有効
         - 作成: 2024-08-12、USER01 による
         - 最終変更: 2025-01-04
         ...
```

**クロスエンティティクエリ**

```
ユーザー: 製品 MZ-FG-R100 を在庫として持つプラントは？
ユーザー: 製品 MZ-FG-R100 の英語説明を表示して
ユーザー: 製品 MZ-FG-R100 の標準価格と評価クラスは？
```

#### API_PRODUCT_SRV テストクエリバンク

Product Master サービスのすべてのエンティティを検証できる貼り付け可能なプロンプト集です。
例の ID (`MZ-FG-R100`、プラント `1010`、販売組織 `1010`) は実際の SAP システムの値に置き換えてください。

**`A_Product` — ヘッダー (クロスプラント)**
```
FERT タイプの製品を 10 件表示して
2024-01-01 以降に作成された製品を作成日順に一覧表示して
CrossPlantStatus が有効な製品は何件ありますか？
製品 MZ-FG-R100 の完全な詳細を表示して
```

**`A_ProductDescription` — 多言語説明**
```
製品 MZ-FG-R100 の英語説明を表示して
製品 MZ-FG-R100 のすべての言語の説明を一覧表示して
```

**`A_ProductPlant` — プラント別マスターデータ**
```
製品 MZ-FG-R100 はどのプラントに存在しますか？
プラント 1010 の製品 MZ-FG-R100 の購買グループと原産国を表示して
プラント 1010 で生産在庫管理されている製品は？
```

**`A_ProductSales` — 販売ステータスと税**
```
製品 MZ-FG-R100 の販売ステータスと税分類は？
FERT タイプの最初の 5 製品の輸送グループを表示して
```

**`A_ProductSalesDelivery` — 販売組織 / 流通チャネル**
```
販売組織 1010 の製品 MZ-FG-R100 の最小注文数量と供給プラントは？
流通チャネル 10 の製品のアカウント決定製品グループを一覧表示して
```

**`A_ProductStorage` — 保管と危険物**
```
製品 MZ-FG-R100 の保管条件と最小残存有効期限を表示して
危険物番号が設定されている製品は？
```

**`A_ProductValuation` — 評価エリア別価格**
```
評価エリア 1010 の製品 MZ-FG-R100 の標準価格と評価クラスは？
製品 MZ-FG-R100 の評価タイプと在庫評価手順を表示して
```

**`A_ProductUnitsOfMeasure` — 代替単位**
```
製品 MZ-FG-R100 の代替単位 (UoM) を表示して
製品 MZ-FG-R100 の総重量と材料体積は？
```

**フィルター、並び替え、集計**
```
最近変更された製品を 5 件表示して
過去 30 日間に USER01 が作成した製品を一覧表示して
ProductType 別に製品をグループ化してカウントして
```

---

### シナリオ 3: 複合クエリ（ドキュメント + SAP）

埋め込みドキュメントとライブ SAP データの両方が必要な質問をします。ADK エージェントが `search_documents`、`sap_query` などの複数のツールを自動的に呼び出します。

```
ユーザー: 製品マスタースナップショットドキュメントとライブ SAP 製品データを比較して
アシスタント: **ドキュメント分析** (product-master-snapshot.pdf より):
         スナップショットには 12 件の完成品 (タイプ FERT) が記載されています...

         **実際の SAP データ** (API_PRODUCT_SRV / A_Product より):
         | 製品 | タイプ | クロスプラントステータス | 最終変更 |
         | MZ-FG-R100 | FERT | 有効 | 2025-01-04 |
         | MZ-FG-R101 | FERT | 有効 | 2025-01-04 |
         | MZ-FG-R102 | FERT | 無効 | 2024-11-22 |

         Q1 の実際売上は予測 $2.1M に対して $2.15M (+2.4%) でした。
```

```
ユーザー: アップロードされたスプレッドシートの製品リストと現在の SAP 製品マスターを比較して
アシスタント: スプレッドシートには 20 件の完成品 (タイプ FERT) が記載されています...
         SAP Product Master (API_PRODUCT_SRV / A_Product) を確認中:
         | 製品 | タイプ | クロスプラントステータス | 最終変更 |
         | MZ-FG-R100 | FERT | 有効 | 2025-01-04 |
         | MZ-FG-R101 | FERT | 有効 | 2025-01-04 |
         ...
```

---

### シナリオ 4: SAP 認証

#### Basic 認証 (SAP_AUTH_TYPE=basic)

`SAP_AUTH_TYPE=basic` が設定されている場合、チャットウィンドウにインラインログインフォームが表示されます:

1. インラインフォームに SAP ユーザー ID とパスワードを入力
2. **ログイン** をクリック
3. ステータスバーが「SAP 接続済み」(緑) に変わる
4. SAP クエリがすぐに利用可能になる

> 認証情報はセッション中メモリに保存されます。SAP サービスを再起動するとクリアされます。

#### OAuth 2.0 (SAP_AUTH_TYPE=sap_oauth)

`SAP_AUTH_TYPE=sap_oauth` が設定されている場合:

1. チャットのステータスバーに「SAP 未接続」(黄) が表示される
2. アシスタントに SAP データについて質問すると、OAuth ログイン URL が提示される
3. URL をブラウザで開いて SAP で認証する
4. 認証コードが自動的にアクセストークンと交換される
5. トークンの有効期限が切れると自動的に更新される

---

### シナリオ 5: マルチモーダルドキュメント検索

テキスト・PDF・画像・音声・動画などさまざまなファイル形式にわたって埋め込みと検索を行います。

**画像検索**

```
ユーザー: [添付: architecture-diagram.png] embedding
アシスタント: ファイル 'architecture-diagram.png' が正常に埋め込まれました。(1 チャンク作成)

ユーザー: アーキテクチャ図にはどのコンポーネントが示されていますか？
アシスタント: アーキテクチャ図 (類似度: 88.5%) によると、システムは...
         [ファイル: architecture-diagram.png、類似度: 88.5%]
```

**動画検索**

```
ユーザー: [添付: product-demo.mp4] embedding this video
アシスタント: ファイル 'product-demo.mp4' が正常に埋め込まれました。(1 チャンク作成)

ユーザー: 製品デモ動画ではどの機能が紹介されていますか？
アシスタント: 製品デモ動画では 3 つの主要機能が示されています...
         [ファイル: product-demo.mp4、類似度: 85.2%]
```

**クロスフォーマット検索**

```
ユーザー: 「クラウド移行」に関連するすべてのドキュメントを検索して
アシスタント: さまざまなファイル形式から 4 件の関連結果が見つかりました:
         1. cloud-migration-plan.pdf (94.1%) — 12 ページの移行ロードマップ...
         2. infrastructure-diagram.png (87.3%) — ターゲットクラウドアーキテクチャを表示...
         3. migration-meeting.mp3 (82.5%) — タイムラインとリスクについての議論...
         4. project-notes.txt (79.8%) — 移行の依存関係に関するメモ...
```

---

## ADK エージェント

ADK Python エージェント (`adk_agent/`) はポート 8200 で動作する Google ADK FastAPI アプリケーションです。すべての SAP と RAG ツールロジックを担当します。Next.js は `ADK_BASE_URL` を通じてエージェント呼び出しをプロキシします。

### 対応 SAP モジュール

| モジュール | サービス ID | エンティティセット | キーフィールド |
|--------|-----------|-------------|------------|
| Product Master | API_PRODUCT_SRV | A_Product, A_ProductDescription, A_ProductPlant, A_ProductSales, A_ProductSalesDelivery, A_ProductStorage, A_ProductValuation, A_ProductUnitsOfMeasure | Product |

### ADK エージェントの設定

`adk_agent/.env.example` から作成:

```bash
cp adk_agent/.env.example adk_agent/.env
```

```env
# === データベース / RAG ===
DATABASE_URL=postgresql://username:password@localhost:5432/gemini_rag
EMBED_MODEL=gemini-embedding-2-preview
EMBED_OUTPUT_DIM=3072
EMBED_NORMALIZE=false

# === SAP 接続 ===
SAP_HOST=your-sap-host.example.com
SAP_AUTH_TYPE=basic   # オプション: basic, sap_oauth

# === 認証情報の暗号化 (Fernet キー) ===
# 生成: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
SAP_CRED_ENCRYPTION_KEY=your-fernet-key

# === Basic 認証 (SAP_AUTH_TYPE=basic) ===
# SAP_USER=your-sap-username
# SAP_PASSWORD=your-sap-password

# === OAuth 2.0 (SAP_AUTH_TYPE=sap_oauth) ===
# SAP_OAUTH_CLIENT_ID=your-oauth-client-id
# SAP_OAUTH_CLIENT_SECRET=your-oauth-client-secret
# SAP_OAUTH_AUTHORIZE_URL=https://your-sap-host:44300/sap/bc/sec/oauth2/authorize?sap-client=100
# SAP_OAUTH_TOKEN_URL=https://your-sap-host:44300/sap/bc/sec/oauth2/token?sap-client=100
# SAP_OAUTH_REDIRECT_URI=http://localhost:3000/api/sap/oauth/callback

# === サーバー ===
ADK_HOST=0.0.0.0
ADK_PORT=8200
SESSION_BACKEND=memory   # memory (開発) | vertex (本番)
```

#### `SAP_AUTH_TYPE` オプション

| 値 | 説明 | 必須変数 |
|-------|-------------|-------------------|
| `basic` | **HTTP Basic 認証** (デフォルト)。インラインログインモーダルまたは `SAP_USER`/`SAP_PASSWORD` 環境変数で認証情報を提供。開発・デモ・サービス間通信に適している。 | `SAP_USER`、`SAP_PASSWORD` (またはランタイムで入力) |
| `sap_oauth` | **OAuth 2.0 Authorization Code + PKCE**。ユーザーがブラウザのポップアップで認証し、SAP が Next.js の `/api/sap/oauth/callback` にリダイレクト (Cloud Run サイドカー不要)。本番環境に推奨。 | `SAP_OAUTH_CLIENT_ID`、`SAP_OAUTH_CLIENT_SECRET`、`SAP_OAUTH_AUTHORIZE_URL`、`SAP_OAUTH_TOKEN_URL`、`SAP_OAUTH_REDIRECT_URI` |

### ADK API エンドポイント

| メソッド | エンドポイント | 説明 |
|--------|----------|-------------|
| GET | `/healthz` | ヘルスチェック |
| POST | `/run` | LlmAgent にメッセージを送信 (ストリーミング) |
| POST | `/api/sap/auth` | SAP 認証のトリガー (Basic または OAuth Step 1) |
| GET | `/api/sap/oauth/callback` | OAuth Step 2 — Next.js コールバックルートからプロキシ |

---

## Docker Compose（ローカル開発）

1 つのコマンドで両方のサービスを起動:

```bash
# 最初に env ファイルを作成
cp .env.local.example .env.local
cp adk_agent/.env.example adk_agent/.env
# 両方に認証情報を設定

docker compose up
```

起動されるサービス:
- **adk**: ポート 8200 (`adk_agent/Dockerfile` からビルド)
- **nextjs**: ポート 3000 (`ADK_BASE_URL=http://adk:8200`; `adk` に依存)

---

## 本番デプロイ

スクリプト化された 2 つのデプロイトポロジがあり、どちらも **1 つの共有
Cloud SQL Postgres + pgvector** インスタンスをバックエンドとして使用します:

- **モード A — Cloud Run × 2。** `nextjs` + `adk_agent` を 2 つの Cloud Run
  サービスとしてデプロイ。カスタム Next.js チャット UI がエンドユーザー向け画面。
- **モード B — Vertex AI Agent Engine 単独。** `adk_agent` のみをデプロイし、
  **Gemini Enterprise** に登録することでエンドユーザーが Gemini チャット画面から
  直接操作できるように設定。

```bash
# モード A
./deploy/setup-cloud-sql.sh <PROJECT_ID>
./deploy/deploy-cloud-run.sh <PROJECT_ID>

# モード B
MODE=agent-engine VPC_NETWORK=<vpc> ./deploy/setup-cloud-sql.sh <PROJECT_ID>
./deploy/setup-agent-engine.sh <PROJECT_ID>
gcloud run deploy sap-oauth-callback --source ./cloud-run-oauth-callback \
  --region us-central1 --allow-unauthenticated \
  --set-env-vars=GOOGLE_CLOUD_PROJECT=<PROJECT_ID>
uv run python deploy/deploy-agent-engine.py --project <PROJECT_ID>
# → Resource Name: projects/.../reasoningEngines/...
# その名前を Gemini Enterprise に登録 (Agents → Register agent)
```

決定マトリックス、前提条件、ネットワークトポロジー図、完全なステップバイステップの手順は
[`deploy/README.md`](./deploy/README.md) を参照してください。

---

## MCP (Model Context Protocol)

ADK エージェントは MCP を通じて **Google Cloud Pub/Sub** へのオプションアクセスを
提供します — Claude Code がプロジェクトスコープの MCP 登録に使用する `.mcp.json` と
同じファイルが、エージェント起動時にも読み込まれます (`adk_agent/mcp_pubsub.py`)。
このファイルが存在する場合、LLM は `list_topics`、`get_topic`、`list_subscriptions`、
`get_subscription`、`publish` ツールを利用でき、すべてツール・トピック・サブスクリプションに
対する **deny-by-default 許可リスト** でゲートされます。

```jsonc
// .mcp.json (抜粋)
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

Pub/Sub **なし** で実行するには: `.mcp.json` を削除または名前変更してください —
エージェントは 6 本ではなく 5 本の基本ツール (RAG + SAP 4 本) でロードされ、
起動時に `mcp.pubsub.not_configured` を 1 回ログ出力します。それ以外に変更はありません。

全体像 — このプロジェクトにおける MCP の役割、deny-by-default のセマンティクス、
各デプロイモードへの `.mcp.json` の配布方法 (モード A: Dockerfile COPY、モード B: `extra_packages` バンドル)、IAM 要件、新しい MCP サーバーの追加方法 — については
[`docs/en/MCP.md`](./docs/en/MCP.md) ([한국어](./docs/ko/MCP.md)) を参照してください。

---

## プロジェクト構造

```
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── page.tsx                  # / → /chat リダイレクト
│   │   ├── chat/page.tsx             # SAP ステータス付きチャット UI
│   │   ├── admin/pipeline/page.tsx   # バッチ埋め込みダッシュボード
│   │   └── api/
│   │       ├── chat/route.ts         # チャットプロキシ → ADK /run
│   │       ├── embed/route.ts        # 単一ファイルの埋め込み
│   │       ├── conversations/        # 会話 CRUD
│   │       ├── pipeline/             # バッチパイプライン
│   │       ├── files/[...path]/      # GCS ファイルプロキシ
│   │       └── sap/                  # SAP プロキシルート
│   │           ├── auth/route.ts     # SAP 認証 (Basic + OAuth Step 1)
│   │           ├── oauth/callback/   # OAuth Step 2 プロキシ → ADK
│   │           └── services/route.ts # SAP サービス一覧
│   ├── lib/
│   │   ├── adk-client.ts            # ADK エージェント用 HTTP クライアント
│   │   ├── gemini.ts                 # Gemini API クライアント (インジェスチョン)
│   │   ├── embedding.ts             # 埋め込み生成
│   │   ├── db.ts                     # PostgreSQL 接続
│   │   ├── schema.ts                # DB スキーマ (Drizzle)
│   │   ├── file-parser.ts           # ファイルの解析/チャンキング
│   │   ├── gcs.ts                    # GCS アップロード/ダウンロード
│   │   └── env.ts                    # 環境変数
│   ├── components/
│   │   ├── ChatSidebar.tsx           # 会話リスト
│   │   ├── ChatWindow.tsx            # メッセージ表示
│   │   ├── ChatInput.tsx             # 入力 + ファイル添付
│   │   ├── SAPDataView.tsx           # SAP データテーブルレンダラー
│   │   └── PipelineDashboard.tsx     # パイプラインダッシュボード
│   └── scripts/
│       ├── setup-db.ts               # DB 初期化
│       └── pipeline.ts               # バッチ埋め込み CLI
├── adk_agent/                        # Google ADK Python エージェント
│   ├── agent.py                      # LlmAgent + 5 ツール定義
│   ├── server.py                     # FastAPI エントリポイント (ポート 8200)
│   ├── sap_gw_connector/             # ベンダー提供 SAP OData コネクター
│   ├── .env.example                  # ADK 環境変数テンプレート
│   ├── Dockerfile
│   └── pyproject.toml
├── scripts/
│   ├── check-parent-workspace.mjs    # predev: 親ワークスペースの検出
│   └── check-adk-health.mjs         # predev: ADK :8200 の動作確認
├── tests/e2e/                        # Playwright E2E テスト
├── docker-compose.yml
└── docs/
```

---

## npm スクリプト

| コマンド | 説明 |
|---------|-------------|
| `pnpm dev` | 開発サーバーを起動 (http://localhost:3000) — predev で ADK ヘルスチェックを実行 |
| `pnpm build` | 本番ビルド |
| `pnpm start` | 本番サーバーを起動 |
| `pnpm lint` | ESLint を実行 |
| `pnpm db:setup` | PostgreSQL テーブルとインデックスを初期化 |
| `pnpm pipeline -- <path>` | フォルダ内のファイルをバッチ埋め込み |
| `pnpm e2e` | Playwright E2E テストを実行 (`tests/e2e/README.md` の前提条件を参照) |
| `uv run python -m adk_agent.server` | ポート 8200 で ADK バックエンドを起動 |

---

## 対応ファイル形式

> [Gemini Embedding 2 ドキュメント](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/embedding-2) に基づきます。

| カテゴリ | MIME タイプ | 制限 | 処理方法 |
|----------|-----------|-------------|-------------------|
| テキスト | プレーンテキスト | 最大 8,192 トークン | チャンキング (2000 文字、200 オーバーラップ) |
| PDF | `application/pdf` | リクエストあたり最大 6 ページ | 6 ページチャンクに分割 + マルチモーダル埋め込み |
| 画像 | `image/png`, `image/jpeg` | リクエストあたり最大 6 枚 | Base64 → マルチモーダル埋め込み + AI サマリー |
| 音声 | `audio/mp3`, `audio/wav` | 最大 80 秒 | Base64 → マルチモーダル埋め込み + AI サマリー |
| 動画 | `video/mpeg`, `video/mp4` | 最大 80 秒 (音声付き) / 120 秒 (無音) | Base64 → マルチモーダル埋め込み + AI サマリー |

追加形式 (`.txt`, `.md`, `.csv`, `.json`, `.xml`, `.html`, `.gif`, `.webp`, `.ogg`, `.flac`, `.m4a`, `.webm`, `.avi`, `.mov`) はアップロード可能で、テキストとして処理または参照用として保存されます。

---

## 設定

### 認証ゲート (`REQUIRE_AUTH`)

Next.js アプリはデフォルトでは認証を強制しません — ローカル開発は摩擦なく始められます。**信頼されていないネットワークにアプリを公開する前に**、以下を設定してください:

```bash
REQUIRE_AUTH=true
```

有効にすると、保護されたすべての API ルートはセッションが `POST /api/sap/auth` でログインしていない限り `401 Unauthorized` を返します。認証は `SAP_SESSION_SECRET` で署名された `sap_session` の iron-session クッキーで検証されます。

保護されるルート: `/api/chat`、`/api/embed`、`/api/conversations`、
`/api/pipeline/*`、`/api/files/*`、`/api/sap/services`。
除外: `/api/sap/auth` (ログイン自体)。

---

## トラブルシューティング

### pgvector インストールエラー

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

### DATABASE_URL 接続エラー

```bash
brew services list | grep postgresql
brew services start postgresql@17
psql postgresql://username:password@localhost:5432/gemini_rag
```

### GCS 認証エラー

```
ERROR: Could not load the default credentials
```

`.env.local` の `GOOGLE_APPLICATION_CREDENTIALS` を確認し、ファイルが存在することを確認してください。

### ADK エージェントが起動していない

```
pnpm dev fails: ADK health check failed — http://localhost:8200/healthz returned no response
```

1. 先に ADK バックエンドを起動: `uv run python -m adk_agent.server`
2. 確認: `curl http://localhost:8200/healthz` → `{"status":"ok"}`
3. `.env.local` の `ADK_BASE_URL` を確認 (デフォルト `http://localhost:8200`)
4. `adk_agent/.env` の必須変数を確認 (`DATABASE_URL`、`SAP_CRED_ENCRYPTION_KEY` など)

### SAP 接続エラー

```
SAP 未接続 (チャットの黄色いドット)
```

1. Basic 認証の場合: チャット UI のインライン SAP ログインフォームに認証情報を入力
2. OAuth の場合: SAP ログインボタンをクリック — ポップアップが SAP の認証 URL を開き、認証後に自動的に閉じます
3. `adk_agent/.env` の `SAP_HOST` と `SAP_AUTH_TYPE` を確認

### SAP OAuth コールバックの問題

OAuth ポップアップが閉じない、またはセッションが設定されない場合:
1. `adk_agent/.env` の `SAP_OAUTH_REDIRECT_URI` が `http://localhost:3000/api/sap/oauth/callback` と一致していることを確認
2. `.env.local` に `SAP_SESSION_SECRET` が設定されていることを確認
3. SAP Gateway のトランザクション `SOAUTH2` でリダイレクト URI が設定されていることを確認

### Gemini API 429 (レート制限)

バッチパイプラインはレート制限が発生すると即座に失敗します。レート制限の処理 (バックオフ付きリトライ) は呼び出し元の責任です。

---

## 技術スタック

| 領域 | 技術 |
|------|-----------|
| チャット UI / インジェスチョン | Next.js 16 (App Router), TypeScript, React 19 |
| エージェントフレームワーク | Google ADK (Python), 単一 LlmAgent |
| エージェント API | FastAPI, ポート 8200 |
| 埋め込みモデル | gemini-embedding-2-preview (3072 次元) |
| LLM | Gemini (ストリーミング、ツール使用) |
| ベクター DB | PostgreSQL + pgvector |
| ORM | Drizzle ORM |
| ファイルストレージ | Google Cloud Storage |
| AI ストリーミング | Vercel AI SDK v6 |
| SAP 認証 | Basic + OAuth 2.0 Authorization Code + PKCE |
| SAP プロトコル | OData v2/v4 |
| UI | Tailwind CSS v4 + shadcn/ui |
| E2E テスト | Playwright |

> 詳細なアーキテクチャとコード分析については [docs/GUIDE.md](./docs/GUIDE.md) を参照してください。
