import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const rules = JSON.parse(fs.readFileSync(new URL('../data/city_rules.json', import.meta.url), 'utf8'));
let passed=0;
function test(name, fn) { fn(); console.log('PASS '+name); passed++; }
const core=html.split('/* @legal-core:start */')[1].split('/* @legal-core:end */')[0];
const {headlineVerdict,HEADLINE_STATUS}=new Function(core+';return {headlineVerdict,HEADLINE_STATUS};')();
test('public verdict vocabulary is exactly three states',()=>assert.deepEqual([...new Set(Object.values(HEADLINE_STATUS).map(x=>x.title))].sort(),['부적합','적합','조건부']));
for (const [name,args,expected] of [
 ['five shops',{population:5,minShops:0,maxShops:5,reqCom:25,reqNon:20,policy:'UNKNOWN'},'부적합'],
 ['missing data',{population:null,reqCom:25},'조건부'],
 ['verified sufficient',{population:35,minShops:35,maxShops:35,reqCom:25,policy:'NONE'},'적합'],
 ['conflict',{population:35,minShops:35,maxShops:35,reqCom:25,policy:'NONE',conflict:true},'조건부']
]) test(name,()=>assert.equal(headlineVerdict(args).title,expected));
test('candidate filters and CSV use shared verdict',()=>{
 const t=html.slice(html.indexOf('function t3Init()'),html.indexOf('const VIEWS'));
 assert.ok(t.includes('verdict: assessmentOf(e)'));assert.ok(t.includes("r => r.verdict.title"));assert.ok(!t.includes('r.e.v'));assert.ok(!t.includes('badge(e.v)'));
});
// Execute real async production function with controlled callback arrival order.
const source=html.slice(html.indexOf('let liveRequestSequence'),html.indexOf('function noteBox'));
const callbacks=[],renders=[];
const a={p:{id:'A'},pos:{lat:37,lng:127},r:25}, b={p:{id:'B'},pos:{lat:38,lng:128},r:25};
const ctx={APP:{},T1:{ev:a,poly:{on:false,pts:[]}},T3:{dirty:false},KMap:{ready:true},KAKAO_GROUPS:[['CS2','편의점']],posOf:p=>p,renderShops:e=>renders.push(e.p.id),renderMap1:()=>{},renderVerdict:()=>{},renderPolyCard:()=>{},syncDrawBar:()=>{},toast:()=>{},kakao:{maps:{LatLng:function(){},services:{Places:function(){this.categorySearch=(c,fn)=>callbacks.push(fn)},Status:{OK:'OK'},SortBy:{DISTANCE:1}}}}};
vm.createContext(ctx);vm.runInContext(source,ctx);
const first=ctx.t1Live(a);ctx.T1.ev=b;const second=ctx.t1Live(b);
callbacks[1]([{id:'b',place_name:'B shop',x:'128',y:'38'}],'OK');await second;
const renderCount=renders.length;
callbacks[0]([{id:'a',place_name:'A shop',x:'127',y:'37'}],'OK');await first;
test('late A response cannot overwrite B',()=>{assert.equal(ctx.APP.live.key,'B');assert.equal(ctx.APP.live.places[0].name,'B shop');assert.equal(renders.length,renderCount)});
// Same store, changed area produces a different evaluation object.
ctx.T1.ev=b;const pending=ctx.t1Live(b);ctx.T1.ev={...b,r:40};callbacks[2]([],'OK');await pending;
test('old area response is ignored',()=>assert.equal(ctx.APP.live.state,'loading'));
for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))if(m[1].trim())new Function(m[1]);
console.log(`${passed} contract/async tests passed; inline syntax OK`);
const raw=JSON.parse(fs.readFileSync(new URL('../data/stores.json',import.meta.url),'utf8'));
const stores=raw.stores.map(row=>Object.fromEntries(raw.cols.map((col,i)=>[col,row[i]])));
test('18k store dataset IDs, coordinates and count integrity',()=>{
 const ids=new Set(); for(const s of stores){assert.ok(s.code&&!ids.has(s.code));ids.add(s.code);assert.ok(Number.isFinite(s.lat)&&Math.abs(s.lat)<=90&&Number.isFinite(s.lng)&&Math.abs(s.lng)<=180);for(const area of [2000,5000,10000]){assert.ok(Number.isInteger(s['n'+area])&&s['n'+area]>=0);assert.ok(Number.isInteger(s['s'+area])&&s['s'+area]>=0&&s['s'+area]<=s['n'+area]);}}
});
const countFn=new Function(html.slice(html.indexOf('function countsFor('),html.indexOf('/** 핵심 판정 함수'))+';return countsFor;')();
test('missing, negative and invalid counts never become zero or pass',()=>{
 const p={cov:true,n2000:5,s2000:5,n5000:8,s5000:8,n10000:12,s10000:12};
 assert.equal(countFn({...p,s2000:null},2000),null);assert.equal(countFn({...p,n2000:-1},2000),null);assert.equal(countFn({...p,s2000:6},2000),null);assert.equal(countFn(p,NaN),null);assert.equal(countFn(p,2000).small,5);
});
console.log(`TOTAL ${passed} tests passed, ${stores.length} stores audited`);
// Delayed address lookup must not replace a newer search or explicit selection.
const searchCallbacks=[];
const searchInput={value:'A',focus(){}};
const sc={T1:{},$:()=>searchInput,KMap:{ready:true,geocode:()=>new Promise(resolve=>searchCallbacks.push(resolve))},t1Match:q=>[{id:q,name:q}],normSido:x=>x,toast(){},resetPolyState(){},t1HideAC(){},t1Run(){},pushHistory(){},ZONE_GIS:{auto(){}},t1RenderAC(){}};
vm.createContext(sc);
vm.runInContext(html.slice(html.indexOf('let searchRequestSequence'),html.indexOf('function t1RenderEmpty()')),sc);
const searchA=sc.t1Analyze();searchInput.value='B';const searchB=sc.t1Analyze();
searchCallbacks[1]([]);await searchB;searchCallbacks[0]([]);await searchA;
test('late search A cannot replace selected B',()=>assert.equal(sc.T1.sel.id,'B'));
searchInput.value='A';const oldSearch=sc.t1Analyze();sc.t1Select({id:'C',name:'C'});searchCallbacks[2]([]);await oldSearch;
test('explicit selection invalidates pending address search',()=>assert.equal(sc.T1.sel.id,'C'));
searchInput.value='D';const editedSearch=sc.t1Analyze();searchInput.value='E';searchCallbacks[3]([]);await editedSearch;
test('editing query invalidates pending result',()=>assert.equal(sc.T1.sel.id,'C'));
test('report does not claim building-wide deduplication or official surveying',()=>{
 for(const phrase of ['같은 건물 여러 호실은 1개 점포로 합산','공무원 실측과 가장 가까운','직접 그린 도면 실측','조례·시행규칙 일치 확인','<div class="k">최종 판정</div>']) assert.ok(!html.includes(phrase),phrase);
});
// 상단 KPI 가 탭 3과 같은 판정 함수를 쓰고, 그 판정 입력이 탭 1(evaluate)과 점포 전수에서 같은지.
const section=(a,b)=>{const i=html.indexOf(a),j=html.indexOf(b);assert.ok(i>=0&&j>i,`구간 없음: ${a}`);return html.slice(i,j);};
const NAT_RULE={base_area:2000,min_shops:30,min_shops_non_commercial:null};
const judge=new Function('DB','CONFIG','NAT_RULE','ruleMatch','posOf','pinOf','dist','inZone','josa','fmt',
 section('function requiredShopsFor(','/* 항목별 상한')+';return {ev,evKPI};')(
 {zones:[],meta:{sido_covered:[]}},{COND_RATIO:.85,MEMBER_NEAR_M:300,DEFAULT_AREA:2000},NAT_RULE,
 (sido,sigungu)=>({rule:rules.find(r=>r.sido===sido&&r.sigungu===sigungu)||null,legacy:null}),
 p=>p,()=>null,()=>9999,()=>false,(s,a)=>a,n=>String(n));
test('KPI 경량 평가가 evaluate()와 같은 판정 입력을 낸다(전 점포)',()=>{
 const bad=stores.filter(s=>{const a=judge.ev(s,2000),b=judge.evKPI(s,2000);
  return !(a.rule===b.rule&&a.thCom===b.thCom&&a.thNon===b.thNon&&a.reqCom===b.reqCom&&a.reqNon===b.reqNon&&a.required===b.required&&a.nSmall===b.nSmall&&(a.counts==null)===(b.counts==null));});
 assert.equal(bad.length,0,bad.slice(0,3).map(s=>s.name).join(', '));
});
test('상단 KPI 는 탭 3과 같은 assessmentOf 로 집계한다',()=>{
 const kpi=section('function computeKPI() {','function updateNavKPI(');
 assert.ok(kpi.includes('assessmentOf(')&&kpi.includes('evKPI('));
 assert.ok(!/per\s*>=\s*th/.test(kpi)&&!kpi.includes('CONFIG.COND_RATIO'));
 assert.ok(section('function loadNearby(','function nearbyState(').includes('nearbyKPIChanged()'));
});
const xc=new Function(section('const XC_NONSHOP','function xcCompute(')+';return xcPairScore;')();
for(const [a,b,want] of [
 ['대전피자스쿨','피자스쿨 대전노은역점',true], ['꿈닮리드인독서논술학원','꿈닮리드인 대전',true],
 ['맘스터치','가마치통닭',false], ['서울굿모닝내과의원','서울굿모닝치과',false],
 ['양재성모안과의원','양재성모정형외과',false], ['태미안의원','태미안치과의원',false],
 ['맑은아침공인중개사','맑은아침세탁소',false], ['중앙학원','중앙의원',false],
 ['GS25대전성남점','GS25대전미라클점',false], ['GS25고양본점','GS25평택어울림점',false], ['부산세공사','서울세공사',false]
]) test(`교차 검증 ${want?'매칭':'비매칭'}: ${a} ↔ ${b}`,()=>assert.equal(xc(a,b)>=.6,want,`점수 ${xc(a,b).toFixed(2)}`));
test('상가 상세목록 로딩 중에는 표본 없음으로 단정하지 않는다',()=>{
 assert.ok(section('function bizStatsOf(','/* ---- 4c. 교차 검증').includes('out.loading = !items && e.p.cov'));
 const axis=section('function legalAxisHTML(','/* 박스 이름은 호출부 호환을 위해 유지한다 */');
 assert.ok(axis.includes('상가 상세목록 불러오는 중…')&&axis.includes('bs.loading ?')&&axis.includes("상가 상세목록 확인 중"));
 assert.ok(html.includes('위 C구역 리스트')&&!html.includes('아래 C구역 리스트'));
});

/* ── 짧은 상호(2~3글자) + 지점명 매칭 — '소담 ↔ 소담 교대점' ───────────────── */
const xcApi = new Function(section('const XC_NONSHOP', 'function xcCompute(') + ';return {xcPairScore,xcShortCore,xcShortSpan,xcMatch};')();
for (const [a, b, want, note] of [
  ['소담', '소담 교대점', true, '감사에서 미확인+신규 후보로 동시 출현한 실제 사례'],
  ['놀숲', '놀숲 교대점', true, '실제 사례'],
  ['소담교대점', '소담', true, '방향이 반대여도 같은 매장'],
  ['중앙', '중앙식당', false, '업종어가 붙은 다른 가게(지점 표기 없음)'],
  ['중앙', '중앙학원', false, '업종어가 붙은 다른 가게'],
  ['소담', '소담집', false, '지점(…점) 표기가 없는 다른 가게'],
  ['중앙', '중앙점', false, '지점명이 비어 있는 경우'],
  ['한솔', '한솔약국', false, '2글자 + 업종어(지점 표기 없음)'],
  ['새봄', '새봄분식', false, '2글자 + 업종어']
]) {
  const sc = xcApi.xcPairScore(a, b);
  test(`짧은 상호 ${want ? '매칭' : '비매칭'}: ${a} ↔ ${b} (${note})`, () => assert.equal(sc >= .6, want, `점수 ${sc.toFixed(2)}`));
}
test('짧은 상호 매칭의 거리 한도는 2글자 15m · 3글자 30m', () => {
  assert.equal(xcApi.xcShortSpan('소담', '소담 교대점'), 15);
  assert.equal(xcApi.xcShortSpan('소담집', '소담집 역점'), 30);   // 3글자 상호 + 지점명 → 30m
  assert.equal(xcApi.xcShortSpan('소담', '소담'), 0);           // 완전 동일은 다른 규칙
});
test('2글자 상호는 중심 거리 15m를 넘으면 붙이지 않는다', () => {
  const rows = [{ s: { id: 'r1', name: '소담' }, d: 10 }];
  const near = xcApi.xcMatch(rows, [{ id: 'p1', name: '소담 교대점', d: 20 }]);
  const far = xcApi.xcMatch(rows, [{ id: 'p2', name: '소담 교대점', d: 45 }]);
  assert.equal(near.matched.length, 1);
  assert.equal(far.matched.length, 0);
});
test('같은 점포가 미확인과 신규 후보에 동시에 나오지 않는다', () => {
  const rows = [{ s: { id: 'r1', name: '소담' }, d: 12 }, { s: { id: 'r2', name: '다른집' }, d: 30 }];
  const places = [{ id: 'p1', name: '소담 교대점', d: 14 }, { id: 'p2', name: '다른집', d: 31 }];
  const m = xcApi.xcMatch(rows, places);
  assert.equal(m.matched.length, 2);
  assert.equal(m.byPlace.size, 2);
});

/* ── 카카오 45건 상한 — 3페이지 + 격자 분할 조회 ─────────────────────────── */
test('카카오 45건 상한 대응이 코드에 있다(3페이지·분할 조회·표시)', () => {
  const live = section('let liveRequestSequence', 'function noteBox');
  assert.ok(live.includes('KAKAO_MAX_PAGES') && live.includes('KAKAO_SWEEP_DIRS'));
  assert.ok(live.includes('pagination.hasNextPage') && live.includes('pagination.nextPage()'));
  assert.ok(/sweep\s*=\s*\{/.test(live) && live.includes('truncated'));
  const sum = section('function xcSummaryHTML', 'function liveBlock');
  assert.ok(sum.includes('45건 상한') && sum.includes('sweep.added'));
});

/* ── 이미 지정 구역 내 점포는 '신규 후보'에서 뺀다 ─────────────────────────── */
test('상단 KPI·탭3 가 이미 지정 구역 내 점포를 후보에서 제외한다', () => {
  const kpi = section('function computeKPI() {', 'function updateNavKPI(');
  assert.ok(kpi.includes('e.inside') && kpi.includes('inZone'), 'KPI 제외');
  assert.ok(section('function evaluateKPI(', '/* 항목별 상한').includes('zonesNear(pos, 1500)'), '경량 평가도 구역 판정');
  const t3 = section('function t3Render()', '/* #####################################################################\n   11. DATA IMPORT');
  assert.ok(t3.includes('r.e.inside && r.e.inside.length'), '탭3 제외');
  assert.ok(t3.includes('이미 지정 구역 내'), '제외 수 표시');
});

/* ── 쉬운 말 요약 · 지금 내가 할 일 ──────────────────────────────────────── */
const EASY_S = '/* @easy-core:start */', EASY_E = '/* @easy-core:end */';
const easyCore = html.slice(html.indexOf(EASY_S) + EASY_S.length, html.indexOf(EASY_E));
const stubRule = rules.find(r => r.sido === '경기' && r.sigungu === '수원시');
const easyStore = stores.find(s => s.sido === '경기' && s.cov && !s.onnuri_member);
const easyEv = {
  p: { ...easyStore, kind: 'store', member: {} }, pos: { lat: easyStore.lat, lng: easyStore.lng },
  rule: stubRule, area: 2000, r: 25.23, base: 2000, th: 25, thCom: 25, thNon: 20, reqCom: 25, reqNon: 20, required: 25,
  counts: { all: 24, small: 20, est: false }, nSmall: 20, nAll: 24, per: 20, ratio: 0.8,
  inside: [], overlapping: [], nearest: { z: { name: '테스트 골목형상점가', lat: easyStore.lat + 0.002, lng: easyStore.lng, radius: 150, type: '골목형상점가' }, d: 220, edge: 70, inside: false },
  v: 'cond', label: '조건부 — 비상업 기준 충족',
};
let easyOut = '';
function easyBuild(over) {
  const st = {
    headlineOf: () => ({ level: (over && over.level) || 'COND', title: '조건부', cls: 'cond', emoji: '🟡', sub: '집계 20개 / 최소 20~25개' }),
    bizStatsOf: () => ({ ok: true, src: 'nearby', n: 24, nEx: 3, nChk: 1, nNonSmall: 0, exTop: [], chkTop: [], population: 20, truncated: false, assess: {} }),
    xcCompute: () => (over && over.xc === null ? null : { both: [1, 2, 3], dups: [], suspect: [{}, {}], fresh: [{}], rowTotal: 24, inR: 5, capped: ['음식점'], sweep: { calls: 4, added: 2 } }),
    ssOf: () => ({ stage: 0 }), zoneRel: () => ['인접', 'z', '테스트 골목형상점가'],
    ZONE_GIS: { get: () => ({ status: 'ok', kind: 'commercial', names: ['제2종일반주거지역'] }) },
    DB: { zones: [{ name: '테스트 골목형상점가', lat: easyEv.pos.lat + 0.002, lng: easyEv.pos.lng, radius: 150, type: '골목형상점가' }] },
    dist: () => 220, posOf: p => ({ lat: p.lat, lng: p.lng }),
    kakaoRvLink: p => 'RV:' + p.lat + ',' + p.lng, naverMapLink: q => 'NV:' + encodeURIComponent(q),
    densityPolicyOf: () => 'UNKNOWN', ruleMatch: () => ({ rule: null, legacy: null }), daysSince: () => 30,
    UI: { STALE_DAYS: 90 },
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    fmt: n => Number(n).toLocaleString('ko-KR'), fmtD: m => Math.round(m) + 'm', fmtDate: () => '2026.11.17',
    findRule: () => null, pinOf: () => null, NAT_RULE: { ordinance: '법정 기본' },
  };
  const fn = new Function('headlineOf', 'bizStatsOf', 'xcCompute', 'ssOf', 'zoneRel', 'ZONE_GIS', 'DB', 'dist', 'posOf', 'kakaoRvLink', 'naverMapLink', 'densityPolicyOf', 'ruleMatch', 'daysSince', 'UI', 'esc', 'fmt', 'fmtD', 'fmtDate', 'findRule', 'pinOf', 'NAT_RULE',
    easyCore + ';return {easySummaryHTML,easyMapSVG,easyTodo,easyWhy};');
  return fn(st.headlineOf, st.bizStatsOf, st.xcCompute, st.ssOf, st.zoneRel, st.ZONE_GIS, st.DB, st.dist, st.posOf, st.kakaoRvLink, st.naverMapLink, st.densityPolicyOf, st.ruleMatch, st.daysSince, st.UI, st.esc, st.fmt, st.fmtD, st.fmtDate, st.findRule, st.pinOf, st.NAT_RULE);
}
test('쉬운 말 요약이 점포명·주소·판정 이유·할 일 3단계를 담는다', () => {
  const api = easyBuild();
  easyOut = api.easySummaryHTML(easyEv);
  assert.ok(easyOut.includes(easyStore.name), '점포명');
  assert.ok(easyOut.includes(easyStore.address), '주소');
  assert.ok(easyOut.includes('지금 내가 할 일'), '할 일 제목');
  assert.ok(easyOut.includes('전화해서 물어보기') && easyOut.includes('현장에서 눈으로 확인') && easyOut.includes('점주·점포 확인'), '3단계');
  assert.ok(easyOut.includes(stubRule.phone), '관할 부서 전화번호');
  assert.ok(/제외되는 업종/.test(easyOut), '조례 상태에 맞춘 동적 질문');
  assert.ok(/사업자등록번호 가운데 2자리/.test(easyOut) && /30억/.test(easyOut) && /상인회/.test(easyOut), '점주 확인 항목');
  assert.ok(/가게.*20곳|20곳.*잡혔어요/.test(easyOut), '주변 상가 수');
  assert.ok(/상업지역 기준 25곳은 5곳 모자라요/.test(easyOut), '왜 조건부인지 쉬운 설명');
});
test('쉬운 말 요약에 위치 스케치·지도/로드뷰 링크가 들어간다', () => {
  assert.ok(/<svg[^>]*viewBox="0 0 360 200"/.test(easyOut), 'SVG 스케치');
  assert.ok(easyOut.includes('카카오맵에서 보기') && easyOut.includes('로드뷰'), '지도·로드뷰 링크');
  assert.ok(easyOut.includes('RV:'), '로드뷰 링크 함수 결과가 리포트에 들어간다');
  assert.ok(html.includes('https://map.kakao.com/link/roadview/') && html.includes('https://map.kakao.com/link/map/'), '카카오 지도·로드뷰 URL 형식');
});
test('쉬운 말 요약은 판정을 새로 만들지 않고 같은 판정을 인용한다', () => {
  const api = easyBuild();
  for (const lvl of ['PASS', 'FAIL', 'NO_DATA', 'BASIS', 'MEMBER', 'COND_LEGAL']) {
    const out = api.easySummaryHTML(easyEv);
    assert.ok(out.includes('지금 내가 할 일'), lvl);
  }
  assert.ok(easyOut.includes('쉬운 말이라고 해서 기준을 낮추거나 결론을 바꾸지 않습니다'));
  assert.ok(!/법적으로 확정|적합 판정을 내립니다/.test(easyOut));
});
test('쉬운 말은 화면 카드와 A4 리포트 0번 섹션에 함께 들어간다', () => {
  const rv = section('function renderVerdict(', 'function t1CopySummary(');
  assert.ok(rv.includes('easySummaryHTML(e)'), '화면 카드');
  const rep = section('function buildReportHTML(', 'function reportText(');
  assert.ok(rep.includes("easySummaryHTML(e, 'sheet')") && rep.includes('쉬운 말 요약'), '리포트 섹션');
  assert.ok(rep.indexOf('쉬운 말 요약') < rep.indexOf('1. 기본 현황'), '리포트 맨 앞');
});

/* ── 구역 DB 보강 — 가맹점 좌표 추정 구역 ────────────────────────────────── */
const zones = JSON.parse(fs.readFileSync(new URL('../data/zones.json', import.meta.url), 'utf8'));
const zMeta = JSON.parse(fs.readFileSync(new URL('../data/meta.json', import.meta.url), 'utf8'));
test('구역 DB 가 264곳에서 보강되어 700곳을 넘는다', () => {
  assert.ok(zones.length >= 700, String(zones.length));
  assert.equal(zMeta.zones, zones.length);
});
test('추정 구역은 추정임을 데이터로 표시한다', () => {
  const est = zones.filter(z => z.geo === 'est-member');
  assert.ok(est.length >= 400, String(est.length));
  for (const z of est) {
    assert.equal(z.radius_est, true, z.name);
    assert.ok(z.est && z.est.anchors >= 1, z.name);
    assert.ok(['high', 'mid', 'low'].includes(z.est.confidence), z.name);
    assert.ok(z.source && /가맹점/.test(z.source), z.name);
  }
});
test('구역 id·이름 중복 없이 전국 좌표 범위 안에 있다', () => {
  assert.equal(new Set(zones.map(z => z.id)).size, zones.length);
  for (const z of zones) {
    assert.ok(z.lat >= 33 && z.lat <= 39.5 && z.lng >= 124 && z.lng <= 132, z.name);
    assert.ok(z.radius >= 50 && z.radius <= 600, z.name);
  }
});
test('추정 구역의 판정·화면 문구가 추정임을 밝힌다', () => {
  assert.ok(section('function evaluate(', '/* ---- 평가 캐시').includes("geo === 'est-member'"));
  assert.ok(section('function headlineOf(', 'function assessmentOf(').includes("est: e.inside[0].z.geo === 'est-member'"));
  assert.ok(html.includes('위치 정확도') && html.includes("z.geo === 'est-member'"), '구역 상세의 위치 정확도 표시');
});
test('반경 25m 원 과소집계 완화 — 경계 밖 점포와 도면 안내', () => {
  assert.ok(html.includes('function nearbyEdgeStats(') && html.includes('nearbyEdgeStats(e)'));
  const hint = section('function circleHintHTML', 'function storeTypeRuleHTML');
  assert.ok(hint.includes('과소집계') && hint.includes('구역 직접 그리기') && hint.includes('justOut'));
  assert.ok(hint.includes('반경 경계 5m 바로 밖'));
});

console.log(`FINAL ${passed} contract/async tests passed`);
