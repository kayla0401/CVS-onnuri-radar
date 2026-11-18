/* 건축물대장 프록시(/building) + 2,000㎡ 절대 상한 UI 계약 테스트
 *
 *  - Worker: PNU 분해 · 표제부/전유부/층별개요 집계 · 부대설비·주거 분리 · 페이지 합산 · 오류 매핑 · CORS
 *  - 프론트: /building 자동조회 · 건축물대장 카드 · 도면 카드 경고 · A4 리포트 문구 · 2,000㎡ 상한 프리셋
 *  - 실측 기준: 2026-11-18 국토교통부 건축HUB 응답 구조
 *      망포센트럴프라자 4111710700104170002 (일반) — 지상 1~4층 3,327.02 + 지하1층 소매 1,293.44 = 4,620.46㎡
 *      스타프라움 4111710700103690003 (집합) — 전유 59호실 5,484.52㎡ 중 주거 251.98㎡ 제외
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';

const here = new URL('.', import.meta.url);
const worker = (await import(new URL('../zoning-proxy/worker.mjs', here).href)).default;
const html = fs.readFileSync(new URL('../index.html', here), 'utf8');
const config = fs.readFileSync(new URL('../zoning-config.js', here), 'utf8');

let passed = 0;
function test(name, fn) { const r = fn(); if (r && typeof r.then === 'function') return r.then(() => { console.log('PASS ' + name); passed++; }); console.log('PASS ' + name); passed++; }
const section = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b); assert.ok(i >= 0 && j > i, `구간 없음: ${a}`); return html.slice(i, j); };

/* ---- 실제 응답과 같은 모양의 건축물대장 레코드 ---- */
const titleRow = (over = {}) => ({
  platPlc: '경기도 수원시 영통구 망포동 417-2번지', sigunguCd: '41117', bjdongCd: '10700', platGbCd: '0',
  bun: '0417', ji: '0002', mgmBldrgstPk: 10841100290166, regstrGbCd: '1', regstrGbCdNm: '일반',
  regstrKindCd: '2', regstrKindCdNm: '일반건축물',
  newPlatPlc: '경기도 수원시 영통구 영통로154번길 60 (망포동)', bldNm: ' ',
  dongNm: ' ', mainAtchGbCdNm: '주건축물', platArea: 1668, archArea: 944.92, totArea: 5858.76,
  vlRatEstmTotArea: 3327.02, mainPurpsCd: '03000', mainPurpsCdNm: '제1종근린생활시설',
  etcPurps: '제1종근린생활시설, 제2종근린생활시설', grndFlrCnt: 4, ugrndFlrCnt: 2, hhldCnt: 0, hoCnt: 0,
  indrMechArea: 173.6, indrAutoArea: 1025.11, useAprDay: '20131127', ...over,
});
const aggTitle = (over = {}) => titleRow({
  regstrGbCd: '2', regstrGbCdNm: '집합', regstrKindCd: '3', regstrKindCdNm: '표제부',
  mgmBldrgstPk: 1000000000000003521909, bldNm: '스타프라움', dongNm: 'A동',
  mainPurpsCdNm: '제1종근린생활시설', etcPurps: '제1,2종근린생활시설,교육연구시설, 운동시설',
  platArea: 2707, totArea: 5778.24, grndFlrCnt: 5, ugrndFlrCnt: 0, hoCnt: 47,
  newPlatPlc: '경기도 수원시 영통구 영통로 157 (망포동)', ...over,
});
const flr = (gb, no, purps, area, etc = null) => ({
  flrGbCd: gb === '지상' ? '20' : '10', flrGbCdNm: gb, flrNo: no, flrNoNm: `${gb === '지하' ? '지' : ''}${no}층`,
  mainPurpsCdNm: purps, etcPurps: etc == null ? purps : etc, area, mainAtchGbCdNm: '주건축물',
});
const exposRow = (dong, flr, ho, gb, purps, area, etc = null) => ({
  dongNm: dong || ' ', flrNoNm: `${dong || ''}${flr}층`, hoNm: ho, exposPubuseGbCd: gb,
  exposPubuseGbCdNm: gb === '1' ? '전유' : '공용', mainPurpsCdNm: purps,
  etcPurps: etc == null ? purps : etc, area, regstrGbCd: '2', regstrGbCdNm: '집합',
});
const body = (items, total = items.length) => ({ response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE' }, body: { items: { item: items }, numOfRows: 100, pageNo: 1, totalCount: String(total) } } });
const NODATA = { response: { header: { resultCode: '03', resultMsg: 'NODATA_ERROR' }, body: { items: '', numOfRows: 100, pageNo: 1, totalCount: '0' } } };
const GATEWAY = '<?xml version="1.0" encoding="UTF-8"?><OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</errMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';

/* ---- upstream 스텁: 오퍼레이션별 응답을 고른다 ---- */
function stub(handler) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const out = await handler(String(url), calls.length);
    if (typeof out === 'string') return new Response(out, { status: 200, headers: { 'content-type': 'text/xml' } });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}
const env = { SITE_ORIGINS: 'https://kayla0401.github.io', SEMAS_API_KEY: 'TEST_KEY_DECODING' };
const ORIGIN = 'https://kayla0401.github.io';
/* 레이트리밋(IP당 60초 20회)은 이 파일 안에서 계산해야 한다 — 앞선 계약 테스트와 같은 모듈을 쓰므로
   실제 클라이언트처럼 호출마다 다른 IP를 준다 */
let ipSeq = 0;
const req = (path, origin = ORIGIN, method = 'GET') => new Request('https://onnuri-zoning.example' + path, { method, headers: origin ? { Origin: origin, 'CF-Connecting-IP': '10.9.' + (Math.floor(ipSeq / 250)) + '.' + (++ipSeq % 250) } : {} });
const MANPO = '4111710700104170002';
const STAR = '4111710700103690003';

/* 일반건축물 — 층별개요(실측 12행, 합계 3,327.02 + 1,293.44, 부대설비 1,238.30 제외) */
const MANPO_FLOORS = [
  flr('지상', 4, '체육도장', 247.85), flr('지상', 4, '의원', 195.16), flr('지상', 4, '학원', 353.64),
  flr('지상', 3, '의원', 494.39, '제1종근린생활시설(의원)'), flr('지상', 3, '학원', 302.26, '제2종근린생활시설(학원)'),
  flr('지상', 2, '복합유통게임제공업소', 354.4), flr('지상', 2, '의원', 318.13), flr('지상', 2, '노래연습장', 124.12),
  flr('지상', 1, '휴게음식점', 522.72, '제1종근린생활시설(휴게음식점, 의원)'), flr('지상', 1, '일반음식점', 414.35),
  flr('지하', 2, '소매점', 1238.3, '전기실,기계실,주차장'), flr('지하', 1, '소매점', 1293.44, '제1종근린생활시설'),
];

await test('/building 은 19자리 PNU를 시군구·법정동·번지로 분해해 표제부를 부른다', async () => {
  const calls = stub((url) => url.includes('getBrTitleInfo') ? body([titleRow()])
    : url.includes('getBrFlrOulnInfo') ? body(MANPO_FLOORS) : NODATA);
  const res = await worker.fetch(req(`/building?pnu=${MANPO}`), env);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.status, 'ok');
  assert.equal(data.source, 'bldrgst');
  const u = new URL(calls[0]);
  assert.ok(u.pathname.endsWith('/getBrTitleInfo'));
  assert.equal(u.searchParams.get('sigunguCd'), '41117');
  assert.equal(u.searchParams.get('bjdongCd'), '10700');
  assert.equal(u.searchParams.get('platGbCd'), '0');
  assert.equal(u.searchParams.get('bun'), '0417');
  assert.equal(u.searchParams.get('ji'), '0002');
  assert.equal(u.searchParams.get('_type'), 'json');
  assert.ok(calls.some(c => c.includes('getBrFlrOulnInfo')), '일반건축물은 층별개요를 부른다');
  assert.ok(!calls.some(c => c.includes('getBrExposPubuseAreaInfo')), '일반건축물은 전유부를 부르지 않는다');
  assert.ok(!JSON.stringify(data).includes('TEST_KEY_DECODING'), '키가 응답에 노출되면 안 된다');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

await test('일반건축물 집계 — 지상 3,327.02 + 지하1층 소매 1,293.44 = 4,620.46㎡ (지하2층 부대설비 제외)', async () => {
  stub((url) => url.includes('getBrTitleInfo') ? body([titleRow()])
    : url.includes('getBrFlrOulnInfo') ? body(MANPO_FLOORS) : NODATA);
  const data = await (await worker.fetch(req(`/building?pnu=${MANPO}`), env)).json();
  assert.equal(data.building.kind, 'general');
  assert.equal(data.building.kindLabel, '일반건축물');
  assert.equal(data.building.hasExpos, false, '일반건축물은 전유부가 없다');
  assert.equal(data.building.platArea, 1668);
  assert.equal(data.building.totalArea, 5858.76);
  assert.equal(data.building.groundFloors, 4);
  assert.equal(data.building.underFloors, 2);
  assert.equal(data.shops.aboveGround, 3327.02);
  assert.equal(data.shops.underground, 1293.44);
  assert.equal(data.shops.area, 4620.46);
  assert.equal(data.shops.otherArea, 1238.3, '지하2층(전기·기계·주차)은 부대설비로 분리');
  assert.equal(data.shops.over2000, true);
  assert.equal(data.shops.excess, 2620.46);
  assert.equal(data.shops.estimatedExclusive, 3696.37, '공용부 20% 차감 참고치');
  assert.equal(data.shops.units, null);
  assert.ok(data.notes.some(n => /호실별 전유면적이 없습니다/.test(n)), '일반건축물 안내 플래그');
  assert.ok(data.notes.some(n => /임대차계약서/.test(n)), '실임대면적 확인 안내');
  /* 층 정렬 — 지상 4층부터, 지하는 아래층 순서 */
  const labels = data.floors.map(f => f.label);
  assert.deepEqual(labels.slice(0, 4), ['4층', '3층', '2층', '1층']);
  assert.deepEqual(labels.slice(-2), ['지하1층', '지하2층']);
  const basement2 = data.floors.find(f => f.label === '지하2층');
  assert.equal(basement2.kind, 'ancillary');
  assert.equal(basement2.area, 0);
});

await test('2,000㎡ 상한 판정 문구와 기준을 함께 돌려준다', async () => {
  stub((url) => url.includes('getBrTitleInfo') ? body([titleRow()])
    : url.includes('getBrFlrOulnInfo') ? body(MANPO_FLOORS) : NODATA);
  const data = await (await worker.fetch(req(`/building?pnu=${MANPO}`), env)).json();
  assert.equal(data.cap.limit, 2000);
  assert.equal(data.cap.exceeded, true);
  assert.equal(data.cap.excess, 2620.46);
  assert.ok(/2,000㎡/.test(data.cap.basis) && /상한/.test(data.cap.basis) && /2026\.08/.test(data.cap.basis), data.cap.basis);
  assert.ok(/지정 불가/.test(data.cap.verdict), data.cap.verdict);
});

/* 집합건축물 — 전유/공용 혼재 + 주거 1호실 */
const STAR_TITLE = [
  aggTitle(),
  aggTitle({ dongNm: 'B동', mainPurpsCdNm: '교육연구시설', etcPurps: '교육연구시설', totArea: 984.24, grndFlrCnt: 3, hoCnt: 10 }),
  aggTitle({ dongNm: 'A,B지하동', etcPurps: '주차장,기계실', totArea: 2072.48, grndFlrCnt: 0, ugrndFlrCnt: 1, hoCnt: 0 }),
];
const STAR_EXPOS = [
  exposRow('A', 3, '303', '1', '의원', 166.06, '제1종근린생활시설(의원)'),
  exposRow('A', 3, '303', '2', '의원', 47.895, '주차장'),
  exposRow('A', 3, '303', '2', '의원', 14.855, '전체공용(기계실및전기실)'),
  exposRow('A', 1, '103', '1', '부동산중개사무소', 39.36, '제2종근린생활시설(부동산중개사무소)'),
  exposRow('A', 1, '110', '1', '휴게음식점', 42.19, '제2종근린생활시설(휴게음식점)'),
  exposRow('A', 1, '110', '2', '휴게음식점', 9.4, '동별공용(계단실및복도)'),
  exposRow('A', 5, '501', '1', '골프연습장', 554.11),
  exposRow('B', 3, '301', '1', '단독주택', 251.98),
  exposRow('B', 1, '101', '1', '소매점', 246.54),
];

await test('집합건축물은 전유부만 합산하고 공용면적·주거를 분리한다', async () => {
  const calls = stub((url) => url.includes('getBrTitleInfo') ? body(STAR_TITLE)
    : url.includes('getBrExposPubuseAreaInfo') ? body(STAR_EXPOS) : NODATA);
  const data = await (await worker.fetch(req(`/building?pnu=${STAR}`), env)).json();
  assert.equal(data.building.kind, 'aggregate');
  assert.equal(data.building.kindLabel, '집합건축물');
  assert.equal(data.building.hasExpos, true);
  assert.equal(data.building.name, '스타프라움');
  assert.ok(calls.some(c => c.includes('getBrExposPubuseAreaInfo')), '집합은 전유부를 부른다');
  assert.ok(!calls.some(c => c.includes('getBrFlrOulnInfo')), '집합은 층별개요를 부르지 않는다');
  assert.equal(data.shops.area, 1048.26, '전유 상가 166.06+39.36+42.19+554.11+246.54');
  assert.equal(data.shops.units, 6, '전유 호실 6개(공용 행은 세지 않는다)');
  assert.equal(data.shops.residentialArea, 251.98, '단독주택 전유는 주거로 분리');
  assert.equal(data.shops.otherArea, 0);
  assert.equal(data.shops.over2000, false);
  assert.equal(data.shops.exclusiveBasis, '전유면적(공용 제외)');
  assert.ok(/이내/.test(data.cap.verdict), data.cap.verdict);
});

await test('전유부가 100건을 넘으면 다음 페이지를 합산하고 잘리면 truncated 로 밝힌다', async () => {
  const pages = [];
  stub((url) => {
    if (url.includes('getBrTitleInfo')) return body([aggTitle()]);
    const p = Number(new URL(url).searchParams.get('pageNo'));
    pages.push(p);
    const rows = Array.from({ length: p === 1 ? 100 : 30 }, (_, i) => exposRow('A', 1, String(p * 1000 + i), '1', '소매점', 10));
    return body(rows, 130);
  });
  const data = await (await worker.fetch(req(`/building?pnu=${STAR}`), env)).json();
  assert.deepEqual(pages, [1, 2]);
  assert.equal(data.shops.units, 130);
  assert.equal(data.shops.area, 1300);
});

await test('전유부가 상한(6페이지)을 넘으면 조용히 자르지 않고 알린다', async () => {
  stub((url) => {
    if (url.includes('getBrTitleInfo')) return body([aggTitle()]);
    const p = Number(new URL(url).searchParams.get('pageNo'));
    return body(Array.from({ length: 100 }, (_, i) => exposRow('A', 1, `${p}-${i}`, '1', '소매점', 10)), 1200);
  });
  const data = await (await worker.fetch(req(`/building?pnu=${STAR}`), env)).json();
  assert.equal(data.shops.units, 600);
  assert.ok(data.notes.some(n => /까지만 조회되어/.test(n)), data.notes.join(' | '));
});

await test('대장이 없는 번지는 404 not_found 로 구분한다', async () => {
  stub(() => NODATA);
  const res = await worker.fetch(req(`/building?pnu=${MANPO}`), env);
  const data = await res.json();
  assert.equal(res.status, 404);
  assert.equal(data.status, 'not_found');
});

await test('PNU 형식·대지구분이 틀리면 400 coordinate', async () => {
  stub(() => NODATA);
  for (const bad of ['123', '41117107001041700004', '4111710700904170002', '41117107A0104170002']) {
    const res = await worker.fetch(req(`/building?pnu=${bad}`), env);
    assert.equal(res.status, 400, bad);
    assert.equal((await res.json()).status, 'coordinate');
  }
  assert.equal((await worker.fetch(req('/building'), env)).status, 400, 'PNU 누락');
});

await test('산(임야) PNU는 대지구분 2 → platGbCd 1 로 보낸다', async () => {
  const calls = stub(() => NODATA);
  await worker.fetch(req('/building?pnu=4111710700204170002'), env);
  assert.equal(new URL(calls[0]).searchParams.get('platGbCd'), '1');
});

await test('게이트웨이 XML 오류는 502 로 안전하게 매핑하고 키를 남기지 않는다', async () => {
  stub(() => GATEWAY);
  const res = await worker.fetch(req(`/building?pnu=${MANPO}`), env);
  const data = await res.json();
  assert.equal(res.status, 502);
  assert.equal(data.status, 'upstream');
  assert.ok(!JSON.stringify(data).includes('TEST_KEY_DECODING'));
});

await test('키가 없으면 503, Origin·메서드는 기존 라우트와 같은 규칙', async () => {
  stub(() => NODATA);
  const res = await worker.fetch(req(`/building?pnu=${MANPO}`), { ...env, SEMAS_API_KEY: '' });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).source, 'bldrgst');
  const noOrigin = await worker.fetch(req(`/building?pnu=${MANPO}`, ''), env);
  assert.equal(noOrigin.status, 403);
  const post = await worker.fetch(req(`/building?pnu=${MANPO}`, ORIGIN, 'POST'), env);
  assert.equal(post.status, 405);
  const pre = await worker.fetch(new Request('https://onnuri-zoning.example/building', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
  assert.equal(pre.status, 204);
});

/* ---------------- 프론트엔드 계약 ---------------- */
test('브라우저 설정에 건축물대장 엔드포인트가 있고 키는 없다', () => {
  assert.ok(config.includes('ONNURI_BUILDING_ENDPOINT'), '설정 누락');
  assert.ok(/workers\.dev\/building/.test(config));
  assert.ok(!config.includes('SEMAS_API_KEY') && !config.includes('serviceKey'));
});

test('점포를 고르면 건축물대장을 자동조회하고 PNU 로 부른다', () => {
  assert.ok(section('function t1Select(', 'function t1RenderEmpty').includes("BLD.auto(p)"), 't1Select 자동조회');
  const bld = section('const BLD = {', 'function bldStateText');
  assert.ok(bld.includes('ZONE_GIS.pnuOf('), 'PNU 재사용');
  assert.ok(bld.includes("url.searchParams.set('pnu', pnu)"), 'pnu 파라미터');
  assert.ok(bld.includes("LS.get('bld:' + pnu)") && bld.includes("LS.set('bld:' + pnu"), '요약 캐시');
  assert.ok(/expires/.test(bld), '캐시 만료');
  assert.ok(bld.includes("'notfound'") && bld.includes("'parcel'"), '오류 상태 구분');
});

test('점포 카드에 건축물대장 블록이 붙고 다시 조회할 수 있다', () => {
  const rv = section('function renderVerdict(', 'function t1CopySummary(');
  assert.ok(rv.includes('bldCardHTML(e)'), '카드 삽입');
  const card = section('function bldCardHTML(', 'function bldFacts(');
  assert.ok(card.includes('집합건축물') && card.includes('일반건축물 · 전유부 미등재'), '대장 구분 배지');
  assert.ok(card.includes("id=\"bld-refresh\""), '재조회 버튼');
  assert.ok(card.includes('2,000㎡ 초과') && card.includes('2,000㎡ 이내'), '상한 판정 칩');
  assert.ok(card.includes('cap-warn') && card.includes('구역을 2,000㎡ 이하로 줄이거나 분할'), '상한 초과 경고');
  assert.ok(card.includes('임대차계약서'), '일반건축물 실면적 확인 안내');
  assert.ok(card.includes('공용부 약 20% 차감'), '공용률 20% 참고치');
  assert.ok(card.includes('층별 내역'), '층별 내역');
  assert.ok(html.includes("closest('#bld-refresh')") && html.includes('BLD.auto(T1.ev.p, true)'), '다시 조회 동작');
});

test('직접 그리기 카드에 도면 면적 ≠ 건물 전 층 전용면적 합산 경고가 붙는다', () => {
  const poly = section('function renderPolyCard(', 'function polyCopy(');
  assert.ok(poly.includes('bldDrawHTML(e)'), '도면 카드 삽입');
  const draw = section('function bldDrawHTML(', '/* ================= 용도지역 혼합 면적');
  assert.ok(draw.includes('도면 지면 면적 ≠ 건물 전 층 점포 전용면적 합산'), '주의 배지');
  assert.ok(draw.includes('2,000㎡ 상한') && draw.includes('구역 축소·분할'), '상한 초과 안내');
  assert.ok(draw.includes('전용면적 합산'), '기준 설명');
});

test('직접 그리기 판정도 2,000㎡ 초과를 적합으로 내지 않는다', () => {
  const sim = section('function polySim(', 'function over2000For(');
  assert.ok(sim.includes('areaCapOf(eff)') && sim.includes("label = `2,000㎡ 상한 초과"), 'polySim 상한');
  assert.ok(sim.includes('cap,'), 'cap 반환');
  const card = section('function renderPolyCard(', 'function polyCopy(');
  assert.ok(card.includes('2,000㎡ 절대 상한 초과 — 구역 축소·분할 필요'), '도면 배너');
  const over = section('function over2000For(', '/* --- 지도 오버레이');
  assert.ok(over.includes('areaCapOf(eff)') && over.includes('capped'), 'over2000For 상한 정보');
});

test('검토 면적 프리셋은 5,000·10,000㎡를 구 기준 참고용으로 표시한다', () => {
  assert.ok(html.includes("a > AREA_CAP_M2 ? '구 기준 참고용 · 현행 2,000㎡ 상한 초과(지정 불가)'"), '프리셋 툴팁');
  const run = section('function t1Run() {', 'function t1Expected(');
  assert.ok(run.includes('areaCapOf(T1.area)') && run.includes('2,000㎡ 상한 초과(구 기준 참고용)'), '면적 설명');
  const home = section('function renderHome() {', 'function renderRecent(');
  assert.ok(home.includes('2,000㎡'), '홈 KPI 2,000㎡ 문구');
  assert.ok(section('function computeKPI() {', 'function updateNavKPI(').includes('CONFIG.DEFAULT_AREA'), 'KPI 기본 면적 유지');
});

test('A4 리포트에 건축물대장 요약과 2,000㎡ 상한·전용면적 합산 문구가 들어간다', () => {
  const rep = section('function buildReportHTML(', 'function reportText(');
  assert.ok(rep.includes('건축물대장(국토부)'), '리포트 행');
  assert.ok(rep.includes('2,000㎡ 절대 상한') && rep.includes('점포 전용면적 합산'), '면적 기준 문구');
  assert.ok(rep.includes('bf.over') || rep.includes("(bf.cap || {}).excess"), '상한 초과 표시');
  const txt = section('function reportText(', 'function openReport(');
  assert.ok(txt.includes('2,000㎡ 절대 상한') && txt.includes('건축물대장:'), '텍스트 리포트');
  assert.ok(html.includes('2,000㎡ 절대 상한</b>') || html.includes('2,000㎡ 절대 상한'), '본문 문구');
});

console.log(`TOTAL ${passed} building contract tests passed`);
