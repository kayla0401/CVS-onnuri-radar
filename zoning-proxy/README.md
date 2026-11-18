# 용도지역 조회 프록시 (Cloudflare Worker)

브라우저에는 브이월드 키를 두지 않는다. 키는 Worker 시크릿(`VWORLD_API_KEY`)에만 두고, 정적 페이지는
아래 두 주소만 부른다.

| 요청 | 하는 일 | 키 필요 |
| --- | --- | --- |
| `GET /zoning?lat=&lng=&pnu=` | 점포 핀 좌표·필지(PNU)의 용도지역 이름 | 아니오(토지이음 폴백) |
| `GET /zoning?mode=area&bbox=w,s,e,n` | 신청 구역 경계 상자의 용도지역 도형(상업·비상업 면적 계산용) | 예 |
| `GET /semas?mode=polygon&key=POLYGON((lng lat,...))` | 직접 그린 구역 안 **공단 상가업소 전수**(storeListInPolygon) | 예(`SEMAS_API_KEY`) |
| `GET /semas?mode=zones&cx=&cy=&radius=` | 반경(≤2,000m) 안 공단 상권 구역(storeZoneInRadius) | 예 |
| `GET /building?pnu=19자리` | 필지(PNU)의 건축물대장 — 표제부·전유부(집합)·층별개요(일반) 집계와 2,000㎡ 상한 판정 | 예(`SEMAS_API_KEY` 재사용) |

## 건축물대장 `/building`

골목형상점가 면적 요건은 **대지면적이 아니라 건물 내 1층~꼭대기 층(지하 영업층 포함) 점포 전용면적 합산**이고,
중기부 2026.08 가이드라인(전국 공통)부터 **2,000㎡ 절대 상한**을 넘으면 비례 인정 없이 지정 불가다.
브라우저는 점포 좌표에서 19자리 PNU(법정동 10 + 대지구분 1 + 본번 4 + 부번 4)를 만들어 이 라우트를 부른다.

- PNU 분해: `sigunguCd=pnu[0..5]`, `bjdongCd=pnu[5..10]`, `platGbCd={'1':'0','2':'1','3':'2'}[pnu[10]]`, `bun=pnu[11..15]`, `ji=pnu[15..19]`.
- 표제부(`getBrTitleInfo`)로 대장구분(`1` 일반 / `2` 집합)·건물명·대지·연면적·층수를 읽는다.
- **집합건축물**은 전유부(`getBrExposPubuseAreaInfo`)에서 `exposPubuseGbCd==='1'`(전유)만 합산하고 공용면적은 뺀다.
  주거(공동·단독주택 등) 전유는 따로 분리해 `residentialArea`로 돌려주고 점포 합계에서 제외한다. 100건×최대 6페이지.
- **일반건축물**은 층별개요(`getBrFlrOulnInfo`)에서 층별 바닥면적을 용도로 갈라 합산한다. 주차장·기계실·전기실 등
  부대설비만 있는 층은 영업면적에서 빼고 `otherArea`로 돌려준다. 대장에 호실별 전유면적이 없으므로
  `shops.estimatedExclusive`(공용부 20% 차감 참고치)와 `notes`의 임대차계약서 확인 안내를 함께 준다.
- 응답: `{status, source:'bldrgst', pnu, building:{kind,kindLabel,name,address,mainPurps,platArea,totalArea,groundFloors,underFloors,dongs,hasExpos}, shops:{area,aboveGround,underground,units,estimatedExclusive,residentialArea,otherArea,over2000,excess}, floors:[{label,area,residential,other,units,kind,purposes}], cap:{limit,basis,exceeded,excess,verdict}, notes, checkedAt}`
- 없음 `404 {status:'not_found'}`, 형식 오류 `400 {status:'coordinate'}`, 키 없음 `503`, 게이트웨이 오류 `502 {status:'upstream'}`.
- 인증키(`SEMAS_API_KEY`)와 원응답은 브라우저로 나가지 않는다. 건축물대장은 초당 요청 제한이 있어 페이지를 순차로 받는다.

## 공단 상가(상권)정보 `/semas`

- 다각형은 `POLYGON((lng lat,...))` 형식만 받고, 꼭짓점 3~100개·국내 범위(경도 124~132, 위도 32~39)·
  경계 상자 한 변 0.04°/넓이 0.0016° 가드를 통과해야 한다(넘으면 `400 coordinate`).
- upstream `storeListInPolygon` 은 `type=json` 으로 부르고, `numOfRows` 는 최대 1,000.
  1페이지가 모자라면 최대 3페이지(3,000건)까지 합산하며, 다 받지 못하면 `truncated: true` 로 알린다.
- `header.resultCode === '00'` → `{status:'ok', stdrYm, totalCount, items}`, `'03'`(NODATA_ERROR) → `{status:'empty', items:[]}`,
  게이트웨이 XML(`OpenAPI_ServiceResponse`)·기타 오류 → `502 {status:'upstream'}`. 인증키는 어떤 응답에도 넣지 않는다.
- 점포 항목은 `bizesId·bizesNm·brchNm·indsLclsNm·indsMclsNm·indsSclsNm·ksicNm·rdnmAdr·lnoAdr·bldNm·flrNo·hoNo·lon·lat` 로 정리해 돌려준다.
- 브라우저 쪽은 `/semas` 호출이 실패해도 기존 카카오 실시간 집계로 그대로 계산하고, 카드에 실패 안내와 재조회 버튼을 띄운다.

## 점포 조회 — 두 경로

1. **브이월드 공식 API** (`LT_C_UQ111~UQ114`, 국토교통부 용도지역 레이어) — `VWORLD_API_KEY`가 있으면 먼저 시도한다.
2. **토지이음 폴백** — 키가 없거나 브이월드가 실패·무응답이면 서버가
   `https://www.eum.go.kr/web/ar/lu/luLandDet.jsp?pnu=…&mode=search&isNoScr=script`를 읽어
   `var sehUcodeListExt = "[{ucode=UQA220, uname=일반상업지역}, …]"`에서 용도지역 코드만 골라 이름으로 돌려준다.
   - 응답은 EUC-KR이라 `TextDecoder('euc-kr')`로 디코드하고, 이름은 표준코드 표(UQA111~UQD001)를 우선 쓴다.
   - 지구·구역·도로 코드(UQP·UQQ·UQS…)와 도시지역 경계(UQA01X·UQA001)는 판정에서 뺀다.
   - 없는 번지(PNU)는 `404 {"status":"not_found"}`로 구분해 오탐을 막는다.
   - 브라우저는 카카오 `Geocoder().coord2Address`의 지번·`mountain_yn`과 `coord2regioncode`의
     법정동(B) 코드로 19자리 PNU(법정동 10 + 대지구분 1 + 본번 4 + 부번 4)를 만든다.
     (`coord2address` 응답에는 `b_code`가 없어 지역코드를 따로 받아야 한다)

## 직접 그린 구역 — 상업·비상업 혼합 면적

브이월드에만 구역 폴리곤이 있으므로 **면적 계산은 키가 있어야 켜진다**. 키가 없으면 화면은
"도형 조회 대기(키 미설정)"로 표시하고 수동 확인을 안내한다(점포 필지 판정은 키 없이 동작).

- Worker는 경계 상자(`BOX(...)`)로 도형을 페이지 끝까지 받아 중복을 제거하고 `{name, kind, outer, holes}`로 돌려준다.
- 안전가드: 한 변 0.04°(약 4.4km), 넓이 0.0016°, 페이지 4, 피처 240, 좌표 12,000개. 넘으면 일부만 주지 않고 `413 too_many`.
- 브라우저는 신청 도면과 도형을 점포 중심 로컬 미터 평면으로 옮겨 **가로 스캔라인(0.5m 밴드) 적분**으로 교집합 면적을 구하고,
  합이 신발끈 공식 총면적과 일치하도록 보정한다. 상업·비상업이 겹치는 부분은 어느 쪽에도 세지 않고 따로 표시한다.
- 비상업이 1% 이상 섞이면 조례상 상업/비상업 기준 차이를 경고한다(혼합 구역 처리 기준은 지자체 확인).

## 배포

```bash
cd zoning-proxy
npx wrangler deploy                       # name = onnuri-zoning
npx wrangler secret put VWORLD_API_KEY    # 키를 받은 뒤 (선택)
npx wrangler secret put SEMAS_API_KEY     # 상가(상권)정보·건축물대장 공통 키
```

`wrangler.toml`의 `SITE_ORIGINS`는 쉼표로 여러 Origin을 둘 수 있고, `CORS`는 그 목록에 든 Origin에만 붙는다.
`OPTIONS` 프리플라이트는 `204` + `Allow-Origin/Methods(GET, OPTIONS)/Headers(Content-Type)/Max-Age 86400`으로 답한다.
`LOOKUP_LIMIT`(IP당 60초 20회) 바인딩이 없거나 응답하지 않으면 Worker가 프로세스 안 메모리 제한으로 대신한다.

## 한계

- 외부 호출자는 `Origin`을 위조할 수 있다. 허용 Origin 검사는 브라우저 공유 정책일 뿐이므로 쿼터를 함께 본다.
- 토지이음은 필지 단위 결과만 준다. 구역 전체 혼합 비율은 브이월드 키가 있어야 자동 계산된다.
- 브이월드가 좌표를 `[위도, 경도]`로 줄 때를 대비해 국내 범위(경도 124~132, 위도 32~39)로 순서를 정규화한다.
