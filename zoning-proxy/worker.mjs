/* 온누리 레이더 · 용도지역 조회 프록시 (Cloudflare Worker)
 *
 * 인증키는 Worker 환경에만 두고, 브라우저에는 조회 결과만 돌려준다.
 *   GET /zoning?lat=&lng=&pnu=               점포 핀 좌표의 용도지역 이름
 *   GET /zoning?mode=area&bbox=w,s,e,n        신청 구역 경계 상자의 용도지역 도형(폴리곤)
 *
 *   GET /semas?mode=polygon&key=POLYGON((lng lat,...))  직접 그린 구역 안 공단 상가업소 전수
 *   GET /semas?mode=zones&cx=&cy=&radius=               반경 안 공단 상권 구역
 *     — 상가(상권)정보 API 키(SEMAS_API_KEY)는 Worker 시크릿에만 둔다.
 *
 * 점포 조회는 두 경로를 쓴다.
 *   1) VWORLD_API_KEY가 있으면 브이월드 공식 API(국토교통부 용도지역 레이어)를 먼저 부른다.
 *   2) 키가 없거나 브이월드가 실패·무응답이면 19자리 PNU로 토지이음 토지이용계획 열람을 읽어
 *      용도지역 코드(UQA·UQB·UQC·UQD)를 이름으로 돌려준다. (키 없이도 단일 필지 조회 가능)
 * 면적(혼합) 계산은 브이월드 도형이 있어야 하므로 키가 없으면 브라우저가 수동 모드로 폴백한다.
 */

const LAYERS = ['LT_C_UQ111', 'LT_C_UQ112', 'LT_C_UQ113', 'LT_C_UQ114'];
const COMMERCIAL = /^(중심|일반|근린|유통)?상업지역$/;
const NONCOMMERCIAL = /^(제[123]종(전용|일반)주거지역|준주거지역|(전용|일반|준)공업지역|(보전|생산|자연)녹지지역|주거지역|전용주거지역|일반주거지역|공업지역|녹지지역|(보전|생산|계획)?관리지역|관리지역|농림지역|자연환경보전지역)$/;

const UPSTREAM = 'https://api.vworld.kr/req/data';
const EUM_URL = 'https://www.eum.go.kr/web/ar/lu/luLandDet.jsp';
const TIMEOUT_MS = 6500;
const EUM_TIMEOUT_MS = 9000;

/* 소상공인시장진흥공단 상가(상권)정보 — 다각형 안 상가업소·반경 안 상권 */
const SEMAS_STORE_URL = 'https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInPolygon';
const SEMAS_ZONE_URL = 'https://apis.data.go.kr/B553077/api/open/sdsc2/storeZoneInRadius';
const SEMAS_TIMEOUT_MS = 12000;
const SEMAS_MAX_ROWS = 1000;          /* upstream 1페이지 상한(요청해도 1000으로 잘린다) */
const SEMAS_MAX_PAGES = 3;            /* 1,000건 초과분은 최대 3페이지(3,000건)까지 합산 */
const SEMAS_MAX_POINTS = 100;         /* 다각형 꼭짓점 상한 */
const SEMAS_RADIUS_MAX = 2000;        /* 상권 반경 상한(m) */

/* 국토교통부 건축HUB 건축물대장정보 서비스 — 표제부·전유공용면적·층별개요 */
const BLD_URL = 'https://apis.data.go.kr/1613000/BldRgstHubService';
const BLD_TIMEOUT_MS = 9000;
const BLD_PAGE_ROWS = 100;
const BLD_MAX_TITLE_PAGES = 2;
const BLD_MAX_EXPOS_PAGES = 6;        /* 전유부 100건×6 = 600호실까지 */
const BLD_MAX_FLOOR_PAGES = 3;
/* 골목형상점가 면적 상한 — 중기부 2026.08 가이드라인(전국 공통). 넘으면 비례 인정 없이 지정 불가 */
const AREA_CAP_M2 = 2000;
const AREA_CAP_BASIS = '중소벤처기업부 2026.08 가이드라인(전국 공통) 2,000㎡ 절대 상한 — 초과 시 비례 인정 없이 지정 불가, 면적은 건물 내 점포 전용면적 합산';
/* 부대설비(점포 아님) — 층별개요의 용도가 이것뿐이면 영업면적에서 뺀다 */
const BLD_ANCILLARY = /(주차장|주차|기계실|전기실|발전실|변전실|창고|계단실|승강기|엘리베이터|화장실|정화조|저수조|관리사무소|경비실|보일러실|펌프실|공조실|방재실|쓰레기|차고)/;
const BLD_RESIDENTIAL = /(공동주택|단독주택|아파트|다세대|다가구|연립|기숙사|오피스텔|주거)/;

/* 경계 상자 안전가드 — 신청 구역(2,000㎡ 급)보다 넉넉하되, 시 단위 요청은 막는다 */
const AREA_MAX_SIDE_DEG = 0.04;        // 한 변 약 4.4km
const AREA_MAX_SPAN_DEG2 = 0.0016;     // 약 4km × 4km
const PAGE_SIZE = 100;
const AREA_MAX_PAGE = 4;
const AREA_MAX_FEATURES = 240;
const AREA_MAX_POINTS = 12000;

/* 레이트리밋 바인딩이 없을 때 쓰는 프로세스 안 폴백(아이솔레이트 단위라 근사치) */
const MEMO_LIMIT = 20, MEMO_WINDOW_MS = 60000;
const memoHits = new Map();

/* 국토교통부 용도지역 표준코드 → 이름 (VWorld/토지이음 공통) */
const ZONE_NAMES = {
  UQA111: '제1종전용주거지역', UQA112: '제2종전용주거지역',
  UQA121: '제1종일반주거지역', UQA122: '제2종일반주거지역', UQA123: '제3종일반주거지역', UQA130: '준주거지역',
  UQA210: '중심상업지역', UQA220: '일반상업지역', UQA230: '근린상업지역', UQA240: '유통상업지역',
  UQA310: '전용공업지역', UQA320: '일반공업지역', UQA330: '준공업지역',
  UQA410: '보전녹지지역', UQA420: '생산녹지지역', UQA430: '자연녹지지역',
  UQB001: '관리지역', UQB100: '계획관리지역', UQB200: '생산관리지역', UQB300: '보전관리지역',
  UQC001: '농림지역', UQD001: '자연환경보전지역',
  /* 개별 용도지역이 특정되지 않은 묶음 코드 — 이름만 돌려주고 상업/비상업은 확정하지 않는다 */
  UQA100: '주거지역', UQA110: '전용주거지역', UQA120: '일반주거지역',
  UQA200: '상업지역', UQA300: '공업지역', UQA400: '녹지지역',
};
/* 용도지역 판정에서 빼는 코드 — 도시지역 경계, 도로, 지구단위계획구역 등 */
const ZONE_SKIP = new Set(['UQA000', 'UQA001', 'UQA01X', 'UQA500', 'UQA999', 'UQE000', 'UQE999', 'UQP999']);
const PNU_RE = /^\d{19}$/;

function kindOf(name) {
  const n = String(name || '').replace(/\s+/g, '');
  if (COMMERCIAL.test(n)) return 'commercial';
  if (NONCOMMERCIAL.test(n)) return 'noncommercial';
  return '';
}

function allowedOrigins(env) {
  return String(env.SITE_ORIGINS || env.SITE_ORIGIN || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

function zoneName(properties) {
  const raw = properties?.uname ?? properties?.UNAME ?? properties?.uname2 ?? '';
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || name.length > 80) throw new Error('Missing VWorld zoning name');
  return name;
}

async function vworld(params, env) {
  const qs = new URLSearchParams({
    service: 'data', request: 'GetFeature', version: '2.0',
    format: 'json', crs: 'EPSG:4326',
    domain: env.VWORLD_DOMAIN, key: env.VWORLD_API_KEY, ...params,
  });
  const response = await fetch(`${UPSTREAM}?${qs}`, {
    /* Workers는 redirect:'error'를 받지 않는다(manual/follow만 허용) — 3xx는 아래 ok 검사에서 실패로 처리된다 */
    signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual',
  });
  if (!response.ok) throw new Error('VWorld HTTP error');
  const body = await response.json();
  const result = body && body.response;
  if (!result || !result.status) throw new Error('VWorld response shape');
  return result;
}

/* ---- 점포 핀 좌표 → 용도지역 이름 (브이월드) ---- */
async function lookupPoint(lng, lat, env) {
  const answers = await Promise.all(LAYERS.map(data => vworld({
    data, geomFilter: `POINT(${lng} ${lat})`, geometry: 'false', attribute: 'true',
    size: '20', page: '1',
  }, env)));
  const names = [];
  for (const res of answers) {
    if (res.status === 'NOT_FOUND') continue;
    const features = res.result?.featureCollection?.features;
    if (res.status !== 'OK' || !Array.isArray(features)) throw new Error('Invalid VWorld response');
    if (Number(res.page?.total ?? 1) > 1 || features.length >= 20) throw new Error('Incomplete VWorld response');
    for (const { properties } of features) names.push(zoneName(properties));
  }
  return [...new Set(names)].sort();
}

/* ---- 점포 필지(PNU) → 용도지역 이름 (토지이음 폴백) ----
 * 토지이음 토지이용계획 열람은 로그인·키 없이 HTML을 돌려주고,
 * `var sehUcodeListExt = "[{ucode=UQA220, uname=일반상업지역}, ...]"` 안에 판정 결과가 들어 있다.
 * 응답은 EUC-KR이므로 코드(ASCII)는 바이트에서 그대로 읽고, 이름은 표준코드 표를 우선 쓴다. */
function decodeEum(buffer) {
  try {
    return new TextDecoder('euc-kr', { fatal: false }).decode(buffer);
  } catch {
    const bytes = new Uint8Array(buffer);
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return out;
  }
}

async function lookupEum(pnu) {
  const response = await fetch(`${EUM_URL}?pnu=${pnu}&mode=search&isNoScr=script`, {
    signal: AbortSignal.timeout(EUM_TIMEOUT_MS),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': 'https://www.eum.go.kr/',
    },
  });
  if (!response.ok) return { status: 'blocked', http: response.status };
  const text = decodeEum(await response.arrayBuffer());
  if (!/name="uCodeUse"/.test(text)) return { status: 'not_found', http: response.status };
  const list = (text.match(/sehUcodeListExt\s*=\s*"([^"]*)"/) || [])[1] || '';
  if (!/ucode=/.test(list)) return { status: 'not_found', http: response.status };
  const parsed = new Map();
  for (const m of list.matchAll(/ucode=([A-Z0-9]{5,6})\s*,\s*uname=([^},]{1,40})/g)) {
    parsed.set(m[1], m[2].trim());
  }
  const names = [];
  for (const m of list.matchAll(/ucode=([A-Z0-9]{5,6})/g)) {
    const code = m[1];
    if (ZONE_SKIP.has(code)) continue;
    /* 용도지역 코드만 남긴다 — 지구·구역·도로(UQP·UQQ·UQS…)는 용도지역 판정 대상이 아니다 */
    if (!ZONE_NAMES[code] && !/^UQ[ABCD]\d{3}$/.test(code)) continue;
    const name = ZONE_NAMES[code] || parsed.get(code) || '';
    if (name && !names.includes(name)) names.push(name);
  }
  return { status: names.length ? 'ok' : 'empty', names: names.sort(), http: response.status };
}

/* ---- 신청 구역 경계 상자 → 용도지역 도형 ---- */
function isPoint(a) { return Array.isArray(a) && Number.isFinite(+a[0]) && Number.isFinite(+a[1]); }
function isRing(a) { return Array.isArray(a) && a.length > 0 && isPoint(a[0]); }
function isPoly(a) { return Array.isArray(a) && a.length > 0 && isRing(a[0]); }

function polygonsOf(geometry) {
  const coords = geometry?.coordinates;
  if (!Array.isArray(coords) || !coords.length) return [];
  if (isPoly(coords[0])) return coords;          // MultiPolygon: [polygon][ring][point]
  if (isRing(coords[0])) return [coords];        // Polygon: [ring][point]
  return [];
}

/* 좌표 순서를 국내 범위(경도 124~132, 위도 32~39)로 정규화한다.
   브이월드가 crs에 따라 [위도, 경도]로 줄 때를 대비한 안전장치. */
function pointPair(p) {
  const a = +p[0], b = +p[1];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const aLng = a >= 124 && a <= 132, bLat = b >= 32 && b <= 39;
  if (aLng && bLat) return [a, b];
  const aLat = a >= 32 && a <= 39, bLng = b >= 124 && b <= 132;
  if (aLat && bLng) return [b, a];
  return null;
}

async function lookupArea(bbox, env) {
  const zones = [];
  let points = 0;
  const geomFilter = `BOX(${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]})`;
  for (const layer of LAYERS) {
    for (let page = 1; page <= AREA_MAX_PAGE; page++) {
      const res = await vworld({
        data: layer, geomFilter, geometry: 'true', attribute: 'true',
        size: String(PAGE_SIZE), page: String(page),
      }, env);
      if (res.status === 'NOT_FOUND') break;
      const features = res.result?.featureCollection?.features;
      if (res.status !== 'OK' || !Array.isArray(features)) throw new Error('Invalid VWorld response');
      if (!features.length) break;
      for (const feature of features) {
        const name = zoneName(feature.properties);
        const kind = kindOf(name);
        for (const poly of polygonsOf(feature.geometry)) {
          const rings = poly
            .map(ring => ring.map(pointPair).filter(Boolean))
            .filter(ring => ring.length >= 3);
          if (!rings.length) continue;
          const size = rings.reduce((n, ring) => n + ring.length, 0);
          /* 조각이 너무 많으면 일부만 돌려주지 않고 실패로 알린다 — 잘린 도형은 면적을 틀리게 만든다 */
          if (zones.length >= AREA_MAX_FEATURES || points + size > AREA_MAX_POINTS) {
            throw Object.assign(new Error('too_many'), { code: 'too_many' });
          }
          points += size;
          zones.push({ name, kind, outer: rings[0], holes: rings.slice(1) });
        }
      }
      const total = Number(res.page?.total ?? 1);
      if (features.length < PAGE_SIZE || page >= total) break;
    }
  }
  return zones;
}

/* ---- 조회 빈도 제한 ---- */
function memoAllow(key) {
  const now = Date.now();
  const hit = memoHits.get(key);
  if (!hit || now - hit.start > MEMO_WINDOW_MS) { memoHits.set(key, { start: now, n: 1 }); return true; }
  hit.n += 1;
  if (memoHits.size > 5000) memoHits.clear();
  return hit.n <= MEMO_LIMIT;
}

async function allowLookup(env, key) {
  const limiter = env.LOOKUP_LIMIT;
  if (limiter && typeof limiter.limit === 'function') {
    try {
      const { success } = await limiter.limit({ key });
      if (!success) return false;
    } catch { /* 바인딩이 응답하지 않으면 폴백으로 계속한다 */ }
  }
  /* 바인딩은 데이터센터 단위 근사치라 한 곳에서 몰아 부르면 새는 경우가 있다 — 초과는 여기서도 막는다 */
  return memoAllow(key);
}

/* ---- 상가(상권)정보: 다각형 안 상가업소 ---- */
const SEMAS_POLY_RE = /^POLYGON\s*\(\(([^()]*)\)\)$/i;
const numOr = v => { const n = +v; return Number.isFinite(n) ? n : null; };

/* POLYGON((lng lat,lng lat,...)) 문자열 검증 — 좌표 수·국내 범위·경계 상자 크기 */
function parsePolygon(raw) {
  const m = SEMAS_POLY_RE.exec(String(raw == null ? '' : raw).trim());
  if (!m) return null;
  const tokens = m[1].split(',').map(t => t.trim()).filter(Boolean);
  if (tokens.length < 3 || tokens.length > SEMAS_MAX_POINTS) return null;
  const pts = [];
  for (const token of tokens) {
    const parts = token.split(/\s+/).map(Number);
    if (parts.length !== 2 || !parts.every(Number.isFinite)) return null;
    const [lng, lat] = parts;
    if (lng < 124 || lng > 132 || lat < 32 || lat > 39) return null;
    pts.push([lng, lat]);
  }
  const lngs = pts.map(p => p[0]), lats = pts.map(p => p[1]);
  const w = Math.min(...lngs), e = Math.max(...lngs), s = Math.min(...lats), n = Math.max(...lats);
  if (e - w > AREA_MAX_SIDE_DEG || n - s > AREA_MAX_SIDE_DEG) return null;
  if ((e - w) * (n - s) > AREA_MAX_SPAN_DEG2) return null;
  return pts;
}

function semasPolygonWkt(pts) {
  const ring = pts.map(([lng, lat]) => `${lng.toFixed(7)} ${lat.toFixed(7)}`);
  if (ring.length) ring.push(ring[0]);              /* 닫힌 고리로 보낸다 */
  return `POLYGON((${ring.join(',')}))`;
}

async function semasCall(base, params, env) {
  const qs = new URLSearchParams({ serviceKey: env.SEMAS_API_KEY, type: 'json', ...params });
  const response = await fetch(`${base}?${qs}`, {
    signal: AbortSignal.timeout(SEMAS_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error('semas http'), { code: 'upstream' });
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  /* 게이트웨이가 XML 오류(OpenAPI_ServiceResponse)를 200으로 돌려주는 경우가 있다 */
  if (!body || typeof body !== 'object' || body.OpenAPI_ServiceResponse || !body.header) {
    throw Object.assign(new Error('semas gateway'), { code: 'upstream' });
  }
  return body;
}

function semasStore(raw) {
  const s = raw || {};
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  return {
    bizesId: str(s.bizesId, 30), bizesNm: str(s.bizesNm, 80), brchNm: str(s.brchNm, 40),
    indsLclsNm: str(s.indsLclsNm, 20), indsMclsNm: str(s.indsMclsNm, 20), indsSclsNm: str(s.indsSclsNm, 30),
    ksicNm: str(s.ksicNm, 60),
    rdnmAdr: str(s.rdnmAdr, 120), lnoAdr: str(s.lnoAdr, 120), bldNm: str(s.bldNm, 60),
    flrNo: str(s.flrNo, 12), hoNo: str(s.hoNo, 12),
    lon: numOr(s.lon), lat: numOr(s.lat),
  };
}

async function semasStores(pts, pageNo, numOfRows, env) {
  const key = semasPolygonWkt(pts);
  const items = [];
  let totalCount = 0, stdrYm = '', page = pageNo;
  for (let i = 0; i < SEMAS_MAX_PAGES; i++) {
    const body = await semasCall(SEMAS_STORE_URL, { key, pageNo: String(page), numOfRows: String(numOfRows) }, env);
    const header = body.header || {};
    const code = String(header.resultCode == null ? '' : header.resultCode);
    if (!stdrYm) stdrYm = String(header.stdrYm || '');
    if (code === '03') break;                        /* NODATA_ERROR — 구역 안 상가 없음 */
    if (code !== '00') throw Object.assign(new Error('semas result ' + code), { code: 'upstream' });
    const bodyData = body.body || {};
    const rows = Array.isArray(bodyData.items) ? bodyData.items
      : (bodyData.items && typeof bodyData.items === 'object' ? [bodyData.items] : []);
    totalCount = Math.max(totalCount, Number(bodyData.totalCount || 0));
    for (const row of rows) items.push(semasStore(row));
    if (items.length >= totalCount || rows.length < numOfRows) break;
    page += 1;
  }
  return { status: items.length ? 'ok' : 'empty', stdrYm, totalCount: Math.max(totalCount, items.length), items,
    returned: items.length, truncated: items.length < Math.max(totalCount, items.length) };
}

async function semasZones(cx, cy, radius, env) {
  const body = await semasCall(SEMAS_ZONE_URL, { cx: String(cx), cy: String(cy), radius: String(radius) }, env);
  const header = body.header || {};
  const code = String(header.resultCode == null ? '' : header.resultCode);
  if (code === '03') return { status: 'empty', zones: [], totalCount: 0 };
  if (code !== '00') throw Object.assign(new Error('semas result ' + code), { code: 'upstream' });
  const rows = Array.isArray(body.body?.items) ? body.body.items : [];
  const zones = rows.slice(0, 40).map(z => ({
    trarNo: String(z.trarNo || ''), name: String(z.mainTrarNm || '').slice(0, 80),
    area: numOr(z.trarArea), coords: String(z.coords || '').slice(0, 4000),
  }));
  return { status: zones.length ? 'ok' : 'empty', zones, totalCount: rows.length };
}

/* ---- 건축물대장: 19자리 PNU → 시군구·법정동·대지구분·번·지 ---- */
function pnuParts(pnu) {
  if (!PNU_RE.test(String(pnu || ''))) return null;
  const gb = { '1': '0', '2': '1', '3': '2' }[pnu[10]];   /* 1 대지 · 2 산 · 3 블록 */
  if (!gb) return null;
  return { sigunguCd: pnu.slice(0, 5), bjdongCd: pnu.slice(5, 10), platGbCd: gb, bun: pnu.slice(11, 15), ji: pnu.slice(15, 19) };
}

async function bldCall(op, params, env) {
  const qs = new URLSearchParams({ serviceKey: env.SEMAS_API_KEY, _type: 'json', ...params });
  const response = await fetch(`${BLD_URL}/${op}?${qs}`, {
    signal: AbortSignal.timeout(BLD_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error('bld http'), { code: 'upstream' });
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  /* 게이트웨이가 XML 오류(OpenAPI_ServiceResponse)를 200으로 돌려주는 경우가 있다 */
  if (!body || typeof body !== 'object' || body.OpenAPI_ServiceResponse || !body.response) {
    throw Object.assign(new Error('bld gateway'), { code: 'upstream' });
  }
  const header = body.response.header || {};
  const code = String(header.resultCode == null ? '' : header.resultCode);
  if (code === '03') return { status: 'empty', rows: [], total: 0 };          /* NODATA_ERROR */
  if (code !== '00') throw Object.assign(new Error('bld result ' + code), { code: 'upstream' });
  const b = body.response.body || {};
  const raw = b.items && b.items.item;
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return { status: rows.length ? 'ok' : 'empty', rows, total: Number(b.totalCount || rows.length) };
}

/* 여러 페이지를 순서대로 받는다 — 건축물대장은 초당 요청 제한이 있어 동시 호출을 피한다 */
async function bldPages(op, parts, maxPages, env) {
  const rows = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const out = await bldCall(op, { ...parts, numOfRows: String(BLD_PAGE_ROWS), pageNo: String(page) }, env);
    total = Math.max(total, out.total);
    for (const row of out.rows) rows.push(row);
    if (!out.rows.length || out.rows.length < BLD_PAGE_ROWS || rows.length >= total) break;
    await new Promise(r => setTimeout(r, 80));
  }
  return { rows, total, truncated: rows.length < total };
}

const bldText = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
/* 층 이름 — '지2층'처럼 적힌 지하 표기를 '지하2층'으로 맞춘다 */
function floorLabel(row) {
  const raw = bldText(row.flrNoNm || `${row.flrGbCdNm || ''}${row.flrNo || ''}층`, 24) || '층 미상';
  return raw.replace(/^지(\d)/, '지하$1');
}
const bldNum = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
const purposesOf = row => [row.mainPurpsCdNm, row.etcPurps]
  .flatMap(v => String(v == null ? ' ' : v).split(/[,()]/))
  .map(s => s.trim()).filter(Boolean);
function bldKindOf(row) {
  const list = purposesOf(row);
  const main = bldText(row.mainPurpsCdNm, 40);
  const etc = String(row.etcPurps == null ? '' : row.etcPurps).split(/[,()]/).map(s => s.trim()).filter(Boolean);
  /* 용도 중 부대설비만 있는 층(주차장·기계실·전기실)은 점포 면적이 아니다.
     etcPurps 가 부대설비만 나열하면(대표 용도가 '소매점'으로 적혀 있어도) 부대설비 층으로 본다. */
  if (list.length && list.every(t => BLD_ANCILLARY.test(t))) return 'ancillary';
  if (etc.length && etc.every(t => BLD_ANCILLARY.test(t))) return 'ancillary';
  if (BLD_RESIDENTIAL.test(main)) return 'residential';
  return 'shop';
}
const round2 = n => Math.round(n * 100) / 100;

function summarizeBuilding(titleRows, expos, floors, pnu) {
  const heads = titleRows.filter(r => String(r.regstrGbCd) === '1' || String(r.regstrGbCd) === '2');
  const aggregate = heads.some(r => String(r.regstrGbCd) === '2');
  const names = [...new Set(heads.map(r => bldText(r.bldNm, 60)).filter(Boolean))];
  const addresses = [...new Set(heads.map(r => bldText(r.newPlatPlc || r.platPlc, 90)).filter(Boolean))];
  const purposes = [...new Set(heads.map(r => bldText(r.mainPurpsCdNm, 30)).filter(Boolean))];
  const building = {
    pnu,
    kind: aggregate ? 'aggregate' : 'general',
    kindLabel: aggregate ? '집합건축물' : '일반건축물',
    name: names.join(' · ').slice(0, 90),
    address: addresses[0] || '',
    mainPurps: purposes.slice(0, 4).join(' · ').slice(0, 80),
    platArea: round2(heads.reduce((n, r) => Math.max(n, bldNum(r.platArea)), 0)),
    totalArea: round2(heads.reduce((n, r) => n + bldNum(r.totArea), 0)),
    groundFloors: heads.reduce((n, r) => Math.max(n, bldNum(r.grndFlrCnt)), 0),
    underFloors: heads.reduce((n, r) => Math.max(n, bldNum(r.ugrndFlrCnt)), 0),
    dongs: heads.length,
    hasExpos: aggregate,
    useAprDay: bldText((heads[0] || {}).useAprDay, 8),
  };

  let shopArea = 0, shopUnits = 0, residentialArea = 0, otherArea = 0, above = 0, under = 0;
  const floorMap = new Map();
  const notes = [];
  if (aggregate) {
    /* 집합건축물 — 전유부(호실별 전용면적)만 쓴다. 공용면적은 합산에서 뺀다. */
    const privateRows = expos.rows.filter(r => String(r.exposPubuseGbCd) === '1');
    const units = new Set();
    for (const row of privateRows) {
      const area = bldNum(row.area);
      const kind = bldKindOf(row);
      const label = floorLabel(row);
      const key = label;
      const bucket = floorMap.get(key) || { label, shop: 0, residential: 0, other: 0, units: 0 };
      bucket.units += 1;
      units.add([bldText(row.dongNm, 12), bldText(row.hoNm, 12), label].join('|'));
      if (kind === 'shop') { shopArea += area; bucket.shop += area; if (/지하/.test(label)) under += area; else above += area; }
      else if (kind === 'residential') { residentialArea += area; bucket.residential += area; }
      else { otherArea += area; bucket.other += area; }
      floorMap.set(key, bucket);
    }
    shopUnits = units.size;
    if (expos.truncated) notes.push(`전유부가 ${expos.rows.length}/${expos.total}건까지만 조회되어 합계가 실제보다 적을 수 있습니다.`);
    if (!privateRows.length) notes.push('전유부(호실별 면적)가 등록되어 있지 않습니다 — 관리사무소·건축물대장 열람으로 확인이 필요합니다.');
  } else {
    /* 일반건축물 — 층별개요. 대장에 호실별 전유면적이 없어 전용면적을 알 수 없다. */
    for (const row of floors.rows) {
      const area = bldNum(row.area);
      const kind = bldKindOf(row);
      const ground = String(row.flrGbCdNm || '').includes('지상');
      const label = floorLabel(row);
      const bucket = floorMap.get(label) || { label, shop: 0, residential: 0, other: 0, units: 0, purposes: new Set() };
      bucket.purposes.add(bldText(row.mainPurpsCdNm, 30));
      if (kind === 'shop') { shopArea += area; bucket.shop += area; ground ? above += area : under += area; }
      else if (kind === 'residential') { residentialArea += area; bucket.residential += area; }
      else { otherArea += area; bucket.other += area; }
      floorMap.set(label, bucket);
    }
    if (floors.truncated) notes.push(`층별개요가 ${floors.rows.length}/${floors.total}건까지만 조회되어 합계가 실제보다 적을 수 있습니다.`);
    notes.push('일반건축물은 건축물대장에 호실별 전유면적이 없습니다 — 위 합계는 층별개요의 바닥면적 합계이며, 실제 임대 전용면적은 임대차계약서로 확인해야 합니다.');
  }

  /* 층 정렬 — 지상은 높은 층부터, 지하는 낮은 층부터. '지2층' 표기도 지하로 본다. */
  const order = x => {
    const under = /(지하|^지)/.test(x.label);
    const n = +(String(x.label).replace(/[^0-9]/g, '') || 0);
    return (under ? -n : n) * 10 + (under ? 1 : 0);
  };
  const floorList = [...floorMap.values()].map(f => ({
    label: f.label,
    area: round2(f.shop),
    residential: round2(f.residential),
    other: round2(f.other),
    units: f.units || 0,
    kind: f.shop >= Math.max(f.residential, f.other) && f.shop > 0 ? 'shop' : f.residential > f.other ? 'residential' : 'ancillary',
    purposes: f.purposes ? [...f.purposes].filter(Boolean).slice(0, 3) : undefined,
  })).sort((a, b) => (order(b) - order(a)) || String(a.label).localeCompare(String(b.label))).slice(0, 40);

  const totalShop = round2(shopArea);
  const estimatedExclusive = aggregate ? totalShop : round2(totalShop * 0.8);
  const shops = {
    area: totalShop,
    aboveGround: round2(above),
    underground: round2(under),
    units: aggregate ? shopUnits : null,
    estimatedExclusive,
    exclusiveBasis: aggregate ? '전유면적(공용 제외)' : '층별 바닥면적 − 공용부 20% 참고치',
    residentialArea: round2(residentialArea),
    otherArea: round2(otherArea),
    over2000: totalShop > AREA_CAP_M2,
    excess: round2(Math.max(0, totalShop - AREA_CAP_M2)),
  };
  return { building, shops, floors: floorList, notes };
}

function parseBbox(raw) {
  const parts = String(raw || '').split(',').map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [w, s, e, n] = parts;
  if (!(w >= 124 && e <= 132 && s >= 32 && n <= 39) || !(e > w) || !(n > s)) return null;
  if (e - w > AREA_MAX_SIDE_DEG || n - s > AREA_MAX_SIDE_DEG) return null;
  if ((e - w) * (n - s) > AREA_MAX_SPAN_DEG2) return null;
  return [w, s, e, n];
}

async function lookupBuilding(pnu, env) {
  const parts = pnuParts(pnu);
  if (!parts) return { status: 'coordinate' };
  const title = await bldPages('getBrTitleInfo', parts, BLD_MAX_TITLE_PAGES, env);
  if (!title.rows.length) return { status: 'not_found' };
  const aggregate = title.rows.some(r => String(r.regstrGbCd) === '2');
  let expos = { rows: [], total: 0, truncated: false };
  let floors = { rows: [], total: 0, truncated: false };
  if (aggregate) expos = await bldPages('getBrExposPubuseAreaInfo', parts, BLD_MAX_EXPOS_PAGES, env);
  else floors = await bldPages('getBrFlrOulnInfo', parts, BLD_MAX_FLOOR_PAGES, env);
  const sum = summarizeBuilding(title.rows, expos, floors, pnu);
  if (title.truncated) sum.notes.push(`표제부가 ${title.rows.length}/${title.total}건까지만 조회되어 일부 동이 빠졌을 수 있습니다.`);
  const cap = {
    limit: AREA_CAP_M2, basis: AREA_CAP_BASIS,
    exceeded: sum.shops.area > AREA_CAP_M2, excess: sum.shops.excess,
    verdict: sum.shops.area > AREA_CAP_M2
      ? `건물 점포 전용면적 합계 ${round2(sum.shops.area)}㎡ — 2,000㎡ 상한을 ${sum.shops.excess}㎡ 초과해 현행 기준으로는 지정 불가(구역 축소·분할 필요)`
      : `건물 점포 전용면적 합계 ${round2(sum.shops.area)}㎡ — 2,000㎡ 상한 이내`,
  };
  return { status: 'ok', source: 'bldrgst', pnu, building: sum.building, shops: sum.shops, floors: sum.floors, cap, notes: sum.notes };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allow = allowedOrigins(env);
    const matched = origin && allow.includes(origin) ? origin : '';
    const headers = { Vary: 'Origin', 'Cache-Control': 'no-store' };
    if (matched) {
      headers['Access-Control-Allow-Origin'] = matched;
      headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
      headers['Access-Control-Max-Age'] = '86400';
    }
    const reply = (status, body) => Response.json(body, { status, headers });

    /* CORS 프리플라이트 — 헤더만 돌려주고 본문은 비운다 */
    if (request.method === 'OPTIONS') {
      if (!matched) return new Response(null, { status: 403, headers });
      return new Response(null, { status: 204, headers });
    }

    /* ---- /building — 국토교통부 건축HUB 건축물대장(표제부·전유부·층별개요) ---- */
    if (url.pathname === '/building') {
      if (request.method !== 'GET') return reply(405, { status: 'method' });
      if (!matched) return reply(403, { status: 'origin' });
      if (!env.SEMAS_API_KEY) return reply(503, { status: 'unavailable', source: 'bldrgst' });
      const pnu = String(url.searchParams.get('pnu') || '');
      if (!pnuParts(pnu)) return reply(400, { status: 'coordinate' });
      if (!await allowLookup(env, request.headers.get('CF-Connecting-IP') || 'unknown')) {
        return reply(429, { status: 'rate_limit' });
      }
      const checkedAt = new Date().toISOString();
      try {
        const out = await lookupBuilding(pnu, env);
        if (out.status === 'not_found') return reply(404, { status: 'not_found', source: 'bldrgst' });
        return reply(200, { ...out, checkedAt });
      } catch {
        return reply(502, { status: 'upstream', source: 'bldrgst' });
      }
    }

    /* ---- /semas — 공단 상가(상권)정보 다각형·반경 조회 ---- */
    if (url.pathname === '/semas') {
      if (request.method !== 'GET') return reply(405, { status: 'method' });
      if (!matched) return reply(403, { status: 'origin' });
      if (!env.SEMAS_API_KEY) return reply(503, { status: 'unavailable', source: 'semas' });
      if (!await allowLookup(env, request.headers.get('CF-Connecting-IP') || 'unknown')) {
        return reply(429, { status: 'rate_limit' });
      }
      const sMode = url.searchParams.get('mode') || 'polygon';
      const checkedAt = new Date().toISOString();
      if (sMode === 'polygon') {
        const pts = parsePolygon(url.searchParams.get('key'));
        if (!pts) return reply(400, { status: 'coordinate' });
        const pageNo = Math.max(1, Math.min(100, Math.floor(+url.searchParams.get('pageNo') || 1)));
        const numOfRows = Math.max(1, Math.min(SEMAS_MAX_ROWS, Math.floor(+url.searchParams.get('numOfRows') || SEMAS_MAX_ROWS)));
        try {
          const out = await semasStores(pts, pageNo, numOfRows, env);
          return reply(200, { ...out, source: 'semas', mode: 'polygon', pageNo, numOfRows, checkedAt });
        } catch {
          return reply(502, { status: 'upstream', source: 'semas', mode: 'polygon' });
        }
      }
      if (sMode === 'zones') {
        const cx = Number(url.searchParams.get('cx')), cy = Number(url.searchParams.get('cy'));
        const radius = Number(url.searchParams.get('radius'));
        const ptOk = Number.isFinite(cx) && Number.isFinite(cy) && cx >= 124 && cx <= 132 && cy >= 32 && cy <= 39;
        if (!ptOk || !(radius > 0 && radius <= SEMAS_RADIUS_MAX)) return reply(400, { status: 'coordinate' });
        try {
          const out = await semasZones(cx, cy, radius, env);
          return reply(200, { ...out, source: 'semas', mode: 'zones', radius, checkedAt });
        } catch {
          return reply(502, { status: 'upstream', source: 'semas', mode: 'zones' });
        }
      }
      return reply(400, { status: 'mode' });
    }

    if (url.pathname !== '/zoning') return reply(404, { status: 'not_found' });
    if (request.method !== 'GET') return reply(405, { status: 'method' });
    if (!matched) return reply(403, { status: 'origin' });

    const mode = url.searchParams.get('mode') || 'point';
    if (mode !== 'point' && mode !== 'area') return reply(400, { status: 'mode' });
    const vworldReady = !!(env.VWORLD_API_KEY && env.VWORLD_DOMAIN);

    if (!await allowLookup(env, request.headers.get('CF-Connecting-IP') || 'unknown')) {
      return reply(429, { status: 'rate_limit' });
    }

    if (mode === 'area') {
      if (!vworldReady) return reply(503, { status: 'unavailable', source: 'vworld' });
      const bbox = parseBbox(url.searchParams.get('bbox'));
      if (!bbox) return reply(400, { status: 'coordinate' });
      try {
        const zones = await lookupArea(bbox, env);
        return reply(200, {
          status: zones.length ? 'ok' : 'empty',
          source: 'vworld', zones, checkedAt: new Date().toISOString(),
        });
      } catch (err) {
        if (err && err.code === 'too_many') return reply(413, { status: 'too_many' });
        return reply(502, { status: 'upstream', source: 'vworld' });
      }
    }

    /* 점포 핀 — 브이월드(키 있을 때) → 실패·무응답이면 토지이음(키 불필요) */
    const pnu = String(url.searchParams.get('pnu') || '');
    const hasPnu = PNU_RE.test(pnu);
    const lng = Number(url.searchParams.get('lng'));
    const lat = Number(url.searchParams.get('lat'));
    const hasPoint = url.searchParams.has('lng') && url.searchParams.has('lat');
    const pointOk = hasPoint && lng >= 124 && lng <= 132 && lat >= 32 && lat <= 39;
    if (!pointOk && !hasPnu) return reply(400, { status: 'coordinate' });

    let vworldError = '';
    if (vworldReady && pointOk) {
      try {
        const names = await lookupPoint(lng, lat, env);
        if (names.length || !hasPnu) {
          return reply(200, {
            status: names.length ? 'ok' : 'empty',
            source: 'vworld', names, checkedAt: new Date().toISOString(),
          });
        }
      } catch { vworldError = 'upstream'; }
    } else if (vworldReady) {
      vworldError = 'coordinate';
    }

    if (hasPnu) {
      try {
        const eum = await lookupEum(pnu);
        if (eum.status === 'ok' || eum.status === 'empty') {
          return reply(200, {
            status: eum.status, source: 'eum', names: eum.names || [], checkedAt: new Date().toISOString(),
          });
        }
        if (eum.status === 'not_found') return reply(404, { status: 'not_found', source: 'eum' });
        return reply(502, { status: 'blocked', source: 'eum', http: eum.http, vworld: vworldError || 'off' });
      } catch {
        return reply(502, { status: 'upstream', source: 'eum', vworld: vworldError || 'off' });
      }
    }
    return reply(503, { status: 'unavailable', source: 'vworld' });
  },
};
