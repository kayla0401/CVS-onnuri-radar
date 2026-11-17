#!/usr/bin/env node
/* 온누리 레이더 — 법적 판정 코어 단위 테스트
 * 실행: node tests/test_legal_criteria.mjs
 *
 * index.html 의 @legal-core 블록(DOM 비의존)을 그대로 떼어내 실행하고,
 * data/city_rules.json 의 대표 3곳(수원·성남·인천 서해구)으로 판정을 검증한다.
 * 실패가 하나라도 있으면 종료 코드 1.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const rules = JSON.parse(readFileSync(path.join(ROOT, 'data', 'city_rules.json'), 'utf8'));
const stores = JSON.parse(readFileSync(path.join(ROOT, 'data', 'stores.json'), 'utf8')).stores;

/* @test-body:start (아래 함수는 Node 없이도 실행된다 — quickjs 등으로 그대로 호출) */
function runTests(html, rules, stores) {
  const S = '/* @legal-core:start */', E = '/* @legal-core:end */';
  const a = html.indexOf(S), b = html.indexOf(E);
  if (a < 0 || b < 0) throw new Error('index.html 에서 @legal-core 블록을 찾지 못했습니다');
  const core = html.slice(a + S.length, b);
  const LS = '/* @legacy-admin:start', LE = '/* @legacy-admin:end */';
  const la = html.indexOf(LS), lb = html.indexOf(LE);
  if (la < 0 || lb < 0) throw new Error('index.html 에서 @legacy-admin 블록을 찾지 못했습니다');
  const legacy = `const normSido = s => String(s || '').trim();\n` + html.slice(html.indexOf('*/', la) + 2, lb);
  const api = new Function(core + legacy + `
    return { classifyOnnuriEligibility, classifyShopBiz, classifyDensityExclusion, densityPolicyOf,
             requiredShopsFor, densityAssess, headlineVerdict, HEADLINE_STATUS,
             ruleMatch, findRule, legacyRule,
             ONNURI_RESTRICTED, DENSITY_STATUS, DENSITY_POLICIES };`)();
  const { classifyOnnuriEligibility: onnuri, classifyDensityExclusion: dens, requiredShopsFor: req,
    densityAssess: assess, headlineVerdict: headline, ruleMatch, ONNURI_RESTRICTED } = api;

  const ruleOf = (sido, sigungu) => {
    const r = rules.find(x => x.sido === sido && x.sigungu === sigungu);
    if (!r) throw new Error(`조례 DB에 ${sido} ${sigungu} 가 없습니다`);
    return r;
  };
  const lines = []; let pass = 0, fail = 0;
  const ok = (name, cond, detail) => {
    if (cond) { pass++; lines.push(`  ✓ ${name}`); }
    else { fail++; lines.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
  };
  const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `기대 ${JSON.stringify(want)} · 실제 ${JSON.stringify(got)}`);

  lines.push('[1] 온누리 가맹 적격성 — 시행령 별표 1(33종)');
  eq('별표 1 업종 수 33종', ONNURI_RESTRICTED.length, 33);
  const cases = [
    ['우리약국', '약국', 'ALLOW', '약국(의약품 소매)은 2026-10 허용 유지'],
    ['참소주', '주류 소매', 'RESTRICTED', '주류 소매업'],
    ['참소주', '주류 도매', 'RESTRICTED', '주류 도매업'],
    ['대한귀금속', '귀금속 도매', 'RESTRICTED', '귀금속 도매업'],
    ['정일학원', '일반교육', 'RESTRICTED', '일반교습학원'],
    ['행복동물병원', '동물병원', 'RESTRICTED', '수의업'],
    ['생맥주집', '생맥주 전문점', 'CONDITIONAL_REVIEW', '별표 1의2 예외 가능'],
    ['GS25망포센트럴점', '편의점', 'ALLOW', '편의점은 제한업종 아님'],
  ];
  cases.forEach(([name, cat, want, why]) => {
    const got = onnuri(name, cat);
    ok(`${cat} → ${want} (${why})`, got.status === want, `실제 ${got.status} / ${got.label}`);
  });
  ok('유흥주점은 예외 없이 RESTRICTED', onnuri('나이트', '유흥주점').status === 'RESTRICTED');
  ok('보건소는 소상공인 대상 아님으로 분리', onnuri('보건소', '보건소').nonSmallBiz === true);
  ok('호환 래퍼 classifyShopBiz 가 제한업종을 ex 로 반환', api.classifyShopBiz('주류 소매', '참소주').k === 'ex');

  lines.push('[2] 경기 수원시 — density_exclusion_policy=NONE (업종 이유 차감 0건)');
  const suwon = ruleOf('경기', '수원시');
  eq('수원시 density_exclusion_policy', suwon.density_exclusion_policy, 'NONE');
  eq('수원시 legal_review_status', suwon.legal_review_status, 'VERIFIED');
  const sShops = [{ name: '정일학원', cat: '일반교육' }, { name: '연세의원', cat: '의원' }, { name: '부동산', cat: '부동산 서비스' }];
  const sEx = sShops.map(s => dens(s, suwon));
  eq('학원·병원·부동산 모두 밀집도 제외 아님', sEx.map(x => x.exclude), [false, false, false]);
  ok('NONE 조례에서 unknownPossibleExclude 도 false', sEx.every(x => x.unknownPossibleExclude === false));
  const sA = assess({ rule: suwon, area: 2000, population: 20, thCom: 25, thNon: 20,
    sample: { n: 20, nEx: 6, nChk: 2, nNonSmall: 0, truncated: false, src: 'nearby' } });
  eq('수원시 조례상 제외 점포 0건', sA.excludedSample, 0);
  eq('수원시 밀집도 인정 점포 20개 그대로', sA.effective, 20);
  ok('수원시 판정은 법적 미확인으로 보류되지 않음', sA.status !== 'LEGAL_UNVERIFIED', sA.status);
  ok('수원시 판정 상태는 4종 중 하나', ['EST_PASS', 'EST_FAIL', 'NEEDS_CHECK', 'LEGAL_UNVERIFIED'].includes(sA.status));

  lines.push('[3] 경기 성남시 — UNKNOWN: 최종 적합 단정 금지, 범위 병기');
  const seongnam = ruleOf('경기', '성남시');
  eq('성남시 density_exclusion_policy', seongnam.density_exclusion_policy, 'UNKNOWN');
  eq('성남시 legal_review_status', seongnam.legal_review_status, 'NEEDS_TEXT_CHECK');
  const nA = assess({ rule: seongnam, area: 2000, population: 12, thCom: 30, thNon: null,
    sample: { n: 12, nEx: 4, nChk: 1, nNonSmall: 0, truncated: false, src: 'nearby' } });
  eq('성남시 판정 상태 = 법적 기준 미확인', nA.status, 'LEGAL_UNVERIFIED');
  ok('성남시 적합 단정 차단(blocksVerdict)', nA.blocksVerdict === true);
  eq('성남시 범위 병기(8~12개)', [nA.rangeLo, nA.rangeHi], [8, 12]);
  ok('성남시 상태 라벨이 "법적 기준 미확인"', nA.statusLabel === api.DENSITY_STATUS.LEGAL_UNVERIFIED.label, nA.statusLabel);

  lines.push('[4] 인천 서해구 — ALL_RESTRICTED + 조례·시행규칙 충돌 + 비율식 15개');
  const seohae = ruleOf('인천', '서해구');
  eq('서해구 density_exclusion_policy', seohae.density_exclusion_policy, 'ALL_RESTRICTED');
  eq('서해구 rule_conflict_flag', seohae.rule_conflict_flag, true);
  eq('2,000㎡ → 15개', req(seohae, 2000, 15), 15);
  eq('3,000㎡ → 23개(2,000㎡당 15개 비율·올림)', req(seohae, 3000, 15), 23);
  eq('4,000㎡ → 30개', req(seohae, 4000, 15), 30);
  eq('1,500㎡ → 15개(비례 축소 금지)', req(seohae, 1500, 15), 15);
  const hShops = [{ name: '연세의원', cat: '의원' }, { name: '미용실', cat: '미용실' }, { name: '정일학원', cat: '일반교육' }, { name: '생맥주집', cat: '생맥주 전문점' }];
  const hEx = hShops.map(s => dens(s, seohae));
  eq('서해구: 병원·학원은 밀집도 제외', [hEx[0].exclude, hEx[2].exclude], [true, true]);
  eq('서해구: 미용실은 포함', hEx[1].exclude, false);
  ok('서해구: 조건부(생맥주)는 자동 제외하지 않음', hEx[3].exclude === false, hEx[3].reason);
  const hA = assess({ rule: seohae, area: 2000, population: 20, thCom: 15, thNon: null,
    sample: { n: 20, nEx: 7, nChk: 1, nNonSmall: 0, truncated: false, src: 'nearby' } });
  eq('서해구 조례상 제외 점포 7건', hA.excludedSample, 7);
  eq('서해구 밀집도 인정 13개', hA.effective, 13);
  ok('서해구는 충돌 경고를 함께 낸다', hA.conflict === true && hA.notes.some(x => /충돌/.test(x)), hA.notes.join(' / '));
  ok('서해구는 유권해석 전 확정 판정하지 않음', hA.status === 'LEGAL_UNVERIFIED', hA.status);
  ok('서해구 필요 점포 수 15개', hA.required === 15, String(hA.required));

  lines.push('[5] 표본 상한·초과면적·미검증 조례 방어');
  /* 충돌 플래그가 없는 경우의 표본 상한 동작을 따로 본다(충돌은 그 자체로 판정 보류 사유) */
  const allRestricted = Object.assign({}, seohae, { rule_conflict_flag: false, rule_conflict_note: null });
  const trunc = assess({ rule: allRestricted, area: 2000, population: 40, thCom: 15, thNon: null,
    sample: { n: 150, nEx: 12, nChk: 3, nNonSmall: 0, truncated: true, src: 'nearby' } });
  eq('표본 상한이면 추가 확인 필요(제외 규정 있는 조례)', trunc.status, 'NEEDS_CHECK');
  ok('표본 상한이면 범위로 표시(28~40)', trunc.rangeLo === 28 && trunc.rangeHi === 40, `${trunc.rangeLo}~${trunc.rangeHi}`);
  const noneTrunc = assess({ rule: suwon, area: 2000, population: 30, thCom: 25, thNon: 20,
    sample: { n: 150, nEx: 12, nChk: 3, nNonSmall: 1, truncated: true, src: 'nearby' } });
  eq('NONE 조례는 표본 상한과 무관하게 차감 없음', noneTrunc.excludedSample, 1);
  eq('NONE 조례는 표본 상한이어도 판정을 보류하지 않음(비소상공인 1건만 빼고 충족 추정)', noneTrunc.status, 'EST_PASS');
  eq('초과면적 미검증 수원시 3,000㎡ 는 보류(null)', req(suwon, 3000, 25), null);
  const noRule = assess({ rule: null, area: 2000, population: 10, thCom: 30, thNon: null, sample: { n: 10, nEx: 0, nChk: 0, nNonSmall: 0 } });
  eq('조례 미확인이면 법적 기준 미확인', noRule.status, 'LEGAL_UNVERIFIED');
  eq('215개 전체에 density_exclusion_policy 존재', rules.filter(r => r.density_exclusion_policy).length, rules.length);
  eq('UNKNOWN 이 아닌 지자체는 2곳(수원 NONE·서해구 ALL_RESTRICTED)',
    rules.filter(r => r.density_exclusion_policy !== 'UNKNOWN').map(r => `${r.sigungu}:${r.density_exclusion_policy}`).sort(),
    ['서해구:ALL_RESTRICTED', '수원시:NONE']);

  lines.push('[6] 메인 배너 직관 판정(headlineVerdict) — 수학적 상한·하한');
  /* ① 명백한 미달: GS252테크노파크점(부천) 4개 / 25·20개 필요 · density UNKNOWN */
  const hvTech = headline({ population: 4, maxShops: 4, minShops: 4, reqCom: 25, reqNon: 20, policy: 'UNKNOWN' });
  eq('테크노파크점 판정 = 추정 미달(빨강)', [hvTech.level, hvTech.cls, hvTech.emoji], ['FAIL', 'fail', '❌']);
  ok('테크노파크점 부제: 업종 제외와 무관한 점포 수 부족', /업종 제외 여부와 무관/.test(hvTech.sub), hvTech.sub);
  ok('테크노파크점 부제에 현재/필요 개수', /현재 확인 4개/.test(hvTech.sub) && /20~25개/.test(hvTech.sub), hvTech.sub);
  /* ② 경계: 수원 망포센트럴점 20개 · 상업 25 / 비상업 20 · density NONE */
  const hvSuwon = headline({ population: 20, maxShops: 20, minShops: 20, reqCom: 25, reqNon: 20, policy: 'NONE' });
  eq('망포센트럴점 판정 = 가능성 있음(노랑)', [hvSuwon.level, hvSuwon.cls], ['COND', 'cond']);
  ok('망포센트럴점 부제: 비상업 충족·상업 5개 부족', /비상업\(20개\) 충족/.test(hvSuwon.sub) && /상업\(25개\)엔 5개 부족/.test(hvSuwon.sub), hvSuwon.sub);
  /* ③ 명백한 충족: 35/25 UNKNOWN */
  const hvPass = headline({ population: 35, maxShops: 35, minShops: 35, reqCom: 25, reqNon: null, policy: 'UNKNOWN' });
  eq('35개/25개 필요 = 지정 가능성 높음(초록)', [hvPass.level, hvPass.cls, hvPass.emoji], ['PASS', 'pass', '✅']);
  ok('충족 배너도 조문 미확인을 괄호로 병기', /조문 미확인으로 A축 참고/.test(hvPass.sub), hvPass.sub);
  /* ④ UNKNOWN 경계: 22~28개 / 25개 */
  const hvRange = headline({ population: 28, maxShops: 28, minShops: 22, reqCom: 25, reqNon: null, policy: 'UNKNOWN' });
  eq('22~28개 경계 = 가능성 있음 · 조문 확인', [hvRange.level, hvRange.cls], ['COND_LEGAL', 'cond']);
  ok('경계 배너 제목에 조문 확인', /가능성 있음/.test(hvRange.title) && /조문 확인/.test(hvRange.title), hvRange.title);
  ok('경계 부제에 22~28개 범위와 갈림 설명', /22~28개 범위/.test(hvRange.sub) && /갈림/.test(hvRange.sub), hvRange.sub);
  /* ⑤ 데이터 없음 */
  const hvNone = headline({ population: null, reqCom: 30, reqNon: null, policy: 'UNKNOWN' });
  eq('상가 데이터 0건 = 데이터 없음(회색)', [hvNone.level, hvNone.cls, hvNone.emoji], ['NO_DATA', 'na', '🔍']);
  ok('데이터 없음 부제에 현장/카카오 확인 안내', /현장\/카카오|현장 확인/.test(hvNone.sub), hvNone.sub);
  /* ⑥ 기준 자체가 불확정 — 초과면적 미검증 */
  const hvBasis = headline({ population: 20, maxShops: 20, minShops: 20, reqCom: null, reqNon: null, policy: 'NONE', basisUnknown: '검토 면적 5,000㎡ 초과면적 계산식 미검증' });
  eq('기준 불확정 = 기준 확인 필요', [hvBasis.level, hvBasis.title], ['BASIS', '기준 확인 필요']);
  ok('기준 확인 부제에 사유 한 줄', /초과면적 계산식 미검증/.test(hvBasis.sub), hvBasis.sub);
  /* ⑦ 조례·시행규칙 충돌(서해구) */
  const hvConflict = headline({ population: 18, maxShops: 18, minShops: 11, reqCom: 15, reqNon: null, policy: 'ALL_RESTRICTED', conflict: true, conflictSub: '조례(15개) vs 시행규칙(30개) 충돌 — 담당 부서 확인 필요' });
  ok('충돌이면 확정 배너 대신 조건 확인', hvConflict.level === 'COND' && /충돌/.test(hvConflict.sub), `${hvConflict.level} / ${hvConflict.sub}`);
  /* 배너 상태 6종이 색상 클래스와 함께 정의되어 있는지 */
  eq('헤드라인 상태 6종', Object.keys(api.HEADLINE_STATUS).sort(), ['BASIS', 'COND', 'COND_LEGAL', 'FAIL', 'NO_DATA', 'PASS']);

  lines.push('[7] 옛 행정구역 → 새 구 조례 매칭(2026-07-01 인천 개편)');
  const mt = (sg, addr) => ruleMatch('인천', sg, addr, rules);
  const rSeohae = mt('서구', '인천 서구 서달로207번길10-1, 1층 (가정동 559-25)');
  ok('옛 인천 서구 + 가정동 → 서해구 조례', rSeohae.rule && rSeohae.rule.sigungu === '서해구' && rSeohae.legacy && rSeohae.legacy.to === '서해구', JSON.stringify(rSeohae.rule && rSeohae.rule.sigungu));
  ok('옛 주소 매칭은 개편 안내를 함께 돌려준다', /2026-07-01/.test(rSeohae.legacy.note), rSeohae.legacy.note);
  const rGeomdan = mt('서구', '인천 서구 이음3로125, , 101-102동 (당하동 1254-1)');
  ok('옛 인천 서구 + 당하동 → 검단구 조례', rGeomdan.rule && rGeomdan.rule.sigungu === '검단구', JSON.stringify(rGeomdan.rule && rGeomdan.rule.sigungu));
  const rNoDong = mt('서구', '인천 서구 어딘가로1');
  ok('법정동을 못 읽으면 서해구로 기본 매칭 + 추정 표시', rNoDong.rule && rNoDong.rule.sigungu === '서해구' && rNoDong.legacy.guessed === true, JSON.stringify(rNoDong.rule && rNoDong.rule.sigungu));
  const rBaekseok = mt('서구', '인천 서구 백석로1 (백석동 100)');
  ok('백석동·시천동은 검단구(법률 제21734호 분구 기준)', rBaekseok.rule && rBaekseok.rule.sigungu === '검단구', JSON.stringify(rBaekseok.rule && rBaekseok.rule.sigungu));
  const rYeongjong = mt('중구', '인천 중구 공항로187 (운서동 2850)');
  ok('옛 인천 중구 + 운서동 → 영종구 조례', rYeongjong.rule && rYeongjong.rule.sigungu === '영종구', JSON.stringify(rYeongjong.rule && rYeongjong.rule.sigungu));
  const rJemulpo = mt('중구', '인천 중구 신포로23번길 (신포동)');
  ok('옛 인천 중구 내륙 → 제물포구 조례', rJemulpo.rule && rJemulpo.rule.sigungu === '제물포구', JSON.stringify(rJemulpo.rule && rJemulpo.rule.sigungu));
  const rDong = mt('동구', '인천 동구 송림로96 (송림동)');
  ok('옛 인천 동구 → 제물포구 조례', rDong.rule && rDong.rule.sigungu === '제물포구', JSON.stringify(rDong.rule && rDong.rule.sigungu));
  const rNam = mt('남구', '인천 남구 주안로 (주안동)');
  ok('옛 인천 남구 → 미추홀구 조례', rNam.rule && rNam.rule.sigungu === '미추홀구', JSON.stringify(rNam.rule && rNam.rule.sigungu));
  ok('현행 구 이름은 그대로 매칭(legacy 없음)', mt('서해구', '인천 서해구 서달로207번길10-1').legacy === null);

  lines.push('[8] stores.json 중복 구조 진단(원본 유지)');
  eq('점포 18,198건 그대로', stores.length, 18198);
  const byName = {};
  stores.forEach(s => { (byName[s[1]] = byName[s[1]] || []).push(s); });
  const dupNames = Object.keys(byName).filter(n => byName[n].length > 1);
  eq('같은 상호가 2건 이상인 그룹 253개', dupNames.length, 253);
  const crossGu = dupNames.filter(n => byName[n].some(s => s[3] === '서구') && byName[n].some(s => s[3] === '서해구' || s[3] === '검단구'));
  eq('인천 옛 서구·새 구에 동시에 있는 점포 4건', crossGu.sort(), ['GS25가정3동점', 'GS25검단더휴점', 'GS25경서타운점', 'GS25청라베르디움점']);
  ok('점포코드는 서로 달라 코드 기준 중복은 0건', new Set(stores.map(s => s[0])).size === stores.length);

  lines.push('');
  lines.push(`결과: ${pass}개 통과 · ${fail}개 실패`);
  return { pass, fail, lines };
}
/* @test-body:end */

const res = runTests(html, rules, stores);
console.log(res.lines.join('\n'));
if (res.fail) process.exit(1);
