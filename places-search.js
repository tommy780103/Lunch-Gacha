(function (root) {
  'use strict';

  const core = root.LunchSearchCore;
  const SEARCH_TIMEOUT_MS = 25000;
  const DAY_LIMIT = 20;
  const MONTH_LIMIT = 600;
  let lastQuota = null;

  function fail(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function endpoint() {
    const config = root.LUNCH_GACHA_CONFIG || {};
    if (config.placesEnabled !== true || typeof config.searchEndpoint !== 'string' || !config.searchEndpoint.trim()) return null;
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

  function responseError(status, payload) {
    const code = payload && payload.error && payload.error.code;
    if (status === 429 || code === 'QUOTA_EXCEEDED') return fail('QUOTA_EXCEEDED', '条件検索の利用上限に達しました。通常の Google マップ検索をご利用ください。');
    if (code === 'NOT_CONFIGURED') return fail('NOT_CONFIGURED', '条件検索は準備中です。通常の Google マップ検索をご利用ください。');
    if (code === 'NETWORK') return fail('NETWORK', '通信できませんでした。接続を確認してから、もう一度お試しください。');
    return fail('REQUEST_FAILED', '条件検索を利用できません。通常の Google マップ検索をご利用ください。');
  }

  async function search(genre, origin, criteria) {
    lastQuota = null;
    const url = endpoint();
    if (!url) throw fail('NOT_CONFIGURED', '条件検索は準備中です。通常の Google マップ検索をご利用ください。');
    const center = core.coordinates(origin);
    const term = core.genreQuery(genre);
    if (!center || !term) throw fail('REQUEST_FAILED', 'ジャンルと現在地を確認してください。');
    if (typeof root.fetch !== 'function' || typeof root.AbortController !== 'function') throw fail('REQUEST_FAILED', 'このブラウザーでは条件検索を利用できません。');
    const filters = core.normalizeCriteria(criteria);
    const controller = new root.AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = root.setTimeout(() => {
          reject(fail('NETWORK', '通信に時間がかかっています。もう一度お試しください。'));
          controller.abort();
        }, SEARCH_TIMEOUT_MS);
      });
      // Exactly one request to the quota-enforcing server. There is no SDK,
      // client API key, pagination, redirect, or automatic retry path.
      const request = (async () => {
        const response = await root.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
          body: JSON.stringify({ genre: term, origin: center, criteria: filters })
        });
        let payload;
        try { payload = await response.json(); }
        catch (_) { throw responseError(response.status); }
        return { response, payload };
      })();
      const { response, payload } = await Promise.race([request, timeout]);
      lastQuota = validQuota(payload && payload.quota);
      if (!response.ok) throw responseError(response.status, payload);
      if (!lastQuota || !payload || !Array.isArray(payload.places) || payload.places.length > 20 || payload.error) {
        lastQuota = null;
        throw fail('REQUEST_FAILED', '店舗情報と利用回数を確認できませんでした。もう一度お試しください。');
      }
      return core.filterPlaces(payload.places, center, filters);
    } catch (error) {
      if (['NOT_CONFIGURED', 'QUOTA_EXCEEDED', 'NETWORK', 'REQUEST_FAILED'].includes(error && error.code)) throw error;
      lastQuota = null;
      throw fail('NETWORK', '通信できませんでした。接続を確認してから、もう一度お試しください。');
    } finally {
      root.clearTimeout(timer);
    }
  }

  root.LunchPlaces = Object.freeze({ search, isConfigured, getQuota });
})(typeof window !== 'undefined' ? window : globalThis);
