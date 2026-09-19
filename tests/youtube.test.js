const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'youtube.js'), 'utf8');
const captionText = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hello world.' }] }] });
const track = { languageCode: 'en', name: 'English', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=A&lang=en' };
const settle = () => new Promise(setImmediate);

function element(tag = 'div') {
  const classes = new Set();
  const node = {
    tagName: tag, children: [], style: {}, textContent: '', parentElement: null,
    isConnected: false, listeners: new Map(),
    classList: {
      add: value => classes.add(value), remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); }
    },
    setAttribute() {},
    addEventListener(type, callback) { this.listeners.set(type, callback); },
    removeEventListener(type) { this.listeners.delete(type); },
    appendChild(child) { child.parentElement = this; child.isConnected = true; this.children.push(child); return child; },
    append(...children) { children.forEach(child => this.appendChild(child)); },
    remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); },
    querySelector(selector) {
      for (const child of this.children) {
        if (child.className?.split(' ').includes(selector.slice(1))) return child;
        const match = child.querySelector(selector);
        if (match) return match;
      }
      return null;
    },
    getBoundingClientRect: () => ({ top: 600, right: 900, bottom: 640 }),
    // Only the subtitle layer's two flat divs need innerHTML in this fixture.
    set innerHTML(html) {
      this.children = [];
      for (const match of html.matchAll(/<div class="([^"]+)"/g)) {
        const child = element();
        child.className = match[1];
        this.appendChild(child);
      }
    }
  };
  return node;
}

function harness() {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const listeners = new Map();
  const messages = [];
  const runtimeMessages = [];
  const location = { href: 'https://www.youtube.com/watch?v=A' };
  const player = element();
  const video = element('video');
  video.currentTime = 0;
  const document = {
    body: element('body'), documentElement: element('html'), segments: [],
    createElement: element, addEventListener() {}, removeEventListener() {},
    querySelector: selector => selector === '#movie_player' ? player : selector === '#movie_player video' || selector === 'video' ? video : null,
    querySelectorAll: () => document.segments.map(textContent => ({ textContent }))
  };
  const window = {
    innerWidth: 1280, innerHeight: 720,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    removeEventListener(type, callback) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== callback)); },
    postMessage: message => messages.push(JSON.parse(JSON.stringify(message)))
  };
  function emit(type, detail) { for (const listener of listeners.get(type) || []) listener(detail); }
  function send(message) { emit('message', { source: window, data: { source: 'bilingual-yt-bridge', ...message } }); }
  function schedule(callback, ms, repeat = false) { timers.set(++timerId, { callback, at: now + ms, ms, repeat }); return timerId; }
  function tick(ms) {
    const end = now + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.at;
      if (timer.repeat) timer.at += timer.ms;
      else timers.delete(id);
      timer.callback();
    }
    now = end;
  }
  const context = {
    window, document, location, URL, console: { log() {}, warn() {}, error() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (callback, ms) => schedule(callback, ms), clearTimeout: id => timers.delete(id),
    setInterval: (callback, ms) => schedule(callback, ms, true), clearInterval: id => timers.delete(id),
    chrome: {
      i18n: { getMessage: key => key },
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
      runtime: {
        sendMessage(message, callback) {
          runtimeMessages.push(JSON.parse(JSON.stringify(message)));
          if (message.action === 'getProviders') return Promise.resolve({ providers: { claude: { model: 'fixture-model' } } });
          if (message.action === 'translate') callback({ translations: message.texts.map(text => `Translated: ${text}`) });
        }
      }
    }
  };
  vm.runInNewContext(`${code}\nglobalThis.api = { state, activate, deactivate, togglePanel };`, context);
  const { api } = context;
  api.state.buttonEl = element('button');
  api.state.buttonEl.isConnected = true;
  return { ...api, document, video, location, emit, send, tick, messages, runtimeMessages };
}

test('native CC without a discovered track starts DOM translation after captions settle', async () => {
  const h = harness();
  h.document.segments = ['Hello', 'world.'];
  h.send({ type: 'tracks', videoId: 'A', tracks: [], status: 'unavailable', nativeAvailable: true });
  assert.equal(h.state.pickedTrack, null);
  h.activate();
  assert.equal(h.state.active, true);
  assert.equal(h.state.mode, 'dom');
  assert.ok(h.state.captionObserver);
  assert.equal(h.messages.at(-1).type, 'enableCaptions');
  assert.equal(h.messages.at(-1).videoId, 'A');
  assert.equal(h.runtimeMessages.length, 0);
  h.tick(2100);
  await settle();
  assert.deepEqual(h.runtimeMessages, [{ action: 'translate', texts: ['Hello world.'], provider: 'claude', targetLang: 'zh' }]);
  assert.equal(h.state.subtitleEl.querySelector('.bilingual-yt-target').textContent, 'Translated: Hello world.');
});

test('captured native captions stay cached until the user activates translation', async () => {
  const h = harness();
  h.send({ type: 'capturedCaptions', videoId: 'A', url: track.baseUrl, text: captionText });
  h.tick(13000);
  await settle();
  assert.equal(h.state.cache.get('A').mode, 'cues');
  assert.equal(h.state.cache.get('A').cues[0].text, 'Hello world.');
  assert.equal(h.state.active, false);
  assert.equal(h.state.mode, null);
  assert.equal(h.state.subtitleEl, null);
  assert.equal(h.runtimeMessages.length, 0);
  assert.equal(h.messages.some(message => message.type === 'enableCaptions'), false);
  h.activate();
  await settle();
  assert.equal(h.state.mode, 'cues');
  assert.equal(h.runtimeMessages.filter(message => message.action === 'translate').length, 1);
  assert.equal(h.messages.some(message => message.type === 'fetchCaptions'), false);
});

test('navigation ignores old-video tracks and captured captions, including mismatched URL IDs', () => {
  const h = harness();
  h.emit('yt-navigate-start');
  h.send({ type: 'tracks', videoId: 'A', tracks: [track], status: 'ready' });
  h.send({ type: 'capturedCaptions', videoId: 'A', url: track.baseUrl, text: captionText });
  assert.equal(h.state.videoId, null);
  assert.equal(h.state.cache.size, 0);
  h.location.href = 'https://www.youtube.com/watch?v=B';
  h.emit('yt-navigate-finish');
  h.send({ type: 'tracks', videoId: 'A', tracks: [track], status: 'ready' });
  h.send({ type: 'capturedCaptions', videoId: 'A', url: track.baseUrl, text: captionText });
  h.send({ type: 'capturedCaptions', videoId: 'B', url: track.baseUrl, text: captionText });
  assert.equal(h.state.videoId, 'B');
  assert.equal(h.state.tracks.length, 0);
  assert.equal(h.state.pickedTrack, null);
  assert.equal(h.state.cache.size, 0);
});

for (const interruption of ['deactivation', 'navigation']) {
  test(`a pending caption cache response cannot reactivate after ${interruption}`, async () => {
    const h = harness();
    h.send({ type: 'tracks', videoId: 'A', tracks: [track], status: 'ready' });
    h.activate();
    const request = h.messages.find(message => message.type === 'fetchCaptions');
    assert.ok(request);
    if (interruption === 'deactivation') h.deactivate();
    else {
      h.emit('yt-navigate-start');
      h.location.href = 'https://www.youtube.com/watch?v=B';
      h.emit('yt-navigate-finish');
    }
    h.send({ type: 'captionsResult', requestId: request.requestId, ok: true, text: captionText });
    await settle();
    assert.equal(h.state.mode, null);
    assert.equal(h.state.cache.size, 0);
    assert.equal(h.document.documentElement.classList.contains('bilingual-yt-active'), false);
    assert.equal(h.runtimeMessages.length, 0);
    assert.equal(h.messages.some(message => message.type === 'enableCaptions'), false);
    if (interruption === 'deactivation') {
      assert.equal(h.state.active, false);
      assert.equal(h.state.subtitleEl, null);
    } else assert.equal(h.state.videoId, 'B');
  });
}

test('an already-open panel updates from loading to retry, native CC, and a discovered track', async () => {
  const h = harness();
  await h.togglePanel();
  const panel = h.state.panelEl;
  const source = panel.querySelector('.bilingual-yt-caption-source');
  const action = panel.querySelector('.bilingual-yt-panel-btn');
  const hint = panel.querySelector('.bilingual-yt-caption-hint');
  assert.equal(source.textContent, 'ytDetectingCaptions');
  assert.equal(action.disabled, true);
  assert.equal(hint.hidden, true);
  h.send({ type: 'tracks', videoId: 'A', tracks: [], status: 'unavailable' });
  assert.equal(source.textContent, 'ytNoCaption');
  assert.equal(action.textContent, 'ytRetryCaptions');
  assert.equal(action.disabled, false);
  assert.equal(hint.hidden, false);
  h.send({ type: 'tracks', videoId: 'A', tracks: [], status: 'unavailable', nativeAvailable: true });
  assert.equal(source.textContent, 'ytNativeCaption');
  assert.equal(action.textContent, 'ytStart');
  assert.equal(action.disabled, false);
  assert.equal(hint.hidden, true);
  h.send({ type: 'tracks', videoId: 'A', tracks: [track], status: 'ready' });
  assert.equal(h.state.panelEl, panel);
  assert.equal(source.textContent, 'EnglishytAutoGenerated');
  assert.equal(action.textContent, 'ytStart');
  assert.equal(action.disabled, false);
});
