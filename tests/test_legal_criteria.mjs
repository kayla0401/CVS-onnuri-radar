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

/* @test-body:start (아래 함수는 Node 없이도 실행된다 — quickjs 등으로 그대로 호출) */
function runTests(html, rules) {
  const S = '/* @legal-core:start */', E = '/* @legal-core:end */';
  const a = html.indexOf(S), b = html.indexOf(E);
  if (a < 0 || b < 0) throw new Error('index.html 에서 @legal-core 블록을 찾지 못했습니다');
  const core = html.slice(a + S.length, b);
  const api = new Function(core + `
    return { classifyOnnuriEligibility, classifyShopBiz, classifyDensityExclusion, densityPolicyOf,
             requiredShopsFor, densityAssess, ONNURI_RESTRICTED, DENSITY_STATUS, DENSITY_POLICIES };`)();
  const { classifyOnnuriEligibility: onnuri, classifyDensityExclusion: dens, requiredShopsFor: req,
    densityAssess: assess, ONNURI_RESTRICTED } = api;

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
  const noneTrunc = assess({ rule: suwon, area: 2000, population: 24, thCom: 25, thNon: 20,
    sample: { n: 150, nEx: 12, nChk: 3, nNonSmall: 1, truncated: true, src: 'nearby' } });
  eq('NONE 조례는 표본 상한과 무관하게 차감 없음', noneTrunc.excludedSample, 1);
  ok('NONE 조례는 표본 상한이어도 판정을 보류하지 않음', noneTrunc.status !== 'NEEDS_CHECK', noneTrunc.status);
  eq('초과면적 미검증 수원시 3,000㎡ 는 보류(null)', req(suwon, 3000, 25), null);
  const noRule = assess({ rule: null, area: 2000, population: 10, thCom: 30, thNon: null, sample: { n: 10, nEx: 0, nChk: 0, nNonSmall: 0 } });
  eq('조례 미확인이면 법적 기준 미확인', noRule.status, 'LEGAL_UNVERIFIED');
  eq('215개 전체에 density_exclusion_policy 존재', rules.filter(r => r.density_exclusion_policy).length, rules.length);
  eq('UNKNOWN 이 아닌 지자체는 2곳(수원 NONE·서해구 ALL_RESTRICTED)',
    rules.filter(r => r.density_exclusion_policy !== 'UNKNOWN').map(r => `${r.sigungu}:${r.density_exclusion_policy}`).sort(),
    ['서해구:ALL_RESTRICTED', '수원시:NONE']);

  lines.push('');
  lines.push(`결과: ${pass}개 통과 · ${fail}개 실패`);
  return { pass, fail, lines };
}
/* @test-body:end */

const res = runTests(html, rules);
console.log(res.lines.join('\n'));
if (res.fail) process.exit(1);
