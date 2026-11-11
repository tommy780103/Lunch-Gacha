import {
  SearchError, GLOBAL_OBJECT_NAME, GOOGLE_ENDPOINT, GOOGLE_FIELDS,
  validateSearchInput, readQuota, reserveQuota, googleSearchBody, normalizePlaces
} from './domain.mjs';

export const MAX_BODY_BYTES = 4096;

function failure(error) {
  const known = error instanceof SearchError;
  const body = { error: {
    code: known ? error.code : 'REQUEST_FAILED',
    message: known ? error.message : 'お店検索を安全に実行できませんでした。時間をおいてお試しください。'
  } };
  if (known && error.quota) body.quota = error.quota;
  return json(body, known ? error.status : 503);
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function assertConfigured(env) {
  if (env.SEARCH_ENABLED !== 'true' || typeof env.GOOGLE_PLACES_API_KEY !== 'string' || !env.GOOGLE_PLACES_API_KEY.trim()) {
    throw new SearchError('NOT_CONFIGURED', 503, 'お店検索は準備中です。通常のGoogleマップ検索をご利用ください。');
  }
}

export async function readBoundedJson(request) {
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new SearchError('INVALID_REQUEST', 400, 'JSON形式で検索条件を送信してください。');
  }
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new SearchError('INVALID_REQUEST', 400, '検索条件のサイズが大きすぎます。');
  }
  if (!request.body) throw new SearchError('INVALID_REQUEST', 400, '検索条件がありません。');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new SearchError('INVALID_REQUEST', 400, '検索条件のサイズが大きすぎます。');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof SearchError) throw error;
    throw new SearchError('INVALID_REQUEST', 400, '検索条件を読み取れませんでした。');
  } finally {
    reader.releaseLock();
  }
}

export async function executeSearch(rawInput, env, { storage, fetchImpl = fetch, now = () => new Date(), timeoutMs = 15000 }) {
  assertConfigured(env);
  const input = validateSearchInput(rawInput);
  // Reservation is durable before fetch, and is never refunded on any failure.
  const quota = await reserveQuota(storage, now());
  const controller = new AbortController();
  let timer;
  try {
    const operation = (async () => {
      // Workers does not support redirect: 'error'. Keep redirects manual so
      // the API key never follows a Location header; !response.ok rejects 3xx.
      const response = await fetchImpl(GOOGLE_ENDPOINT, {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
          'X-Goog-FieldMask': GOOGLE_FIELDS
        },
        body: JSON.stringify(googleSearchBody(input))
      });
      if (!response.ok) {
        throw new SearchError(response.status === 429 ? 'QUOTA_EXCEEDED' : 'REQUEST_FAILED', response.status === 429 ? 429 : 502,
          response.status === 429 ? 'Google側の検索上限に達しました。' : 'お店情報を取得できませんでした。', quota);
      }
      try { return { places: normalizePlaces(await response.json()), quota }; }
      catch { throw new SearchError('REQUEST_FAILED', 502, 'お店情報を読み取れませんでした。', quota); }
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SearchError('NETWORK', 503, 'お店検索がタイムアウトしました。', quota));
      }, timeoutMs);
    });
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (error instanceof SearchError) throw error;
    throw new SearchError('NETWORK', 503, 'お店検索に接続できませんでした。', quota);
  } finally {
    clearTimeout(timer);
  }
}

export async function handleQuotaRequest(request, env, dependencies) {
  try {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/quota') {
      return json({ quota: await readQuota(dependencies.storage, dependencies.now ? dependencies.now() : new Date()) });
    }
    if (request.method !== 'POST' || path !== '/search') {
      throw new SearchError('INVALID_REQUEST', 400, '検索リクエストが正しくありません。');
    }
    return json(await executeSearch(await readBoundedJson(request), env, dependencies));
  } catch (error) { return failure(error); }
}

function allowedOrigin(env) {
  if (typeof env.ALLOWED_ORIGIN !== 'string') return null;
  try {
    const url = new URL(env.ALLOWED_ORIGIN);
    return url.protocol === 'https:' && url.origin === env.ALLOWED_ORIGIN ? url.origin : null;
  } catch { return null; }
}

export async function handlePublicRequest(request, env) {
  const origin = allowedOrigin(env);
  if (!origin) return failure(new SearchError('NOT_CONFIGURED', 503, 'お店検索は準備中です。'));
  const path = new URL(request.url).pathname;
  const requestOrigin = request.headers.get('Origin');
  // Same-origin browser GETs may omit Origin. Access protects this read-only
  // route too; explicit origins and every search keep the exact-origin check.
  const originlessQuotaRead = path === '/quota' && request.method === 'GET' && requestOrigin === null;
  // CORS is a browser access policy, not authentication. The shared hard cap
  // protects the Google request count even if an attacker forges this header.
  if (!originlessQuotaRead && requestOrigin !== origin) {
    return failure(new SearchError('FORBIDDEN', 403, 'このサイトからは検索できません。'));
  }
  const cors = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': path === '/quota' ? 'GET, OPTIONS' : 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'Cache-Control': 'no-store'
  };
  let response;
  try {
    if (path !== '/search' && path !== '/quota') {
      throw new SearchError('INVALID_REQUEST', 404, 'このURLは利用できません。');
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let internalRequest;
    if (path === '/quota') {
      if (request.method !== 'GET') throw new SearchError('INVALID_REQUEST', 405, 'GETで利用回数を取得してください。');
      internalRequest = new Request('https://quota.internal/quota');
    } else {
      if (request.method !== 'POST') throw new SearchError('INVALID_REQUEST', 405, 'POSTで検索条件を送信してください。');
      assertConfigured(env);
      const input = validateSearchInput(await readBoundedJson(request));
      internalRequest = new Request('https://quota.internal/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
      });
    }
    if (!env.GLOBAL_QUOTA) throw new SearchError('NOT_CONFIGURED', 503, 'お店検索は準備中です。');
    const id = env.GLOBAL_QUOTA.idFromName(GLOBAL_OBJECT_NAME);
    const stub = env.GLOBAL_QUOTA.get(id);
    response = await stub.fetch(internalRequest);
  } catch (error) { response = failure(error); }
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

