(function (root) {
  'use strict';

  const core = root.LunchSearchCore;
  const SEARCH_TIMEOUT_MS = 25000;
  const DAY_LIMIT = 20;
  const MONTH_LIMIT = 600;
  let lastQuota = null;
  let quotaStatus = 'idle';
  let quotaGeneration = 0;
  let activeSearches = 0;
  let pendingQuotaRead = null;

  function fail(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function endpoint(requireEnabled = true) {
    const config = root.LUNCH_GACHA_CONFIG || {};
    if ((requireEnabled && config.placesEnabled !== true) || typeof config.searchEndpoint !== 'string' || !config.searchEndpoint.trim()) return null;
    try {
      const url = new URL(config.searchEndpoint.trim());
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/search') return null;
      if (url.protocol === 'https:') return url.href;
      // HTTP is permitted only when both the page and endpoint are on the
      // same local development origin. A published page cannot opt into it.
      const page = new URL(root.location.href);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(page.hostname);
      return local && page.protocol === 'http:' && url.origin === page.origin ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  function isConfigured() {
    return endpoint() !== null;
  }

  function validQuota(quota) {
    if (!quota || quota.dayLimit !== DAY_LIMIT || quota.monthLimit !== MONTH_LIMIT) return null;
    if (!Number.isSafeInteger(quota.dayUsed) || quota.dayUsed < 0 || quota.dayUsed > DAY_LIMIT) return null;
    if (!Number.isSafeInteger(quota.monthUsed) || quota.monthUsed < 0 || quota.monthUsed > MONTH_LIMIT) return null;
    if (quota.monthUsed < quota.dayUsed) return null;
    return { dayUsed: quota.dayUsed, dayLimit: DAY_LIMIT, monthUsed: quota.monthUsed, monthLimit: MONTH_LIMIT };
  }

  function getQuota() {
    return lastQuota ? { ...lastQuota } : null;
  }

  function getQuotaStatus() {
    return quotaStatus;
  }

  function saveQuota(generation, quota, status = quota ? 'ready' : 'error') {
    if (generation !== quotaGeneration) return;
    lastQuota = quota;
    quotaStatus = status;
  }

  function responseError(status, payload) {
    const code = payload && payload.error && payload.error.code;
    if (status === 429 || code === 'QUOTA_EXCEEDED') return fail('QUOTA_EXCEEDED', '条件検索の利用上限に達しました。通常の Google マップ検索をご利用ください。');
    if (code === 'NOT_CONFIGURED') return fail('NOT_CONFIGURED', '条件検索は準備中です。通常の Google マップ検索をご利用ください。');
    if (code === 'NETWORK') return fail('NETWORK', '通信できませんでした。接続を確認してから、もう一度お試しください。');
    return fail('REQUEST_FAILED', '条件検索を利用できません。通常の Google マップ検索をご利用ください。');
  }

  async function fetchJson(url, options) {
    if (typeof root.fetch !== 'function' || typeof root.AbortController !== 'function') throw fail('REQUEST_FAILED', 'このブラウザーでは条件検索を利用できません。');
    const controller = new root.AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = root.setTimeout(() => {
          reject(fail('NETWORK', '通信に時間がかかっています。もう一度お試しください。'));
          controller.abort();
        }, SEARCH_TIMEOUT_MS);
      });
      const request = (async () => {
        const response = await root.fetch(url, {
          // Send the Access session cookie only to this page's own origin.
          // A separately configured origin never receives browser credentials.
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          ...options,
          signal: controller.signal
        });
        let payload;
        try { payload = await response.json(); }
        catch (_) { throw responseError(response.status); }
        return { response, payload };
      })();
      return await Promise.race([request, timeout]);
    } finally {
      root.clearTimeout(timer);
    }
  }

  function refreshQuota() {
    // A read started during a search could return the pre-reservation count.
    // Use the search response instead, and invalidate reads started before it.
    if (activeSearches) return Promise.resolve(getQuota());
    if (pendingQuotaRead?.generation === quotaGeneration) return pendingQuotaRead.promise;
    const generation = ++quotaGeneration;
    saveQuota(generation, null, 'loading');
    const promise = (async () => {
      try {
        const searchUrl = endpoint(false);
        if (!searchUrl || new URL(searchUrl).origin !== new URL(root.location.href).origin) {
          throw fail('NOT_CONFIGURED', '利用回数の取得先を確認できません。');
        }
        const url = new URL('/quota', searchUrl).href;
        const { response, payload } = await fetchJson(url, { method: 'GET', headers: { Accept: 'application/json' } });
        if (!response.ok) throw responseError(response.status, payload);
        const quota = validQuota(payload && payload.quota);
        if (!quota || payload.error) throw fail('REQUEST_FAILED', '利用回数を取得できませんでした。');
        saveQuota(generation, quota);
        return getQuota();
      } catch (error) {
        if (generation !== quotaGeneration) return getQuota();
        saveQuota(generation, null);
        if (['NOT_CONFIGURED', 'NETWORK', 'REQUEST_FAILED', 'QUOTA_EXCEEDED'].includes(error?.code)) throw error;
        throw fail('NETWORK', '利用回数を取得できませんでした。');
      }
    })().finally(() => {
      if (pendingQuotaRead?.generation === generation) pendingQuotaRead = null;
    });
    pendingQuotaRead = { generation, promise };
    return promise;
  }

  async function search(genre, origin, criteria) {
    const generation = ++quotaGeneration;
    saveQuota(generation, null, 'loading');
    activeSearches += 1;
    try {
      const url = endpoint();
      if (!url) throw fail('NOT_CONFIGURED', '条件検索は準備中です。通常の Google マップ検索をご利用ください。');
      const center = core.coordinates(origin);
      const term = core.genreQuery(genre);
      if (!center || !term) throw fail('REQUEST_FAILED', 'ジャンルと現在地を確認してください。');
      const filters = core.normalizeCriteria(criteria);
      // One explicit search makes one POST. Quota reads never use this path.
      const { response, payload } = await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ genre: term, origin: center, criteria: filters })
      });
      const quota = validQuota(payload && payload.quota);
      saveQuota(generation, quota);
      if (!response.ok) throw responseError(response.status, payload);
      if (!quota || !payload || !Array.isArray(payload.places) || payload.places.length > 20 || payload.error) {
        saveQuota(generation, null);
        throw fail('REQUEST_FAILED', '店舗情報と利用回数を確認できませんでした。もう一度お試しください。');
      }
      return core.filterPlaces(payload.places, center, filters);
    } catch (error) {
      if (generation === quotaGeneration && !lastQuota) quotaStatus = 'error';
      if (['NOT_CONFIGURED', 'QUOTA_EXCEEDED', 'NETWORK', 'REQUEST_FAILED'].includes(error && error.code)) throw error;
      saveQuota(generation, null);
      throw fail('NETWORK', '通信できませんでした。接続を確認してから、もう一度お試しください。');
    } finally {
      activeSearches -= 1;
    }
  }

  root.LunchPlaces = Object.freeze({ search, isConfigured, getQuota, getQuotaStatus, refreshQuota });
})(typeof window !== 'undefined' ? window : globalThis);

