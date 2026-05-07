# SAP 自然言語クエリ例

`adk_agent/services.yaml` に登録されている 5 つの SAP OData サービス（合計 40 エンティティセット）の自然言語プロンプト例です。これらをチャット UI に入力してください。エージェントオーケストレーターが適切なエンティティにルーティングし、SAP 呼び出しの `$filter` / `$select` / `$top` に変換します。

対象サービス:
- **`API_PRODUCT_SRV`** — 製品マスター（ヘッダー、プラント、販売、評価、単位）— 32 エンティティ — §1–7
- **`API_MATERIAL_STOCK_SRV`** — プラント / 保管場所 / バッチ / シリアルごとの資材在庫 — 3 エンティティ — §8
- **`API_PLANT_SRV`** — プラントマスター — 1 エンティティ — §9
- **`API_MATERIAL_DOCUMENT_SRV`** — 資材伝票（物品移動）— 3 エンティティ — §10
- **`API_STORAGELOCATION_SRV`** — プラントごとの保管場所マスター — 1 エンティティ — §11

> 規約
> - **プロンプト** — チャットにそのまま入力
> - **ターゲットエンティティ** — オーケストレーターが選択すると期待されるエンティティセット
> - **ヒントフィルター** — LLM が生成する可能性のある OData 式の例（実際の出力は異なる場合があります）
> - サンプル製品コードはデモ用のみ: `MZ-FG-R100`、`RM233-2`、`FG-126`

---

## 1. ヘッダー — 製品マスター

### `A_Product` — クロスプラント製品マスターヘッダー
1. "製品 MZ-FG-R100 の基本情報を表示して"
   - ヒント: `Product eq 'MZ-FG-R100'`
2. "過去 30 日間に作成された完成品を 10 件表示して"
   - ヒント: `ProductType eq 'FERT' and CreationDate ge datetime'2026-03-30T00:00:00'`、`$top=10`
3. "FG- で始まるアクティブな製品"
   - ヒント: `startswith(Product, 'FG-') and CrossPlantStatus eq ''`

---

## 2. 説明 / テキスト — 多言語

### `A_ProductDescription` — 多言語製品名
1. "MZ-FG-R100 の韓国語説明"
   - ヒント: `Product eq 'MZ-FG-R100' and Language eq 'KO'`
2. "RM233-2 のすべての言語の説明"
   - ヒント: `Product eq 'RM233-2'`

### `A_ProductBasicText` — 長い基本テキスト
1. "MZ-FG-R100 の英語基本テキスト"
   - ヒント: `Product eq 'MZ-FG-R100' and Language eq 'EN'`

### `A_ProductPurchaseText` — 発注テキスト
1. "FG-126 の韓国語購買テキスト"
   - ヒント: `Product eq 'FG-126' and Language eq 'KO'`

### `A_ProductInspectionText` — 検査指示
1. "RM233-2 の英語検査テキスト"
   - ヒント: `Product eq 'RM233-2' and Language eq 'EN'`

### `A_ProductPlantText` — プラントレベルの自由テキスト
1. "MZ-FG-R100 のプラント 1010 のメモ"
   - ヒント: `Product eq 'MZ-FG-R100' and Plant eq '1010'`

### `A_ProductSalesText` — 販売組織 / チャンネル / 言語
1. "MZ-FG-R100 の韓国語販売テキスト、販売組織 1010、チャンネル 10"
   - ヒント: `Product eq 'MZ-FG-R100' and ProductSalesOrg eq '1010' and ProductDistributionChnl eq '10' and Language eq 'KO'`

---

## 3. プラントレベル — プラントマスターごと

### `A_ProductPlant` — プラントヘッダー
1. "MZ-FG-R100 はどのプラントに設定されていますか?"
   - ヒント: `Product eq 'MZ-FG-R100'`
2. "プラント 1010 の PurchasingGroup 001 の製品を 20 件"
   - ヒント: `Plant eq '1010' and PurchasingGroup eq '001'`、`$top=20`

### `A_ProductPlantCosting` — プラントコストデータ
1. "MZ-FG-R100 / 1010 のコストロットサイズと差異キー"
   - ヒント: `Product eq 'MZ-FG-R100' and Plant eq '1010'`
   - `$select`: `CostingLotSize, VarianceKey, BaseUnit`

### `A_ProductPlantForecasting` — 予測パラメータ
1. "FG-126 / 1010 の予測設定"
   - ヒント: `Product eq 'FG-126' and Plant eq '1010'`

### `A_ProductPlantIntlTrd` — 外国貿易 / 関税
1. "MZ-FG-R100 / 1010 の原産国と CAS 番号"
   - ヒント: `Product eq 'MZ-FG-R100' and Plant eq '1010'`
   - `$select`: `CountryOfOrigin, RegionOfOrigin, ProductCASNumber`

### `A_ProductPlantMRPArea` — MRP エリア計画
1. "プラント 1010 の RM233-2 のすべての MRP エリア設定"
   - ヒント: `Product eq 'RM233-2' and Plant eq '1010'`
2. "MRPType ND の Kanban MRP エリアの製品"
   - ヒント: `MRPArea eq 'KANBAN1010' and MRPType eq 'ND'`、`$top=20`

### `A_ProductPlantProcurement` — 調達パラメータ
1. "プラント 1010 の MZ-FG-R100 に自動 PO 作成が許可されているか?"
   - ヒント: `Product eq 'MZ-FG-R100' and Plant eq '1010'`
   - `$select`: `IsAutoPurOrdCreationAllowed, IsSourceListRequired, SourceOfSupplyCategory`

### `A_ProductPlantQualityMgmt` — 品質管理（プラント）
1. "MZ-FG-R100 / 1010 の QM コントロールキーと最大保管期間"
   - ヒント: `Product eq 'MZ-FG-R100' and Plant eq '1010'`

### `A_ProductPlantSales` — プラント販売（積載グループ）
1. "FG-126 / 1010 の積載グループと出荷処理時間"
   - ヒント: `Product eq 'FG-126' and Plant eq '1010'`

### `A_ProductPlantStorage` — プラント保管データ
1. "MZ-FG-R100 / 1010 のサイクルカウント設定"
   - ヒント: `Product eq 'MZ-FG-R100' and Plant eq '1010'`
   - `$select`: `InventoryForCycleCountInd, CycleCountingIndicatorIsFixed, ProvisioningServiceLevel`

### `A_ProductStorageLocation` — 保管場所マスター
1. "MZ-FG-R100 / プラント 1010 / SLoc 0001 の倉庫棚番"
   - ヒント: `Product eq 'MZ-FG-R100' and Plant eq '1010' and StorageLocation eq '0001'`
2. "プラント 1010 / SLoc 0001 の最初の 50 製品"
   - ヒント: `Plant eq '1010' and StorageLocation eq '0001'`、`$top=50`

---

## 4. 販売

### `A_ProductSales` — クロス流通チェーン
1. "MZ-FG-R100 の販売ステータスと税分類"
   - ヒント: `Product eq 'MZ-FG-R100'`
   - `$select`: `SalesStatus, TaxClassification, TransportationGroup`

### `A_ProductSalesDelivery` — 販売組織 / 流通チャンネル
1. "MZ-FG-R100 の最小注文数量と供給プラント、販売組織 1010、チャンネル 10"
   - ヒント: `Product eq 'MZ-FG-R100' and ProductSalesOrg eq '1010' and ProductDistributionChnl eq '10'`
2. "販売組織 1010 / チャンネル 10 で最小注文数量が 100 超の製品"
   - ヒント: `ProductSalesOrg eq '1010' and ProductDistributionChnl eq '10' and MinimumOrderQuantity gt 100`

### `A_ProductSalesTax` — 国ごとの税分類
1. "MZ-FG-R100 の韓国（KR）MWST 税分類"
   - ヒント: `Product eq 'MZ-FG-R100' and Country eq 'KR' and TaxCategory eq 'MWST'`

---

## 5. 評価 / コスト計算

### `A_ProductValuation` — 評価エリア / タイプごと
1. "評価エリア 1010 の MZ-FG-R100 の標準原価"
   - ヒント: `Product eq 'MZ-FG-R100' and ValuationArea eq '1010' and ValuationType eq ''`
2. "評価エリア 1010 で標準価格が 1000 超の製品を 10 件"
   - ヒント: `ValuationArea eq '1010' and StandardPrice gt 1000`、`$top=10`

### `A_ProductValuationAccount` — 勘定科目決定
1. "MZ-FG-R100 / 1010 評価の商業価格 1–3"
   - ヒント: `Product eq 'MZ-FG-R100' and ValuationArea eq '1010' and ValuationType eq ''`

### `A_ProductValuationCosting` — 評価コストデータ
1. "MZ-FG-R100 / 1010 のコスト起源グループとオーバーヘッドグループ"
   - ヒント: `Product eq 'MZ-FG-R100' and ValuationArea eq '1010' and ValuationType eq ''`

### `A_ProductMLAccount` — マテリアルレジャー勘定
1. "MZ-FG-R100 / 1010 の ML 勘定情報（法定通貨）"
   - ヒント: `Product eq 'MZ-FG-R100' and ValuationArea eq '1010' and ValuationType eq '' and CurrencyRole eq '10'`

### `A_ProductMLPrices` — マテリアルレジャー価格
1. "MZ-FG-R100 / 1010 の将来価格と有効開始日"
   - ヒント: `Product eq 'MZ-FG-R100' and ValuationArea eq '1010' and ValuationType eq '' and CurrencyRole eq '10'`
   - `$select`: `FuturePrice, FuturePriceValidityStartDate, PlannedPrice`

---

## 6. 調達 / 供給 / 生産

### `A_ProductProcurement` — クロスプラント調達
1. "MZ-FG-R100 のクロスプラント調達単位と確認プロファイル"
   - ヒント: `Product eq 'MZ-FG-R100'`

### `A_ProductSupplyPlanning` — MRP / 供給計画（プラントごと）
1. "RM233-2 / 1010 のロットサイズ設定（固定/最小/最大）"
   - ヒント: `Product eq 'RM233-2' and Plant eq '1010'`
   - `$select`: `FixedLotSizeQuantity, MinimumLotSizeQuantity, MaximumLotSizeQuantity, LotSizeRoundingQuantity`
2. "プラント 1010 で最小ロットサイズが 100 以上の製品"
   - ヒント: `Plant eq '1010' and MinimumLotSizeQuantity ge 100`、`$top=20`

### `A_ProductWorkScheduling` — 作業スケジューリング
1. "FG-126 / 1010 の生産基準数量と過剰/不足納品許容差"
   - ヒント: `Product eq 'FG-126' and Plant eq '1010'`

### `A_ProductQualityMgmt` — クロスプラント QM
1. "MZ-FG-R100 の調達時 QM は有効か?"
   - ヒント: `Product eq 'MZ-FG-R100'`

---

## 7. 保管 / 単位

### `A_ProductStorage` — クロスプラント保管条件
1. "MZ-FG-R100 の保管条件、危険物番号、残存有効期間"
   - ヒント: `Product eq 'MZ-FG-R100'`
   - `$select`: `StorageConditions, TemperatureConditionInd, HazardousMaterialNumber, MinRemainingShelfLife`

### `A_ProductUnitsOfMeasure` — 代替単位
1. "MZ-FG-R100 のすべての代替単位と換算係数"
   - ヒント: `Product eq 'MZ-FG-R100'`
2. "FG-126 のパレット（PAL）の体積と重量"
   - ヒント: `Product eq 'FG-126' and AlternativeUnit eq 'PAL'`

### `A_ProductUnitsOfMeasureEAN` — EAN/UPC バーコード
1. "EA 単位の MZ-FG-R100 の EAN バーコード"
   - ヒント: `Product eq 'MZ-FG-R100' and AlternativeUnit eq 'EA'`
2. "MZ-FG-R100 のメイン GTIN のみ"
   - ヒント: `Product eq 'MZ-FG-R100' and IsMainGlobalTradeItemNumber eq true`

---

## 8. 資材在庫 — `API_MATERIAL_STOCK_SRV`

### `A_MaterialStock` — クロスプラント在庫ヘッダー
1. "MZ-FG-R100 の在庫単位を表示して"
   - ヒント: `Material eq 'MZ-FG-R100'`
   - `$select`: `Material, MaterialBaseUnit`

### `A_MatlStkInAcctMod` — プラント / 保管場所 / バッチ / 特殊在庫ごとの在庫
1. "プラント 1010 の MZ-FG-R100 のすべての在庫"
   - ヒント: `Material eq 'MZ-FG-R100' and Plant eq '1010'`
2. "プラント 1010 / 保管場所 0001 の MZ-FG-R100 のバッチレベル在庫"
   - ヒント: `Material eq 'MZ-FG-R100' and Plant eq '1010' and StorageLocation eq '0001'`
3. "仕入先 0000100001 の委託在庫（K）"
   - ヒント: `Supplier eq '0000100001' and InventorySpecialStockType eq 'K'`
4. "WBS 1234 のプロジェクト在庫（Q）"
   - ヒント: `WBSElementExternalID eq '1234' and InventorySpecialStockType eq 'Q'`
5. "RM233-2 の自由使用在庫のみ"
   - ヒント: `Material eq 'RM233-2' and InventoryStockType eq '01'`

### `A_MaterialSerialNumber` — シリアル番号在庫場所
1. "MZ-FG-R100 のすべてのシリアル番号場所"
   - ヒント: `Material eq 'MZ-FG-R100'`
2. "機器 10000123 に付加されたシリアル番号"
   - ヒント: `Equipment eq '10000123'`
3. "MZ-FG-R100 / シリアル ABC0001 の現在地"
   - ヒント: `Material eq 'MZ-FG-R100' and SerialNumber eq 'ABC0001'`

---

## 9. プラントマスター — `API_PLANT_SRV`

### `A_Plant` — プラントマスター
1. "会社コード 1010 に属するすべてのプラント"
   - ヒント: `CompanyCode eq '1010'`
2. "プラント 1010 の名前と会社コード"
   - ヒント: `Plant eq '1010'`
3. "名前に「Seoul」を含むプラント"
   - ヒント: `substringof('Seoul', PlantName)`

---

## 10. 資材伝票 — `API_MATERIAL_DOCUMENT_SRV`

資材伝票（物品移動）は `MaterialDocumentYear` + `MaterialDocument` で識別されます。明細には `MaterialDocumentItem` が追加されます。

### `A_MaterialDocumentHeader` — 伝票ヘッダー
1. "会計年度 2026 に作成された資材伝票を 10 件"
   - ヒント: `MaterialDocumentYear eq '2026'`、`$top=10`
2. "2026-04-01 以降に転記されたすべての資材伝票"
   - ヒント: `PostingDate ge datetime'2026-04-01T00:00:00'`
3. "ユーザー ADMIN が作成した最新の資材伝票を 20 件"
   - ヒント: `CreatedByUser eq 'ADMIN'`、`$top=20`
4. "InventoryTransactionType = WL の伝票"
   - ヒント: `InventoryTransactionType eq 'WL'`

### `A_MaterialDocumentItem` — 伝票明細
1. "資材伝票 2026 / 4900000123 のすべての明細"
   - ヒント: `MaterialDocumentYear eq '2026' and MaterialDocument eq '4900000123'`
2. "MZ-FG-R100 の入庫（移動タイプ 101）"
   - ヒント: `Material eq 'MZ-FG-R100' and GoodsMovementType eq '101'`
3. "プラント 1010 / 保管場所 0001 からの最新の出庫（601）を 50 件"
   - ヒント: `Plant eq '1010' and StorageLocation eq '0001' and GoodsMovementType eq '601'`、`$top=50`
4. "特定バッチのすべての伝票明細"
   - ヒント: `Material eq 'MZ-FG-R100' and Batch eq 'BATCH-2026-001'`

### `A_SerialNumberMaterialDocument` — 伝票明細ごとのシリアル番号
1. "資材伝票 2026 / 4900000123 / 明細 1 のシリアル番号"
   - ヒント: `MaterialDocumentYear eq '2026' and MaterialDocument eq '4900000123' and MaterialDocumentItem eq '0001'`
2. "MZ-FG-R100 / シリアル ABC0001 が登場したすべての資材伝票"
   - ヒント: `Material eq 'MZ-FG-R100' and SerialNumber eq 'ABC0001'`

---

## 11. 保管場所 — `API_STORAGELOCATION_SRV`

### `StorageLocation` — プラントごとの保管場所マスター
1. "プラント 1010 配下のすべての保管場所"
   - ヒント: `Plant eq '1010'`
2. "プラント 1010 / 保管場所 0001 の詳細"
   - ヒント: `Plant eq '1010' and StorageLocation eq '0001'`
3. "名前に「Warehouse」を含む保管場所"
   - ヒント: `substringof('Warehouse', StorageLocationName)`
4. "認可チェックが有効な保管場所のみ"
   - ヒント: `IsStorLocAuthznCheckActive eq true`

---

## 付録 — 直接呼び出し

自然言語プロンプトは最終的に ADK プロセス（ポート 8200）内の `sap_query` LLM ツールにルーティングされます。直接 curl で再現するには:

```bash
# 1. Basic 認証
curl -s -X POST http://localhost:3000/api/sap/auth \
  -H 'Content-Type: application/json' \
  -c cookies.txt \
  -d '{"method":"basic","username":"<USER>","password":"<PASS>"}'

# 2. チャットターンを送信
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{
    "conversationId": "<UUID>",
    "content": "プラント 1010 の製品プラント MRP 行を 5 件表示して"
  }'
```

LLM をバイパスした決定論的なテスト:

```bash
curl -s -X POST http://localhost:8200/run \
  -H 'Content-Type: application/json' \
  -d '{
    "app_name": "adk_agent",
    "function_call": {
      "name": "sap_query",
      "args": {
        "service_id": "API_PRODUCT_SRV",
        "entity_set": "A_ProductPlantMRPArea",
        "filter": "Plant eq '\''1010'\''",
        "top": 5
      }
    },
    "state": { "sap_credentials": { "...": "/sap/auth/basic レスポンスから" } }
  }'
```

エージェント経由のフルエンティティリスト:

```bash
curl -s http://localhost:3000/api/sap/services -b cookies.txt \
  | jq '.services[] | select(.id=="API_PRODUCT_SRV")'
```
