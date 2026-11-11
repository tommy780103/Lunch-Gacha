(function (root, factory) {
  'use strict';
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.LunchSearchCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EARTH_KM = 6371.0088;
  const DEFAULTS = Object.freeze({ minRating: 4, minReviews: 100, radiusKm: 1, sort: 'rating' });
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

  function formatDistance(distance) {
    return distance < 1 ? `${Math.round(distance * 1000)}m` : `${Number(distance.toFixed(1))}km`;
  }

  function describeCriteria(criteria) {
    const filters = normalizeCriteria(criteria);
    const rating = filters.minRating === 0 ? '評価指定なし' : `★${filters.minRating.toFixed(1)}以上`;
    const reviews = filters.minReviews === 0 ? '口コミ指定なし' : `口コミ${filters.minReviews.toLocaleString('ja-JP')}件以上`;
    const sort = { rating: '評価が高い順', reviews: '口コミが多い順', distance: '近い順' }[filters.sort];
    return `${rating}・${reviews}・${formatDistance(filters.radiusKm)}以内 ／ ${sort}`;
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
    return Object.hasOwn(aliases, name) ? aliases[name] : name;
  }

  function normalizeGenres(genres) {
    const seen = new Set();
    return (Array.isArray(genres) ? genres : []).flatMap(value => {
      if (typeof value !== 'string') return [];
      const name = value.trim().slice(0, 80);
      const query = genreQuery(name);
      if (!query || seen.has(query)) return [];
      seen.add(query);
      return [name];
    });
  }

  function buildSearchUrl(genre, origin) {
    // Each genre has its own length limit; never truncate a joined batch.
    const term = (Array.isArray(genre)
      ? normalizeGenres(genre).map(genreQuery).join(' または ')
      : genreQuery(genre)) || '飲食店';
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

  function filterPlaces(places, origin, criteria, maxResults = 10) {
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
      // Missing information stays unknown. It is eligible only when its
      // corresponding minimum is unset; never turn it into a zero rating.
      const rating = place.rating ?? null;
      const reviewCount = place.userRatingCount ?? null;
      if (rating !== null && (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 5)) continue;
      if (reviewCount !== null && (typeof reviewCount !== 'number' || !Number.isSafeInteger(reviewCount) || reviewCount < 0)) continue;
      const distance = distanceKm(center, place.location);
      if (!Number.isFinite(distance) || distance > filters.radiusKm + 1e-9) continue;
      if (filters.minRating > 0 && (rating === null || rating < filters.minRating)) continue;
      if (filters.minReviews > 0 && (reviewCount === null || reviewCount < filters.minReviews)) continue;
      seen.add(id);
      results.push({ id, name, rating, reviewCount, distanceKm: distance, mapsUrl: buildPlaceUrl(id, name), attributions: normalizeAttributions(place.attributions) });
    }
    return sortPlaces(results, filters.sort).slice(0, maxResults === 20 ? 20 : 10);
  }

  function sortPlaces(places, sort) {
    const tie = (a, b) => a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id);
    const ratingOrder = (a, b) => (b.rating ?? -1) - (a.rating ?? -1);
    const reviewOrder = (a, b) => (b.reviewCount ?? -1) - (a.reviewCount ?? -1);
    const byRating = (a, b) => ratingOrder(a, b) || reviewOrder(a, b) || a.distanceKm - b.distanceKm || tie(a, b);
    const byReviews = (a, b) => reviewOrder(a, b) || ratingOrder(a, b) || a.distanceKm - b.distanceKm || tie(a, b);
    const byDistance = (a, b) => a.distanceKm - b.distanceKm || ratingOrder(a, b) || reviewOrder(a, b) || tie(a, b);
    return places.sort(sort === 'reviews' ? byReviews : sort === 'distance' ? byDistance : byRating);
  }

  // Genres describe the search that found a place, not Google's official type.
  // Merge all matching candidates before the final top ten so duplicate labels
  // and provider attribution are retained even beyond one genre's first ten.
  function mergeGenreResults(groups, criteria) {
    const merged = new Map();
    for (const group of Array.isArray(groups) ? groups : []) {
      const genre = normalizeGenres([group?.genre])[0];
      if (!genre || !Array.isArray(group.places)) continue;
      for (const place of group.places) {
        if (!place || typeof place.id !== 'string' || !place.id || typeof place.name !== 'string') continue;
        const previous = merged.get(place.id);
        if (previous) {
          previous.genres = normalizeGenres([...previous.genres, genre]);
          const seen = new Set(previous.attributions.map(source => JSON.stringify([source.provider, source.providerURI])));
          for (const source of normalizeAttributions(place.attributions)) {
            const key = JSON.stringify([source.provider, source.providerURI]);
            if (!seen.has(key)) { previous.attributions.push(source); seen.add(key); }
          }
        } else {
          merged.set(place.id, { ...place, genres: [genre], attributions: normalizeAttributions(place.attributions) });
        }
      }
    }
    return sortPlaces([...merged.values()], normalizeCriteria(criteria).sort).slice(0, 10);
  }

  return Object.freeze({ DEFAULTS, normalizeCriteria, formatDistance, describeCriteria, coordinates, distanceKm, boundsForRadius, genreQuery, normalizeGenres, filterPlaces, mergeGenreResults, buildSearchUrl, buildShortlistUrl });
});

