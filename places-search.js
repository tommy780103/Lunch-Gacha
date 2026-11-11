(function (root) {
  'use strict';

  const core = root.LunchSearchCore;
  const LOAD_TIMEOUT_MS = 15000;
  const SEARCH_TIMEOUT_MS = 20000;
  let libraryPromise;
  let loadAttempt = 0;

  function fail(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function isConfigured() {
    const config = root.LUNCH_GACHA_CONFIG || {};
    return config.placesEnabled === true && typeof config.googleMapsApiKey === 'string' && config.googleMapsApiKey.trim().length > 0;
  }

  function classifyError(error) {
    if (['NOT_CONFIGURED', 'QUOTA_EXCEEDED', 'NETWORK', 'REQUEST_FAILED'].includes(error && error.code)) return error;
    const status = [error && error.code, error && error.status, error && error.message].filter(Boolean).join(' ');
    if (/OVER_QUERY_LIMIT|RESOURCE_EXHAUSTED|quota|rate.?limit|429/i.test(status)) return fail('QUOTA_EXCEEDED', '本日の条件検索は上限に達しました。通常の Google マップ検索をご利用ください。');
    if (/network|failed to fetch|timeout|timed out|offline/i.test(status)) return fail('NETWORK', '通信できませんでした。接続を確認してから、もう一度お試しください。');
    return fail('REQUEST_FAILED', '条件検索を利用できません。通常の Google マップ検索をご利用ください。');
  }

  function withTimeout(promise, timeout) {
    return new Promise((resolve, reject) => {
      const timer = root.setTimeout(() => reject(fail('NETWORK', '通信に時間がかかっています。もう一度お試しください。')), timeout);
      Promise.resolve(promise).then(value => { root.clearTimeout(timer); resolve(value); }, error => { root.clearTimeout(timer); reject(error); });
    });
  }

  function loadPlaces() {
    if (!isConfigured()) return Promise.reject(fail('NOT_CONFIGURED', '条件検索は準備中です。通常の Google マップ検索をご利用ください。'));
    if (libraryPromise) return libraryPromise;
    // The SDK is loaded only after an explicit search. No map is constructed.
    const pending = new Promise((resolve, reject) => {
      if (root.google && root.google.maps && typeof root.google.maps.importLibrary === 'function') {
        withTimeout(root.google.maps.importLibrary('places'), LOAD_TIMEOUT_MS).then(resolve, reject);
        return;
      }
      // Each attempt gets its own callback. A late script from a timed-out
      // attempt must never resolve or reject a later user-initiated attempt.
      const callbackName = `__lunchGachaMapsReady${++loadAttempt}`;
      const script = root.document.createElement('script');
      const previousAuthFailure = root.gm_authFailure;
      let settled = false;
      const finish = (error, library) => {
        if (settled) return;
        settled = true;
        root.clearTimeout(timer);
        script.onerror = null;
        // Keep a no-op callback so a late network response cannot throw.
        root[callbackName] = function () {};
        root.gm_authFailure = previousAuthFailure;
        if (error) { script.remove(); reject(error); }
        else resolve(library);
      };
      const timer = root.setTimeout(() => finish(fail('NETWORK', 'Google マップへの接続がタイムアウトしました。')), LOAD_TIMEOUT_MS);
      root[callbackName] = function () {
        if (!root.google || !root.google.maps || typeof root.google.maps.importLibrary !== 'function') {
          finish(fail('REQUEST_FAILED', '店舗情報を読み込めませんでした。'));
          return;
        }
        root.google.maps.importLibrary('places').then(library => finish(null, library), error => finish(classifyError(error)));
      };
      root.gm_authFailure = function () {
        finish(fail('REQUEST_FAILED', '条件検索を利用できません。通常の Google マップ検索をご利用ください。'));
        if (typeof previousAuthFailure === 'function') previousAuthFailure();
      };
      const params = new URLSearchParams({
        key: root.LUNCH_GACHA_CONFIG.googleMapsApiKey.trim(),
        v: 'quarterly', loading: 'async', language: 'ja', region: 'JP',
        auth_referrer_policy: 'origin', callback: callbackName
      });
      script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
      script.async = true;
      script.onerror = () => finish(fail('NETWORK', 'Google マップに接続できませんでした。'));
      root.document.head.appendChild(script);
    });
    const loaded = pending.catch(error => {
      if (libraryPromise === loaded) libraryPromise = null;
      throw classifyError(error);
    });
    libraryPromise = loaded;
    // Failure clears only our cached promise. A retry starts exclusively on
    // the next explicit search; no background or automatic retry is scheduled.
    return libraryPromise;
  }

  async function search(genre, origin, criteria) {
    if (!isConfigured()) throw fail('NOT_CONFIGURED', '条件検索は準備中です。通常の Google マップ検索をご利用ください。');
    const center = core.coordinates(origin);
    const term = core.genreQuery(genre);
    if (!center || !term) throw fail('REQUEST_FAILED', 'ジャンルと現在地を確認してください。');
    const filters = core.normalizeCriteria(criteria);
    try {
      const { Place } = await loadPlaces();
      const request = {
        textQuery: `${term} 飲食店`,
        fields: ['id', 'displayName', 'location', 'rating', 'userRatingCount', 'googleMapsURI', 'attributions'],
        locationRestriction: core.boundsForRadius(center, filters.radiusKm),
        // The API rounds UP to 0.5; round down here and apply the exact user threshold below.
        minRating: Math.floor(filters.minRating * 2) / 2,
        maxResultCount: 20,
        language: 'ja',
        region: 'jp'
      };
      // Exactly one query. No pagination, background refresh, or automatic retry.
      const response = await withTimeout(Place.searchByText(request), SEARCH_TIMEOUT_MS);
      if (!response || !Array.isArray(response.places)) throw fail('REQUEST_FAILED', '店舗情報を取得できませんでした。');
      return core.filterPlaces(response.places, center, filters);
    } catch (error) {
      throw classifyError(error);
    }
  }

  root.LunchPlaces = Object.freeze({ search, isConfigured });
})(typeof window !== 'undefined' ? window : globalThis);
