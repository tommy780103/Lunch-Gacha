'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../search-core.js');
const origin = { lat: 34.32, lng: 133.86 };

function place(id, overrides = {}) {
  return { id, displayName: `店舗${id}`, rating: 4.2, userRatingCount: 100, location: { ...origin }, ...overrides };
}

function quota(overrides = {}) {
  return { dayUsed: 1, dayLimit: 20, monthUsed: 1, monthLimit: 600, ...overrides };
}

function response(body = { places: [place('A')], quota: quota() }, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function adapterHarness({ configured = true, config, fetch, timers, page = 'https://example.github.io/Lunch-Gacha/' } = {}) {
  const requests = [];
  const root = {
    LunchSearchCore: core,
    LUNCH_GACHA_CONFIG: config || { searchEndpoint: configured ? 'https://lunch.example.workers.dev/search' : '', placesEnabled: configured },
    location: new URL(page),
    AbortController,
    setTimeout: timers ? timers.setTimeout : setTimeout,
    clearTimeout: timers ? timers.clearTimeout : clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return fetch ? fetch(url, options, requests.length) : response();
    },
    document: { createElement() { throw new Error('SDK must never be loaded'); } },
    google: { maps: { importLibrary() { throw new Error('SDK must never be used'); } } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../places-search.js'), 'utf8'), { window: root, URL, console });
  return { api: root.LunchPlaces, requests, root };
}

test('criteria keep decimal ratings and use safe defaults for missing/non-finite input', () => {
  assert.deepEqual(core.normalizeCriteria(), { minRating: 4, minReviews: 100, radiusKm: 5, sort: 'rating' });
  assert.equal(core.normalizeCriteria({ minRating: '4.2' }).minRating, 4.2);
  assert.deepEqual(core.normalizeCriteria({ minRating: NaN, minReviews: null, radiusKm: Infinity, sort: 'random' }), core.DEFAULTS);
});

test('all three thresholds are applied inclusively; missing data never passes', () => {
  const northAt5km = origin.lat + 5 / 6371.0088 * 180 / Math.PI;
  const candidates = [
    place('boundary', { location: { lat: northAt5km, lng: origin.lng } }),
    place('lowRating', { rating: 4.19 }),
    place('lowCount', { userRatingCount: 99 }),
    place('outside', { location: { lat: northAt5km + 0.0001, lng: origin.lng } }),
    place('noRating', { rating: null }),
    place('noCount', { userRatingCount: undefined }),
    place('noLocation', { location: null }),
    place('badRating', { rating: Infinity }),
    place('badCount', { userRatingCount: -5 }),
    place('badCoordinates', { location: { lat: 95, lng: 0 } })
  ];
  const result = core.filterPlaces(candidates, origin, { minRating: 4.2, minReviews: 100, radiusKm: 5 });
  assert.deepEqual(result.map(item => item.id), ['boundary']);
  assert.ok(Math.abs(result[0].distanceKm - 5) < 1e-8);
});

test('zero coordinates and Google LatLng getter functions are supported', () => {
  assert.equal(core.distanceKm({ lat: 0, lng: 0 }, { lat: () => 0, lng: () => 0 }), 0);
  assert.equal(core.filterPlaces([place('zero', { location: { lat: () => 0, lng: () => 0 } })], { lat: 0, lng: 0 }, {}).length, 1);
  assert.ok(Number.isNaN(core.distanceKm({ lat: null, lng: 0 }, { lat: 0, lng: 0 })));
});

test('ranking obeys requested priority with predictable tiebreaks, removes duplicate ids, and caps at 10', () => {
  const candidates = [
    place('reviewWinner', { userRatingCount: 1000, location: { lat: origin.lat + 0.01, lng: origin.lng } }),
    place('ratingWinner', { rating: 4.9, userRatingCount: 200, location: { lat: origin.lat + 0.02, lng: origin.lng } }),
    place('nearWinner', { rating: 4.3 }),
    place('reviewWinner')
  ];
  assert.equal(core.filterPlaces(candidates, origin, { sort: 'rating' })[0].id, 'ratingWinner');
  assert.equal(core.filterPlaces(candidates, origin, { sort: 'reviews' })[0].id, 'reviewWinner');
  assert.equal(core.filterPlaces(candidates, origin, { sort: 'distance' })[0].id, 'nearWinner');
  assert.equal(core.filterPlaces(candidates, origin, {}).length, 3);
  const many = Array.from({ length: 20 }, (_, index) => place(`id${index}`));
  const first = core.filterPlaces(many, origin, {}).map(item => item.id);
  assert.equal(first.length, 10);
  assert.deepEqual(core.filterPlaces([...many].reverse(), origin, {}).map(item => item.id), first);
});

test('bounding box handles the date line and the poles without excluding the circle', () => {
  const normal = core.boundsForRadius(origin, 5);
  assert.ok(normal.south < origin.lat && normal.north > origin.lat && normal.west < origin.lng && normal.east > origin.lng);
  const crossing = core.boundsForRadius({ lat: 0, lng: 179.99 }, 5);
  assert.ok(crossing.west > crossing.east);
  const polar = core.boundsForRadius({ lat: 90, lng: 0 }, 5);
  assert.equal(polar.north, 90);
  assert.equal(polar.west, -180);
  assert.equal(polar.east, 180);
  assert.throws(() => core.boundsForRadius({ lat: NaN, lng: 0 }, 5));
});

test('Maps URLs encode free text, use exact Place IDs, and limit shortlists to 20 unique entries', () => {
  const search = new URL(core.buildSearchUrl('パン & カフェ', { lat: 0, lng: 0 }));
  assert.equal(search.searchParams.get('api'), '1');
  assert.equal(search.searchParams.get('query'), 'パン & カフェ near 0,0');
  const selected = core.filterPlaces([place('id&123', { displayName: '店 <script>' })], origin, {})[0];
  const details = new URL(selected.mapsUrl);
  assert.equal(details.searchParams.get('query_place_id'), 'id&123');
  assert.equal(details.searchParams.get('query'), '店 <script>');
  const shortlist = new URL(core.buildShortlistUrl(['one', 'one', ...Array.from({ length: 30 }, (_, i) => `id${i}`)]));
  assert.equal(shortlist.searchParams.get('map_action'), 'shortlist');
  assert.equal(shortlist.searchParams.get('place_ids').split(',').length, 20);
  assert.equal(core.buildShortlistUrl([]), '');
});

test('provider attribution is preserved while unsafe URI schemes are removed', () => {
  const result = core.filterPlaces([place('A', { attributions: [{ provider: 'Provider A', providerURI: 'https://example.com' }, { provider: 'Provider B', providerURI: 'javascript:alert(1)' }] })], origin, {});
  assert.deepEqual(result[0].attributions, [{ provider: 'Provider A', providerURI: 'https://example.com/' }, { provider: 'Provider B', providerURI: '' }]);
});

test('genre names matching inherited object properties remain plain search text', () => {
  for (const genre of ['constructor', 'toString', '__proto__']) {
    assert.equal(core.genreQuery(genre), genre);
  }
});

test('unconfigured and legacy client-key configurations fail closed without any request', async () => {
  for (const config of [
    { searchEndpoint: '', placesEnabled: false },
    { searchEndpoint: 'https://lunch.example.workers.dev/search', placesEnabled: false },
    { googleMapsApiKey: 'old-browser-key', placesEnabled: true }
  ]) {
    const harness = adapterHarness({ config });
    assert.equal(harness.api.isConfigured(), false);
    assert.equal(harness.api.getQuota(), null);
    await assert.rejects(harness.api.search('ラーメン', origin, {}), { code: 'NOT_CONFIGURED' });
    assert.equal(harness.requests.length, 0);
  }
});

test('endpoint validation rejects insecure, credentialed, and ambiguous URLs', async () => {
  for (const searchEndpoint of [
    'http://lunch.example.workers.dev/search',
    'http://localhost:8000/search',
    'https://user:secret@lunch.example.workers.dev/search',
    'https://lunch.example.workers.dev/search?key=secret',
    'https://lunch.example.workers.dev/search#ignored',
    'https://lunch.example.workers.dev/other',
    '/search',
    'javascript:alert(1)'
  ]) {
    const harness = adapterHarness({ config: { searchEndpoint, placesEnabled: true } });
    assert.equal(harness.api.isConfigured(), false, searchEndpoint);
    await assert.rejects(harness.api.search('ラーメン', origin, {}), { code: 'NOT_CONFIGURED' });
    assert.equal(harness.requests.length, 0);
  }
});

test('local HTTP development requires the exact same localhost origin', async () => {
  const local = adapterHarness({ page: 'http://localhost:8787/', config: { searchEndpoint: 'http://localhost:8787/search', placesEnabled: true } });
  assert.equal(local.api.isConfigured(), true);
  await local.api.search('ラーメン', origin, {});
  assert.equal(local.requests.length, 1);
  for (const searchEndpoint of ['http://localhost:8788/search', 'http://127.0.0.1:8787/search']) {
    const other = adapterHarness({ page: 'http://localhost:8787/', config: { searchEndpoint, placesEnabled: true } });
    assert.equal(other.api.isConfigured(), false);
  }
});

test('one explicit search sends one credential-free proxy POST and filters exact thresholds', async () => {
  const harness = adapterHarness({
    config: { searchEndpoint: 'https://lunch.example.workers.dev/search', placesEnabled: true, googleMapsApiKey: 'legacy-secret-must-not-be-sent' },
    fetch: () => response({ places: [place('pass'), place('low', { rating: 4.1 }), place('few', { userRatingCount: 99 })], quota: quota() })
  });
  assert.equal(harness.api.isConfigured(), true);
  assert.equal(harness.requests.length, 0, 'configuration checks do not fetch');
  const result = await harness.api.search('マック', origin, { minRating: 4.2, minReviews: 100, radiusKm: 3 });
  assert.deepEqual(result.map(item => item.id), ['pass']);
  assert.equal(harness.requests.length, 1);
  const { url, options } = harness.requests[0];
  assert.equal(url, 'https://lunch.example.workers.dev/search');
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.redirect, 'error');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.deepEqual({ ...options.headers }, { 'Content-Type': 'application/json', Accept: 'application/json' });
  assert.deepEqual(JSON.parse(options.body), { genre: 'マクドナルド', origin, criteria: { minRating: 4.2, minReviews: 100, radiusKm: 3, sort: 'rating' } });
  assert.equal(JSON.stringify(harness.requests).includes('legacy-secret-must-not-be-sent'), false);
  assert.equal(options.signal.aborted, false);
  assert.deepEqual({ ...harness.api.getQuota() }, quota());
  const exposed = harness.api.getQuota();
  exposed.dayUsed = 999;
  assert.equal(harness.api.getQuota().dayUsed, 1, 'callers cannot mutate the cached count');
});

test('invalid input never consumes a request, and empty filtered results stay empty', async () => {
  const harness = adapterHarness({ fetch: () => response({ places: [], quota: quota() }) });
  await assert.rejects(harness.api.search('', origin, {}), { code: 'REQUEST_FAILED' });
  await assert.rejects(harness.api.search('カレー', { lat: NaN, lng: 0 }, {}), { code: 'REQUEST_FAILED' });
  assert.equal(harness.requests.length, 0);
  assert.deepEqual(await harness.api.search('カレー', origin, {}), []);
  assert.equal(harness.requests.length, 1);
});

test('both daily and monthly shared quota errors preserve verified counts and never retry', async () => {
  for (const counts of [quota({ dayUsed: 20, monthUsed: 20 }), quota({ dayUsed: 2, monthUsed: 600 })]) {
    const harness = adapterHarness({ fetch: () => response({ error: { code: 'QUOTA_EXCEEDED' }, quota: counts }, 429) });
    await assert.rejects(harness.api.search('ラーメン', origin, {}), { code: 'QUOTA_EXCEEDED' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.requests.length, 1);
    assert.deepEqual({ ...harness.api.getQuota() }, counts);
  }
});

test('malformed counts and result envelopes are rejected instead of displaying a made-up allowance', async () => {
  const invalidCounts = [null, {}, quota({ dayUsed: -1 }), quota({ dayUsed: 21 }), quota({ dayUsed: 0.5 }), quota({ monthUsed: 601 }), quota({ dayUsed: 2, monthUsed: 1 }), quota({ dayLimit: 100 }), quota({ monthLimit: 1000 })];
  for (const counts of invalidCounts) {
    const harness = adapterHarness({ fetch: () => response({ places: [place('A')], quota: counts }) });
    await assert.rejects(harness.api.search('ラーメン', origin, {}), { code: 'REQUEST_FAILED' });
    assert.equal(harness.api.getQuota(), null);
    assert.equal(harness.requests.length, 1);
  }
  for (const body of [null, { quota: quota() }, { places: Array.from({ length: 21 }, (_, i) => place(String(i))), quota: quota() }, { places: [], quota: quota(), error: { code: 'NETWORK' } }]) {
    const harness = adapterHarness({ fetch: () => response(body) });
    await assert.rejects(harness.api.search('ラーメン', origin, {}), { code: 'REQUEST_FAILED' });
    assert.equal(harness.api.getQuota(), null);
  }
});

test('server errors and non-JSON responses never trigger Google calls or automatic retries', async () => {
  for (const [status, code, expected] of [[503, 'NOT_CONFIGURED', 'NOT_CONFIGURED'], [503, 'NETWORK', 'NETWORK'], [400, 'INVALID_REQUEST', 'REQUEST_FAILED'], [502, 'UNEXPECTED', 'REQUEST_FAILED']]) {
    const harness = adapterHarness({ fetch: () => response({ error: { code, message: 'private server details' } }, status) });
    await assert.rejects(harness.api.search('ラーメン', origin, {}), error => error.code === expected && !error.message.includes('private'));
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.api.getQuota(), null);
  }
  for (const [status, expected] of [[200, 'REQUEST_FAILED'], [429, 'QUOTA_EXCEEDED']]) {
    const harness = adapterHarness({ fetch: () => ({ status, ok: status === 200, json: async () => { throw new SyntaxError('HTML response'); } }) });
    await assert.rejects(harness.api.search('ラーメン', origin, {}), { code: expected });
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.api.getQuota(), null);
  }
});

test('a network failure clears stale quota, and only another explicit search retries', async () => {
  const harness = adapterHarness({ fetch: (_url, _options, attempt) => {
    if (attempt === 2) throw new TypeError('Failed to fetch');
    return response({ places: [place('A')], quota: quota({ dayUsed: attempt, monthUsed: attempt }) });
  } });
  await harness.api.search('ラーメン', origin, {});
  assert.equal(harness.api.getQuota().dayUsed, 1);
  await assert.rejects(harness.api.search('ラーメン', origin, {}), { code: 'NETWORK' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.api.getQuota(), null);
  assert.equal(harness.requests.length, 2);
  await harness.api.search('ラーメン', origin, {});
  assert.equal(harness.requests.length, 3);
  assert.equal(harness.api.getQuota().dayUsed, 3);
});

test('timeout aborts the request after 25 seconds and late responses cannot overwrite a later quota', async () => {
  const timers = new Map();
  let nextTimer = 0;
  let resolveFirst;
  const harness = adapterHarness({
    timers: {
      setTimeout(callback, delay) { assert.equal(delay, 25000); const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); }
    },
    fetch: (_url, _options, attempt) => attempt === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : response()
  });
  const first = harness.api.search('ラーメン', origin, {});
  const rejected = assert.rejects(first, { code: 'NETWORK' });
  assert.equal(timers.size, 1);
  timers.values().next().value();
  await rejected;
  assert.equal(harness.requests[0].options.signal.aborted, true);
  assert.equal(harness.requests.length, 1, 'no automatic retry');
  assert.equal(timers.size, 0);
  assert.equal(harness.api.getQuota(), null);
  await harness.api.search('うどん', origin, {});
  assert.equal(harness.api.getQuota().dayUsed, 1);
  resolveFirst(response({ places: [], quota: quota({ dayUsed: 9, monthUsed: 9 }) }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.api.getQuota().dayUsed, 1);
  assert.equal(harness.requests.length, 2);
  assert.equal(timers.size, 0);
});
