export const DAILY_LIMIT = 20;
export const MONTHLY_LIMIT = 600;
export const STATE_KEY = 'quota-v1';
export const GLOBAL_OBJECT_NAME = 'lunch-gacha-global-v1';
export const GOOGLE_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
export const GOOGLE_FIELDS = 'places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.googleMapsUri,places.attributions';

export class SearchError extends Error {
  constructor(code, status, message, quota) {
    super(message);
    this.code = code;
    this.status = status;
    this.quota = quota;
  }
}

const calendar = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
});

export function billingPeriod(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid clock');
  const parts = Object.fromEntries(calendar.formatToParts(now).map(part => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, month: `${parts.year}-${parts.month}` };
}

export function quotaSummary(state) {
  return { dayUsed: state.dayUsed, dayLimit: DAILY_LIMIT, monthUsed: state.monthUsed, monthLimit: MONTHLY_LIMIT };
}

function validState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  if (Object.keys(state).sort().join(',') !== 'day,dayUsed,month,monthUsed,version') return false;
  if (state.version !== 1 || typeof state.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(state.day)) return false;
  const date = new Date(`${state.day}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== state.day) return false;
  return state.month === state.day.slice(0, 7)
    && Number.isSafeInteger(state.dayUsed) && state.dayUsed >= 0 && state.dayUsed <= DAILY_LIMIT
    && Number.isSafeInteger(state.monthUsed) && state.monthUsed >= state.dayUsed && state.monthUsed <= MONTHLY_LIMIT;
}

export function nextReservation(previous, now = new Date()) {
  const period = billingPeriod(now);
  if (previous !== undefined && (!validState(previous) || previous.day > period.day)) {
    throw new Error('Quota state is invalid; refusing to reset it');
  }
  const state = previous === undefined
    ? { version: 1, ...period, dayUsed: 0, monthUsed: 0 }
    : { ...previous };
  if (state.month !== period.month) {
    state.month = period.month;
    state.monthUsed = 0;
  }
  if (state.day !== period.day) {
    state.day = period.day;
    state.dayUsed = 0;
  }
  if (state.dayUsed >= DAILY_LIMIT || state.monthUsed >= MONTHLY_LIMIT) {
    throw new SearchError('QUOTA_EXCEEDED', 429, 'お店検索の利用上限に達しました。次の更新までお待ちください。', quotaSummary(state));
  }
  state.dayUsed += 1;
  state.monthUsed += 1;
  return state;
}

// The transaction contains no network operations: a retry can never call Google twice.
export async function reserveQuota(storage, now = new Date()) {
  const quota = await storage.transaction(async transaction => {
    const state = nextReservation(await transaction.get(STATE_KEY), now);
    await transaction.put(STATE_KEY, state);
    return quotaSummary(state);
  });
  // Wait for durable persistence before permitting any billable request.
  await storage.sync();
  return quota;
}

function invalid() {
  throw new SearchError('INVALID_REQUEST', 400, '検索条件が正しくありません。');
}

function onlyKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
}

function numberInRange(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid();
  return value;
}

export function validateSearchInput(input) {
  onlyKeys(input, ['genre', 'origin', 'criteria']);
  if (typeof input.genre !== 'string' || !input.genre.trim() || input.genre.length > 80 || /[\u0000-\u001f\u007f]/.test(input.genre)) invalid();
  onlyKeys(input.origin, ['lat', 'lng']);
  const origin = {
    lat: numberInRange(input.origin.lat, -90, 90),
    lng: numberInRange(input.origin.lng, -180, 180)
  };
  const criteria = input.criteria === undefined ? {} : input.criteria;
  onlyKeys(criteria, ['minRating', 'minReviews', 'radiusKm', 'sort']);
  const minRating = numberInRange(criteria.minRating === undefined ? 4 : criteria.minRating, 0, 5);
  const minReviews = numberInRange(criteria.minReviews === undefined ? 100 : criteria.minReviews, 0, 1000000);
  const radiusKm = numberInRange(criteria.radiusKm === undefined ? 5 : criteria.radiusKm, 0.1, 50);
  const sort = criteria.sort === undefined ? 'rating' : criteria.sort;
  if (!Number.isSafeInteger(minReviews) || !['rating', 'reviews', 'distance'].includes(sort)) invalid();
  return { genre: input.genre.trim(), origin, criteria: { minRating, minReviews, radiusKm, sort } };
}

export function googleSearchBody(input) {
  const { genre, origin, criteria } = input;
  const radians = degrees => degrees * Math.PI / 180;
  const degrees = radians => radians * 180 / Math.PI;
  const angularRadius = criteria.radiusKm / 6371.0088;
  const latitude = radians(origin.lat);
  const south = Math.max(-Math.PI / 2, latitude - angularRadius);
  const north = Math.min(Math.PI / 2, latitude + angularRadius);
  let west = -180;
  let east = 180;
  if (south !== -Math.PI / 2 && north !== Math.PI / 2) {
    const delta = degrees(Math.asin(Math.min(1, Math.sin(angularRadius) / Math.cos(latitude))));
    const wrap = longitude => ((longitude + 540) % 360) - 180;
    west = wrap(origin.lng - delta);
    east = wrap(origin.lng + delta);
  }
  const aliases = { 'マック': 'マクドナルド', 'パン': 'パン屋', '弁当': '弁当屋' };
  return {
    textQuery: `${Object.hasOwn(aliases, genre) ? aliases[genre] : genre} 飲食店`,
    languageCode: 'ja', regionCode: 'JP', pageSize: 20,
    minRating: Math.floor(criteria.minRating * 2) / 2,
    locationRestriction: { rectangle: {
      low: { latitude: degrees(south), longitude: west },
      high: { latitude: degrees(north), longitude: east }
    } }
  };
}

function safeUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

export function normalizePlaces(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || (payload.places !== undefined && !Array.isArray(payload.places))) throw new Error('Invalid Google response');
  return (payload.places || []).slice(0, 20).flatMap(place => {
    if (!place || typeof place.id !== 'string' || typeof place.displayName?.text !== 'string') return [];
    const lat = place.location?.latitude;
    const lng = place.location?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return [];
    return [{
      id: place.id, displayName: place.displayName.text,
      location: { lat, lng }, rating: place.rating, userRatingCount: place.userRatingCount,
      googleMapsURI: safeUrl(place.googleMapsUri),
      attributions: (Array.isArray(place.attributions) ? place.attributions : []).flatMap(attribution =>
        typeof attribution?.provider === 'string'
          ? [{ provider: attribution.provider, providerURI: safeUrl(attribution.providerUri) }] : [])
    }];
  });
}
