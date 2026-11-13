import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SearchError, STATE_KEY, GLOBAL_OBJECT_NAME, GOOGLE_ENDPOINT, GOOGLE_FIELDS,
  billingPeriod, nextReservation, readQuota, reserveQuota, validateSearchInput, googleSearchBody, normalizePlaces
} from '../backend/domain.mjs';
import {
  executeSearch, handlePublicRequest, handleQuotaRequest, readBoundedJson
} from '../backend/server.mjs';

// Emulates the documented transactional storage contract, including rollback.
// Production uses the SQLite Durable Object's storage.transaction and sync.
class MemoryStorage {
  constructor(state) {
    this.state = structuredClone(state);
    this.tail = Promise.resolve();
    this.committed = 0;
    this.synced = 0;
  }
  get(key) {
    assert.equal(key, STATE_KEY);
    return this.tail.then(() => structuredClone(this.state));
  }
  transaction(callback) {
    const result = this.tail.then(async () => {
      let pending = structuredClone(this.state);
      const transaction = {
        get: async key => { assert.equal(key, STATE_KEY); return structuredClone(pending); },
        put: async (key, state) => { assert.equal(key, STATE_KEY); pending = structuredClone(state); }
      };
      const value = await callback(transaction);
      this.state = pending;
      this.committed += 1;
      return value;
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async sync() { this.synced = this.committed; }
}

const env = {
  SEARCH_ENABLED: 'true', GOOGLE_PLACES_API_KEY: 'test-secret-not-real',
  ALLOWED_ORIGIN: 'https://tommy780103.github.io'
};
const input = {
  genre: 'ラーメン', origin: { lat: 35.68, lng: 139.76 },
  criteria: { minRating: 4.2, minReviews: 100, radiusKm: 5, sort: 'rating' }
};
const now = () => new Date('2026-11-11T12:00:00Z');
const request = (body = input, options = {}) => new Request('https://search.example/search', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: env.ALLOWED_ORIGIN },
  body: JSON.stringify(body), ...options
});
const googleSuccess = () => Response.json({ places: [{
  id: 'abc', displayName: { text: 'ラーメン店', languageCode: 'ja' },
  location: { latitude: 35.68, longitude: 139.76 }, rating: 4.5, userRatingCount: 200,
  googleMapsUri: 'https://maps.google.com/?cid=123',
  attributions: [{ provider: '提供元', providerUri: 'https://example.com/provider' }]
}], nextPageToken: 'must-never-be-used' });

test('parallel requests share one cap and reserve durably before Google', async () => {
  const storage = new MemoryStorage();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    assert.ok(storage.state.dayUsed >= calls);
    assert.equal(storage.synced, storage.committed);
    return googleSuccess();
  };
  const results = await Promise.allSettled(Array.from({ length: 55 }, () => executeSearch(input, env, { storage, fetchImpl, now })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 20);
  assert.equal(calls, 20);
  assert.equal(storage.state.dayUsed, 20);
  assert.equal(storage.state.monthUsed, 20);
  for (const result of results.filter(result => result.status === 'rejected')) {
    assert.equal(result.reason.code, 'QUOTA_EXCEEDED');
    assert.equal(result.reason.quota.dayUsed, 20);
  }
});

test('month cap is shared across days and concurrent callers', async () => {
  const storage = new MemoryStorage({ version: 1, day: '2026-03-30', month: '2026-03', dayUsed: 20, monthUsed: 599 });
  let calls = 0;
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => executeSearch(input, env, {
    storage, now: () => new Date('2026-03-31T12:00:00Z'), fetchImpl: async () => { calls++; return googleSuccess(); }
  })));
  assert.equal(calls, 1);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(storage.state.dayUsed, 1);
  assert.equal(storage.state.monthUsed, 600);
  assert.equal(results.find(result => result.status === 'rejected').reason.quota.monthUsed, 600);
});

test('Pacific billing calendar follows midnight and DST, not UTC or Japan', () => {
  for (const [timestamp, day] of [
    ['2026-03-01T07:59:59Z', '2026-02-28'], ['2026-03-01T08:00:00Z', '2026-03-01'],
    ['2026-03-08T09:59:59Z', '2026-03-08'], ['2026-03-08T10:00:00Z', '2026-03-08'],
    ['2026-03-09T06:59:59Z', '2026-03-08'], ['2026-03-09T07:00:00Z', '2026-03-09'],
    ['2026-11-01T08:59:59Z', '2026-11-01'], ['2026-11-01T09:00:00Z', '2026-11-01'],
    ['2026-11-02T07:59:59Z', '2026-11-01'], ['2026-11-02T08:00:00Z', '2026-11-02']
  ]) assert.equal(billingPeriod(new Date(timestamp)).day, day);
});

test('only the appropriate counters roll over at Pacific midnight/month boundary', () => {
  const prior = { version: 1, day: '2026-03-30', month: '2026-03', dayUsed: 20, monthUsed: 580 };
  const nextDay = nextReservation(prior, new Date('2026-03-31T07:00:00Z'));
  assert.equal(nextDay.dayUsed, 1);
  assert.equal(nextDay.monthUsed, 581);
  const exhausted = { ...nextDay, dayUsed: 20, monthUsed: 600 };
  assert.throws(() => nextReservation(exhausted, new Date('2026-04-01T06:59:59Z')), { code: 'QUOTA_EXCEEDED' });
  assert.deepEqual(nextReservation(exhausted, new Date('2026-04-01T07:00:00Z')), {
    version: 1, day: '2026-04-01', month: '2026-04', dayUsed: 1, monthUsed: 1
  });
});

test('new handler/storage instance resumes persisted usage', async () => {
  const first = new MemoryStorage();
  await reserveQuota(first, now());
  const restarted = new MemoryStorage(JSON.parse(JSON.stringify(first.state)));
  assert.deepEqual(await reserveQuota(restarted, now()), { dayUsed: 2, dayLimit: 20, monthUsed: 2, monthLimit: 600 });
});

test('quota reads report unused and exhausted storage without reservations or writes', async () => {
  const exhausted = { version: 1, day: '2026-11-11', month: '2026-11', dayUsed: 20, monthUsed: 600 };
  for (const previous of [undefined, exhausted]) {
    const storage = new MemoryStorage(previous);
    const expected = previous
      ? { dayUsed: 20, dayLimit: 20, monthUsed: 600, monthLimit: 600 }
      : { dayUsed: 0, dayLimit: 20, monthUsed: 0, monthLimit: 600 };
    for (let i = 0; i < 3; i++) assert.deepEqual(await readQuota(storage, now()), expected);
    assert.deepEqual(storage.state, previous);
    assert.equal(storage.committed, 0);
    assert.equal(storage.synced, 0);
  }
});

test('quota reads apply Pacific day and month rollover only to the returned view', async () => {
  for (const [previous, timestamp, dayUsed, monthUsed] of [
    [{ version: 1, day: '2026-03-08', month: '2026-03', dayUsed: 20, monthUsed: 160 }, '2026-03-09T06:59:59Z', 20, 160],
    [{ version: 1, day: '2026-03-08', month: '2026-03', dayUsed: 20, monthUsed: 160 }, '2026-03-09T07:00:00Z', 0, 160],
    [{ version: 1, day: '2026-03-31', month: '2026-03', dayUsed: 20, monthUsed: 600 }, '2026-04-01T06:59:59Z', 20, 600],
    [{ version: 1, day: '2026-03-31', month: '2026-03', dayUsed: 20, monthUsed: 600 }, '2026-04-01T07:00:00Z', 0, 0]
  ]) {
    const storage = new MemoryStorage(previous);
    assert.deepEqual(await readQuota(storage, new Date(timestamp)), { dayUsed, dayLimit: 20, monthUsed, monthLimit: 600 });
    assert.deepEqual(storage.state, previous);
    assert.equal(storage.committed, 0);
  }
});

test('parallel quota reads neither consume nor overwrite concurrent reservations', async () => {
  const storage = new MemoryStorage();
  const reservations = [];
  const reads = [];
  for (let i = 0; i < 35; i++) {
    reads.push(readQuota(storage, now()));
    reservations.push(reserveQuota(storage, now()));
    reads.push(readQuota(storage, now()));
  }
  const [reservationResults, snapshots] = await Promise.all([Promise.allSettled(reservations), Promise.all(reads)]);
  assert.equal(reservationResults.filter(result => result.status === 'fulfilled').length, 20);
  assert.equal(reservationResults.filter(result => result.status === 'rejected' && result.reason.code === 'QUOTA_EXCEEDED').length, 15);
  assert.equal(storage.committed, 20);
  assert.deepEqual(await readQuota(storage, now()), { dayUsed: 20, dayLimit: 20, monthUsed: 20, monthLimit: 600 });
  for (const snapshot of snapshots) {
    assert.ok(snapshot.dayUsed >= 0 && snapshot.dayUsed <= 20);
    assert.equal(snapshot.monthUsed, snapshot.dayUsed);
  }
});

test('internal quota reads work without search configuration and never call Google', async () => {
  const previous = { version: 1, day: '2026-11-11', month: '2026-11', dayUsed: 2, monthUsed: 50 };
  const storage = new MemoryStorage(previous);
  for (const config of [{}, { SEARCH_ENABLED: 'false' }, { ...env, GOOGLE_PLACES_API_KEY: '' }]) {
    const result = await handleQuotaRequest(new Request('https://quota.internal/quota'), config, {
      storage, now, fetchImpl: async () => { assert.fail('Quota reads must never call Google'); }
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await result.json(), { quota: { dayUsed: 2, dayLimit: 20, monthUsed: 50, monthLimit: 600 } });
  }
  assert.deepEqual(storage.state, previous);
  assert.equal(storage.committed, 0);
});

test('quota read failures return unavailable rather than inventing zero usage', async () => {
  for (const storage of [
    { get: async () => { throw new Error('read failure'); } },
    new MemoryStorage(null),
    new MemoryStorage({ version: 1, day: '2026-11-12', month: '2026-11', dayUsed: 1, monthUsed: 1 })
  ]) {
    const result = await handleQuotaRequest(new Request('https://quota.internal/quota'), {}, {
      storage, now, fetchImpl: async () => { assert.fail('Google must not be called'); }
    });
    assert.equal(result.status, 503);
    const body = await result.json();
    assert.equal(body.error.code, 'REQUEST_FAILED');
    assert.equal(Object.hasOwn(body, 'quota'), false);
  }
});

test('failed HTTP, malformed response, network failure and timeout all consume exactly once', async () => {
  for (const [fetchImpl, code] of [
    [async () => new Response('secret backend error', { status: 500 }), 'REQUEST_FAILED'],
    [async () => new Response('quota', { status: 429 }), 'QUOTA_EXCEEDED'],
    [async () => new Response('not JSON'), 'REQUEST_FAILED'],
    [async () => Response.json({ places: 'invalid' }), 'REQUEST_FAILED'],
    [async () => { throw new Error('secret network details'); }, 'NETWORK'],
    [async () => new Promise(() => {}), 'NETWORK']
  ]) {
    const storage = new MemoryStorage();
    let calls = 0;
    await assert.rejects(executeSearch(input, env, {
      storage, now, timeoutMs: 5, fetchImpl: (...args) => { calls++; return fetchImpl(...args); }
    }), error => error instanceof SearchError && error.code === code && error.quota.dayUsed === 1);
    assert.equal(calls, 1);
    assert.equal(storage.state.dayUsed, 1);
  }
});

test('disabled or missing secret cannot reserve or call Google', async () => {
  for (const config of [{ ...env, SEARCH_ENABLED: 'false' }, { ...env, SEARCH_ENABLED: undefined }, { ...env, GOOGLE_PLACES_API_KEY: '' }]) {
    const storage = new MemoryStorage();
    await assert.rejects(executeSearch(input, config, {
      storage, now, fetchImpl: async () => { assert.fail('Google must not be called'); }
    }), { code: 'NOT_CONFIGURED' });
    assert.equal(storage.state, undefined);
  }
});

test('unknown/corrupt state and backwards clock fail closed without Google', async () => {
  const valid = { version: 1, day: '2026-11-11', month: '2026-11', dayUsed: 1, monthUsed: 1 };
  for (const state of [
    null, {}, { ...valid, version: 2 }, { ...valid, dayUsed: -1 }, { ...valid, dayUsed: 21 },
    { ...valid, monthUsed: 601 }, { ...valid, monthUsed: 0 }, { ...valid, dayUsed: '1' },
    { ...valid, day: '2026-02-30', month: '2026-02' }, { ...valid, month: '2025-01' },
    { ...valid, day: '2026-11-12' }, { ...valid, unexpected: true }
  ]) {
    const storage = new MemoryStorage(state);
    await assert.rejects(executeSearch(input, env, {
      storage, now, fetchImpl: async () => { assert.fail('Google must not be called'); }
    }));
    await assert.rejects(readQuota(storage, now()));
    assert.deepEqual(storage.state, state);
  }
});

test('storage read/write/commit failures all fail closed before Google', async () => {
  for (const storage of [
    { transaction: async () => { throw new Error('read failure'); } },
    { transaction: callback => callback({ get: async () => undefined, put: async () => { throw new Error('write failure'); } }) },
    { transaction: async () => { throw new Error('commit failure'); }, sync: async () => {} },
    Object.assign(new MemoryStorage(), { sync: async () => { throw new Error('persistence failure'); } })
  ]) {
    const result = await handleQuotaRequest(request(), env, {
      storage, now, fetchImpl: async () => { assert.fail('Google must not be called'); }
    });
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error.code, 'REQUEST_FAILED');
  }
});

test('fixed Google request has narrow fields, one page, strict location restriction and no retry', async () => {
  const storage = new MemoryStorage();
  let calls = 0;
  const result = await executeSearch(input, env, { storage, now, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, GOOGLE_ENDPOINT);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['X-Goog-FieldMask'], GOOGLE_FIELDS);
    assert.equal(init.headers['X-Goog-Api-Key'], env.GOOGLE_PLACES_API_KEY);
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ['languageCode', 'locationRestriction', 'minRating', 'pageSize', 'regionCode', 'textQuery']);
    assert.equal(body.pageSize, 20);
    assert.equal(body.minRating, 4);
    assert.equal(body.textQuery, 'ラーメン 飲食店');
    assert.ok(body.locationRestriction.rectangle.low.latitude < input.origin.lat);
    assert.ok(body.locationRestriction.rectangle.high.latitude > input.origin.lat);
    assert.ok(body.locationRestriction.rectangle.low.longitude < input.origin.lng);
    assert.ok(body.locationRestriction.rectangle.high.longitude > input.origin.lng);
    return googleSuccess();
  } });
  assert.equal(calls, 1);
  assert.equal(result.places[0].displayName, 'ラーメン店');
  assert.deepEqual(result.places[0].location, input.origin);
  assert.deepEqual(result.places[0].attributions, [{ provider: '提供元', providerURI: 'https://example.com/provider' }]);
  assert.equal(result.nextPageToken, undefined);
});

test('Google redirects fail without following Location or refunding the reservation', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const storage = new MemoryStorage();
    const calls = [];
    const result = await handleQuotaRequest(request(), env, {
      storage, now, fetchImpl: async (url, init) => {
        calls.push(url);
        assert.equal(url, GOOGLE_ENDPOINT);
        assert.equal(init.redirect, 'manual');
        return new Response(null, { status, headers: { Location: 'https://redirect.example/collect' } });
      }
    });
    assert.equal(result.status, 502);
    assert.equal(result.headers.get('Location'), null);
    assert.deepEqual(await result.json(), {
      error: { code: 'REQUEST_FAILED', message: 'お店情報を取得できませんでした。' },
      quota: { dayUsed: 1, dayLimit: 20, monthUsed: 1, monthLimit: 600 }
    });
    assert.deepEqual(calls, [GOOGLE_ENDPOINT]);
    assert.equal(storage.state.dayUsed, 1);
    assert.equal(storage.state.monthUsed, 1);
  }
});

test('bad input and client key/quota/endpoint/object/field overrides are rejected', () => {
  for (const body of [
    ...['apiKey', 'url', 'endpoint', 'quota', 'counter', 'objectId', 'fields', 'pageToken', 'pageSize'].map(key => ({ ...input, [key]: 'override' })),
    { ...input, genre: '' }, { ...input, genre: 'x'.repeat(81) }, { ...input, genre: 'x\n' },
    { ...input, origin: { lat: '35', lng: 139 } }, { ...input, origin: { lat: 91, lng: 139 } },
    { ...input, origin: { ...input.origin, key: 'override' } },
    { ...input, criteria: { minRating: 6 } }, { ...input, criteria: { minReviews: 1.2 } },
    { ...input, criteria: { radiusKm: 51 } }, { ...input, criteria: { sort: 'invalid' } },
    { ...input, criteria: { dailyLimit: 500 } }, { ...input, criteria: null }
  ]) assert.throws(() => validateSearchInput(body), { code: 'INVALID_REQUEST' });
});

test('omitted radius uses the 1km search area while an explicit 5km choice remains wider', () => {
  const explicitOne = validateSearchInput({ ...input, criteria: { radiusKm: 1 } });
  for (const criteria of [undefined, {}, { minRating: 3.5 }]) {
    const validated = validateSearchInput({ ...input, criteria });
    assert.equal(validated.criteria.radiusKm, 1);
    assert.deepEqual(googleSearchBody(validated).locationRestriction, googleSearchBody(explicitOne).locationRestriction);
  }
  assert.deepEqual(explicitOne.criteria, { minRating: 4, minReviews: 100, radiusKm: 1, sort: 'rating' });
  const explicitFive = validateSearchInput({ ...input, criteria: { radiusKm: 5 } });
  assert.equal(explicitFive.criteria.radiusKm, 5);
  const one = googleSearchBody(explicitOne).locationRestriction.rectangle;
  const five = googleSearchBody(explicitFive).locationRestriction.rectangle;
  assert.ok(five.low.latitude < one.low.latitude && five.high.latitude > one.high.latitude);
  assert.ok(five.low.longitude < one.low.longitude && five.high.longitude > one.high.longitude);
});

test('new filter choices preserve values and omit the Google rating restriction for no minimum', () => {
  for (const minRating of [0, 3.5]) {
    for (const minReviews of [0, 1000]) {
      for (const radiusKm of [0.1, 0.5]) {
        const criteria = { minRating, minReviews, radiusKm, sort: 'rating' };
        const validated = validateSearchInput({ ...input, criteria });
        assert.deepEqual(validated.criteria, criteria);
        const body = googleSearchBody(validated);
        assert.equal(Object.hasOwn(body, 'minRating'), minRating !== 0);
        if (minRating !== 0) assert.equal(body.minRating, 3.5);
        const rectangle = body.locationRestriction.rectangle;
        assert.ok(rectangle.low.latitude < input.origin.lat && rectangle.high.latitude > input.origin.lat);
        assert.ok(rectangle.low.longitude < input.origin.lng && rectangle.high.longitude > input.origin.lng);
        assert.ok(rectangle.high.latitude - rectangle.low.latitude < 0.01);
        assert.equal(body.pageSize, 20);
      }
    }
  }
  const small = googleSearchBody(validateSearchInput({ ...input, criteria: { radiusKm: 0.1 } })).locationRestriction.rectangle;
  const larger = googleSearchBody(validateSearchInput({ ...input, criteria: { radiusKm: 0.5 } })).locationRestriction.rectangle;
  assert.ok(larger.low.latitude < small.low.latitude && larger.high.latitude > small.high.latitude);
  const [unrated] = normalizePlaces({ places: [{ id: 'unrated', displayName: { text: '評価情報なし' }, location: { latitude: 35.68, longitude: 139.76 } }] });
  assert.equal(unrated.id, 'unrated');
  assert.equal(unrated.rating, undefined);
  assert.equal(unrated.userRatingCount, undefined);
});

test('custom filter numbers and inclusive bounds survive public routing without preset rounding', async () => {
  for (const [criteria, googleRating] of [
    [{ minRating: 4.35, minReviews: 5678, radiusKm: 1.25, sort: 'distance' }, 4],
    [{ minRating: 4.35, minReviews: 5000, radiusKm: 1.25, sort: 'reviews' }, 4],
    [{ minRating: 0, minReviews: 0, radiusKm: 0.1, sort: 'rating' }, undefined],
    [{ minRating: 5, minReviews: 1000000, radiusKm: 50, sort: 'rating' }, 5]
  ]) {
    const body = { ...input, criteria };
    assert.deepEqual(validateSearchInput(body).criteria, criteria);
    const storage = new MemoryStorage();
    let routed = 0;
    let googleCalls = 0;
    const boundEnv = { ...env, GLOBAL_QUOTA: {
      idFromName: name => { assert.equal(name, GLOBAL_OBJECT_NAME); return 'fixed-id'; },
      get: id => {
        assert.equal(id, 'fixed-id');
        return { fetch: async internal => {
          routed++;
          assert.deepEqual(await internal.clone().json(), body);
          return handleQuotaRequest(internal, boundEnv, {
            storage, now, fetchImpl: async (url, init) => {
              googleCalls++;
              assert.equal(url, GOOGLE_ENDPOINT);
              const googleBody = JSON.parse(init.body);
              // Google receives a wider half-star filter; the adapter applies
              // the exact custom minimum after the response is normalized.
              assert.equal(googleBody.minRating, googleRating);
              assert.equal(Object.hasOwn(googleBody, 'minRating'), googleRating !== undefined);
              const rectangle = googleBody.locationRestriction.rectangle;
              const radiusFromLatitude = (rectangle.high.latitude - rectangle.low.latitude) / 2 * Math.PI / 180 * 6371.0088;
              assert.ok(Math.abs(radiusFromLatitude - criteria.radiusKm) < 1e-9);
              assert.equal(googleBody.pageSize, 20);
              return googleSuccess();
            }
          });
        } };
      }
    } };
    const result = await handlePublicRequest(request(body), boundEnv);
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).quota, { dayUsed: 1, dayLimit: 20, monthUsed: 1, monthLimit: 600 });
    assert.equal(routed, 1);
    assert.equal(googleCalls, 1);
    assert.equal(storage.committed, 1);
    assert.equal(storage.synced, 1);
  }
});

test('invalid custom filter numbers fail before object routing, Google or quota reservation', async () => {
  const previous = { version: 1, day: '2026-11-11', month: '2026-11', dayUsed: 3, monthUsed: 42 };
  const storage = new MemoryStorage(previous);
  let objectAccesses = 0;
  let googleCalls = 0;
  const boundEnv = { ...env, GLOBAL_QUOTA: {
    idFromName: () => { objectAccesses++; throw new Error('Invalid input must not reach the quota object'); }
  } };
  for (const [key, values] of [
    ['minRating', [-0.01, 5.01, '4.35', null]],
    ['minReviews', [-1, 1000001, 5678.1, '5678', null]],
    ['radiusKm', [0.099, 50.001, '1.25', null]]
  ]) {
    for (const value of values) {
      const body = { ...input, criteria: { ...input.criteria, [key]: value } };
      const publicResult = await handlePublicRequest(request(body), boundEnv);
      const internalResult = await handleQuotaRequest(request(body), env, {
        storage, now, fetchImpl: async () => { googleCalls++; return googleSuccess(); }
      });
      for (const result of [publicResult, internalResult]) {
        assert.equal(result.status, 400, `${key}: ${JSON.stringify(value)}`);
        const payload = await result.json();
        assert.equal(payload.error.code, 'INVALID_REQUEST');
        assert.equal(Object.hasOwn(payload, 'quota'), false);
      }
    }
  }
  assert.equal(objectAccesses, 0);
  assert.equal(googleCalls, 0);
  assert.equal(storage.committed, 0);
  assert.equal(storage.synced, 0);
  assert.deepEqual(storage.state, previous);
});

test('body size is enforced for streamed bodies without Content-Length', async () => {
  let cancelled = false;
  const streamed = new Request('https://search.example/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, duplex: 'half',
    body: new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(4097))); },
      cancel() { cancelled = true; }
    })
  });
  assert.equal(streamed.headers.get('Content-Length'), null);
  await assert.rejects(readBoundedJson(streamed), { code: 'INVALID_REQUEST' });
  assert.equal(cancelled, true);
  await assert.rejects(readBoundedJson(request(input, {
    headers: { 'Content-Type': 'application/json', 'Content-Length': '4097' }
  })), { code: 'INVALID_REQUEST' });
});

test('public route always chooses the same global object and returns no-store CORS', async () => {
  let routed = 0;
  const boundEnv = { ...env, GLOBAL_QUOTA: {
    idFromName: name => { assert.equal(name, GLOBAL_OBJECT_NAME); return 'fixed-id'; },
    get: id => {
      assert.equal(id, 'fixed-id');
      return { fetch: async internal => {
        routed++;
        assert.equal(internal.url, 'https://quota.internal/search');
        assert.deepEqual(await internal.json(), input);
        return Response.json({ places: [], quota: { dayUsed: 1, dayLimit: 20, monthUsed: 1, monthLimit: 600 } });
      } };
    }
  } };
  const result = await handlePublicRequest(request(), boundEnv);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), env.ALLOWED_ORIGIN);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(routed, 1);
  const options = await handlePublicRequest(new Request('https://search.example/search', {
    method: 'OPTIONS', headers: { Origin: env.ALLOWED_ORIGIN }
  }), boundEnv);
  assert.equal(options.status, 204);
  assert.equal(routed, 1);
  for (const origin of ['https://evil.example', 'https://tommy780103.github.io.evil.example', 'null', '']) {
    const rejected = await handlePublicRequest(request(input, { headers: { Origin: origin, 'Content-Type': 'application/json' } }), boundEnv);
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('Access-Control-Allow-Origin'), null);
  }
  const override = await handlePublicRequest(request({ ...input, objectId: 'my-counter' }), boundEnv);
  assert.equal(override.status, 400);
  assert.equal(routed, 1);
});

test('disabled public route and nonexistent reset route never access the quota object', async () => {
  const boundEnv = { ...env, GLOBAL_QUOTA: { idFromName() { assert.fail('No object access'); } } };
  const disabled = await handlePublicRequest(request(), { ...boundEnv, SEARCH_ENABLED: 'false' });
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).error.code, 'NOT_CONFIGURED');
  const reset = await handlePublicRequest(new Request('https://search.example/reset', {
    method: 'POST', headers: { Origin: env.ALLOWED_ORIGIN }
  }), boundEnv);
  assert.equal(reset.status, 404);
});

test('public quota GET uses the existing object with or without Origin and never consumes usage', async () => {
  const storage = new MemoryStorage({ version: 1, day: '2026-11-11', month: '2026-11', dayUsed: 3, monthUsed: 30 });
  let routed = 0;
  const boundEnv = { ALLOWED_ORIGIN: env.ALLOWED_ORIGIN, SEARCH_ENABLED: 'false', GLOBAL_QUOTA: {
    idFromName: name => { assert.equal(name, GLOBAL_OBJECT_NAME); return 'fixed-id'; },
    get: id => {
      assert.equal(id, 'fixed-id');
      return { fetch: internal => {
        routed++;
        assert.equal(internal.url, 'https://quota.internal/quota');
        assert.equal(internal.method, 'GET');
        assert.equal(internal.body, null);
        return handleQuotaRequest(internal, boundEnv, {
          storage, now, fetchImpl: async () => { assert.fail('Google must not be called'); }
        });
      } };
    }
  } };
  for (const headers of [{}, { Origin: env.ALLOWED_ORIGIN }]) {
    const result = await handlePublicRequest(new Request('https://search.example/quota', { headers }), boundEnv);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('Access-Control-Allow-Origin'), env.ALLOWED_ORIGIN);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await result.json(), { quota: { dayUsed: 3, dayLimit: 20, monthUsed: 30, monthLimit: 600 } });
  }
  for (const origin of ['https://evil.example', 'https://tommy780103.github.io.evil.example', 'null', '']) {
    const result = await handlePublicRequest(new Request('https://search.example/quota', { headers: { Origin: origin } }), boundEnv);
    assert.equal(result.status, 403);
  }
  const searchWithoutOrigin = await handlePublicRequest(request(input, { headers: { 'Content-Type': 'application/json' } }), boundEnv);
  assert.equal(searchWithoutOrigin.status, 403);
  assert.equal(routed, 2);
  assert.equal(storage.committed, 0);
  const unavailable = await handlePublicRequest(new Request('https://search.example/quota'), { ALLOWED_ORIGIN: env.ALLOWED_ORIGIN });
  assert.equal(unavailable.status, 503);
  assert.equal(Object.hasOwn(await unavailable.json(), 'quota'), false);
});

test('quota preflight advertises GET and rejects other methods without touching the object', async () => {
  const boundEnv = { ...env, GLOBAL_QUOTA: { idFromName() { assert.fail('No object access'); } } };
  for (const [path, methods] of [['/quota', 'GET, OPTIONS'], ['/search', 'POST, OPTIONS']]) {
    const result = await handlePublicRequest(new Request(`https://search.example${path}`, {
      method: 'OPTIONS', headers: { Origin: env.ALLOWED_ORIGIN }
    }), boundEnv);
    assert.equal(result.status, 204);
    assert.equal(result.headers.get('Access-Control-Allow-Methods'), methods);
  }
  const wrongMethod = await handlePublicRequest(new Request('https://search.example/quota', {
    method: 'POST', headers: { Origin: env.ALLOWED_ORIGIN }
  }), boundEnv);
  assert.equal(wrongMethod.status, 405);
  const noOriginPreflight = await handlePublicRequest(new Request('https://search.example/quota', { method: 'OPTIONS' }), boundEnv);
  assert.equal(noOriginPreflight.status, 403);
});

test('rectangle remains valid across the date line and at the poles', () => {
  for (const origin of [{ lat: 90, lng: 0 }, { lat: -90, lng: 0 }, { lat: 0, lng: 179.99 }]) {
    const rect = googleSearchBody(validateSearchInput({ ...input, origin })).locationRestriction.rectangle;
    assert.ok(rect.low.latitude >= -90 && rect.high.latitude <= 90);
    assert.ok(rect.low.latitude < rect.high.latitude);
    assert.ok(rect.low.longitude >= -180 && rect.high.longitude <= 180);
  }
  assert.equal(googleSearchBody(validateSearchInput({ ...input, genre: 'constructor' })).textQuery, 'constructor 飲食店');
});

