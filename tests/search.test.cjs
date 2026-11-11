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

function uiHarness(api, { genres = ['うどん'], getLocation } = {}) {
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.textContent = ''; this.value = ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); }
    focus() {}
  }
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  Object.assign(elements.minRating, { value: '0' });
  Object.assign(elements.minReviews, { value: '0' });
  Object.assign(elements.radiusKm, { value: '0.1' });
  Object.assign(elements.sortOrder, { value: 'rating' });
  elements.restaurantSearchForm.children = ['genreGrid', 'genreInput', 'minRating', 'minReviews', 'radiusKm', 'sortOrder', 'searchBtn'].map(id => elements[id]);
  const window = {};
  const document = {
    getElementById: id => elements[id],
    createElement: tag => new Element(tag),
    createTextNode: text => Object.assign(new Element(), { textContent: text })
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../search-ui.js'), 'utf8'), { window, document, LunchPlaces: api, LunchSearchCore: core, URL });
  let locationCalls = 0;
  window.LunchSearchUI.init({ genres, getLocation: async () => { locationCalls++; return getLocation ? getLocation() : origin; } });
  return { elements, api: window.LunchSearchUI, get locationCalls() { return locationCalls; } };
}

test('criteria keep decimal ratings and use safe defaults for missing/non-finite input', () => {
  assert.deepEqual(core.normalizeCriteria(), { minRating: 4, minReviews: 100, radiusKm: 1, sort: 'rating' });
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

test('unset rating and review filters retain unknowns without inventing zero values', () => {
  const candidates = [
    place('unknown', { rating: undefined, userRatingCount: null }),
    place('noRating', { rating: null }),
    place('noCount', { userRatingCount: undefined }),
    place('knownZero', { rating: 0, userRatingCount: 0 }),
    place('badRating', { rating: '4.5' }),
    place('badInfinite', { rating: Infinity }),
    place('badCount', { userRatingCount: -1 })
  ];
  const result = core.filterPlaces(candidates, origin, { minRating: 0, minReviews: 0 });
  assert.deepEqual(result.map(item => item.id), ['noCount', 'knownZero', 'noRating', 'unknown']);
  const unknown = result.find(item => item.id === 'unknown');
  assert.equal(unknown.rating, null);
  assert.equal(unknown.reviewCount, null);
  assert.deepEqual(core.filterPlaces(candidates, origin, { minRating: 0, minReviews: 100 }).map(item => item.id), ['noRating']);
  assert.deepEqual(core.filterPlaces(candidates, origin, { minRating: 4, minReviews: 0 }).map(item => item.id), ['noCount']);
});

test('new decimal radius and thresholds preserve exact filtering and human-readable labels', () => {
  for (const radiusKm of [0.1, 0.5]) {
    const boundaryLat = origin.lat + radiusKm / 6371.0088 * 180 / Math.PI;
    const result = core.filterPlaces([
      place('boundary', { rating: 3.5, userRatingCount: 1000, location: { lat: boundaryLat, lng: origin.lng } }),
      place('outside', { rating: 3.5, userRatingCount: 1000, location: { lat: boundaryLat + 0.00001, lng: origin.lng } }),
      place('low', { rating: 3.49, userRatingCount: 1000 }),
      place('few', { rating: 3.5, userRatingCount: 999 })
    ], origin, { minRating: 3.5, minReviews: 1000, radiusKm });
    assert.deepEqual(result.map(item => item.id), ['boundary']);
    assert.equal(core.formatDistance(radiusKm), `${radiusKm * 1000}m`);
  }
  assert.equal(core.describeCriteria({ minRating: 0, minReviews: 0, radiusKm: 0.1 }), '評価指定なし・口コミ指定なし・100m以内 ／ 評価が高い順');
  assert.equal(core.describeCriteria({ minRating: 3.5, minReviews: 1000, radiusKm: 0.5 }), '★3.5以上・口コミ1,000件以上・500m以内 ／ 評価が高い順');
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
  assert.equal(core.filterPlaces(candidates, origin, { sort: 'rating', radiusKm: 5 })[0].id, 'ratingWinner');
  assert.equal(core.filterPlaces(candidates, origin, { sort: 'reviews', radiusKm: 5 })[0].id, 'reviewWinner');
  assert.equal(core.filterPlaces(candidates, origin, { sort: 'distance', radiusKm: 5 })[0].id, 'nearWinner');
  assert.equal(core.filterPlaces(candidates, origin, { radiusKm: 5 }).length, 3);
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

test('one explicit search uses only same-origin credentials and filters exact thresholds', async () => {
  const harness = adapterHarness({
    page: 'https://lunch.example.workers.dev/',
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
  assert.equal(options.credentials, 'same-origin');
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

  const crossOrigin = adapterHarness({ page: 'https://other.example/' });
  await crossOrigin.api.search('うどん', origin, {});
  const crossRequest = crossOrigin.requests[0];
  assert.notEqual(new URL(crossRequest.url).origin, crossOrigin.root.location.origin);
  assert.equal(crossRequest.options.credentials, 'same-origin', 'never opt into cross-origin cookies');
  assert.equal(Object.keys(crossRequest.options.headers).some(name => /^(authorization|cookie)$/i.test(name)), false);
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

test('quota refresh reads the same-origin endpoint without a search POST or location data', async () => {
  const counts = quota({ dayUsed: 3, monthUsed: 125 });
  const harness = adapterHarness({
    page: 'https://lunch.example.workers.dev/',
    config: { searchEndpoint: 'https://lunch.example.workers.dev/search', placesEnabled: false },
    fetch: () => response({ quota: counts })
  });
  assert.equal(harness.api.getQuota(), null);
  assert.equal(harness.api.getQuotaStatus(), 'idle');
  const first = harness.api.refreshQuota();
  const concurrent = harness.api.refreshQuota();
  assert.equal(first, concurrent, 'concurrent reads share one request');
  assert.equal(harness.api.getQuotaStatus(), 'loading');
  assert.equal(harness.api.getQuota(), null);
  await first;
  assert.deepEqual({ ...harness.api.getQuota() }, counts);
  assert.equal(harness.api.getQuotaStatus(), 'ready');
  assert.equal(harness.requests.length, 1);
  const { url, options } = harness.requests[0];
  assert.equal(url, 'https://lunch.example.workers.dev/quota');
  assert.equal(options.method, 'GET');
  assert.equal(options.body, undefined);
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.redirect, 'error');
  assert.deepEqual({ ...options.headers }, { Accept: 'application/json' });
  const other = adapterHarness();
  await assert.rejects(other.api.refreshQuota(), { code: 'NOT_CONFIGURED' });
  assert.equal(other.requests.length, 0, 'quota reads never target a separate origin');
});

test('failed or malformed quota reads clear counts instead of guessing unused quota', async () => {
  for (const failure of [
    () => response({ error: { code: 'REQUEST_FAILED' } }, 503),
    () => response({ quota: quota({ dayUsed: 21 }) }),
    () => response({ quota: quota(), error: { code: 'NETWORK' } }),
    () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('login HTML'); } }),
    () => { throw new TypeError('offline'); }
  ]) {
    const harness = adapterHarness({ page: 'https://lunch.example.workers.dev/', fetch: (_url, _options, attempt) => attempt === 1 ? response({ quota: quota() }) : failure() });
    await harness.api.refreshQuota();
    assert.ok(harness.api.getQuota());
    await assert.rejects(harness.api.refreshQuota());
    assert.equal(harness.api.getQuota(), null);
    assert.equal(harness.api.getQuotaStatus(), 'error');
    assert.equal(harness.requests.length, 2, 'no retry or search on read failure');
  }
});

test('quota refresh cannot overwrite newer search counts or clear them on a late read failure', async () => {
  for (const lateFailure of [false, true]) {
    let resolveRead;
    const counts = quota({ dayUsed: 8, monthUsed: 90 });
    const harness = adapterHarness({ page: 'https://lunch.example.workers.dev/', fetch: (_url, options) => options.method === 'GET'
      ? new Promise(resolve => { resolveRead = resolve; })
      : response({ places: [], quota: counts }) });
    const read = harness.api.refreshQuota();
    await harness.api.search('うどん', origin, {});
    resolveRead(lateFailure ? response({ error: { code: 'REQUEST_FAILED' } }, 503) : response({ quota: quota() }));
    await read;
    assert.deepEqual({ ...harness.api.getQuota() }, counts);
    assert.equal(harness.api.getQuotaStatus(), 'ready');
    assert.equal(harness.requests.length, 2);
  }
});

test('quota reads during an in-flight search defer to its result without another GET', async () => {
  let resolveSearch;
  const harness = adapterHarness({ page: 'https://lunch.example.workers.dev/', fetch: () => new Promise(resolve => { resolveSearch = resolve; }) });
  const search = harness.api.search('うどん', origin, {});
  assert.equal(await harness.api.refreshQuota(), null);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].options.method, 'POST');
  resolveSearch(response());
  await search;
  assert.deepEqual({ ...harness.api.getQuota() }, quota());
});

test('quota cards show pending, verified month/day balances and explicit read failure', async () => {
  let resolveRead;
  const adapter = adapterHarness({ page: 'https://lunch.example.workers.dev/', fetch: (_url, _options, attempt) => attempt === 1
    ? new Promise(resolve => { resolveRead = resolve; })
    : response({ error: { code: 'REQUEST_FAILED' } }, 503) });
  const ui = uiHarness(adapter.api);
  assert.equal(ui.elements.quotaMonthUsed.textContent, '確認中…');
  assert.equal(ui.elements.quotaMonthRemaining.textContent, '確認中…');
  assert.equal(ui.locationCalls, 0);
  resolveRead(response({ quota: quota({ dayUsed: 20, monthUsed: 450 }) }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.elements.quotaMonthUsed.textContent, '450回');
  assert.equal(ui.elements.quotaMonthRemaining.textContent, '150回');
  assert.equal(ui.elements.quotaDayRemaining.textContent, '0回');
  assert.match(ui.elements.quotaStatus.textContent, /今日は検索できません/);
  await ui.elements.quotaRefreshBtn.listeners.click();
  assert.equal(ui.elements.quotaMonthUsed.textContent, '取得できません');
  assert.equal(ui.elements.quotaMonthRemaining.textContent, '取得できません');
  assert.equal(ui.elements.quotaDayRemaining.textContent, '取得できません');
  assert.equal(ui.elements.quotaRefreshBtn.disabled, false);
  assert.equal(adapter.requests.every(({ options }) => options.method === 'GET'), true);
});

test('UI renders unknown ratings and reviews with unset filters and meter labels', async () => {
  const adapter = adapterHarness({ page: 'https://lunch.example.workers.dev/', fetch: (_url, options) => options.method === 'GET'
    ? response({ quota: quota() })
    : response({ places: [place('new', { rating: undefined, userRatingCount: undefined })], quota: quota({ dayUsed: 2, monthUsed: 2 }) }) });
  const ui = uiHarness(adapter.api);
  await new Promise(resolve => setImmediate(resolve));
  await ui.elements.restaurantSearchForm.listeners.submit({ preventDefault() {} });
  assert.equal(ui.elements.searchResults.hidden, false);
  const stats = ui.elements.restaurantList.children[0].children[1].children.map(element => element.textContent);
  assert.deepEqual(stats, ['評価情報なし', '口コミ情報なし', '0m']);
  assert.equal(ui.elements.resultCriteria.textContent, '評価指定なし・口コミ指定なし・100m以内 ／ 評価が高い順');
  assert.equal(ui.elements.quotaMonthUsed.textContent, '2回');
  assert.equal(ui.elements.quotaMonthRemaining.textContent, '598回');
  assert.equal(ui.elements.quotaDayRemaining.textContent, '18回');
  assert.deepEqual(ui.elements.restaurantList.children[0].children[2].children.map(element => element.textContent), ['検索ジャンル：', 'うどん']);
  assert.equal(ui.locationCalls, 1);
  assert.deepEqual(adapter.requests.map(({ options }) => options.method), ['GET', 'POST']);
});

test('genre toggles keep optional input, deduplicate aliases and allow a gacha choice to replace all selections', async () => {
  const adapter = adapterHarness({ page: 'https://lunch.example.workers.dev/', fetch: () => response({ quota: quota() }) });
  const ui = uiHarness(adapter.api, { genres: ['うどん', 'ラーメン', 'マック'] });
  const [udon, ramen, mac] = ui.elements.genreGrid.children;
  assert.equal(udon['aria-pressed'], 'true');
  assert.equal(ui.elements.genreInput.value, '');
  ramen.listeners.click();
  ui.elements.genreInput.value = 'マクドナルド';
  ui.elements.genreInput.listeners.input();
  mac.listeners.click();
  assert.equal(ui.elements.genreInput.value, 'マクドナルド');
  assert.match(ui.elements.genreSelectionSummary.textContent, /^3ジャンル選択中／検索は最大3回分使用/);
  ramen.listeners.click();
  assert.equal(ramen['aria-pressed'], 'false');
  assert.match(ui.elements.genreSelectionSummary.textContent, /^2ジャンル/);
  ui.api.chooseGenre('ラーメン');
  assert.equal(ui.elements.genreInput.value, '');
  assert.deepEqual(ui.elements.genreGrid.children.map(button => button['aria-pressed']), ['false', 'true', 'false']);
  assert.match(ui.elements.genreSelectionSummary.textContent, /^1ジャンル/);
  ui.api.chooseGenre('ハンバーグ');
  assert.equal(ui.elements.genreInput.value, 'ハンバーグ');
  assert.equal(ui.elements.genreGrid.children.every(button => button['aria-pressed'] === 'false'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.requests.every(({ options }) => options.method === 'GET'), true);
});

test('multiple genres search serially with one location lookup and merge duplicate restaurant labels', async () => {
  const resolvers = [];
  const adapter = adapterHarness({ page: 'https://lunch.example.workers.dev/', fetch: (_url, options) => options.method === 'GET'
    ? response({ quota: quota({ dayUsed: 0, monthUsed: 0 }) })
    : new Promise(resolve => { resolvers.push(resolve); }) });
  const ui = uiHarness(adapter.api, { genres: ['うどん', 'ラーメン'] });
  ui.elements.genreGrid.children[1].listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  const search = ui.elements.restaurantSearchForm.listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolvers.length, 1, 'second genre waits for the first');
  assert.equal(ui.elements.genreGrid.children.every(button => button.disabled), true);
  await ui.elements.restaurantSearchForm.listeners.submit({ preventDefault() {} });
  assert.equal(resolvers.length, 1, 'double submit cannot add another request');
  resolvers[0](response({ places: [place('shared')], quota: quota() }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolvers.length, 2);
  assert.equal(ui.elements.restaurantList.children.length, 1, 'first successful results are already visible');
  resolvers[1](response({ places: [place('shared'), place('other')], quota: quota({ dayUsed: 2, monthUsed: 2 }) }));
  await search;
  const posts = adapter.requests.filter(({ options }) => options.method === 'POST');
  assert.deepEqual(posts.map(({ options }) => JSON.parse(options.body).genre), ['うどん', 'ラーメン']);
  assert.equal(ui.locationCalls, 1);
  assert.equal(ui.elements.restaurantList.children.length, 2);
  const shared = ui.elements.restaurantList.children.find(card => card.children[0].textContent.includes('店舗shared'));
  assert.deepEqual(shared.children[2].children.map(element => element.textContent), ['検索ジャンル：', 'うどん', 'ラーメン']);
  assert.match(ui.elements.resultGenres.textContent, /うどん、ラーメン/);
  assert.equal(ui.elements.searchStatus.dataset.state, 'success');
  assert.equal(ui.elements.quotaMonthUsed.textContent, '2回');
});

test('mid-batch errors and limits retain successful restaurants and name failed and unsearched genres', async () => {
  for (const failedResponse of [
    () => { throw new TypeError('offline'); },
    () => response({ error: { code: 'QUOTA_EXCEEDED' }, quota: quota({ dayUsed: 20, monthUsed: 20 }) }, 429),
    () => response({ places: [], quota: null })
  ]) {
    let posts = 0;
    const adapter = adapterHarness({ page: 'https://lunch.example.workers.dev/', fetch: (_url, options) => {
      if (options.method === 'GET') return response({ quota: quota() });
      posts++;
      return posts === 1 ? response({ places: [place('kept')], quota: quota({ dayUsed: 2, monthUsed: 2 }) }) : failedResponse();
    } });
    const ui = uiHarness(adapter.api, { genres: ['うどん', 'ラーメン', 'カレー'] });
    ui.elements.genreGrid.children[1].listeners.click();
    ui.elements.genreGrid.children[2].listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    await ui.elements.restaurantSearchForm.listeners.submit({ preventDefault() {} });
    assert.equal(posts, 2, 'no retry and no third search after failure');
    assert.equal(ui.elements.restaurantList.children.length, 1);
    assert.match(ui.elements.restaurantList.children[0].children[0].textContent, /店舗kept/);
    assert.equal(ui.elements.searchStatus.dataset.state, 'partial');
    assert.match(ui.elements.searchStatus.textContent, /検索できなかったジャンル：ラーメン/);
    assert.match(ui.elements.searchStatus.textContent, /未検索：カレー/);
    assert.equal(ui.elements.searchBtn.disabled, false);
  }
});

test('only fresh in-batch exhausted counts stop later genres; stale initial counts never block the first POST', async () => {
  for (const counts of [quota({ dayUsed: 20, monthUsed: 30 }), quota({ dayUsed: 2, monthUsed: 600 })]) {
    const adapter = adapterHarness({ page: 'https://lunch.example.workers.dev/', fetch: (_url, options) => options.method === 'GET'
      ? response({ quota: quota({ dayUsed: 20, monthUsed: 600 }) })
      : response({ places: [place('kept')], quota: counts }) });
    const ui = uiHarness(adapter.api, { genres: ['うどん', 'ラーメン'] });
    ui.elements.genreGrid.children[1].listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    await ui.elements.restaurantSearchForm.listeners.submit({ preventDefault() {} });
    assert.equal(adapter.requests.filter(({ options }) => options.method === 'POST').length, 1);
    assert.equal(ui.elements.searchStatus.dataset.state, 'partial');
    assert.match(ui.elements.searchStatus.textContent, /未検索：ラーメン/);
    assert.equal(ui.elements.restaurantList.children.length, 1);
  }
});

test('an initial quota read failure does not block a server-checked search', async () => {
  const adapter = adapterHarness({ page: 'https://lunch.example.workers.dev/', fetch: (_url, options) => options.method === 'GET'
    ? response({ error: { code: 'REQUEST_FAILED' } }, 503) : response() });
  const ui = uiHarness(adapter.api);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.api.getQuota(), null);
  await ui.elements.restaurantSearchForm.listeners.submit({ preventDefault() {} });
  assert.equal(ui.elements.searchStatus.dataset.state, 'success');
  assert.equal(adapter.requests.filter(({ options }) => options.method === 'POST').length, 1);
});

test('no genre selection makes no location request or search POST', async () => {
  const adapter = adapterHarness({ page: 'https://lunch.example.workers.dev/', fetch: () => response({ quota: quota() }) });
  const ui = uiHarness(adapter.api);
  ui.elements.genreGrid.children[0].listeners.click();
  await ui.elements.restaurantSearchForm.listeners.submit({ preventDefault() {} });
  assert.equal(ui.locationCalls, 0);
  assert.equal(adapter.requests.some(({ options }) => options.method === 'POST'), false);
  assert.match(ui.elements.searchStatus.textContent, /ジャンルを1つ以上/);
  await new Promise(resolve => setImmediate(resolve));
});

test('a replacement genre during a pending search discards its results and prevents following requests', async () => {
  let resolveSearch;
  const adapter = adapterHarness({ page: 'https://lunch.example.workers.dev/', fetch: (_url, options) => options.method === 'GET'
    ? response({ quota: quota() }) : new Promise(resolve => { resolveSearch = resolve; }) });
  const ui = uiHarness(adapter.api, { genres: ['うどん', 'ラーメン', 'カレー'] });
  ui.elements.genreGrid.children[1].listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  const search = ui.elements.restaurantSearchForm.listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  ui.api.chooseGenre('カレー');
  resolveSearch(response());
  await search;
  assert.equal(adapter.requests.filter(({ options }) => options.method === 'POST').length, 1);
  assert.equal(ui.elements.searchResults.hidden, true);
  assert.equal(ui.elements.restaurantList.children.length, 0);
  assert.deepEqual(ui.elements.genreGrid.children.map(button => button['aria-pressed']), ['false', 'false', 'true']);
});

