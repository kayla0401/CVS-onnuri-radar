#!/usr/bin/env python3
"""data/city_rules.json 에 법적 검증 필드를 추가한다 (하위 호환 100%).

- 기존 18개 키는 삭제·이름변경하지 않는다.
- 215개 전체에 density_exclusion_policy 등 신규 필드를 넣되, 조문 검증이 끝나지 않은
  지자체의 밀집도 제외 정책은 임의로 NONE 으로 찍지 않고 UNKNOWN 으로 둔다.
- 검증이 끝난 대표 3곳(수원·성남·인천 서해구)만 실제 값으로 채운다.

사용: python3 scripts/apply_legal_fields.py [--check]
  --check : 파일을 쓰지 않고, 적용 후 달라질 내용만 확인한다.
"""
import json
import sys
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATH = ROOT / "data" / "city_rules.json"
VERIFIED_AT = "2026-11-17"

# 조문 전수 검증 전 기본값 — 절대 NONE 으로 두지 않는다
DEFAULTS = OrderedDict([
    ("density_exclusion_policy", "UNKNOWN"),
    ("density_excluded_industries", []),
    ("shop_definition_note", None),
    ("exclusion_legal_basis", None),
    ("exclusion_effective_date", None),
    ("area_measurement_basis", "UNKNOWN"),
    ("over_area_verified", False),
    ("over_area_rule_type", None),
    ("over_area_step_m2", None),
    ("over_area_shops", None),
    ("over_area_legal_basis", None),
    ("consent_denominator_rule", "UNKNOWN"),
    ("required_consent_ratio", None),
    ("enforcement_rule_url", None),
    ("rule_conflict_flag", False),
    ("rule_conflict_note", None),
    ("legal_review_status", "UNVERIFIED"),
    ("verified_at", None),
    ("official_interpretations", []),
])

# 검증된 대표 사례 — 2026-11-17 자치법규 원문 대조
VERIFIED = {
    ("경기", "수원시"): OrderedDict([
        ("density_exclusion_policy", "NONE"),
        ("density_excluded_industries", []),
        ("shop_definition_note", "조례 제2조제3호: 상가건물 또는 건축물 대장에 등재된 건물에서 도매업·소매업·용역업을 경영하는 장소"),
        ("exclusion_legal_basis", "수원시 골목형상점가 지정 및 지원에 관한 조례(2026-09-30 공포) 제3조 — 별도 가맹제한업종 제외 조항 없음"),
        ("exclusion_effective_date", "2026-10-01"),
        ("area_measurement_basis", "ZONE_NET_EXCL_PUBLIC"),
        ("consent_denominator_rule", "ALL_SHOPS"),
        ("required_consent_ratio", "1/2"),
        ("rule_conflict_flag", False),
        ("legal_review_status", "VERIFIED"),
        ("verified_at", VERIFIED_AT),
    ]),
    ("인천", "서해구"): OrderedDict([
        ("density_exclusion_policy", "ALL_RESTRICTED"),
        ("density_excluded_industries", ["시행령 별표1 전체"]),
        ("shop_definition_note", "조례 제2조제3호: 건축법상 건축물에서 소상공인이 직접 사업 운영하는 장소"),
        ("exclusion_legal_basis", "인천광역시 서해구 골목형상점가 지정 및 활성화에 관한 조례(2026-06-29 공포) 제3조제2항"),
        ("exclusion_effective_date", "2026-07-01"),
        ("area_measurement_basis", "CHECK_REQUIRED"),
        ("over_area_verified", True),
        ("over_area_rule_type", "PROPORTIONAL_CEIL"),
        ("over_area_step_m2", 2000),
        ("over_area_shops", 15),
        ("over_area_legal_basis", "조례 제3조제1항 단서 (2,000㎡당 15개 비율, 소수점 올림)"),
        ("consent_denominator_rule", "UNKNOWN"),
        ("required_consent_ratio", "1/2"),
        ("enforcement_rule_url", "https://www.law.go.kr/ordinInfoP.do?ordinSeq=2134615"),
        ("rule_conflict_flag", True),
        ("rule_conflict_note", "조례(15개·별표1 전체 제외) vs 시행규칙 제2조(30개·별표1 중 일부 취지 부적합 업종 제외·점포면적 합계) 문언 상충 — 서해구 경제정책과(032-560-4431) 확인 필요"),
        ("legal_review_status", "CONFLICT_CHECK_NEEDED"),
        ("verified_at", VERIFIED_AT),
    ]),
    ("경기", "성남시"): OrderedDict([
        ("density_exclusion_policy", "UNKNOWN"),
        ("density_excluded_industries", []),
        ("shop_definition_note", "조례 제2조제5호: 상가건축물 또는 지붕이 있는 상가건물에서 도매업·소매업·용역업 영위 장소"),
        ("exclusion_legal_basis", "성남시 전통시장 및 상점가 육성을 위한 조례 제13조·제14조 (2025-08-04 공포, 온라인 공개 미리보기 한계로 최신 제13~14조 전문 추가 대조 필요)"),
        ("area_measurement_basis", "UNKNOWN"),
        ("consent_denominator_rule", "ALL_SHOPS"),
        ("required_consent_ratio", "1/2"),
        ("rule_conflict_flag", False),
        ("legal_review_status", "NEEDS_TEXT_CHECK"),
        ("verified_at", VERIFIED_AT),
    ]),
}


def main() -> int:
    check = "--check" in sys.argv[1:]
    rules = json.loads(PATH.read_text(encoding="utf-8"))
    changed = 0
    for r in rules:
        before = len(r)
        # 기본값 → 검증값 순으로 덮어쓴다 (기존 키는 건드리지 않는다)
        for k, v in DEFAULTS.items():
            r.setdefault(k, v)
        r["over_area_verified"] = bool(r.get("over_area_verified") is True)
        spec = VERIFIED.get((r.get("sido"), r.get("sigungu")))
        if spec:
            r.update(spec)
            changed += 1

    if check:
        print(f"총 {len(rules)}건 · 대표 검증 {changed}건 적용 예정 (파일 미변경)")
        for r in rules:
            if (r.get("sido"), r.get("sigungu")) in VERIFIED:
                print(json.dumps(r, ensure_ascii=False, indent=1)[:400])
        return 0

    PATH.write_text(json.dumps(rules, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    pol = {}
    for r in rules:
        pol[r["density_exclusion_policy"]] = pol.get(r["density_exclusion_policy"], 0) + 1
    print(f"저장 완료: {len(rules)}건 · {PATH}")
    print("density_exclusion_policy 분포:", pol)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
