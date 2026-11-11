(function (root, factory) {
  'use strict';
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.LunchSearchCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EARTH_KM = 6371.0088;
  const DEFAULTS = Object.freeze({ minRating: 4, minReviews: 100, radiusKm: 5, sort: 'rating' });
  const aliases = Object.freeze({ 'マック': 'マクドナルド', 'パン': 'パン屋', '弁当': '弁当屋', '丼もの': '丼もの' });
  const rad = value => value * Math.PI / 180;
  const deg = value => value * 180 / Math.PI;

  function bounded(value, fallback, min, max) {
    if (value === null || value === '' || value === undefined) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function normalizeCriteria(criteria = {}) {
    criteria = criteria || {};
    return {
      minRating: bounded(criteria.minRating, DEFAULTS.minRating, 0, 5),
      minReviews: Math.floor(bounded(criteria.minReviews, DEFAULTS.minReviews, 0, 1000000)),
      radiusKm: bounded(criteria.radiusKm, DEFAULTS.radiusKm, 0.1, 50),
      sort: ['rating', 'reviews', 'distance'].includes(criteria.sort) ? criteria.sort : DEFAULTS.sort
    };
  }

  function coordinates(value) {
    if (!value) return null;
    let lat;
    let lng;
    try {
      lat = typeof value.lat === 'function' ? value.lat() : (value.lat ?? value.latitude);
      lng = typeof value.lng === 'function' ? value.lng() : (value.lng ?? value.longitude);
    } catch (_) { return null; }
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  }

  function distanceKm(origin, location) {
    const a = coordinates(origin);
    const b = coordinates(location);
    if (!a || !b) return NaN;
    const latitudeDelta = rad(b.lat - a.lat);
    const longitudeDelta = rad(b.lng - a.lng);
    const h = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(longitudeDelta / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
  }

  function boundsForRadius(origin, radiusKm) {
    const center = coordinates(origin);
    if (!center) throw new TypeError('現在地を確認できません。');
    const radius = normalizeCriteria({ radiusKm }).radiusKm;
    const angularRadius = radius / EARTH_KM;
    const latitude = rad(center.lat);
    const south = Math.max(-Math.PI / 2, latitude - angularRadius);
    const north = Math.min(Math.PI / 2, latitude + angularRadius);
    if (south === -Math.PI / 2 || north === Math.PI / 2) {
      return { south: deg(south), north: deg(north), west: -180, east: 180 };
    }
    const longitudeDelta = deg(Math.asin(Math.min(1, Math.sin(angularRadius) / Math.cos(latitude))));
    const wrap = longitude => ((longitude + 540) % 360) - 180;
    return { south: deg(south), north: deg(north), west: wrap(center.lng - longitudeDelta), east: wrap(center.lng + longitudeDelta) };
  }

  function genreQuery(genre) {
    const name = String(genre || '').trim().slice(0, 80);
    return aliases[name] || name;
  }

  function buildSearchUrl(genre, origin) {
    const term = genreQuery(genre) || '飲食店';
    const center = coordinates(origin);
    const query = center ? `${term} near ${center.lat},${center.lng}` : `${term} 近く`;
    return `https://www.google.com/maps/search/?${new URLSearchParams({ api: '1', query })}`;
  }

  function buildPlaceUrl(id, name) {
    return `https://www.google.com/maps/search/?${new URLSearchParams({ api: '1', query: name, query_place_id: id })}`;
  }

  function buildShortlistUrl(ids) {
    const unique = [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))].slice(0, 20);
    if (!unique.length) return '';
    return `https://www.google.com/maps/@?${new URLSearchParams({ api: '1', map_action: 'shortlist', place_ids: unique.join(',') })}`;
  }

  function normalizeAttributions(attributions) {
    if (!Array.isArray(attributions)) return [];
    return attributions.flatMap(attribution => {
      if (!attribution || typeof attribution.provider !== 'string' || !attribution.provider.trim()) return [];
      let providerURI = '';
      try {
        const url = new URL(attribution.providerURI);
        if (url.protocol === 'https:' || url.protocol === 'http:') providerURI = url.href;
      } catch (_) { /* Provider text remains available without an unsafe link. */ }
      return [{ provider: attribution.provider, providerURI }];
    });
  }

  function filterPlaces(places, origin, criteria) {
    const center = coordinates(origin);
    if (!center || !Array.isArray(places)) return [];
    const filters = normalizeCriteria(criteria);
    const results = [];
    const seen = new Set();
    for (const place of places) {
      if (!place || typeof place.id !== 'string' || !place.id.trim()) continue;
      const id = place.id.trim();
      const name = typeof place.displayName === 'string' ? place.displayName.trim() : '';
      if (!name || seen.has(id)) continue;
      const rating = place.rating;
      const reviewCount = place.userRatingCount;
      if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 5) continue;
      if (typeof reviewCount !== 'number' || !Number.isSafeInteger(reviewCount) || reviewCount < 0) continue;
      const distance = distanceKm(center, place.location);
      if (!Number.isFinite(distance) || rating < filters.minRating || reviewCount < filters.minReviews || distance > filters.radiusKm + 1e-9) continue;
      seen.add(id);
      results.push({ id, name, rating, reviewCount, distanceKm: distance, mapsUrl: buildPlaceUrl(id, name), attributions: normalizeAttributions(place.attributions) });
    }
    const tie = (a, b) => a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id);
    const byRating = (a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount || a.distanceKm - b.distanceKm || tie(a, b);
    const byReviews = (a, b) => b.reviewCount - a.reviewCount || b.rating - a.rating || a.distanceKm - b.distanceKm || tie(a, b);
    const byDistance = (a, b) => a.distanceKm - b.distanceKm || b.rating - a.rating || b.reviewCount - a.reviewCount || tie(a, b);
    results.sort(filters.sort === 'reviews' ? byReviews : filters.sort === 'distance' ? byDistance : byRating);
    return results.slice(0, 10);
  }

  return Object.freeze({ DEFAULTS, normalizeCriteria, coordinates, distanceKm, boundsForRadius, genreQuery, filterPlaces, buildSearchUrl, buildShortlistUrl });
});
