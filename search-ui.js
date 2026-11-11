(function () {
  'use strict';

  let options;
  let busy = false;
  let generation = 0;
  let origin = null;
  const byId = id => document.getElementById(id);

  function setStatus(message, state = 'ready') {
    byId('searchStatus').textContent = message;
    byId('searchStatus').dataset.state = state;
  }

  function updateFallback() {
    const genre = byId('genreInput').value.trim();
    byId('normalSearchLink').href = LunchSearchCore.buildSearchUrl(genre || '飲食店', origin);
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
    const chosen = byId('genreInput').value.trim();
    byId('genreGrid').querySelectorAll('button').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.genre === chosen));
    });
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
    element.hidden = !LunchPlaces.isConfigured();
    if (element.hidden) return;
    const quota = LunchPlaces.getQuota();
    element.textContent = quota
      ? `検索受付：本日 ${quota.dayUsed} / ${quota.dayLimit}回・今月 ${quota.monthUsed} / ${quota.monthLimit}回（全利用者合計）`
      : '条件つき検索は全利用者で1日20回・月600回まで。上限に達すると自動で停止します。';
    element.textContent += ' 失敗した通信も回数に含み、日・月の切り替えは米国太平洋時間です。';
  }

  function chooseGenre(genre) {
    byId('genreInput').value = String(genre).trim().slice(0, 80);
    syncGenres();
    clearResults();
    readyMessage();
  }

  function setBusy(value) {
    busy = value;
    byId('restaurantSearchForm').querySelectorAll('input, select, button').forEach(control => {
      control.disabled = value;
    });
    byId('searchBtn').textContent = value ? 'お店を探しています…' : 'この条件でお店を検索';
    byId('searchPanel').setAttribute('aria-busy', String(value));
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

  function renderResults(places, genre, criteria) {
    const list = byId('restaurantList');
    list.replaceChildren();
    for (const [index, place] of places.entries()) {
      const card = createTextElement('li', 'restaurant-card', '');
      card.append(createTextElement('h4', '', `${index + 1}. ${place.name}`));
      const stats = createTextElement('div', 'restaurant-stats', '');
      stats.append(createTextElement('span', 'restaurant-rating', `★${place.rating.toFixed(1)}`));
      stats.append(createTextElement('span', '', `口コミ ${place.reviewCount.toLocaleString('ja-JP')}件`));
      stats.append(createTextElement('span', '', `${place.distanceKm.toFixed(1)}km`));
      card.append(stats);
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
    byId('resultsTitle').textContent = `${genre}のお店 ${places.length}件`;
    const sortLabel = { rating: '評価が高い順', reviews: '口コミが多い順', distance: '近い順' }[criteria.sort];
    byId('resultCriteria').textContent = `★${criteria.minRating.toFixed(1)}以上・口コミ${criteria.minReviews}件以上・${criteria.radiusKm}km以内 ／ ${sortLabel}`;
    byId('searchResults').hidden = false;
    const shortlist = LunchSearchCore.buildShortlistUrl(places.map(place => place.id));
    if (shortlist && places.length) {
      byId('shortlistLink').href = shortlist;
      byId('shortlistLink').hidden = false;
    }
    if (!places.length) {
      setStatus('取得した候補に、条件に合うお店がありませんでした。距離を広げるか、評価・口コミ件数の条件を変更して検索してください。', 'empty');
    } else {
      setStatus(`${places.length}件見つかりました。気になるお店をGoogleマップで確認できます。`, 'success');
    }
  }

  async function search(event) {
    event.preventDefault();
    if (busy) return;
    const genre = byId('genreInput').value.trim();
    if (!genre) {
      setStatus('ジャンルを選ぶか、店名を入力してください。', 'error');
      byId('genreInput').focus();
      return;
    }
    clearResults();
    if (!LunchPlaces.isConfigured()) {
      readyMessage();
      return;
    }
    const criteria = LunchSearchCore.normalizeCriteria({
      minRating: Number(byId('minRating').value),
      minReviews: Number(byId('minReviews').value),
      radiusKm: Number(byId('radiusKm').value),
      sort: byId('sortOrder').value
    });
    const requestGeneration = generation;
    setBusy(true);
    setStatus('現在地を確認しています…', 'loading');
    try {
      origin = await options.getLocation();
      if (generation !== requestGeneration) return;
      updateFallback();
      setStatus('評価・口コミ件数を確認して、お店を探しています…', 'loading');
      const places = await LunchPlaces.search(genre, origin, criteria);
      if (generation !== requestGeneration) return;
      renderResults(places, genre, criteria);
    } catch (error) {
      if (generation !== requestGeneration) return;
      const messages = {
        NOT_CONFIGURED: '条件つき検索は準備中です。通常のGoogleマップ検索をご利用ください。',
        QUOTA_EXCEEDED: '条件つき検索の利用上限に達しました。通常のGoogleマップ検索をご利用ください。',
        LOCATION_DENIED: '現在地の利用が許可されていません。ブラウザーの位置情報設定を確認するか、通常のGoogleマップ検索をご利用ください。',
        LOCATION_UNAVAILABLE: '現在地を取得できませんでした。時間をおいて試すか、通常のGoogleマップ検索をご利用ください。',
        NETWORK: '通信できませんでした。接続を確認して、もう一度お試しください。'
      };
      setStatus(messages[error.code] || '条件つき検索を利用できませんでした。通常のGoogleマップ検索をご利用ください。', 'error');
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
      button.addEventListener('click', () => chooseGenre(genre));
      grid.append(button);
    }
    byId('genreInput').addEventListener('input', () => {
      syncGenres();
      clearResults();
      readyMessage();
    });
    ['minRating', 'minReviews', 'radiusKm', 'sortOrder'].forEach(id => {
      byId(id).addEventListener('change', () => { clearResults(); readyMessage(); });
    });
    byId('restaurantSearchForm').addEventListener('submit', search);
    chooseGenre(settings.genres[0]);
  }

  window.LunchSearchUI = Object.freeze({ init, chooseGenre });
})();
