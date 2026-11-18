/* 공단 상가(상권)정보 프록시(/semas) + 직접 그리기 전수 추출 UI 계약 테스트
 *
 *  - Worker: 다각형 검증·페이지 합산·빈 결과·게이트웨이 오류 매핑·CORS
 *  - 프론트: SEMAS 엔드포인트 호출·전수 목록/CSV·폴백 문구
 *  - 실측 기준: 2026-11-18 storeListInPolygon 응답(JSON, type=json) 구조 그대로 사용
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';

const here = new URL('.', import.meta.url);
const worker = (await import(new URL('../zoning-proxy/worker.mjs', here).href)).default;
const html = fs.readFileSync(new URL('../index.html', here), 'utf8');
const config = fs.readFileSync(new URL('../zoning-config.js', here), 'utf8');
const wrangler = fs.readFileSync(new URL('../zoning-proxy/wrangler.toml', here), 'utf8');

let passed = 0;
function test(name, fn) { const r = fn(); if (r && typeof r.then === 'function') return r.then(() => { console.log('PASS ' + name); passed++; }); console.log('PASS ' + name); passed++; }
const section = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b); assert.ok(i >= 0 && j > i, `구간 없음: ${a}`); return html.slice(i, j); };

/* ---- 실제 응답과 같은 모양의 상가업소 1건 ---- */
const row = (i, over = {}) => ({
  bizesId: 'MA010120220804' + String(i).padStart(6, '0'), bizesNm: `테스트상가${i}`, brchNm: '망포점',
  indsLclsCd: 'G2', indsLclsNm: '소매', indsMclsCd: 'G204', indsMclsNm: '종합 소매',
  indsSclsCd: 'G20404', indsSclsNm: '슈퍼마켓', ksicCd: 'G47216', ksicNm: '빵류, 과자류 및 당류 소매업',
  ctprvnNm: '경기도', signguNm: '수원시 영통구', adongNm: '망포1동', ldongNm: '망포동',
  lnoAdr: '경기도 수원시 영통구 망포동 417-2', rdnmAdr: '경기도 수원시 영통구 영통로154번길 60',
  bldNm: '망포센트럴프라자', flrNo: '1', hoNo: '104호', lon: 127.0590558, lat: 37.2412906, ...over,
});
const okBody = (rows, total = rows.length, stdrYm = '202609') => ({
  header: { description: '소상공인시장진흥공단 다각형내 상가업소정보', stdrYm, resultCode: '00', resultMsg: 'NORMAL SERVICE' },
  body: { items: rows, numOfRows: 1000, pageNo: 1, totalCount: total },
});
const NODATA = { header: { resultCode: '03', resultMsg: 'NODATA_ERROR' }, body: {} };
const GATEWAY = '<?xml version="1.0" encoding="UTF-8"?><OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</errMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';

/* ---- upstream fetch 스텁 ---- */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const out = await handler(String(url), calls.length);
    if (typeof out === 'string') return new Response(out, { status: 200, headers: { 'content-type': 'text/xml' } });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}
const env = { SITE_ORIGINS: 'https://kayla0401.github.io', SEMAS_API_KEY: 'TEST_KEY_DECODING', VWORLD_API_KEY: '', VWORLD_DOMAIN: '' };
const ORIGIN = 'https://kayla0401.github.io';
function req(path, origin = ORIGIN) {
  return new Request('https://onnuri-zoning.example' + path, { headers: origin ? { Origin: origin } : {} });
}
const POLY = 'POLYGON((127.0585 37.2408,127.0598 37.2408,127.0598 37.2419,127.0585 37.2419,127.0585 37.2408))';

await test('/semas 는 다각형 안 상가를 정규화해 돌려주고 키는 응답에 남기지 않는다', async () => {
  const calls = stubFetch(() => okBody([row(1), row(2, { indsSclsNm: '유흥주점' })]));
  const res = await worker.fetch(req(`/semas?mode=polygon&key=${encodeURIComponent(POLY)}`), env);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.status, 'ok');
  assert.equal(data.source, 'semas');
  assert.equal(data.stdrYm, '202609');
  assert.equal(data.totalCount, 2);
  assert.equal(data.items.length, 2);
  assert.equal(data.truncated, false);
  assert.equal(data.items[0].bizesNm, '테스트상가1');
  assert.equal(data.items[0].flrNo, '1');
  assert.equal(data.items[0].hoNo, '104호');
  assert.equal(data.items[0].rdnmAdr, '경기도 수원시 영통구 영통로154번길 60');
  assert.ok(Math.abs(data.items[0].lon - 127.0590558) < 1e-9);
  assert.ok(calls[0].includes('storeListInPolygon'));
  assert.ok(calls[0].includes('type=json'));
  assert.ok(!JSON.stringify(data).includes('TEST_KEY_DECODING'), '키가 응답에 노출되면 안 된다');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

await test('1,000건 상한을 넘으면 다음 페이지를 합산하고 truncated 로 알린다', async () => {
  const pages = [];
  stubFetch((url) => {
    const p = Number(new URL(url).searchParams.get('pageNo'));
    pages.push(p);
    const start = (p - 1) * 1000;
    const rows = Array.from({ length: Math.max(0, Math.min(1000, 2500 - start)) }, (_, i) => row(start + i + 1));
    return okBody(rows, 2500);
  });
  const res = await worker.fetch(req(`/semas?mode=polygon&key=${encodeURIComponent(POLY)}&numOfRows=1000`), env);
  const data = await res.json();
  assert.deepEqual(pages, [1, 2, 3], '최대 3페이지까지 합산');
  assert.equal(data.returned, 2500);
  assert.equal(data.totalCount, 2500);
  assert.equal(data.truncated, false, '전체를 다 받았으면 truncated=false');
  assert.equal(new Set(data.items.map(x => x.bizesId)).size, 2500);
});

await test('3페이지로도 모자라면 truncated=true 로 잘림을 밝힌다', async () => {
  stubFetch(() => okBody(Array.from({ length: 1000 }, (_, i) => row(i + 1)), 12000));
  const res = await worker.fetch(req(`/semas?mode=polygon&key=${encodeURIComponent(POLY)}`), env);
  const data = await res.json();
  assert.equal(data.returned, 3000);
  assert.equal(data.totalCount, 12000);
  assert.equal(data.truncated, true);
});

await test('NODATA_ERROR(03)는 빈 구역으로 매핑한다', async () => {
  stubFetch(() => NODATA);
  const res = await worker.fetch(req(`/semas?mode=polygon&key=${encodeURIComponent(POLY)}`), env);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.status, 'empty');
  assert.deepEqual(data.items, []);
  assert.equal(data.totalCount, 0);
});

await test('게이트웨이 XML 오류는 502로 안전하게 매핑한다', async () => {
  stubFetch(() => GATEWAY);
  const res = await worker.fetch(req(`/semas?mode=polygon&key=${encodeURIComponent(POLY)}`), env);
  const data = await res.json();
  assert.equal(res.status, 502);
  assert.equal(data.status, 'upstream');
  assert.ok(!JSON.stringify(data).includes('TEST_KEY_DECODING'));
});

for (const [name, key] of [
  ['꼭짓점 2개', 'POLYGON((127.05 37.24,127.06 37.24))'],
  ['POLYGON 형식 아님', '127.05,37.24,127.06,37.24'],
  ['국내 범위 밖(경도)', 'POLYGON((120 37.24,127.06 37.24,127.06 37.25,120 37.24))'],
  ['국내 범위 밖(위도)', 'POLYGON((127.05 40,127.06 40,127.06 40.1,127.05 40))'],
  ['경계 상자 과대(도시 단위)', 'POLYGON((127.0 37.2,127.5 37.2,127.5 37.5,127.0 37.5,127.0 37.2))'],
  ['꼭짓점 100개 초과', 'POLYGON((' + Array.from({ length: 101 }, (_, i) => `127.0${String(i % 10)} 37.2${String(i % 10)}`).join(',') + '))'],
]) {
  await test(`좌표 검증 실패 → 400 (${name})`, async () => {
    const calls = stubFetch(() => okBody([row(1)]));
    const res = await worker.fetch(req(`/semas?mode=polygon&key=${encodeURIComponent(key)}`), env);
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.status, 'coordinate');
    assert.equal(calls.length, 0, '검증 실패 시 upstream 을 부르지 않는다');
  });
}

await test('숫자·공백 표기가 흔들려도 다각형을 읽는다(꼭짓점 3개)', async () => {
  stubFetch(() => okBody([row(1)]));
  const res = await worker.fetch(req('/semas?mode=polygon&key=' + encodeURIComponent('POLYGON (( 127.0585  37.2408 , 127.0598 37.2408 , 127.0598 37.2419 ))')), env);
  assert.equal(res.status, 200);
});

await test('허용 Origin 이 아니면 403, 키가 없으면 503', async () => {
  stubFetch(() => okBody([row(1)]));
  const denied = await worker.fetch(req(`/semas?mode=polygon&key=${encodeURIComponent(POLY)}`, 'https://evil.example'), env);
  assert.equal(denied.status, 403);
  const noKey = await worker.fetch(req(`/semas?mode=polygon&key=${encodeURIComponent(POLY)}`), { ...env, SEMAS_API_KEY: '' });
  assert.equal(noKey.status, 503);
  assert.equal((await noKey.json()).source, 'semas');
});

await test('반경 상권(mode=zones)은 반경 2,000m 를 넘으면 400', async () => {
  stubFetch(() => ({ header: { resultCode: '00' }, body: { items: [{ trarNo: '10108', mainTrarNm: '강남역9번 출구', trarArea: 103848 }] } }));
  const ok = await worker.fetch(req('/semas?mode=zones&cx=127.0276&cy=37.4979&radius=500'), env);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).zones[0].name, '강남역9번 출구');
  const bad = await worker.fetch(req('/semas?mode=zones&cx=127.0276&cy=37.4979&radius=2500'), env);
  assert.equal(bad.status, 400);
});

await test('기존 /zoning 동작은 그대로다(좌표 없음 400·경로 없음 404·프리플라이트 204)', async () => {
  const bad = await worker.fetch(req('/zoning?mode=point'), env);
  assert.equal(bad.status, 400);
  const nf = await worker.fetch(req('/nope'), env);
  assert.equal(nf.status, 404);
  const pre = await worker.fetch(new Request('https://onnuri-zoning.example/zoning', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

/* ── 프론트엔드 계약 ─────────────────────────────────────────────────── */

test('zoning-config 에 공단 상가 엔드포인트가 추가되고 기존 엔드포인트는 유지된다', () => {
  assert.ok(config.includes("window.ONNURI_SEMAS_ENDPOINT = 'https://onnuri-zoning.coolcoolso10.workers.dev/semas'"));
  assert.ok(config.includes("window.ONNURI_ZONING_ENDPOINT = 'https://onnuri-zoning.coolcoolso10.workers.dev/zoning'"));
  assert.ok(!config.includes('SEMAS_API_KEY') && !config.includes('serviceKey'), '브라우저 설정에 키가 없어야 한다');
});

await test('Worker CORS 허용 목록은 github.io 를 유지하고 wildcard 를 쓰지 않는다', async () => {
  const m = wrangler.match(/SITE_ORIGINS\s*=\s*"([^"]*)"/);
  assert.ok(m, 'SITE_ORIGINS 를 선언한다');
  const origins = m[1].split(',').map(s => s.trim()).filter(Boolean);
  assert.ok(origins.includes('https://kayla0401.github.io'), '기존 GitHub Pages Origin 유지');
  assert.ok(!m[1].includes('*'), 'wildcard 금지');

  /* 선언한 쉼표 목록을 워커가 그대로 읽어 두 주소 모두 허용하는지 확인한다 */
  const both = { ...env, SITE_ORIGINS: m[1] };
  for (const origin of origins) {
    const pre = await worker.fetch(new Request('https://onnuri-zoning.example/zoning', { method: 'OPTIONS', headers: { Origin: origin } }), both);
    assert.equal(pre.status, 204, `${origin} 프리플라이트`);
    assert.equal(pre.headers.get('Access-Control-Allow-Origin'), origin);
  }
  const other = await worker.fetch(new Request('https://onnuri-zoning.example/zoning', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), both);
  assert.equal(other.status, 403, '목록에 없는 Origin 은 거부');
});

test('직접 그리기에서 공단 DB 전수 조회를 호출한다(모드·POLYGON·페이지)', () => {
  const src = section('const SEMAS_DB_SRC', 'function semasOf(') + section('async function semasLoad', 'function semasSoon');
  assert.ok(src.includes("window.ONNURI_SEMAS_ENDPOINT"));
  assert.ok(/url\.searchParams\.set\('mode',\s*'polygon'\)/.test(src));
  assert.ok(src.includes("'key', ring") || src.includes("set('key', ring"));
  assert.ok(src.includes("set('numOfRows', '1000')"));
  assert.ok(src.includes('POLYGON(('), '닫힌 고리 WKT 를 만든다');
  assert.ok(src.includes('truncated'));
  assert.ok(src.includes("status: 'error'"), '장애 상태를 남긴다');
});

test('다각형 완성·꼭짓점 이동 뒤 공단 조회가 따라간다', () => {
  const finish = section('function polyFinish()', 'function polyRedraw()');
  assert.ok(finish.includes('semasLoad('), '그리기 완료 시 조회');
  const edit = section('function polyAfterEdit()', '/* --- 그리기 조작 --- */');
  assert.ok(edit.includes('semasSoon('), '꼭짓점 이동 시 디바운스 재조회');
});

test('카드가 공단 DB 전수·소상공인 참고·카카오 비교를 한눈에 보여준다', () => {
  const card = section('function renderPolyCard()', 'function polyCopy()');
  assert.ok(card.includes('공단 상가 DB 전수'), '공단 전수 블록');
  assert.ok(card.includes('sim.semStats') && card.includes('semChip'), '공단 상태를 읽어 칩으로 보여준다');
  assert.ok(card.includes('소상공인 성격(참고)'), '소상공인 참고 표기');
  assert.ok(card.includes('카카오 도면 내'), '카카오 비교');
  assert.ok(card.includes('semas-retry'), '실패 시 재조회 버튼');
  assert.ok(card.includes('공단 DB 조회 실패'), '장애 안내 문구');
  assert.ok(card.includes('카카오 실시간 기준으로 표시'), '폴백 안내');
});

test('구역 내 상가 목록이 공단 DB(상호·지점·업종·층/호·주소)를 보여준다', () => {
  const list = section('function semasRowHTML', 'function polyCopy()');
  for (const h of ['상호', '업종', '층/호', '주소', '참고']) assert.ok(list.includes(`<th>${h}</th>`), h);
  assert.ok(list.includes('x.brchNm') && list.includes('x.flrNo') && list.includes('x.hoNo'));
  assert.ok(list.includes('x.rdnmAdr') && list.includes('x.lnoAdr'));
  assert.ok(list.includes('indsSclsNm'));
});

test('CSV 는 공단 DB와 카카오를 출처로 나눠 담고 UTF-8 BOM 을 쓴다', () => {
  const csv = section('function polyCSV()', 'function renderMap1(');
  assert.ok(csv.includes("'출처'") || csv.includes('출처'), '출처 열');
  assert.ok(csv.includes('SEMAS_DB_SRC') && csv.includes('카카오 실시간'));
  assert.ok(csv.includes("['층', x => x.flrNo]") && csv.includes("['호', x => x.hoNo]"));
  assert.ok(csv.includes('rdnmAdr') && csv.includes('lnoAdr'));
  assert.ok(csv.includes('bizesId'));
  assert.ok(/new Blob\(\['\uFEFF' \+ csv\]/.test(html), 'downloadCSV BOM');
});

test('지도에 공단 DB 점포를 카카오 점과 구분해 표시한다', () => {
  assert.ok(html.includes('semas-square') || html.includes("t: 'sq'"), '구분되는 마커');
  const marks = section('function polySemasMarks', 'function polyDotList');
  assert.ok(marks.includes("KMap.sq") && marks.includes('APP.semasOv'));
  assert.ok(html.includes('id="lg-semas"') && html.includes('공단 상가 DB'));
});

test('카카오 45건 표본 문구는 공단 전수와 함께 설명된다', () => {
  const card = section('function renderPolyCard()', 'function polyCopy()');
  assert.ok(card.includes('45건'), '카카오 표본 한계');
  assert.ok(card.includes('전수'), '공단 DB 전수');
});

console.log(`TOTAL ${passed} semas contract tests passed`);

/* 건축물대장(/building) 프록시·2,000㎡ 상한 UI 계약 — 같은 CI 단계에서 실행한다 */
await import('./test_building_contract.mjs');
