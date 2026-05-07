# API リファレンス

本ドキュメントは、Next.js HTTP サーフェス（ポート 3000）、ADK エージェントの HTTP サーフェス（ポート 8200）、およびエージェントが公開する 5 つの LLM ツールを網羅しています。

レガシーの `sap-service/` FastAPI サイドカーは削除されました — ポート 8100 のエンドポイントは**存在しません**。

## 目次

- [Next.js API ルート](#nextjs-api-ルート)
  - [`POST /api/chat`](#post-apichat)
  - [`GET / POST / DELETE /api/conversations`](#会話-crud)
  - [`GET /api/conversations/[id]/messages`](#get-apiconversationsidmessages)
  - [`POST /api/embed`](#post-apiembed)
  - [`POST /api/pipeline/start`](#post-apipipelinestart)
  - [`POST /api/pipeline/upload`](#post-apipipelineupload)
  - [`GET /api/pipeline/status`](#get-apipipelinestatus)
  - [`GET /api/files/[...path]`](#get-apifilespath)
  - [`POST /api/sap/auth`](#post-apisapauth)
  - [`GET /api/sap/oauth/callback`](#get-apisapoauthcallback)
  - [`GET /api/sap/services`](#get-apisapservices)
- [ADK エージェントエンドポイント](#adk-エージェントエンドポイント)
- [LLM ツール（エージェント自身が呼び出す）](#llm-ツールエージェント自身が呼び出す)
- [SSE イベント形式](#sse-イベント形式)
- [認証とエラーモデル](#認証とエラーモデル)

---

## Next.js API ルート

すべてのルートは `runtime='nodejs'` を設定し、ほとんどが `maxDuration = 300`（5 分）を固定しています。`sap_session` クッキー（iron-session、8 時間 TTL）が正規の認証指標です。`requireSession()` は欠如時に `{error:"NOT_AUTHENTICATED"}` で 401 を返します。

### `POST /api/chat`

Server-Sent Events で ADK チャット返信をストリームします。ADK 呼び出し前にユーザーメッセージを永続化し、ストリーム終了後にアシスタントメッセージを永続化し、最初のターンで会話に自動タイトルを付けます。

**リクエスト**

```json
{
  "conversationId": "uuid",
  "content": "string",
  "attachments": [{ "fileName": "string", "mimeType": "string", "url": "string" }]
}
```

**認証**: `sap_session` クッキーが必要。ハンドラーは呼び出し元が `conversationId` を所有しているか（`conversations.sap_user_id` が一致するか）も検証します。

**レスポンス**: `text/event-stream`。各イベントペイロードは JSON です。[SSE イベント形式](#sse-イベント形式) を参照してください。

**ステータスコード**

| ステータス | 意味 |
|--------|---------|
| 200 | ストリームが即座に開始される |
| 401 | `NOT_AUTHENTICATED`（`sap_session` なし/期限切れ） |
| 403 | 会話が別の SAP ユーザーに属している |
| 404 | 会話が存在しない |
| 502 | ADK アップストリームエラー（リクエスト ID とともにログ記録） |
| 503 | ADK に到達不可（predev / ヘルスプローブが失敗） |

### 会話 CRUD

`/api/conversations`

| メソッド | ボディ / パラメータ | 返り値 | 備考 |
|--------|---------------|---------|-------|
| `GET` | — | `[{id, title, updatedAt, …}]` | `conversations.sap_user_id` でフィルタリング |
| `POST` | `{title?: string}` | `{id, title, …}` | 現在の `sapUserId` で行を作成 |
| `DELETE` | `?id=<uuid>` | `{deleted: true}` | 安全のため `sapUserId` でフィルタリング |

すべて `sap_session` が必要。

### `GET /api/conversations/[id]/messages`

会話の順序付きメッセージを返します:
`[{id, role, content, fileName, attachments, createdAt}]`。所有権を検証し、それに応じて `401 / 403 / 404` を返します。

### `POST /api/embed`

1 ファイルのマルチパートアップロード。ボディ: フィールド `file` を持つ `multipart/form-data`。サーバー側で最大 100 MB を強制。

`embedFile(buffer, fileName)` を同期実行: GCS にアップロードし、カテゴリに基づいて埋め込み — テキスト（チャンク）、PDF（6 ページスライス）、画像/音声/動画（マルチモーダル埋め込み + AI サマリー）。

**返り値**: `{success: true, fileName, chunks: number, gcsUrl}`。

### `POST /api/pipeline/start`

バックグラウンドバッチインジェスションを開始。ボディ:
`{sourcePath: "./data" | "gs://bucket/prefix"}`。ローカルパスは `./data` または `./uploads` 配下である必要があります。

並行数 3、ファイルごとに 3 回リトライ。インメモリの `pipeline-state` シングルトンを更新します。`/api/pipeline/status` でポーリングしてください。

**返り値**: `{started: true}`（または実行中の場合は `409`）。

### `POST /api/pipeline/upload`

マルチパート `files[]` アップロード。各ファイルをバッファし、並行数 3 のバックグラウンドバッチで `embedFile` を実行します。

### `GET /api/pipeline/status`

シングルトンのスナップショットを返します:

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

状態はインメモリであり、プロセス再起動でリセットされます。永続化はありません。

### `GET /api/files/[...path]`

GCS からファイルをストリームします。パスはバケットルートに追加され、**必ず** `uploads/` 配下である必要があります。`..` は 400 を引き起こします。

**キャッシュ**: `Cache-Control: public, max-age=86400`。

### `POST /api/sap/auth`

すべての SAP 認証操作の単一エンドポイント。

| ボディ | 動作 |
|------|----------|
| `{method: "basic", username, password}` | ADK `/sap/auth/basic` に転送。成功時、`sap_session` クッキーを設定し `{success:true, sap_user, method:"basic"}` を返す |
| `{method: "oauth"}` | `501 not_implemented` を返す — OAuth フローは、このエンドポイントではなく `sap_authenticate` ツール経由でチャット中に LLM が開始する |

`GET` は現在のセッションプローブ（`{authenticated, sapUserId}`）を返します。
`DELETE` はクッキーをクリアし `{loggedOut: true}` を返します。

### `GET /api/sap/oauth/callback`

ユーザーが SAP OAuth フローを完了した後に `?code&state` を受け取ります。`sap_oauth_pending` クッキーに対して `state` を検証します。**現在は失敗クローズ** — 親ウィンドウに失敗メッセージをポストするポップアップ HTML を返します。
ADK の Step-2 エンドポイント（`adk_agent/oauth.exchange_code`）への Step-2 配線は [`docs/followups/post-migration.md`](../followups/post-migration.md) でトラッキングされています。

### `GET /api/sap/services`

`function_call: sap_list_services` で ADK `/run` を呼び出し、JSON を転送します。`sap_session` が必要。`maxDuration = 60`。

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

## ADK エージェントエンドポイント

ADK エージェントは `google.adk.cli.fast_api.get_fast_api_app` と 2 つのカスタムルートでビルドされています。ベース URL: `${ADK_BASE_URL}`（デフォルト `http://localhost:8200`）。

| メソッド | パス | 説明 |
|--------|------|-------------|
| `GET` | `/healthz` | 起動プローブが通過すると `{status:"ok"}`。`predev` はこれを必要とする |
| `POST` | `/sap/auth/basic` | `sap_authenticate(method="basic", …)` の直接呼び出し。Next.js ログインルートが LLM/`/run` エンベロープを介さずに iron-session クッキーに暗号化された認証情報をシードできるようにする |
| `POST` | `/run` | 標準 ADK 関数呼び出しエントリポイント。`/api/sap/services` が `sap_list_services` を直接呼び出すために使用する |
| `POST` | `/run_sse` | 標準 ADK SSE エンドポイント。ストリーミングチャットのために `/api/chat` が使用する |

`/run` と `/run_sse` は ADK ランタイム自体によってドキュメント化されています（<https://google.github.io/adk-docs/>）。どちらも `app_name: "adk_agent"` と、Next.js レイヤーが `sap_credentials` を渡すために使用する `state` ブロブを期待します。

CORS はデフォルトで `http://localhost:3000` に制限されています（`adk_agent/server.py` 参照）。

---

## LLM ツール（エージェント自身が呼び出す）

これらは HTTP エンドポイントではありません — `LlmAgent` に登録された Python の callable です。決定論的なテストを記述し、LLM が何を参照するかを推論できるようにするためにここに記載しています。

### `search_documents`

```python
search_documents(query: str, top_k: int = 8) -> dict
```

`embeddings` テーブルに対する pgvector コサイン検索。

**返り値**

```json
{
  "results": [
    { "id": "...", "file_name": "...", "chunk_text": "...", "score": 0.81 }
  ],
  "count": N
}
```

ソフトフェイルエンベロープ: 埋め込みモデルまたは DB がダウンしている場合は `{"results": [], "count": 0, "warning": "embedding_unavailable"}` または `"vector_db_unavailable"`。エージェントはこれらをエラーではなく「結果なし」として扱います。

### `sap_authenticate`

```python
sap_authenticate(
    method: str | None = None,   # "basic" | "oauth"、デフォルトは env SAP_AUTH_TYPE
    username: str | None = None,
    password: str | None = None,
    code: str | None = None,
    state: str | None = None,
    user_id: str | None = None,
) -> dict
```

| シナリオ | 返り値 |
|----------|---------|
| Basic、OK | `{success:true, sap_user, method:"basic", credentials:{...encrypted}}` |
| Basic、パスワード誤り | `{success:false, error:"invalid_credentials"}` |
| OAuth Step 1 | `{success:false, action_required:"sap_login", login_url, oauth_state, method:"oauth"}` |
| OAuth Step 2、OK | `{success:true, sap_user, method:"oauth"}` |
| OAuth state 不一致 | `{success:false, error:"oauth_state_mismatch"}` |
| OAuth env 不完全 | `{success:false, error:"oauth_config_incomplete: missing […]"}` |
| OAuth 交換失敗 | `{success:false, error:"oauth_exchange_failed: <detail>"}` |

エージェントのシステムプロンプトは `action_required: "sap_login"` エンベロープをそのまま提示し、`login_url` をユーザーに提示するよう指示します。

### `sap_list_services`

```python
sap_list_services() -> dict
```

`adk_agent/services.yaml` の同期読み取り。サービスカタログを返します（上記の `/api/sap/services` の例を参照）。YAML が空の場合は起動プローブが既に失敗しているため、エラーは発生しません。

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

`sap_gw_connector.SAPClient` 経由で SAP OData を呼び出します。v2（`d.results`）と v4（`value`）両方のレスポンスエンベロープが正規化されます。

| シナリオ | 返り値 |
|----------|---------|
| OK | `{success:true, results:[…], count}` |
| セッションに `sap_credentials` なし | `{success:false, action_required:"sap_login", error:"not_authenticated"}` |
| `SAPAuthenticationError`（例: 期限切れ） | `{success:false, action_required:"re_authenticate", error:"<detail>"}` |
| `SAPRequestError` | `{success:false, error:{message:"<detail>"}}` |
| その他 | `{success:false, error:"internal_error", detail:"<repr>"}` |

`async with` ブロック内で呼び出しごとに新しい `SAPClient` がビルドされます — ターン間で共有されるクライアント状態はありません。

### `sap_get_entity`

```python
sap_get_entity(service_id: str, entity_set: str, key: str) -> dict
```

`sap_query` と同じ認証ゲートとエラーエンベロープ。成功時に `{success:true, entity:{…}}` を返します。

### Pub/Sub MCP ツール（オプション）

`.mcp.json` が有効な `mcpServers.pubsub` エントリを定義している場合、`McpToolset` はその許可リストからツールを公開します。デフォルト設定では `list_topics`、`get_topic`、`list_subscriptions`、`get_subscription`、`publish` を許可し、`sapphire-demo` トピックと `sapphire-demo-sub` サブスクリプションのみを対象とします。引数:

- `projectId` — ベアプロジェクト文字列、`projects/` プレフィックスなし
- `topicId` / `subscriptionId` — ベア名。ゲートは許可リストとの照合前に `projects/X/topics/` と `topics/` プレフィックスを除去する
- `data`（publish）— base64 エンコードされたメッセージボディ

拒否された呼び出しは `{"isError": true, "content":[{"type":"text","text":"Access denied: …"}]}` を返し、Pub/Sub には到達しません。

---

## SSE イベント形式

`/api/chat` は `text/event-stream` チャンクをストリームします。各 `data:` ペイロードは、生の ADK フレームを解析した後 `src/lib/adk-client.ts:normalizeAdkEvent` によって発行される JSON です。

```json
{ "type": "text_delta", "delta": "Hello" }
{ "type": "tool_call", "name": "sap_query", "args": { "service_id": "API_PRODUCT_SRV", "entity_set": "A_Product", "top": 5 } }
{ "type": "tool_result", "name": "sap_query", "result": { "success": true, "results": [...], "count": 5 } }
{ "type": "error", "error": "string" }
```

基盤となる ADK ランタイムからの `partial:false` 集計テキストフレームは、組み立てられたメッセージの重複を避けるために**ドロップ**されます。

典型的なチャットターンは多数の `text_delta`、オプションで 1 つ以上の `tool_call`/`tool_result` ペア、ゼロまたは 1 つの終端 `error` を生成します。フロントエンド（`src/components/ChatWindow.tsx`）はテキストデルタをインラインでレンダリングし、ツール結果を折りたたみ可能な詳細として付加します。

---

## 認証とエラーモデル

| 失敗 | HTTP ステータス | JSON ボディ |
|---------|-------------|-----------|
| `sap_session` クッキーなし | 401 | `{error:"NOT_AUTHENTICATED"}` |
| 別ユーザーが所有する会話 | 403 | `{error:"FORBIDDEN"}` |
| リソースなし | 404 | `{error:"NOT_FOUND"}` |
| パイプラインが既に実行中 | 409 | `{error:"PIPELINE_BUSY"}` |
| ADK が 2xx 以外を返した | 502 | `{error:"ADK_UPSTREAM", detail:"…"}` |
| ADK に到達不可 | 503 | `{error:"ADK_UNAVAILABLE"}` |
| `REQUIRE_AUTH=true` 時に `proxy.ts` がブロック | 401 | 空のボディ |

LLM ツールエラーエンベロープ（SSE `tool_result` イベント**内**で返され、HTTP ステータスは 200 のまま）は、上記のツールごとのドキュメントのパターンに従います。`action_required` はエージェントがユーザーにログインまたは再認証を求めるために使用する正規のハンドシェイクです。システムプロンプトはそれをそのまま転送し、チャット UI は `"sap_login"` を特別扱いしてインライン SAP ログインフォームをレンダリングします。

---

## 関連情報

- [ARCHITECTURE.md](./ARCHITECTURE.md) — ランタイムトポロジーとシーケンス図
- [DEPLOYMENT.md](./DEPLOYMENT.md) — 環境変数、スキーマ、GCS、Cloud Run / Vertex Agent Engine
- [SAP_QUERY_EXAMPLES.md](./SAP_QUERY_EXAMPLES.md) — 自然言語プロンプトと OData 呼び出しのマッピング
