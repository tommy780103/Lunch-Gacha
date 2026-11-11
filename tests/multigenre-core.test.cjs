const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../search-core.js');

test('1km is the default radius while an explicit wider radius is preserved', () => {
  const places = [
    { id: 'near', displayName: '近い店', rating: 4.5, userRatingCount: 100, location: { lat: 0.005, lng: 0 } },
    { id: 'far', displayName: '遠い店', rating: 4.5, userRatingCount: 100, location: { lat: 0.02, lng: 0 } }
  ];
  assert.equal(core.DEFAULTS.radiusKm, 1);
  assert.deepEqual(core.filterPlaces(places, { lat: 0, lng: 0 }).map(place => place.id), ['near']);
  assert.equal(core.filterPlaces(places, { lat: 0, lng: 0 }, { radiusKm: 5 }).length, 2);
});

test('genre selection deduplicates whitespace and aliases without changing display labels', () => {
  assert.deepEqual(core.normalizeGenres([' うどん ', 'ラーメン', 'うどん', '', null, 'マック', 'マクドナルド', 'constructor']), ['うどん', 'ラーメン', 'マック', 'constructor']);
  assert.deepEqual(core.normalizeGenres(null), []);
});

test('the fallback Maps URL preserves every selected genre beyond eighty combined characters', () => {
  const genres = ['うどん', 'ラーメン', '寿司', '焼肉', 'マック', '定食', 'パスタ', 'カレー', '中華', '丼もの', 'ピザ', '弁当', 'パン', '追加のジャンル'.repeat(8)];
  const expected = core.normalizeGenres(genres).map(core.genreQuery).join(' または ');
  assert.ok(expected.length > 80);
  const url = new URL(core.buildSearchUrl(genres, { lat: 0, lng: 0 }));
  assert.equal(url.searchParams.get('query'), `${expected} near 0,0`);
  assert.equal(new URL(core.buildSearchUrl([])).searchParams.get('query'), '飲食店 近く');
});

test('all twenty candidates retain search labels and attribution before a final top-ten merge', () => {
  const raw = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, displayName: `店${i}`, rating: 5 - i * 0.05, userRatingCount: 100 + i, location: { lat: i * 0.0001, lng: 0 } }));
  raw[19].attributions = [{ provider: 'A', providerURI: 'https://a.example/' }];
  const all = core.filterPlaces(raw, { lat: 0, lng: 0 }, { minRating: 0, minReviews: 0 }, 20);
  assert.equal(all.length, 20);
  assert.equal(core.filterPlaces(raw, { lat: 0, lng: 0 }, { minRating: 0, minReviews: 0 }).length, 10);
  const promoted = { ...all[19], rating: 5, reviewCount: 500, attributions: [{ provider: 'B', providerURI: 'https://b.example/' }] };
  const groups = [{ genre: 'ラーメン', places: [promoted] }, { genre: '中華', places: all }, { genre: '中華', places: all }];
  const snapshot = JSON.stringify(groups);
  const merged = core.mergeGenreResults(groups, { sort: 'rating' });
  assert.equal(merged.length, 10);
  assert.equal(merged[0].id, 'p19');
  assert.deepEqual(merged[0].genres, ['ラーメン', '中華']);
  assert.deepEqual(merged[0].attributions.map(source => source.provider), ['B', 'A']);
  assert.equal(new Set(merged.map(place => place.id)).size, 10);
  assert.equal(JSON.stringify(groups), snapshot);
});

test('merged results use the chosen ranking and keep unknown ratings after known ratings', () => {
  const a = { id: 'a', name: 'A', rating: 4.5, reviewCount: 100, distanceKm: 0.7 };
  const b = { id: 'b', name: 'B', rating: 4, reviewCount: 500, distanceKm: 0.5 };
  const c = { id: 'c', name: 'C', rating: null, reviewCount: null, distanceKm: 0.1 };
  const groups = [{ genre: '定食', places: [a, c] }, { genre: 'カレー', places: [b] }];
  assert.deepEqual(core.mergeGenreResults(groups, { sort: 'rating' }).map(place => place.id), ['a', 'b', 'c']);
  assert.deepEqual(core.mergeGenreResults(groups, { sort: 'reviews' }).map(place => place.id), ['b', 'a', 'c']);
  assert.deepEqual(core.mergeGenreResults(groups, { sort: 'distance' }).map(place => place.id), ['c', 'b', 'a']);
});
