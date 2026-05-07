# SAP Natural-Language Query Examples

Natural-language prompt examples for the 5 SAP OData services (40 entity sets total) registered in `adk_agent/services.yaml`. Type any of these into the chat UI; the agentic orchestrator routes to the right entity and translates to `$filter` / `$select` / `$top` for the SAP call.

Covered services:
- **`API_PRODUCT_SRV`** — product master (header, plant, sales, valuation, units) — 32 entities — §1–7
- **`API_MATERIAL_STOCK_SRV`** — material stock by plant / storage / batch / serial — 3 entities — §8
- **`API_PLANT_SRV`** — plant master — 1 entity — §9
- **`API_MATERIAL_DOCUMENT_SRV`** — material documents (goods movements) — 3 entities — §10
- **`API_STORAGELOCATION_SRV`** — storage location master per plant — 1 entity — §11

> Conventions
> - **Prompt** — type verbatim into the chat
> - **Target entity** — the entity set the orchestrator is expected to pick
> - **Hint filter** — illustrative OData expression the LLM may emit (actual output may differ)
> - Sample product codes are demo-only: `MZ-FG-R100`, `RM233-2`, `FG-126`

---

## 1. Header — Product Master

### `A_Product` — cross-plant product master header
1. "Show me the basic info for product MZ-FG-R100"
   - Hint: `Product eq 'MZ-FG-R100'`
2. "List 10 finished goods created in the last 30 days"
   - Hint: `ProductType eq 'FERT' and CreationDate ge datetime'2026-03-30T00:00:00'`, `$top=10`
3. "Active products starting with FG-"
   - Hint: `startswith(Product, 'FG-') and CrossPlantStatus eq ''`

---

## 2. Descriptions / Texts — multilingual

### `A_ProductDescription` — multilingual product names
1. "Korean description for MZ-FG-R100"
   - Hint: `Product eq 'MZ-FG-R100' and Language eq 'KO'`
2. "All language descriptions for RM233-2"
   - Hint: `Product eq 'RM233-2'`

### `A_ProductBasicText` — long basic text
1. "English basic text for MZ-FG-R100"
   - Hint: `Product eq 'MZ-FG-R100' and Language eq 'EN'`

### `A_ProductPurchaseText` — purchase order text
1. "Korean purchasing text for FG-126"
   - Hint: `Product eq 'FG-126' and Language eq 'KO'`

### `A_ProductInspectionText` — inspection instructions
1. "English inspection text for RM233-2"
   - Hint: `Product eq 'RM233-2' and Language eq 'EN'`

### `A_ProductPlantText` — plant-level free text
1. "Plant 1010 notes for MZ-FG-R100"
   - Hint: `Product eq 'MZ-FG-R100' and Plant eq '1010'`

### `A_ProductSalesText` — sales-org / channel / language
1. "Korean sales text for MZ-FG-R100, sales org 1010, channel 10"
   - Hint: `Product eq 'MZ-FG-R100' and ProductSalesOrg eq '1010' and ProductDistributionChnl eq '10' and Language eq 'KO'`

---

## 3. Plant Level — per plant master

### `A_ProductPlant` — plant header
1. "Which plants is MZ-FG-R100 set up in?"
   - Hint: `Product eq 'MZ-FG-R100'`
2. "20 products in plant 1010 with PurchasingGroup 001"
   - Hint: `Plant eq '1010' and PurchasingGroup eq '001'`, `$top=20`

### `A_ProductPlantCosting` — plant costing data
1. "Costing lot size and variance key for MZ-FG-R100 / 1010"
   - Hint: `Product eq 'MZ-FG-R100' and Plant eq '1010'`
   - `$select`: `CostingLotSize, VarianceKey, BaseUnit`

### `A_ProductPlantForecasting` — forecasting parameters
1. "Forecast settings for FG-126 / 1010"
   - Hint: `Product eq 'FG-126' and Plant eq '1010'`

### `A_ProductPlantIntlTrd` — foreign trade / customs
1. "Country of origin and CAS number for MZ-FG-R100 / 1010"
   - Hint: `Product eq 'MZ-FG-R100' and Plant eq '1010'`
   - `$select`: `CountryOfOrigin, RegionOfOrigin, ProductCASNumber`

### `A_ProductPlantMRPArea` — MRP area planning
1. "All MRP-area settings for RM233-2 in plant 1010"
   - Hint: `Product eq 'RM233-2' and Plant eq '1010'`
2. "Products in Kanban MRP area with MRPType ND"
   - Hint: `MRPArea eq 'KANBAN1010' and MRPType eq 'ND'`, `$top=20`

### `A_ProductPlantProcurement` — procurement parameters
1. "Is auto PO creation allowed for MZ-FG-R100 in plant 1010?"
   - Hint: `Product eq 'MZ-FG-R100' and Plant eq '1010'`
   - `$select`: `IsAutoPurOrdCreationAllowed, IsSourceListRequired, SourceOfSupplyCategory`

### `A_ProductPlantQualityMgmt` — quality management (plant)
1. "QM control key and max storage period for MZ-FG-R100 / 1010"
   - Hint: `Product eq 'MZ-FG-R100' and Plant eq '1010'`

### `A_ProductPlantSales` — plant sales (loading group)
1. "Loading group and shipping processing time for FG-126 / 1010"
   - Hint: `Product eq 'FG-126' and Plant eq '1010'`

### `A_ProductPlantStorage` — plant storage data
1. "Cycle counting setup for MZ-FG-R100 / 1010"
   - Hint: `Product eq 'MZ-FG-R100' and Plant eq '1010'`
   - `$select`: `InventoryForCycleCountInd, CycleCountingIndicatorIsFixed, ProvisioningServiceLevel`

### `A_ProductStorageLocation` — storage-location master
1. "Warehouse bin for MZ-FG-R100 / plant 1010 / SLoc 0001"
   - Hint: `Product eq 'MZ-FG-R100' and Plant eq '1010' and StorageLocation eq '0001'`
2. "First 50 products at plant 1010 / SLoc 0001"
   - Hint: `Plant eq '1010' and StorageLocation eq '0001'`, `$top=50`

---

## 4. Sales

### `A_ProductSales` — cross-distribution-chain
1. "Sales status and tax classification for MZ-FG-R100"
   - Hint: `Product eq 'MZ-FG-R100'`
   - `$select`: `SalesStatus, TaxClassification, TransportationGroup`

### `A_ProductSalesDelivery` — sales-org / dist-channel
1. "Min order qty and supplying plant for MZ-FG-R100, sales org 1010, channel 10"
   - Hint: `Product eq 'MZ-FG-R100' and ProductSalesOrg eq '1010' and ProductDistributionChnl eq '10'`
2. "Products in sales org 1010 / channel 10 with min order qty above 100"
   - Hint: `ProductSalesOrg eq '1010' and ProductDistributionChnl eq '10' and MinimumOrderQuantity gt 100`

### `A_ProductSalesTax` — tax classification per country
1. "Korea (KR) MWST tax classification for MZ-FG-R100"
   - Hint: `Product eq 'MZ-FG-R100' and Country eq 'KR' and TaxCategory eq 'MWST'`

---

## 5. Valuation / Costing

### `A_ProductValuation` — per valuation area / type
1. "Standard price for MZ-FG-R100 in valuation area 1010"
   - Hint: `Product eq 'MZ-FG-R100' and ValuationArea eq '1010' and ValuationType eq ''`
2. "10 products in valuation area 1010 with standard price > 1000"
   - Hint: `ValuationArea eq '1010' and StandardPrice gt 1000`, `$top=10`

### `A_ProductValuationAccount` — account determination
1. "Commercial prices 1–3 for MZ-FG-R100 / 1010 valuation"
   - Hint: `Product eq 'MZ-FG-R100' and ValuationArea eq '1010' and ValuationType eq ''`

### `A_ProductValuationCosting` — valuation costing data
1. "Cost origin group and overhead group for MZ-FG-R100 / 1010"
   - Hint: `Product eq 'MZ-FG-R100' and ValuationArea eq '1010' and ValuationType eq ''`

### `A_ProductMLAccount` — Material Ledger account
1. "ML account info for MZ-FG-R100 / 1010 (legal currency)"
   - Hint: `Product eq 'MZ-FG-R100' and ValuationArea eq '1010' and ValuationType eq '' and CurrencyRole eq '10'`

### `A_ProductMLPrices` — Material Ledger prices
1. "Future price and validity start for MZ-FG-R100 / 1010"
   - Hint: `Product eq 'MZ-FG-R100' and ValuationArea eq '1010' and ValuationType eq '' and CurrencyRole eq '10'`
   - `$select`: `FuturePrice, FuturePriceValidityStartDate, PlannedPrice`

---

## 6. Procurement / Supply / Production

### `A_ProductProcurement` — cross-plant procurement
1. "Cross-plant procurement unit and acknowledgement profile for MZ-FG-R100"
   - Hint: `Product eq 'MZ-FG-R100'`

### `A_ProductSupplyPlanning` — MRP / supply planning (per plant)
1. "Lot-size settings (fixed/min/max) for RM233-2 / 1010"
   - Hint: `Product eq 'RM233-2' and Plant eq '1010'`
   - `$select`: `FixedLotSizeQuantity, MinimumLotSizeQuantity, MaximumLotSizeQuantity, LotSizeRoundingQuantity`
2. "Products in plant 1010 with min lot size ≥ 100"
   - Hint: `Plant eq '1010' and MinimumLotSizeQuantity ge 100`, `$top=20`

### `A_ProductWorkScheduling` — work scheduling
1. "Production base quantity and over/under delivery tolerance for FG-126 / 1010"
   - Hint: `Product eq 'FG-126' and Plant eq '1010'`

### `A_ProductQualityMgmt` — cross-plant QM
1. "Is QM-in-procurement active for MZ-FG-R100?"
   - Hint: `Product eq 'MZ-FG-R100'`

---

## 7. Storage / Units

### `A_ProductStorage` — cross-plant storage conditions
1. "Storage conditions, hazmat number, and remaining shelf life for MZ-FG-R100"
   - Hint: `Product eq 'MZ-FG-R100'`
   - `$select`: `StorageConditions, TemperatureConditionInd, HazardousMaterialNumber, MinRemainingShelfLife`

### `A_ProductUnitsOfMeasure` — alternative units
1. "All alternative units and conversion factors for MZ-FG-R100"
   - Hint: `Product eq 'MZ-FG-R100'`
2. "Pallet (PAL) volume and weight for FG-126"
   - Hint: `Product eq 'FG-126' and AlternativeUnit eq 'PAL'`

### `A_ProductUnitsOfMeasureEAN` — EAN/UPC barcodes
1. "EAN barcode for MZ-FG-R100 in EA unit"
   - Hint: `Product eq 'MZ-FG-R100' and AlternativeUnit eq 'EA'`
2. "Main GTIN only for MZ-FG-R100"
   - Hint: `Product eq 'MZ-FG-R100' and IsMainGlobalTradeItemNumber eq true`

---

## 8. Material Stock — `API_MATERIAL_STOCK_SRV`

### `A_MaterialStock` — cross-plant stock header
1. "Show me the stock unit for MZ-FG-R100"
   - Hint: `Material eq 'MZ-FG-R100'`
   - `$select`: `Material, MaterialBaseUnit`

### `A_MatlStkInAcctMod` — stock by plant / storage location / batch / special-stock
1. "All stock of MZ-FG-R100 in plant 1010"
   - Hint: `Material eq 'MZ-FG-R100' and Plant eq '1010'`
2. "Batch-level stock of MZ-FG-R100 in plant 1010 / storage location 0001"
   - Hint: `Material eq 'MZ-FG-R100' and Plant eq '1010' and StorageLocation eq '0001'`
3. "Consignment stock (K) from supplier 0000100001"
   - Hint: `Supplier eq '0000100001' and InventorySpecialStockType eq 'K'`
4. "Project stock (Q) for WBS 1234"
   - Hint: `WBSElementExternalID eq '1234' and InventorySpecialStockType eq 'Q'`
5. "Unrestricted-use stock only for RM233-2"
   - Hint: `Material eq 'RM233-2' and InventoryStockType eq '01'`

### `A_MaterialSerialNumber` — serialized stock locations
1. "All serial-number locations for MZ-FG-R100"
   - Hint: `Material eq 'MZ-FG-R100'`
2. "Serial numbers attached to equipment 10000123"
   - Hint: `Equipment eq '10000123'`
3. "Current location of MZ-FG-R100 / serial ABC0001"
   - Hint: `Material eq 'MZ-FG-R100' and SerialNumber eq 'ABC0001'`

---

## 9. Plant Master — `API_PLANT_SRV`

### `A_Plant` — plant master
1. "All plants belonging to company code 1010"
   - Hint: `CompanyCode eq '1010'`
2. "Name and company code for plant 1010"
   - Hint: `Plant eq '1010'`
3. "Plants whose name contains 'Seoul'"
   - Hint: `substringof('Seoul', PlantName)`

---

## 10. Material Documents — `API_MATERIAL_DOCUMENT_SRV`

Material documents (goods movements) are identified by `MaterialDocumentYear` + `MaterialDocument`; line items add `MaterialDocumentItem`.

### `A_MaterialDocumentHeader` — document header
1. "10 material documents created in fiscal year 2026"
   - Hint: `MaterialDocumentYear eq '2026'`, `$top=10`
2. "All material documents posted on or after 2026-04-01"
   - Hint: `PostingDate ge datetime'2026-04-01T00:00:00'`
3. "Last 20 material documents created by user ADMIN"
   - Hint: `CreatedByUser eq 'ADMIN'`, `$top=20`
4. "Documents with InventoryTransactionType = WL"
   - Hint: `InventoryTransactionType eq 'WL'`

### `A_MaterialDocumentItem` — document line items
1. "All line items of material document 2026 / 4900000123"
   - Hint: `MaterialDocumentYear eq '2026' and MaterialDocument eq '4900000123'`
2. "Goods receipts (movement type 101) for MZ-FG-R100"
   - Hint: `Material eq 'MZ-FG-R100' and GoodsMovementType eq '101'`
3. "50 latest goods issues (601) from plant 1010 / storage location 0001"
   - Hint: `Plant eq '1010' and StorageLocation eq '0001' and GoodsMovementType eq '601'`, `$top=50`
4. "All document lines for a specific batch"
   - Hint: `Material eq 'MZ-FG-R100' and Batch eq 'BATCH-2026-001'`

### `A_SerialNumberMaterialDocument` — serial numbers per doc item
1. "Serial numbers on material doc 2026 / 4900000123 / item 1"
   - Hint: `MaterialDocumentYear eq '2026' and MaterialDocument eq '4900000123' and MaterialDocumentItem eq '0001'`
2. "Every material document where MZ-FG-R100 / serial ABC0001 appeared"
   - Hint: `Material eq 'MZ-FG-R100' and SerialNumber eq 'ABC0001'`

---

## 11. Storage Location — `API_STORAGELOCATION_SRV`

### `StorageLocation` — storage location master per plant
1. "All storage locations under plant 1010"
   - Hint: `Plant eq '1010'`
2. "Detail for plant 1010 / storage location 0001"
   - Hint: `Plant eq '1010' and StorageLocation eq '0001'`
3. "Storage locations whose name contains 'Warehouse'"
   - Hint: `substringof('Warehouse', StorageLocationName)`
4. "Only storage locations with authorization check enabled"
   - Hint: `IsStorLocAuthznCheckActive eq true`

---

## Appendix — direct call

A natural-language prompt is ultimately routed by the agent to the
`sap_query` LLM tool inside the ADK process (port 8200). The agent owns
session state, so direct curl reproduction needs a small dance:

```bash
# 1. Basic auth — Next.js proxies to ADK /sap/auth/basic and sets the
#    sap_session cookie that scopes follow-up calls to your SAP user.
curl -s -X POST http://localhost:3000/api/sap/auth \
  -H 'Content-Type: application/json' \
  -c cookies.txt \
  -d '{"method":"basic","username":"<USER>","password":"<PASS>"}'

# 2. Send a chat turn — the agent will pick sap_query automatically.
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{
    "conversationId": "<UUID>",
    "content": "Show 5 product-plant MRP rows for plant 1010"
  }'
```

For a fully deterministic test that bypasses the LLM, hit the ADK agent
directly with a function-call envelope (this is what `/api/sap/services`
does internally):

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
    "state": { "sap_credentials": { "...": "from /sap/auth/basic response" } }
  }'
```

Full entity list and metadata via the agent:

```bash
# Through Next.js (requires sap_session cookie):
curl -s http://localhost:3000/api/sap/services -b cookies.txt \
  | jq '.services[] | select(.id=="API_PRODUCT_SRV")'
```
