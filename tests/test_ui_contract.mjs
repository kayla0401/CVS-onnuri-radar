import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
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
console.log(`FINAL ${passed} contract/async tests passed`);
