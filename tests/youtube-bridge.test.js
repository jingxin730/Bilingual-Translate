const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'youtube-bridge.js'), 'utf8');
const captionText = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hello world.' }] }] });
const track = (lang = 'en') => ({ languageCode: lang, name: { simpleText: lang }, baseUrl: `https://www.youtube.com/api/timedtext?v=A&lang=${lang}` });
const response = (id, tracks = []) => ({ videoDetails: { videoId: id }, captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } });

function harness(options = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const listeners = new Map();
  const messages = [];
  const location = { href: 'https://www.youtube.com/watch?v=A' };
  const data = {
    playerId: options.playerId ?? 'A',
    response: options.response,
    options: options.tracks || [],
    cc: options.cc || null,
    fetchCalls: 0,
    selected: [],
    loaded: 0
  };
  const player = {
    getVideoData: () => ({ video_id: data.playerId }),
    getPlayerResponse: () => data.response,
    getOption: () => data.options,
    loadModule: () => data.loaded++,
    setOption: (module, option, value) => data.selected.push(value),
    querySelector: selector => selector === '.ytp-subtitles-button' ? data.cc : null
  };
  class XHR {
    open() {}
    send() {}
    addEventListener(type, listener) { this.listener = listener; }
  }
  const window = {
    ytInitialPlayerResponse: options.initial,
    addEventListener: (type, callback) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    postMessage: message => messages.push(JSON.parse(JSON.stringify(message))),
    fetch: (...args) => {
      data.fetchCalls++;
      return options.fetch ? options.fetch(...args) : Promise.resolve({ ok: true, clone: () => ({ text: () => Promise.resolve(captionText) }) });
    }
  };
  function emit(type, detail) {
    for (const listener of listeners.get(type) || []) listener(detail);
  }
  function send(message) {
    emit('message', { source: window, data: { source: 'bilingual-yt-iso', ...message } });
  }
  function tick(ms) {
    const end = now + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = end;
  }
  vm.runInNewContext(code, {
    window, location, URL, XMLHttpRequest: XHR,
    document: { getElementById: () => player },
    setTimeout: (callback, ms) => {
      timers.set(++timerId, { callback, at: now + ms });
      return timerId;
    },
    clearTimeout: id => timers.delete(id)
  });
  return { data, window, location, emit, send, tick, messages, XHR };
}

test('discovers delayed player captions despite an existing empty initial response', () => {
  const h = harness({ initial: response('A') });
  assert.equal(h.messages.at(-1).status, 'loading');
  h.tick(600);
  h.data.response = response('A', [track()]);
  h.tick(300);
  assert.equal(h.messages.at(-1).status, 'ready');
  assert.equal(h.messages.at(-1).tracks[0].languageCode, 'en');
});

test('rejects stale initial and player tracks during SPA navigation', () => {
  const h = harness({ initial: response('A', [track()]), response: response('A', [track()]) });
  h.emit('yt-navigate-start');
  h.location.href = 'https://www.youtube.com/watch?v=B';
  h.emit('yt-navigate-finish');
  assert.equal(h.messages.at(-1).videoId, 'B');
  assert.deepEqual(h.messages.at(-1).tracks, []);
  h.data.playerId = 'B';
  h.data.response = response('B', [track('fr')]);
  h.tick(300);
  assert.equal(h.messages.at(-1).tracks[0].languageCode, 'fr');
});

test('uses current caption module tracks without baseUrl and answers every request', () => {
  const h = harness({ tracks: [{ languageCode: 'en', languageName: 'English', kind: 'asr' }] });
  assert.equal(h.messages.at(-1).status, 'ready');
  assert.equal(h.messages.at(-1).tracks[0].baseUrl, '');
  assert.equal(h.messages.at(-1).tracks[0].name, 'English');
  const count = h.messages.length;
  h.send({ type: 'requestTracks', videoId: 'A' });
  h.send({ type: 'requestTracks', videoId: 'A' });
  assert.equal(h.messages.length, count + 2);
});

test('reports native captions when metadata is absent and finishes empty discovery', () => {
  const h = harness({ cc: { getAttribute: () => null, style: {} } });
  assert.equal(h.messages.at(-1).nativeAvailable, true);
  h.tick(10000);
  assert.equal(h.messages.at(-1).status, 'unavailable');
  assert.equal(h.messages.at(-1).nativeAvailable, true);
  assert.equal(h.messages.length, 2);
});

test('uses the current response ID for native CC but refuses a stale caption module', () => {
  const h = harness({ playerId: '', response: response('A'), cc: { getAttribute: () => null, style: {} } });
  assert.equal(h.messages.at(-1).nativeAvailable, true);
  h.data.playerId = 'B';
  h.data.response = response('B');
  h.data.options = [track()];
  h.send({ type: 'requestTracks', videoId: 'A' });
  assert.equal(h.messages.at(-1).nativeAvailable, false);
  assert.deepEqual(h.messages.at(-1).tracks, []);
});

test('cache misses respond immediately without fetching a supplied URL', () => {
  const h = harness();
  h.send({ type: 'fetchCaptions', videoId: 'A', requestId: 1, baseUrl: track().baseUrl });
  assert.equal(h.messages.at(-1).type, 'captionsResult');
  assert.equal(h.messages.at(-1).error, 'not-captured');
  h.send({ type: 'fetchCaptions', videoId: 'A', requestId: 2, baseUrl: 'https://example.com/api/timedtext' });
  assert.equal(h.messages.at(-1).error, 'invalid-caption-url');
  assert.equal(h.data.fetchCalls, 0);
});

test('captures native fetch responses and serves the matching video and track from cache', async () => {
  const h = harness();
  await h.window.fetch(new URL(`${track().baseUrl}&fmt=json3`));
  await new Promise(setImmediate);
  const captured = h.messages.find(item => item.type === 'capturedCaptions');
  assert.equal(captured.videoId, 'A');
  h.send({ type: 'fetchCaptions', videoId: 'A', requestId: 3, baseUrl: track().baseUrl });
  assert.equal(h.messages.at(-1).ok, true);
  assert.equal(h.messages.at(-1).text, captionText);
  h.send({ type: 'fetchCaptions', videoId: 'A', requestId: 4, baseUrl: `${track().baseUrl}&kind=asr` });
  assert.equal(h.messages.at(-1).ok, false);
  h.send({ type: 'fetchCaptions', videoId: 'B', requestId: 5, baseUrl: track().baseUrl });
  assert.equal(h.messages.at(-1).error, 'stale-video');
  assert.equal(h.data.fetchCalls, 1);
});

test('ignores delayed old-video responses and timedtext-shaped external URLs', async () => {
  let resolveResponse;
  const h = harness({ fetch: () => new Promise(resolve => { resolveResponse = resolve; }) });
  const pending = h.window.fetch(track().baseUrl);
  h.emit('yt-navigate-start');
  h.location.href = 'https://www.youtube.com/watch?v=B';
  h.emit('yt-navigate-finish');
  resolveResponse({ ok: true, clone: () => ({ text: () => Promise.resolve(captionText) }) });
  await pending;
  await new Promise(setImmediate);
  assert.equal(h.messages.some(item => item.type === 'capturedCaptions'), false);
  const external = harness();
  await external.window.fetch('https://example.com/api/timedtext?v=A');
  await new Promise(setImmediate);
  assert.equal(external.messages.some(item => item.type === 'capturedCaptions'), false);
});

test('captures successful native XHR and cancels caption toggles on navigation', () => {
  let clicks = 0;
  const h = harness({ cc: { getAttribute: () => null, click: () => clicks++, style: {} } });
  const xhr = new h.XHR();
  xhr.open('GET', track().baseUrl);
  xhr.send();
  xhr.status = 200;
  xhr.responseText = captionText;
  xhr.listener();
  assert.equal(h.messages.at(-1).type, 'capturedCaptions');
  h.send({ type: 'enableCaptions', videoId: 'A', languageCode: 'en' });
  h.emit('yt-navigate-start');
  h.location.href = 'https://www.youtube.com/watch?v=B';
  h.data.playerId = 'B';
  h.data.options = [track()];
  h.tick(3000);
  assert.equal(clicks, 0);
  assert.equal(h.data.selected.length, 0);
});

test('retries a delayed caption module and selects the requested native language', () => {
  const h = harness();
  h.send({ type: 'enableCaptions', videoId: 'A', languageCode: 'fr' });
  h.tick(600);
  h.data.options = [track(), track('fr')];
  h.tick(200);
  assert.equal(h.data.loaded, 1);
  assert.equal(h.data.selected.length, 1);
  assert.equal(h.data.selected[0].languageCode, 'fr');
  assert.equal(h.messages.at(-1).status, 'ready');
});
