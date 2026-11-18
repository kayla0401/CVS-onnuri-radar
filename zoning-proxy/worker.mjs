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

function parseBbox(raw) {
  const parts = String(raw || '').split(',').map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [w, s, e, n] = parts;
  if (!(w >= 124 && e <= 132 && s >= 32 && n <= 39) || !(e > w) || !(n > s)) return null;
  if (e - w > AREA_MAX_SIDE_DEG || n - s > AREA_MAX_SIDE_DEG) return null;
  if ((e - w) * (n - s) > AREA_MAX_SPAN_DEG2) return null;
  return [w, s, e, n];
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
