const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../search-core.js');

test('custom criteria are displayed without rounding their thresholds', () => {
  assert.equal(core.describeCriteria({ minRating: 4.35, minReviews: 5678, radiusKm: 1.25 }), '★4.35以上・口コミ5,678件以上・1.25km以内 ／ 評価が高い順');
  assert.equal(core.describeCriteria({ minRating: 4, minReviews: 5000, radiusKm: 0.15 }), '★4.0以上・口コミ5,000件以上・150m以内 ／ 評価が高い順');
  assert.equal(core.describeCriteria({ minRating: 0, minReviews: 0, radiusKm: 0.12345 }), '評価指定なし・口コミ指定なし・0.12345km以内 ／ 評価が高い順');
});

test('custom rating, review and distance thresholds exclude nearby lower matches', () => {
  const locationAt = km => ({ lat: km / 6371.0088 * 180 / Math.PI, lng: 0 });
  const place = { id: 'match', displayName: '一致する店', rating: 4.35, userRatingCount: 5678, location: locationAt(1.24) };
  const candidates = [
    place,
    { ...place, id: 'rating-low', rating: 4.34 },
    { ...place, id: 'reviews-low', userRatingCount: 5677 },
    { ...place, id: 'too-far', location: locationAt(1.26) }
  ];
  assert.deepEqual(core.filterPlaces(candidates, { lat: 0, lng: 0 }, { minRating: 4.35, minReviews: 5678, radiusKm: 1.25 }).map(item => item.id), ['match']);
});
