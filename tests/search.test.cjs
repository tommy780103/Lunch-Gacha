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

function adapterHarness({ configured = true, search, existingLibrary = true, importPlaces, onAppend, timers } = {}) {
  const queries = [];
  const scriptLoads = [];
  let libraryImports = 0;
  const library = { Place: { searchByText: async request => {
    queries.push(request);
    return search ? search(request) : { places: [place('A')] };
  } } };
  const fakeGoogle = { maps: { importLibrary: async name => {
    assert.equal(name, 'places');
    libraryImports++;
    if (importPlaces) return importPlaces(libraryImports, library);
    return library;
  } } };
  const root = {
    LunchSearchCore: core,
    LUNCH_GACHA_CONFIG: { googleMapsApiKey: configured ? 'browser-restricted-test-key' : '', placesEnabled: configured },
    setTimeout: timers ? timers.setTimeout : setTimeout,
    clearTimeout: timers ? timers.clearTimeout : clearTimeout,
    document: {
      createElement: () => ({ remove() {} }),
      head: { appendChild(script) {
        scriptLoads.push(script.src);
        if (onAppend) {
          onAppend({ script, root, fakeGoogle, attempt: scriptLoads.length });
          return;
        }
        root.google = fakeGoogle;
        const callback = new URL(script.src).searchParams.get('callback');
        queueMicrotask(() => root[callback]());
      } }
    }
  };
  if (existingLibrary) root.google = fakeGoogle;
  const context = { window: root, URL, URLSearchParams, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../places-search.js'), 'utf8'), context);
  return { api: root.LunchPlaces, queries, scriptLoads, imports: () => libraryImports, root };
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

test('unconfigured adapter fails closed and never loads the SDK or performs a query', async () => {
  const harness = adapterHarness({ configured: false, existingLibrary: false });
  assert.equal(harness.api.isConfigured(), false);
  await assert.rejects(harness.api.search('ラーメン', origin, {}), { code: 'NOT_CONFIGURED' });
  assert.equal(harness.scriptLoads.length, 0);
  assert.equal(harness.queries.length, 0);
});

test('one paid query requests only needed fields and applies exact rating and count thresholds', async () => {
  const harness = adapterHarness({ search: () => ({ places: [place('pass'), place('low', { rating: 4.1 }), place('few', { userRatingCount: 99 })] }) });
  const result = await harness.api.search('マック', origin, { minRating: 4.2, minReviews: 100, radiusKm: 3 });
  assert.deepEqual(result.map(item => item.id), ['pass']);
  assert.equal(harness.queries.length, 1);
  const request = harness.queries[0];
  assert.equal(request.textQuery, 'マクドナルド 飲食店');
  assert.equal(request.minRating, 4);
  assert.equal(request.maxResultCount, 20);
  assert.equal(request.language, 'ja');
  assert.equal(request.region, 'jp');
  assert.deepEqual([...request.fields], ['id', 'displayName', 'location', 'rating', 'userRatingCount', 'googleMapsURI', 'attributions']);
  assert.equal(request.locationBias, undefined);
  assert.deepEqual(request.locationRestriction, core.boundsForRadius(origin, 3));
});

test('SDK is lazy-loaded once and reused across searches without constructing a map', async () => {
  const harness = adapterHarness({ existingLibrary: false });
  assert.equal(harness.scriptLoads.length, 0);
  await harness.api.search('ラーメン', origin, {});
  await harness.api.search('うどん', origin, {});
  assert.equal(harness.scriptLoads.length, 1);
  assert.equal(harness.imports(), 1);
  assert.equal(harness.queries.length, 2);
  const url = new URL(harness.scriptLoads[0]);
  assert.equal(url.origin, 'https://maps.googleapis.com');
  assert.equal(url.searchParams.get('loading'), 'async');
  assert.equal(url.searchParams.get('language'), 'ja');
  assert.equal(url.searchParams.get('auth_referrer_policy'), 'origin');
});

test('a failed library import is retried only after the next explicit search', async () => {
  const harness = adapterHarness({ importPlaces: (attempt, library) => {
    if (attempt === 1) throw new Error('Network unavailable');
    return library;
  } });
  await assert.rejects(harness.api.search('ラーメン', origin, {}), { code: 'NETWORK' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.imports(), 1, 'no automatic retry');
  assert.equal(harness.queries.length, 0);
  const result = await harness.api.search('ラーメン', origin, {});
  assert.equal(result.length, 1);
  assert.equal(harness.imports(), 2);
  assert.equal(harness.queries.length, 1);
});

test('a timed-out script can be retried and its late callback cannot affect the new load', async () => {
  const timers = new Map();
  let nextTimer = 0;
  const attempts = [];
  const harness = adapterHarness({
    existingLibrary: false,
    timers: {
      setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); }
    },
    onAppend: state => attempts.push(state)
  });
  const first = harness.api.search('ラーメン', origin, {});
  const firstRejected = assert.rejects(first, { code: 'NETWORK' });
  assert.equal(timers.size, 1);
  timers.values().next().value();
  await firstRejected;
  assert.equal(timers.size, 0, 'expired load cleans up its timer');
  assert.equal(attempts.length, 1, 'no automatic retry');

  const second = harness.api.search('ラーメン', origin, {});
  assert.equal(attempts.length, 2);
  const firstCallback = new URL(attempts[0].script.src).searchParams.get('callback');
  const secondCallback = new URL(attempts[1].script.src).searchParams.get('callback');
  assert.notEqual(firstCallback, secondCallback);
  harness.root[firstCallback]();
  await Promise.resolve();
  assert.equal(harness.queries.length, 0, 'retired callback does not start a query');
  assert.equal(timers.size, 1, 'late callback does not clear the current load timer');

  harness.root.google = attempts[1].fakeGoogle;
  harness.root[secondCallback]();
  assert.equal((await second).length, 1);
  assert.equal(harness.queries.length, 1);
  assert.equal(timers.size, 0);
});

test('empty results stay empty; quota and network failures are classified without retries', async () => {
  const empty = adapterHarness({ search: () => ({ places: [] }) });
  assert.deepEqual(await empty.api.search('カレー', origin, {}), []);
  for (const [source, expected] of [['OVER_QUERY_LIMIT', 'QUOTA_EXCEEDED'], ['RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED'], ['Failed to fetch', 'NETWORK'], ['REQUEST_DENIED', 'REQUEST_FAILED']]) {
    const harness = adapterHarness({ search: () => { throw new Error(source); } });
    await assert.rejects(harness.api.search('ラーメン', origin, {}), { code: expected });
    assert.equal(harness.queries.length, 1);
  }
});
