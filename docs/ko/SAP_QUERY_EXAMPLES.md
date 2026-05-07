# SAP 자연어 질의 예시

`adk_agent/services.yaml`에 등록된 5개 SAP OData 서비스(총 40개 entity)에 대한 자연어 질의 예시 모음입니다. 채팅 UI(에이전틱 오케스트레이터)에 그대로 입력하면 적절한 entity로 라우팅되고, 필요한 `$filter` / `$select` / `$top` 으로 변환되어 SAP에 호출됩니다.

대상 서비스:
- **`API_PRODUCT_SRV`** — Product master (header, plant, sales, valuation, units) — 32 entities — §1–7
- **`API_MATERIAL_STOCK_SRV`** — Material stock by plant / storage / batch / serial — 3 entities — §8
- **`API_PLANT_SRV`** — Plant master — 1 entity — §9
- **`API_MATERIAL_DOCUMENT_SRV`** — Material documents (goods movements) — 3 entities — §10
- **`API_STORAGELOCATION_SRV`** — Storage location master per plant — 1 entity — §11

> 표기 규칙
> - **자연어 예시**는 사용자가 채팅에 입력하는 그대로 작성됨
> - **대상 entity**는 오케스트레이터가 선택할 것으로 기대되는 entity set
> - **힌트 필터**는 LLM이 생성할 OData 표현식의 예 (참고용; 실제 LLM 출력은 다를 수 있음)
> - 제품 코드는 데모 데이터 기준 — `MZ-FG-R100`, `RM233-2`, `FG-126` 등

---

## 1. Header — 제품 마스터

### `A_Product` — 제품 마스터 헤더 (cross-plant)
1. "제품 코드 MZ-FG-R100의 기본 정보 보여줘"
   - 힌트 필터: `Product eq 'MZ-FG-R100'`
2. "최근 30일 내에 생성된 완제품 10개 알려줘"
   - 힌트 필터: `ProductType eq 'FERT' and CreationDate ge datetime'2026-03-30T00:00:00'`, `$top=10`
3. "FG- 로 시작하는 제품 중 cross-plant status가 활성인 것만"
   - 힌트 필터: `startswith(Product, 'FG-') and CrossPlantStatus eq ''`

---

## 2. Descriptions / Texts — 다국어 설명·텍스트

### `A_ProductDescription` — 다국어 제품명
1. "MZ-FG-R100의 한국어 제품명 알려줘"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and Language eq 'KO'`
2. "RM233-2의 모든 언어 제품명을 보여줘"
   - 힌트 필터: `Product eq 'RM233-2'`

### `A_ProductBasicText` — 기본 텍스트 (long text)
1. "MZ-FG-R100의 영어 기본 텍스트 본문 좀 보여줘"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and Language eq 'EN'`

### `A_ProductPurchaseText` — 구매 발주 텍스트
1. "FG-126 구매 텍스트 한국어 버전"
   - 힌트 필터: `Product eq 'FG-126' and Language eq 'KO'`

### `A_ProductInspectionText` — 검사 텍스트
1. "RM233-2 검사 지침서 영어로"
   - 힌트 필터: `Product eq 'RM233-2' and Language eq 'EN'`

### `A_ProductPlantText` — 플랜트별 자유 텍스트
1. "MZ-FG-R100 / 1010 플랜트의 메모 보여줘"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and Plant eq '1010'`

### `A_ProductSalesText` — 영업조직/유통채널/언어별 텍스트
1. "MZ-FG-R100, sales org 1010, 채널 10의 한국어 영업 텍스트"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and ProductSalesOrg eq '1010' and ProductDistributionChnl eq '10' and Language eq 'KO'`

---

## 3. Plant 레벨 — 플랜트별 마스터

### `A_ProductPlant` — 플랜트별 헤더
1. "MZ-FG-R100이 어느 플랜트에 등록돼 있는지 알려줘"
   - 힌트 필터: `Product eq 'MZ-FG-R100'`
2. "플랜트 1010에서 PurchasingGroup이 001인 제품 20개"
   - 힌트 필터: `Plant eq '1010' and PurchasingGroup eq '001'`, `$top=20`

### `A_ProductPlantCosting` — 플랜트 원가 데이터
1. "MZ-FG-R100 / 1010 플랜트의 원가 lot size와 variance key"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and Plant eq '1010'`
   - `$select`: `CostingLotSize, VarianceKey, BaseUnit`

### `A_ProductPlantForecasting` — 예측 파라미터
1. "FG-126 / 1010의 수요 예측 설정 보여줘"
   - 힌트 필터: `Product eq 'FG-126' and Plant eq '1010'`

### `A_ProductPlantIntlTrd` — 대외무역/관세 데이터
1. "MZ-FG-R100 / 1010 플랜트의 원산지와 CAS 번호"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and Plant eq '1010'`
   - `$select`: `CountryOfOrigin, RegionOfOrigin, ProductCASNumber`

### `A_ProductPlantMRPArea` — MRP 영역별 계획
1. "RM233-2 / 1010 플랜트의 모든 MRP area 설정"
   - 힌트 필터: `Product eq 'RM233-2' and Plant eq '1010'`
2. "Kanban MRP area에서 MRPType이 ND인 제품들"
   - 힌트 필터: `MRPArea eq 'KANBAN1010' and MRPType eq 'ND'`, `$top=20`

### `A_ProductPlantProcurement` — 플랜트 조달 파라미터
1. "MZ-FG-R100 / 1010에서 자동 PO 생성이 허용되어 있는지"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and Plant eq '1010'`
   - `$select`: `IsAutoPurOrdCreationAllowed, IsSourceListRequired, SourceOfSupplyCategory`

### `A_ProductPlantQualityMgmt` — 품질관리 (플랜트 레벨)
1. "MZ-FG-R100 / 1010의 품질관리 컨트롤 키와 최대 보관기간"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and Plant eq '1010'`

### `A_ProductPlantSales` — 플랜트 영업 (적재 그룹 등)
1. "FG-126 / 1010의 loading group과 출하 처리 시간"
   - 힌트 필터: `Product eq 'FG-126' and Plant eq '1010'`

### `A_ProductPlantStorage` — 플랜트 저장 데이터
1. "MZ-FG-R100 / 1010의 cycle counting 설정"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and Plant eq '1010'`
   - `$select`: `InventoryForCycleCountInd, CycleCountingIndicatorIsFixed, ProvisioningServiceLevel`

### `A_ProductStorageLocation` — 저장 위치별 마스터
1. "MZ-FG-R100 / 1010 플랜트, 저장위치 0001의 창고 빈"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and Plant eq '1010' and StorageLocation eq '0001'`
2. "플랜트 1010 / 저장위치 0001에 등록된 모든 제품 50개"
   - 힌트 필터: `Plant eq '1010' and StorageLocation eq '0001'`, `$top=50`

---

## 4. Sales — 영업

### `A_ProductSales` — cross-distribution-chain
1. "MZ-FG-R100의 영업 상태와 세금 분류"
   - 힌트 필터: `Product eq 'MZ-FG-R100'`
   - `$select`: `SalesStatus, TaxClassification, TransportationGroup`

### `A_ProductSalesDelivery` — sales-org / 유통채널별
1. "MZ-FG-R100 / sales org 1010 / 채널 10의 최소 주문 수량과 공급 플랜트"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and ProductSalesOrg eq '1010' and ProductDistributionChnl eq '10'`
2. "sales org 1010, 채널 10의 모든 제품 중 최소 주문량 100 이상"
   - 힌트 필터: `ProductSalesOrg eq '1010' and ProductDistributionChnl eq '10' and MinimumOrderQuantity gt 100`

### `A_ProductSalesTax` — 국가/세금 카테고리별 분류
1. "MZ-FG-R100의 한국(KR) MWST 세금 분류"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and Country eq 'KR' and TaxCategory eq 'MWST'`

---

## 5. Valuation / Costing — 평가·원가

### `A_ProductValuation` — 평가 영역/타입별
1. "MZ-FG-R100의 valuation area 1010, type 공란의 표준가"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and ValuationArea eq '1010' and ValuationType eq ''`
2. "valuation area 1010에서 표준가 1000 초과 제품 10개"
   - 힌트 필터: `ValuationArea eq '1010' and StandardPrice gt 1000`, `$top=10`

### `A_ProductValuationAccount` — 계정 결정
1. "MZ-FG-R100 / 1010 평가의 상업 가격(CommercialPrice 1~3)"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and ValuationArea eq '1010' and ValuationType eq ''`

### `A_ProductValuationCosting` — 평가 원가 데이터
1. "MZ-FG-R100 / 1010의 원가 origin group과 overhead group"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and ValuationArea eq '1010' and ValuationType eq ''`

### `A_ProductMLAccount` — Material Ledger 계정
1. "MZ-FG-R100 / 1010 평가의 ML 계정 정보 (legal currency)"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and ValuationArea eq '1010' and ValuationType eq '' and CurrencyRole eq '10'`

### `A_ProductMLPrices` — Material Ledger 가격
1. "MZ-FG-R100 / 1010의 미래가(future price)와 발효일자"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and ValuationArea eq '1010' and ValuationType eq '' and CurrencyRole eq '10'`
   - `$select`: `FuturePrice, FuturePriceValidityStartDate, PlannedPrice`

---

## 6. Procurement / Supply / Production — 조달·공급계획·생산

### `A_ProductProcurement` — cross-plant 조달
1. "MZ-FG-R100의 cross-plant 조달 단위와 발주 acknowledgement 프로파일"
   - 힌트 필터: `Product eq 'MZ-FG-R100'`

### `A_ProductSupplyPlanning` — MRP/공급 계획 (플랜트별)
1. "RM233-2 / 1010의 lot size 설정 (고정/최소/최대)"
   - 힌트 필터: `Product eq 'RM233-2' and Plant eq '1010'`
   - `$select`: `FixedLotSizeQuantity, MinimumLotSizeQuantity, MaximumLotSizeQuantity, LotSizeRoundingQuantity`
2. "플랜트 1010에서 최소 lot size 100 이상인 제품 20개"
   - 힌트 필터: `Plant eq '1010' and MinimumLotSizeQuantity ge 100`, `$top=20`

### `A_ProductWorkScheduling` — 작업 일정
1. "FG-126 / 1010의 production base quantity와 over/under delivery 허용치"
   - 힌트 필터: `Product eq 'FG-126' and Plant eq '1010'`

### `A_ProductQualityMgmt` — cross-plant 품질관리
1. "MZ-FG-R100의 조달 품질관리 활성 여부"
   - 힌트 필터: `Product eq 'MZ-FG-R100'`

---

## 7. Storage / Units — 보관·단위

### `A_ProductStorage` — cross-plant 보관 조건
1. "MZ-FG-R100의 보관 조건과 위험물 번호, 잔여 유통기한"
   - 힌트 필터: `Product eq 'MZ-FG-R100'`
   - `$select`: `StorageConditions, TemperatureConditionInd, HazardousMaterialNumber, MinRemainingShelfLife`

### `A_ProductUnitsOfMeasure` — 대체 단위
1. "MZ-FG-R100의 모든 대체 단위와 환산 계수"
   - 힌트 필터: `Product eq 'MZ-FG-R100'`
2. "FG-126의 PAL(팔레트) 단위 부피와 무게"
   - 힌트 필터: `Product eq 'FG-126' and AlternativeUnit eq 'PAL'`

### `A_ProductUnitsOfMeasureEAN` — EAN/UPC 바코드
1. "MZ-FG-R100의 EA(개) 단위 EAN 바코드"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and AlternativeUnit eq 'EA'`
2. "MZ-FG-R100의 메인 GTIN(주 바코드)만"
   - 힌트 필터: `Product eq 'MZ-FG-R100' and IsMainGlobalTradeItemNumber eq true`

---

## 8. Material Stock — `API_MATERIAL_STOCK_SRV`

### `A_MaterialStock` — 재고 헤더 (cross-plant)
1. "MZ-FG-R100의 재고 단위 보여줘"
   - 힌트 필터: `Material eq 'MZ-FG-R100'`
   - `$select`: `Material, MaterialBaseUnit`

### `A_MatlStkInAcctMod` — 플랜트/저장위치/배치/special-stock 별 재고
1. "MZ-FG-R100의 플랜트 1010 재고 모두 보여줘"
   - 힌트 필터: `Material eq 'MZ-FG-R100' and Plant eq '1010'`
2. "플랜트 1010 / 저장위치 0001의 MZ-FG-R100 batch별 재고"
   - 힌트 필터: `Material eq 'MZ-FG-R100' and Plant eq '1010' and StorageLocation eq '0001'`
3. "공급업체 0000100001의 consignment(K) 재고"
   - 힌트 필터: `Supplier eq '0000100001' and InventorySpecialStockType eq 'K'`
4. "프로젝트 WBS 1234의 project stock(Q)"
   - 힌트 필터: `WBSElementExternalID eq '1234' and InventorySpecialStockType eq 'Q'`
5. "RM233-2의 unrestricted-use 재고만"
   - 힌트 필터: `Material eq 'RM233-2' and InventoryStockType eq '01'`

### `A_MaterialSerialNumber` — 시리얼 번호별 재고 위치
1. "MZ-FG-R100의 모든 시리얼 번호 위치"
   - 힌트 필터: `Material eq 'MZ-FG-R100'`
2. "Equipment 10000123에 연결된 시리얼 번호"
   - 힌트 필터: `Equipment eq '10000123'`
3. "MZ-FG-R100 / 시리얼 ABC0001의 현재 위치"
   - 힌트 필터: `Material eq 'MZ-FG-R100' and SerialNumber eq 'ABC0001'`

---

## 9. Plant Master — `API_PLANT_SRV`

### `A_Plant` — 플랜트 마스터
1. "회사코드 1010에 속한 모든 플랜트"
   - 힌트 필터: `CompanyCode eq '1010'`
2. "플랜트 1010의 이름과 회사코드"
   - 힌트 필터: `Plant eq '1010'`
3. "이름에 'Seoul'이 포함된 플랜트"
   - 힌트 필터: `substringof('Seoul', PlantName)`

---

## 10. Material Documents — `API_MATERIAL_DOCUMENT_SRV`

자재 문서(goods movement)는 `MaterialDocumentYear` + `MaterialDocument` 으로 식별합니다. 라인 항목은 `+ MaterialDocumentItem`.

### `A_MaterialDocumentHeader` — 자재 문서 헤더
1. "2026년에 작성된 자재 문서 10개"
   - 힌트 필터: `MaterialDocumentYear eq '2026'`, `$top=10`
2. "PostingDate가 2026-04-01 이후인 모든 자재 문서"
   - 힌트 필터: `PostingDate ge datetime'2026-04-01T00:00:00'`
3. "사용자 ADMIN이 만든 최근 자재 문서 20개"
   - 힌트 필터: `CreatedByUser eq 'ADMIN'`, `$top=20`
4. "거래유형(InventoryTransactionType)이 WL인 문서"
   - 힌트 필터: `InventoryTransactionType eq 'WL'`

### `A_MaterialDocumentItem` — 자재 문서 라인
1. "자재 문서 2026 / 4900000123의 모든 라인"
   - 힌트 필터: `MaterialDocumentYear eq '2026' and MaterialDocument eq '4900000123'`
2. "MZ-FG-R100의 입고(movement type 101) 이력"
   - 힌트 필터: `Material eq 'MZ-FG-R100' and GoodsMovementType eq '101'`
3. "플랜트 1010 / 저장위치 0001의 출고(601) 라인 50개"
   - 힌트 필터: `Plant eq '1010' and StorageLocation eq '0001' and GoodsMovementType eq '601'`, `$top=50`
4. "특정 batch의 모든 자재 문서 라인"
   - 힌트 필터: `Material eq 'MZ-FG-R100' and Batch eq 'BATCH-2026-001'`

### `A_SerialNumberMaterialDocument` — 자재 문서별 시리얼 번호
1. "자재 문서 2026 / 4900000123 / 라인 1의 시리얼 번호"
   - 힌트 필터: `MaterialDocumentYear eq '2026' and MaterialDocument eq '4900000123' and MaterialDocumentItem eq '0001'`
2. "MZ-FG-R100 / 시리얼 ABC0001이 등장한 모든 자재 문서"
   - 힌트 필터: `Material eq 'MZ-FG-R100' and SerialNumber eq 'ABC0001'`

---

## 11. Storage Location — `API_STORAGELOCATION_SRV`

### `StorageLocation` — 플랜트별 저장위치 마스터
1. "플랜트 1010의 모든 저장위치"
   - 힌트 필터: `Plant eq '1010'`
2. "플랜트 1010 / 저장위치 0001의 상세 정보"
   - 힌트 필터: `Plant eq '1010' and StorageLocation eq '0001'`
3. "이름에 'Warehouse'가 포함된 저장위치"
   - 힌트 필터: `substringof('Warehouse', StorageLocationName)`
4. "권한 체크가 활성화된 저장위치만"
   - 힌트 필터: `IsStorLocAuthznCheckActive eq true`

---

## 부록 — 직접 호출 예시

자연어 질의는 결국 ADK 프로세스 (8200 포트) 안의 `sap_query` LLM 도구로
에이전트가 라우팅합니다. 에이전트가 세션 상태를 소유하므로, 직접 curl로
재현하려면 약간의 사전 작업이 필요합니다:

```bash
# 1. Basic 인증 — Next.js가 ADK /sap/auth/basic으로 프록시하고
#    후속 호출을 SAP 사용자 스코프로 묶는 sap_session 쿠키를 설정합니다.
curl -s -X POST http://localhost:3000/api/sap/auth \
  -H 'Content-Type: application/json' \
  -c cookies.txt \
  -d '{"method":"basic","username":"<USER>","password":"<PASS>"}'

# 2. 채팅 턴 전송 — 에이전트가 sap_query를 자동으로 선택합니다.
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{
    "conversationId": "<UUID>",
    "content": "플랜트 1010의 product-plant MRP 5건 보여줘"
  }'
```

LLM을 우회하는 완전히 결정론적인 테스트의 경우, function-call envelope으로
ADK 에이전트를 직접 호출하세요 (이것이 `/api/sap/services`이 내부적으로
하는 것):

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
    "state": { "sap_credentials": { "...": "/sap/auth/basic 응답에서" } }
  }'
```

에이전트를 통한 전체 entity 목록과 메타데이터:

```bash
# Next.js를 통해 (sap_session 쿠키 필요):
curl -s http://localhost:3000/api/sap/services -b cookies.txt \
  | jq '.services[] | select(.id=="API_PRODUCT_SRV")'
```
