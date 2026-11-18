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

/* ── 망포센트럴점 라이브 검증에서 확인된 7개 실제 사례 — 영문 음차·업종 꼬리말·과목 수식어 ───── */
const xcGrp = new Function(section('const XC_NONSHOP', 'function xcCompute(') + '\n' + section('const KW_MAX_TARGETS', 'async function xcKeywordPass') + ';return {xcPairScore,xcNorm,xcNormKo,xcBizGroup,xcGroupStub,xcGroupScore,xcGroupSpan,xcKeywordTerms};')();
for (const [a, b, note] of [
  ['아가페미용실', '아가페헤어샵', '미용 계열 꼬리말 차이'],
  ['수원바디온필라테스', '수원 바디온필라테스 망포점', '지점명·띄어쓰기'],
  ['에이앤아이영어교습소', 'A&I영어교습소', '한글↔영문 이니셜'],
  ['이알씨영어독서클럽수원망포대선초점영어교습소', 'ERC영어독서클럽 수원망포대선초점', '한글↔영문 이니셜 + 긴 지점명'],
  ['망포플레이팩토창의수학교습소', '플레이팩토 창의수학놀이터', '앞 지명 + 뒤 수식어 차이'],
  ['뮤엠영어망포영어교습소', '뮤엠영어폴리오국어논술 망포학원', '과목 수식어 차이'],
  ['이투스수학신영통학원', '이투스영수학원', '과목·동네명 차이'],
]) {
  const sc = xcGrp.xcPairScore(a, b);
  test(`교차검증 강화 매칭: ${a} ↔ ${b} (${note})`, () => assert.ok(sc >= .6, `점수 ${sc.toFixed(2)}`));
}
test('영문 표기를 한글 발음으로 읽어 같은 상호로 본다', () => {
  assert.equal(xcGrp.xcNormKo('A&I영어교습소'), xcGrp.xcNormKo('에이앤아이영어교습소'));
  assert.equal(xcGrp.xcNormKo('ERC영어독서클럽'), xcGrp.xcNormKo('이알씨영어독서클럽'));
  assert.notEqual(xcGrp.xcNormKo('GS25고양본점'), xcGrp.xcNormKo('GS25대전성남점'));
  /* 영문 음차가 우연히 겹치는 짧은 브랜드는 붙이지 않는다(라이브 데이터에서 나온 실제 오탐 사례) */
  assert.ok(xcGrp.xcPairScore('광교SK뷰공인중개사사무소', '에스케이뷰') < .6);
  assert.ok(xcGrp.xcPairScore('BBMC헬스클럽', 'BBMS헬스클럽') < .6);
  assert.ok(xcGrp.xcPairScore('광교라온수학학원', '광교라온스터디카페') < .6);
});
test('업종 꼬리말 계열은 다르게 둔다(내과↔치과·부동산↔세탁소 가드 유지)', () => {
  assert.equal(xcGrp.xcBizGroup('굿모닝내과의원'), null);
  assert.equal(xcGrp.xcBizGroup('굿모닝치과'), null);
  assert.notEqual(xcGrp.xcBizGroup('아가페미용실'), xcGrp.xcBizGroup('맑은아침세탁소'));
  for (const [a, b] of [['굿모닝내과의원', '굿모닝치과'], ['서울굿모닝내과의원', '서울굿모닝치과'],
    ['맑은아침공인중개사', '맑은아침세탁소'], ['중앙학원', '중앙의원'], ['중앙영어학원', '중앙수학학원'],
    ['한솔수학학원', '한솔영어학원'], ['중앙', '중앙식당'], ['중앙', '중앙학원']]) {
    assert.ok(xcGrp.xcPairScore(a, b) < .6, `${a} ↔ ${b}`);
  }
});
test('계열 매칭은 같은 건물 안 오매칭을 막기 위해 거리를 좀게 건다', () => {
  assert.equal(xcGrp.xcGroupSpan('아가페미용실', '아가페헤어샵'), 20);
  assert.equal(xcGrp.xcGroupSpan('이투스수학신영통학원', '이투스영수학원'), 25);
  assert.equal(xcGrp.xcGroupSpan('굿모닝내과의원', '굿모닝치과'), 0);
});
test('키워드 검색어는 원 상호 → 업종 꼬리를 뗸 핵심 상호 순서로 만든다', () => {
  assert.deepEqual(xcGrp.xcKeywordTerms('아가페미용실'), ['아가페미용실', '아가페']);
  const t = xcGrp.xcKeywordTerms('뮤엠영어망포영어교습소');
  assert.equal(t[0], '뮤엠영어망포영어교습소');
  assert.equal(t[1], '뮤엠영어망포영어');
  assert.equal(xcGrp.xcKeywordTerms('중').length, 0, '1글자 검색은 하지 않는다');
  assert.ok(xcGrp.xcKeywordTerms('아가페미용실').length <= 2, '점포당 최대 2회');
});
test('폐업 의심 단정 라벨을 카카오 미확인으로 바꿨다', () => {
  const sum = section('function xcSummaryHTML', 'function liveBlock');
  assert.ok(sum.includes('카카오 미확인') && sum.includes('kw.added'));
  assert.ok(!/>폐업 의심/.test(html), '칩·표에 폐업 의심 단정 라벨이 남아 있으면 안 된다');
  assert.ok(!html.includes('폐업 의심 제외') && !html.includes('폐업·미확인 의심'));
});
/* 2차 상호 키워드 재조회 — 업종 코드 밖 점포를 상호로 다시 찾아 합치는지 실측 */
test('2차 상호 키워드 재조회가 미매칭 점포만 조회해 결과를 합친다', async () => {
  const src = section('let liveRequestSequence', 'function noteBox');
  const kw = [], renders = [];
  const e = { p: { id: 'M' }, pos: { lat: 37, lng: 127 }, r: 25 };
  const kwCallbacks = [];
  const ctx2 = {
    APP: {}, T1: { ev: e, poly: { on: false, pts: [] } }, T3: { dirty: false }, KMap: { ready: true },
    KAKAO_GROUPS: [['CS2', '편의점']], UI: { EDGE: 1.15 },
    t1ShopRows: () => [{ s: { id: 'r1', name: '아가페미용실', category: '미용실' }, d: 12 },
      { s: { id: 'r2', name: '이미있음', category: '편의점' }, d: 15 }],
    xcPairScore: (a, b) => (a === '이미있음' && b === '이미있음' ? 1 : 0),
    posOf: p => p, renderShops: () => renders.push(1), renderMap1() {}, renderVerdict() {},
    renderPolyCard() {}, syncDrawBar() {}, toast() {},
    kakao: { maps: { LatLng: function (lat, lng) { this.lat = lat; this.lng = lng; }, services: {
      Places: function () {
        this.categorySearch = (c, fn) => fn([{ id: 'p1', place_name: '이미있음', x: '127', y: '37' }], 'OK');
        this.keywordSearch = (q, fn) => { kw.push(q); kwCallbacks.push(fn); };
      }, Status: { OK: 'OK' }, SortBy: { DISTANCE: 1 } } } },
  };
  vm.createContext(ctx2); vm.runInContext(src, ctx2);
  const p = ctx2.t1Live(e);
  const tick = () => new Promise(r => setTimeout(r, 5));
  await tick();
  assert.deepEqual(kw, ['아가페미용실'], '미매칭 1곳만, 원 상호부터 조회한다');
  kwCallbacks.shift()([{ id: 'k1', place_name: '아가페헤어샵', category_name: '가정,생활 > 미용실', x: '127.0002', y: '37.0001', road_address_name: '수원시 팔달구' }], 'OK');
  await tick();
  assert.deepEqual(kw, ['아가페미용실', '아가페'], '결과가 없거나 부족하면 업종 꼬리를 뗸 핵심 상호로 한 번 더');
  kwCallbacks.shift()([{ id: 'k1', place_name: '아가페헤어샵', category_name: '가정,생활 > 미용실', x: '127.0002', y: '37.0001', road_address_name: '수원시 팔달구' }], 'OK');
  await p;
  assert.equal(ctx2.APP.live.state, 'ok');
  const kh = ctx2.APP.live.places.find(x => x.name === '아가페헤어샵');
  assert.ok(kh && kh.via === 'kw', '키워드로 찾은 장소는 via kw 로 들어간다');
  assert.equal(ctx2.APP.live.kw.added, 1);
  assert.equal(ctx2.APP.live.kw.targets, 1);
  assert.equal(ctx2.APP.live.places.filter(x => x.name === '아가페헤어샵').length, 1, '중복 합치기');
});
test('키워드 2차 조회 결과도 오래된 요청이면 버린다', async () => {
  const src = section('let liveRequestSequence', 'function noteBox');
  const kwCallbacks = [];
  const e = { p: { id: 'X' }, pos: { lat: 37, lng: 127 }, r: 25 };
  const ctx3 = {
    APP: {}, T1: { ev: e, poly: { on: false, pts: [] } }, T3: { dirty: false }, KMap: { ready: true },
    KAKAO_GROUPS: [['CS2', '편의점']], UI: { EDGE: 1.15 },
    t1ShopRows: () => [{ s: { id: 'r1', name: '아가페미용실', category: '미용실' }, d: 12 }],
    xcPairScore: () => 0, posOf: p => p, renderShops() {}, renderMap1() {}, renderVerdict() {},
    renderPolyCard() {}, syncDrawBar() {}, toast() {},
    kakao: { maps: { LatLng: function () {}, services: {
      Places: function () {
        this.categorySearch = (c, fn) => fn([{ id: 'p1', place_name: '어떤가게', x: '127', y: '37' }], 'OK');
        this.keywordSearch = (q, fn) => kwCallbacks.push(fn);
      }, Status: { OK: 'OK' }, SortBy: { DISTANCE: 1 } } } },
  };
  vm.createContext(ctx3); vm.runInContext(src, ctx3);
  const p = ctx3.t1Live(e);
  await new Promise(r => setTimeout(r, 5));
  ctx3.T1.ev = { ...e, p: { id: 'Y' } };            /* 다른 점포·다른 구역으로 바뀜 */
  kwCallbacks.forEach(fn => fn([{ id: 'k9', place_name: '늦게온가게', x: '127.001', y: '37.001' }], 'OK'));
  await p;
  assert.equal(ctx3.APP.live.key, 'X');
  assert.equal(ctx3.APP.live.state, 'loading', '늦은 키워드 응답으로 결과를 확정하지 않는다');
  assert.ok(!ctx3.APP.live.places.some(x => x.name === '늦게온가게'));
});
/* ── keywordSearch 옵션의 location 은 반드시 kakao.maps.LatLng 인스턴스 ─────────
   2026-11-18 라이브 실측: 평범한 {lat,lng} 객체를 넘기면 SDK가 내부에서 getLng 를 부르다
   'TypeError: a.getLng is not a function'을 던지고, 바깥 catch 가 삼켜 '0건 더 찾았습니다'로
   조용히 표시됐다(GS25망포센트럴점 — 아가페미용실·수원바디온필라테스 등 5곳 거짓 음성). */
test('2차 키워드 조회는 location 에 kakao.maps.LatLng 인스턴스를 넘긴다', async () => {
  const src = section('let liveRequestSequence', 'function noteBox');
  const seenOpts = [];
  function LatLng(lat, lng) { this.lat = lat; this.lng = lng; }
  LatLng.prototype.getLat = function () { return this.lat; };
  LatLng.prototype.getLng = function () { return this.lng; };
  const e = { p: { id: 'L' }, pos: { lat: 37.0, lng: 127.0 }, r: 25 };
  const ctx4 = {
    APP: {}, T1: { ev: e, poly: { on: false, pts: [] } }, T3: { dirty: false }, KMap: { ready: true },
    KAKAO_GROUPS: [['CS2', '편의점']], UI: { EDGE: 1.15 },
    t1ShopRows: () => [{ s: { id: 'r1', name: '온결헤어룸', category: '미용실' }, d: 9 }],
    xcPairScore: () => 0, posOf: p => p, renderShops() {}, renderMap1() {}, renderVerdict() {},
    renderPolyCard() {}, syncDrawBar() {}, toast() {},
    kakao: { maps: { LatLng, services: {
      Places: function () {
        this.categorySearch = (c, fn) => fn([{ id: 'p1', place_name: '다른가게', x: '127', y: '37' }], 'OK');
        this.keywordSearch = (q, fn, opts) => {
          seenOpts.push(opts);
          /* 실제 SDK와 같은 제약: LatLng 인스턴스가 아니면 getLng 를 부르다 던진다 */
          if (!(opts && opts.location instanceof LatLng)) throw new TypeError('a.getLng is not a function');
          if (opts.location.getLng() !== 127.0) throw new TypeError('a.getLng is not a function');
          if (!(opts.radius > 0) || opts.sort === undefined) throw new Error('반경·정렬 옵션 누락');
          fn([{ id: 'k1', place_name: '온결헤어룸', category_name: '가정,생활 > 미용실', x: '127.0001', y: '37.0001' }], 'OK');
        };
      }, Status: { OK: 'OK' }, SortBy: { DISTANCE: 1 } } } },
  };
  vm.createContext(ctx4); vm.runInContext(src, ctx4);
  await ctx4.t1Live(e);
  assert.ok(seenOpts.length >= 1, '키워드 2차 조회가 호출된다');
  assert.ok(seenOpts[0].location instanceof LatLng, 'location 은 kakao.maps.LatLng 인스턴스여야 한다');
  assert.equal(seenOpts[0].location.lat, 37.0);
  assert.equal(seenOpts[0].location.lng, 127.0);
  assert.equal(ctx4.APP.live.kw.added, 1, 'LatLng 를 넘겨야 2차 조회가 결과를 실제로 회수한다');
});
/* ── '카카오 미확인'·'신규 후보' 행의 카카오맵·네이버지도 바로 찾기 링크 ── */
test('카카오 미확인 행에 카카오맵·네이버지도 바로 찾기 링크가 함께 붙는다', () => {
  const escStub = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const linkApi = new Function('esc', section('const naverMapLink', 'const UI =') + '\n' +
    section('const xcRowLink', 'function xcEstCell') + ';return {xcRowLink,kakaoMapLink,naverMapLink};')(escStub);
  const q = '수원시 영통구 망포동 자란다태권도';
  const out = linkApi.xcRowLink('자란다태권도', '수원시 영통구 망포동');
  assert.ok(out.includes('카카오맵 ↗'), '카카오맵 링크');
  assert.ok(out.includes('네이버지도 ↗'), '네이버지도 링크');
  assert.ok(out.includes(`href="https://map.kakao.com/link/search/${encodeURIComponent(q)}"`), '카카오맵 검색 URL');
  assert.ok(out.includes(`href="https://map.naver.com/p/search/${encodeURIComponent(q)}"`), '네이버지도 검색 URL');
  assert.equal((out.match(/target="_blank"/g) || []).length, 2, '두 링크 모두 새 창');
  assert.equal((out.match(/rel="noopener"/g) || []).length, 2, '두 링크 모두 noopener');
  assert.ok(out.includes('class="xc-links"'), '모바일에서 줄바꿈되는 링크 묶음');
  /* 지역 단서가 비면 상호만으로도 링크가 성립한다(주소 없는 카카오 장소) */
  assert.ok(linkApi.kakaoMapLink('  ').endsWith('/link/search/'));
});
test('요약·하단 안내가 카카오 오픈API 정책 한계와 지도 링크를 설명한다', () => {
  const sum = section('function xcSummaryHTML', 'function liveBlock');
  const live = section('function liveBlock', 'let liveRequestSequence');
  assert.ok(sum.includes('카카오 오픈API 정책상') && sum.includes('카카오맵·네이버지도'), '요약 안내');
  assert.ok(live.includes('카카오 오픈API가 제공하지 않는 매장'), '하단 안내');
  assert.ok(/xc-links\{display:inline-flex[^}]*flex-wrap:wrap/.test(html), '링크 묶음 CSS(줄바꿈 허용)');
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

/* ── 2026-11-18 UI 계약 — 기본 진입 홈 · 모바일 검색창/표 · KPI 프리페치 · 시도별 기준일 ── */
const m760 = html.slice(html.indexOf('@media (max-width:760px)'), html.indexOf('@media (max-width:520px)'));
const m520 = html.slice(html.indexOf('@media (max-width:520px)'), html.indexOf('/* --- 특수입지'));
test('기본 진입 화면은 홈이고 해시 딥링크는 그대로 동작한다', () => {
  assert.ok(/<section class="view active" id="view-home"/.test(html));
  assert.ok(!/<section class="view active" id="view-check"/.test(html));
  assert.ok(html.includes('data-view="home" aria-selected="true"'));
  assert.ok(!html.includes('data-view="check" aria-selected="true"'));
  assert.ok(html.includes("switchView(location.hash.slice(1) || 'home')"));
  assert.ok(section('function switchView(v) {', 'const meta = VIEW_META').includes("v = 'home'"));
  const views = section('const VIEWS =', 'const VIEW_META');
  for (const v of ['check', 'db', 'discover', 'history', 'rules', 'fav', 'data', 'feedback']) assert.ok(views.includes(`'${v}'`), v);
  assert.ok(html.includes('switchView(\'check\')'), '점포 선택 시 탭1 전환은 유지');
});
test('모바일 홈 검색창은 눌리지 않게 높이·테두리를 고정한다', () => {
  assert.ok(/\.hero-search \.searchbox\{[^}]*height:54px/.test(m760));
  assert.ok(/\.hero-search \.searchbox\{[^}]*min-height:54px/.test(m760));
  assert.ok(/\.hero-search \.searchbox\{[^}]*border:2px solid/.test(m760));
  assert.ok(/\.hero-search \.searchbox \.input\{[^}]*font-size:15px/.test(m760));
  assert.ok(/\.hero-search \.btn\{[^}]*height:54px/.test(m760));
});
test('가맹점·발굴 탭 KPI 는 인라인 4열이 아니라 클래스로 반응한다', () => {
  assert.ok(!html.includes('style="grid-template-columns:repeat(4,1fr)"'), '인라인 style 제거');
  assert.ok(html.includes('class="kpis kpis-4" id="t2-kpis"'));
  assert.ok(html.includes('class="kpis kpis-4" id="t3-kpis"'));
  assert.ok(/\.kpis-4\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)\}/.test(html));
  assert.ok(m760.includes('.kpis,.kpis-4{grid-template-columns:repeat(2,minmax(0,1fr))'), '760px 2열');
  assert.ok(m520.includes('.kpis,.kpis-4{grid-template-columns:minmax(0,1fr)}'), '520px 1열');
});
test('모바일 표는 주소·조례명을 줄바꿈해 오른쪽 넘침을 막는다', () => {
  assert.ok(/\.tbl \.cell2 small\{[^}]*white-space:normal/.test(m760));
  assert.ok(/\.tbl \.cell2 small\{[^}]*max-width:none/.test(m760));
  assert.ok(/\.tbl td\.nw,\.tbl th\.nw\{white-space:normal\}/.test(m760));
  assert.ok(m760.includes('.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}'));
});
test('부트에서 시도별 상가목록을 미리 받고 KPI 는 그 전에 계산 중으로 표시한다', () => {
  const pre = section('async function prefetchNearbyAll()', 'function computeKPI() {');
  assert.ok(pre.includes('loadNearby(sido)'), '시도별 프리페치');
  assert.ok(pre.includes('NEARBY.concurrency') && /concurrency: 5/.test(html));
  assert.ok(pre.includes('NEARBY.finished = true'), '완료 표시');
  assert.ok(section('async function start()', '(async function boot()').includes('prefetchNearbyAll();'), '부트에서 호출');
  const kpi = section('function computeKPI() {', 'function updateNavKPI(');
  assert.ok(kpi.includes('nearbyPending()') && kpi.includes('pending: true'));
  assert.ok(kpi.includes('assessmentOf(') && kpi.includes('evKPI('), '판정 계약 유지');
  assert.ok(section('function updateNavKPI()', 'function updateHeader()').includes("'계산 중'"));
  assert.ok(section('function renderHome()', 'function renderRecent()').includes('계산 중'));
});
test('시도별 상가 기준일(asof_by_sido)을 헤더 pill 과 KPI 카드에 반영한다', () => {
  const kpi = section('function computeKPI() {', 'function updateNavKPI(');
  assert.ok(kpi.includes('asof_by_sido') && kpi.includes('개 시도'));
  assert.ok(section('function updateHeader()', 'function bootErrorHeader()').includes('asofNote'));
  assert.ok(section('function updateNavKPI()', 'function updateHeader()').includes('asofOldN'));
  assert.ok(section('function renderHome()', 'function renderRecent()').includes('asofOldN'));
  const asofBy = zMeta.sources.find(s => s.name === '상가(상권)정보').asof_by_sido;
  const old = Object.values(asofBy).filter(v => v !== '2026-09-30');
  assert.equal(Object.keys(asofBy).length, 17);
  assert.equal(old.length, 9);
  assert.ok(old.every(v => v === '2025-06-30'));
});

/* 카카오 탭 표 — 열 붕괴 회귀 계약 (2026-11-18: 집계 칩이 상호·주소 열을 1글자 폭으로 밀어낸 문제) */
const kakaoTableHTML = new Function('esc', 'classifyDensityExclusion',
  section('function kakaoTableHTML(sim, e) {', 'function polyListHTML(sim, e) {') + '\n;return kakaoTableHTML;')(
  (s) => String(s == null ? '' : s),
  () => ({ exclude: false, status: 'RESTRICTED', label: '일반음식점' }));
const kakaoRowsHTML = kakaoTableHTML({
  ownConfirmed: true,
  inside: [
    { p: { name: '가맹점상호가길게', cat: '일반음식점', d: 154.4, addr: '경기도 수원시 영통구 영통로154번길 60' }, self: false, small: true },
    { p: { name: '대상점포', cat: '편의점', d: 0, addr: '경기도 수원시 영통구 망포동 417-2' }, self: true, small: true },
  ],
}, { rule: {} });
test('카카오 표는 고정 레이아웃 + 5열 colgroup(합 100%)으로 상호·주소 열이 붕괴하지 않는다', () => {
  assert.ok(kakaoRowsHTML.includes('table-layout:fixed'), 'table-layout:fixed 없음');
  assert.ok(kakaoRowsHTML.includes('class="tbl num semas-tbl"'), '공단 DB 표와 같은 표 클래스');
  const cols = [...kakaoRowsHTML.matchAll(/<col style="width:(\d+)%">/g)].map((m) => Number(m[1]));
  assert.equal(cols.length, 5, 'col 개수 ' + cols.length);
  assert.equal(cols.reduce((a, b) => a + b, 0), 100, '열 폭 합계 ' + cols.reduce((a, b) => a + b, 0));
  assert.ok(cols[0] >= 20 && cols[3] >= 20, '상호·주소 열이 좁은 조각으로 붕괴: ' + cols.join('/'));
  assert.deepEqual([...kakaoRowsHTML.matchAll(/<th>([^<]+)<\/th>/g)].map((m) => m[1]), ['상호', '업종', '거리', '주소', '집계']);
  assert.equal((kakaoRowsHTML.match(/<tr>/g) || []).length, 3, '헤더 1 + 데이터 2행');
  assert.equal((kakaoRowsHTML.match(/<td/g) || []).length, 10, '행마다 5칸');
});
test('좁은 열의 집계·참고 칩은 줄바꿈되고 nowrap 으로 열을 밀지 않는다', () => {
  const css = section('.semas-tbl{width:100%;table-layout:fixed}', '.semas-square');
  assert.ok(/\.semas-tbl \.chip\{[^}]*white-space:normal/.test(css), '칩 white-space:normal');
  assert.ok(/\.semas-tbl \.chip\{[^}]*max-width:100%/.test(css), '칩 max-width:100%');
  assert.ok(css.includes('word-break:keep-all'), '한글 단어 단위 줄바꿈');
  assert.ok(kakaoRowsHTML.includes('<span class="chip cf">가맹 제한(참고) · 일반음식점</span>'), '긴 집계 칩 렌더');
});

console.log(`FINAL ${passed} contract/async tests passed`);

/* 공단 상가(상권)정보 프록시(/semas) 계약 — 워크플로 수정 없이 같은 CI 단계에서 실행한다 */
await import('./test_semas_contract.mjs');
