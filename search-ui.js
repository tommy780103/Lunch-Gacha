(function () {
  'use strict';

  let options;
  let busy = false;
  let generation = 0;
  let origin = null;
  const selectedGenres = new Set();
  const byId = id => document.getElementById(id);
  const numericFilters = [
    { id: 'minRating', min: 0, max: 5, message: '評価は0〜5の数値で入力してください。' },
    { id: 'minReviews', min: 0, max: 1000000, integer: true, message: '口コミ件数は0〜1,000,000の整数で入力してください。' },
    { id: 'radiusKm', min: 0.1, max: 50, message: '距離は0.1〜50kmの数値で入力してください。' }
  ];

  function syncCustomFilters() {
    for (const { id } of numericFilters) {
      const selected = byId(id).value === 'custom';
      const input = byId(`${id}Custom`);
      byId(`${id}CustomField`).hidden = !selected;
      input.disabled = busy || !selected;
      input.required = selected;
      if (!selected) {
        input.setCustomValidity('');
        input.removeAttribute('aria-invalid');
      }
    }
  }

  function readCriteria() {
    const values = { sort: byId('sortOrder').value };
    for (const { id, min, max, integer, message } of numericFilters) {
      const field = byId(id).value === 'custom' ? byId(`${id}Custom`) : byId(id);
      const raw = field.value.trim();
      const value = Number(raw);
      // Validate before normalization: a blank, invalid or out-of-range custom
      // value must never silently become a default, rounded value or bound.
      const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw);
      if (!numeric || field.validity?.badInput || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
        field.setCustomValidity(message);
        field.setAttribute('aria-invalid', 'true');
        setStatus(message, 'error');
        field.focus();
        field.reportValidity();
        return null;
      }
      field.setCustomValidity('');
      field.removeAttribute('aria-invalid');
      values[id] = value;
    }
    return LunchSearchCore.normalizeCriteria(values);
  }

  function setStatus(message, state = 'ready') {
    byId('searchStatus').textContent = message;
    byId('searchStatus').dataset.state = state;
  }

  function updateFallback() {
    const genres = getSelectedGenres();
    byId('normalSearchLink').href = LunchSearchCore.buildSearchUrl(genres, origin);
  }

  function getSelectedGenres() {
    return LunchSearchCore.normalizeGenres([...selectedGenres, byId('genreInput').value]);
  }

  function clearResults() {
    generation += 1;
    byId('searchResults').hidden = true;
    byId('restaurantList').replaceChildren();
    byId('shortlistLink').hidden = true;
    byId('shortlistLink').removeAttribute('href');
    updateFallback();
  }

  function syncGenres() {
    byId('genreGrid').querySelectorAll('button').forEach(button => {
      button.setAttribute('aria-pressed', String(selectedGenres.has(button.dataset.genre)));
    });
    const count = getSelectedGenres().length;
    byId('genreSelectionSummary').textContent = `${count}ジャンル選択中／検索は最大${count}回分使用（全利用者で1日20回・月600回まで）`;
  }

  function readyMessage() {
    updateQuota();
    if (!LunchPlaces.isConfigured()) {
      setStatus('条件つき検索は準備中です。通常のGoogleマップ検索は利用できます。', 'unavailable');
    } else {
      setStatus('ジャンルと条件を選び、「この条件でお店を検索」を押してください。');
    }
  }

  function updateQuota() {
    const element = byId('searchQuota');
    const quota = LunchPlaces.getQuota();
    const state = LunchPlaces.getQuotaStatus();
    element.dataset.state = state;
    const unknown = state === 'error' ? '取得できません' : '確認中…';
    byId('quotaMonthUsed').textContent = quota ? `${quota.monthUsed}回` : unknown;
    byId('quotaMonthRemaining').textContent = quota ? `${quota.monthLimit - quota.monthUsed}回` : unknown;
    byId('quotaDayRemaining').textContent = quota ? `${quota.dayLimit - quota.dayUsed}回` : unknown;
    let message = state === 'error' ? '利用回数を取得できませんでした。「更新」でもう一度確認できます。' : '利用回数を確認中です。';
    if (quota) {
      message = quota.monthUsed === quota.monthLimit ? '今月の検索上限に達しました。'
        : quota.dayUsed === quota.dayLimit ? '今日の検索上限に達しました。今月の残りがあっても、今日は検索できません。'
        : '全利用者で共通の回数です。検索のたびに表示を更新します。';
    }
    byId('quotaStatus').textContent = message;
    byId('quotaRefreshBtn').disabled = busy || state === 'loading';
  }

  async function refreshQuota() {
    if (busy) return;
    const request = LunchPlaces.refreshQuota();
    updateQuota();
    try { await request; }
    catch (_) { /* The adapter exposes an unknown count and error state. */ }
    finally { updateQuota(); }
  }

  function chooseGenre(genre) {
    const chosen = LunchSearchCore.normalizeGenres([genre])[0] || '';
    const preset = options.genres.find(item => LunchSearchCore.genreQuery(item) === LunchSearchCore.genreQuery(chosen));
    selectedGenres.clear();
    if (preset) selectedGenres.add(preset);
    byId('genreInput').value = preset ? '' : chosen;
    syncGenres();
    clearResults();
    readyMessage();
  }

  function setBusy(value) {
    busy = value;
    byId('restaurantSearchForm').querySelectorAll('input, select, button').forEach(control => {
      control.disabled = value;
    });
    syncCustomFilters();
    byId('searchBtn').textContent = value ? 'お店を探しています…' : 'この条件でお店を検索';
    byId('searchPanel').setAttribute('aria-busy', String(value));
    updateQuota();
  }

  function createTextElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  function safeExternalLink(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : null;
    } catch { return null; }
  }

  function renderResults(places, genres, criteria) {
    const list = byId('restaurantList');
    list.replaceChildren();
    for (const [index, place] of places.entries()) {
      const card = createTextElement('li', 'restaurant-card', '');
      card.append(createTextElement('h4', '', `${index + 1}. ${place.name}`));
      const stats = createTextElement('div', 'restaurant-stats', '');
      stats.append(createTextElement('span', 'restaurant-rating', place.rating === null ? '評価情報なし' : `★${place.rating.toFixed(1)}`));
      stats.append(createTextElement('span', '', place.reviewCount === null ? '口コミ情報なし' : `口コミ ${place.reviewCount.toLocaleString('ja-JP')}件`));
      stats.append(createTextElement('span', '', LunchSearchCore.formatDistance(place.distanceKm)));
      card.append(stats);
      const tags = createTextElement('div', 'restaurant-genres', '');
      tags.append(createTextElement('span', 'restaurant-genres-label', '検索ジャンル：'));
      for (const genre of place.genres) tags.append(createTextElement('span', 'restaurant-genre-tag', genre));
      card.append(tags);
      const href = safeExternalLink(place.mapsUrl);
      if (href) {
        const link = createTextElement('a', 'restaurant-link', 'Googleマップでお店を見る ↗');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        card.append(link);
      }
      if (place.attributions?.length) {
        const attribution = createTextElement('div', 'restaurant-attributions', 'データ提供：');
        for (const [i, source] of place.attributions.entries()) {
          if (i) attribution.append(document.createTextNode(' / '));
          const uri = safeExternalLink(source.providerURI);
          const element = createTextElement(uri ? 'a' : 'span', '', source.provider);
          if (uri) {
            element.href = uri;
            element.target = '_blank';
            element.rel = 'noopener noreferrer';
          }
          attribution.append(element);
        }
        card.append(attribution);
      }
      list.append(card);
    }
    byId('resultsTitle').textContent = `お店 ${places.length}件`;
    byId('resultGenres').textContent = `検索済み：${genres.join('、')}`;
    byId('resultCriteria').textContent = LunchSearchCore.describeCriteria(criteria);
    byId('searchResults').hidden = false;
    const shortlist = LunchSearchCore.buildShortlistUrl(places.map(place => place.id));
    if (shortlist && places.length) {
      byId('shortlistLink').href = shortlist;
      byId('shortlistLink').hidden = false;
    }
  }

  function errorMessage(error) {
    const messages = {
      NOT_CONFIGURED: '条件つき検索は準備中です。',
      QUOTA_EXCEEDED: '条件つき検索の利用上限に達したため、検索を停止しました。',
      QUOTA_UNAVAILABLE: '利用回数を確認できないため、検索を停止しました。利用回数の「更新」でもう一度確認できます。',
      LOCATION_DENIED: '現在地の利用が許可されていません。ブラウザーの位置情報設定を確認してください。',
      LOCATION_UNAVAILABLE: '現在地を取得できませんでした。時間をおいてお試しください。',
      NETWORK: '通信できなかったため、検索を停止しました。接続を確認してください。'
    };
    return messages[error.code] || 'お店情報を取得できなかったため、検索を停止しました。';
  }

  function showBatchOutcome(groups, genres, criteria, stopped) {
    const places = LunchSearchCore.mergeGenreResults(groups, criteria);
    if (groups.length) renderResults(places, groups.map(group => group.genre), criteria);
    if (stopped) {
      const progress = groups.length ? `${genres.length}ジャンル中${groups.length}ジャンルを検索し、${places.length}件を表示しています。` : '';
      const failed = stopped.failed ? ` 検索できなかったジャンル：${stopped.failed}。` : '';
      const remaining = stopped.unsearched.length ? ` 未検索：${stopped.unsearched.join('、')}。` : '';
      setStatus(`${progress}${errorMessage(stopped.error)}${failed}${remaining}`, groups.length ? 'partial' : 'error');
    } else if (!places.length) {
      setStatus(`${genres.length}ジャンルを検索しましたが、条件に合うお店がありませんでした。距離や評価・口コミ件数の条件を変更して検索してください。`, 'empty');
    } else {
      setStatus(`${genres.length}ジャンルを検索し、${places.length}件見つかりました。気になるお店をGoogleマップで確認できます。`, 'success');
    }
  }

  async function search(event) {
    event.preventDefault();
    if (busy) return;
    const genres = getSelectedGenres();
    if (!genres.length) {
      setStatus('ジャンルを1つ以上選ぶか、追加のジャンル・店名を入力してください。', 'error');
      byId('genreInput').focus();
      return;
    }
    const criteria = readCriteria();
    if (!criteria) return;
    clearResults();
    if (!LunchPlaces.isConfigured()) {
      readyMessage();
      return;
    }
    const requestGeneration = generation;
    const groups = [];
    setBusy(true);
    setStatus('現在地を確認しています…', 'loading');
    try {
      origin = await options.getLocation();
      if (generation !== requestGeneration) return;
      updateFallback();
      for (const [index, genre] of genres.entries()) {
        if (generation !== requestGeneration) return;
        const quota = LunchPlaces.getQuota();
        // The first POST checks the authoritative server state, including a
        // period rollover. Only this batch's fresh counts gate later searches.
        if (index > 0 && (!quota || quota.dayUsed >= quota.dayLimit || quota.monthUsed >= quota.monthLimit)) {
          showBatchOutcome(groups, genres, criteria, {
            error: { code: quota ? 'QUOTA_EXCEEDED' : 'QUOTA_UNAVAILABLE' }, unsearched: genres.slice(index)
          });
          return;
        }
        setStatus(`${index + 1}/${genres.length}ジャンル目：${genre}のお店を探しています…`, 'loading');
        try {
          if (generation !== requestGeneration) return;
          const request = LunchPlaces.search(genre, origin, criteria);
          updateQuota();
          const places = await request;
          if (generation !== requestGeneration) return;
          groups.push({ genre, places });
          renderResults(LunchSearchCore.mergeGenreResults(groups, criteria), groups.map(group => group.genre), criteria);
          updateQuota();
        } catch (error) {
          if (generation !== requestGeneration) return;
          showBatchOutcome(groups, genres, criteria, { error, failed: genre, unsearched: genres.slice(index + 1) });
          return;
        }
      }
      showBatchOutcome(groups, genres, criteria);
    } catch (error) {
      if (generation !== requestGeneration) return;
      showBatchOutcome(groups, genres, criteria, { error, unsearched: genres.slice(groups.length) });
    } finally {
      updateQuota();
      setBusy(false);
    }
  }

  function init(settings) {
    options = settings;
    const grid = byId('genreGrid');
    for (const genre of settings.genres) {
      const button = createTextElement('button', 'genre-choice', genre);
      button.type = 'button';
      button.dataset.genre = genre;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        if (busy) return;
        if (selectedGenres.has(genre)) selectedGenres.delete(genre);
        else selectedGenres.add(genre);
        syncGenres();
        clearResults();
        readyMessage();
      });
      grid.append(button);
    }
    byId('genreInput').addEventListener('input', () => {
      syncGenres();
      clearResults();
      readyMessage();
    });
    ['minRating', 'minReviews', 'radiusKm', 'sortOrder'].forEach(id => {
      byId(id).addEventListener('change', () => {
        byId(id).setCustomValidity('');
        byId(id).removeAttribute('aria-invalid');
        syncCustomFilters();
        clearResults();
        readyMessage();
      });
    });
    for (const { id } of numericFilters) {
      byId(`${id}Custom`).addEventListener('input', () => {
        byId(`${id}Custom`).setCustomValidity('');
        byId(`${id}Custom`).removeAttribute('aria-invalid');
        clearResults();
        readyMessage();
      });
    }
    byId('restaurantSearchForm').addEventListener('submit', search);
    byId('quotaRefreshBtn').addEventListener('click', refreshQuota);
    syncCustomFilters();
    chooseGenre(settings.genres[0]);
    refreshQuota();
  }

  window.LunchSearchUI = Object.freeze({ init, chooseGenre });
})();

