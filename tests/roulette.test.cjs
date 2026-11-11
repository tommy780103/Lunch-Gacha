'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  class Element {
    constructor() {
      this.style = {};
      this.dataset = {};
      this.hidden = false;
      this.disabled = false;
      this.textContent = '';
      this.value = '';
      this.children = [];
      this.classList = { toggle() {} };
    }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    appendChild(child) { this.children.push(child); }
  }
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const tabs = ['lunch', 'search', 'custom'].map(tab => Object.assign(new Element(), { dataset: { tab } }));
  elements.appTitle.textContent = html.match(/<h1 id="appTitle">([^<]+)<\/h1>/)[1];
  elements.customInput.value = html.match(/<textarea id="customInput">([\s\S]*?)<\/textarea>/)[1];
  elements.resultSearchBtn.hidden = true;
  elements.mapBtn.style.display = 'none';
  let labels = [];
  const canvasContext = new Proxy({
    clearRect() { labels = []; },
    fillText(label) { labels.push(label); }
  }, { get(target, property) { return target[property] || (() => {}); } });
  elements.wheelCanvas.getContext = () => canvasContext;
  elements.wheelCanvas.parentElement = { clientWidth: 340 };
  let time = 0;
  let locationCallback;
  const frames = [];
  const mapQueries = [];
  const genres = [];
  const document = {
    title: html.match(/<title>([^<]+)<\/title>/)[1],
    getElementById: id => elements[id],
    querySelectorAll: selector => selector === '.tab' ? tabs : [...tabs, elements.customInput],
    createElement: () => new Element(),
    createTextNode: text => Object.assign(new Element(), { textContent: text })
  };
  const context = vm.createContext({
    document,
    window: { devicePixelRatio: 1, addEventListener() {} },
    navigator: { geolocation: { getCurrentPosition(callback) { locationCallback = callback; } } },
    performance: { now: () => time },
    requestAnimationFrame: callback => frames.push(callback),
    LunchSearchCore: { buildSearchUrl(genre) { mapQueries.push(genre); return `https://maps.example/?query=${encodeURIComponent(genre)}`; } },
    LunchSearchUI: { init() {}, chooseGenre(genre) { genres.push(genre); } }
  });
  vm.runInContext(script, context);
  return {
    elements, document, mapQueries, genres, frames,
    run: source => vm.runInContext(source, context),
    get labels() { return labels; },
    finishSpin() {
      vm.runInContext('stopSpin()', context);
      time += 16;
      frames.shift()(time);
      time += 5000;
      frames.shift()(time);
    },
    resolveLocation() { locationCallback({ coords: { latitude: 34.3, longitude: 133.8 } }); }
  };
}

test('roulette tab removes meal branding and quota, then restores search and lunch views', () => {
  const app = harness();
  const originalTitle = app.document.title;
  app.run("switchTab('custom')");
  assert.equal(app.elements.appTitle.textContent, 'ルーレット');
  assert.equal(app.document.title, 'ルーレット');
  assert.equal(app.elements.appSubtitle.hidden, true);
  assert.equal(app.elements.searchQuota.hidden, true);
  assert.equal(app.elements.locationStatus.hidden, true);
  assert.equal(app.elements.searchPanel.hidden, true);
  assert.equal(app.elements.lunchSelectArea.style.display, 'none');
  assert.deepEqual(app.labels, ['項目1', '項目2', '項目3']);
  for (const tab of ['search', 'lunch']) {
    app.run(`switchTab('${tab}')`);
    assert.equal(app.elements.appTitle.textContent, 'きょうめし');
    assert.equal(app.document.title, originalTitle);
    assert.equal(app.elements.appSubtitle.hidden, false);
    assert.equal(app.elements.searchQuota.hidden, false);
    assert.equal(app.elements.locationStatus.hidden, false);
    assert.equal(app.elements.searchPanel.hidden, tab !== 'search');
  }
});

test('roulette spin returns only an item name while lunch retains its search actions', () => {
  const app = harness();
  app.elements.customInput.value = '掃除\n洗濯';
  app.run("switchTab('custom'); spin()");
  app.finishSpin();
  assert.ok(['掃除', '洗濯'].includes(app.elements.result.textContent));
  assert.equal(app.elements.mapBtn.style.display, 'none');
  assert.equal(app.elements.mapBtn.href, undefined);
  assert.equal(app.elements.resultSearchBtn.hidden, true);
  assert.equal(app.elements.resultSearchBtn.onclick, null);
  assert.equal(app.elements.locationStatus.hidden, true);
  assert.deepEqual(app.mapQueries, []);

  app.run("switchTab('lunch'); spin()");
  app.finishSpin();
  const chosen = app.elements.result.textContent;
  assert.ok(app.labels.includes(chosen));
  assert.deepEqual(app.mapQueries, [chosen]);
  assert.equal(app.elements.mapBtn.style.display, 'inline-block');
  assert.equal(app.elements.resultSearchBtn.hidden, false);
  app.elements.resultSearchBtn.onclick();
  assert.deepEqual(app.genres, [chosen]);
  assert.equal(app.elements.searchPanel.hidden, false);
  assert.equal(app.elements.appTitle.textContent, 'きょうめし');
  assert.equal(app.elements.searchQuota.hidden, false);
});

test('invalid candidates clear the wheel and results instead of reusing another tab candidates', () => {
  const app = harness();
  app.elements.customInput.value = 'ひとつだけ';
  app.run("switchTab('custom'); spin()");
  assert.equal(app.elements.spinBtn.disabled, true);
  assert.deepEqual(app.labels, []);
  assert.equal(app.frames.length, 0);
  assert.equal(app.elements.result.textContent, '');

  app.elements.customInput.value = 'A\nB';
  app.run('applyCustom(); spin()');
  app.finishSpin();
  assert.ok(app.elements.result.textContent);
  app.elements.customInput.value = '';
  app.run('applyCustom(); spin()');
  assert.equal(app.elements.spinBtn.disabled, true);
  assert.deepEqual(app.labels, []);
  assert.equal(app.elements.result.textContent, '');
  assert.equal(app.frames.length, 0);

  app.run("switchTab('lunch'); toggleAll(false)");
  app.elements.customInput.value = 'A\nB';
  app.run("switchTab('custom')");
  assert.deepEqual(app.labels, ['A', 'B']);
  app.run("switchTab('lunch'); spin()");
  assert.deepEqual(app.labels, []);
  assert.equal(app.elements.spinBtn.disabled, true);
  assert.equal(app.frames.length, 0);
  app.run('toggleAll(true)');
  assert.equal(app.elements.spinBtn.disabled, false);
  assert.ok(app.labels.includes('うどん'));
  assert.equal(app.labels.includes('A'), false);
});

test('a location response arriving after tab change remains hidden in roulette', async () => {
  const app = harness();
  const pending = app.run('getLocation()');
  app.run("switchTab('custom')");
  app.resolveLocation();
  await pending;
  assert.equal(app.elements.locationStatus.textContent, '現在地を取得しました');
  assert.equal(app.elements.locationStatus.hidden, true);
  assert.equal(app.elements.searchQuota.hidden, true);
  assert.equal(app.elements.mapBtn.style.display, 'none');
});
