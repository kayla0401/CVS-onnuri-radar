const layers = ['LT_C_UQ111', 'LT_C_UQ112', 'LT_C_UQ113', 'LT_C_UQ114'];

async function lookupLayer(data, lng, lat, env) {
  const params = new URLSearchParams({
    service: 'data', request: 'GetFeature', version: '2.0',
    data, geomFilter: `POINT(${lng} ${lat})`, geometry: 'false',
    attribute: 'true', size: '20', page: '1', format: 'json',
    crs: 'EPSG:4326', domain: env.VWORLD_DOMAIN, key: env.VWORLD_API_KEY,
  });
  const response = await fetch(`https://api.vworld.kr/req/data?${params}`, {
    signal: AbortSignal.timeout(6500), redirect: 'error',
  });
  if (!response.ok) throw new Error('VWorld HTTP error');
  const { response: result } = await response.json();
  if (result?.status === 'NOT_FOUND') return [];
  const features = result?.result?.featureCollection?.features;
  if (result?.status !== 'OK' || !Array.isArray(features) || !features.length ||
      Number(result.page?.total ?? 1) > 1 || features.length >= 20) {
    throw new Error('Invalid or incomplete VWorld response');
  }

  return features.map(({ properties }) => {
    const name = properties?.uname ?? properties?.UNAME;
    if (typeof name !== 'string' || !name.trim() || name.length > 80) {
      throw new Error('Missing VWorld zoning name');
    }
    return name.trim();
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const headers = { 'Vary': 'Origin', 'Cache-Control': 'no-store' };
    if (origin === env.SITE_ORIGIN) headers['Access-Control-Allow-Origin'] = origin;
    const reply = (status, body) => Response.json(body, { status, headers });

    if (url.pathname !== '/zoning') return reply(404, { status: 'not_found' });
    if (request.method !== 'GET') return reply(405, { status: 'method' });
    if (origin !== env.SITE_ORIGIN) return reply(403, { status: 'origin' });

    const lng = Number(url.searchParams.get('lng'));
    const lat = Number(url.searchParams.get('lat'));
    if (!(lng >= 124 && lng <= 132 && lat >= 32 && lat <= 39)) {
      return reply(400, { status: 'coordinate' });
    }
    if (!env.VWORLD_API_KEY || !env.VWORLD_DOMAIN) return reply(503, { status: 'unavailable' });

    const { success } = await env.LOOKUP_LIMIT.limit({
      key: request.headers.get('CF-Connecting-IP') || 'unknown',
    });
    if (!success) return reply(429, { status: 'rate_limit' });

    try {
      const names = [...new Set((await Promise.all(
        layers.map(layer => lookupLayer(layer, lng, lat, env))
      )).flat())].sort();
      return reply(200, { status: names.length ? 'ok' : 'empty', names, checkedAt: new Date().toISOString() });
    } catch {
      return reply(502, { status: 'upstream' });
    }
  },
};
