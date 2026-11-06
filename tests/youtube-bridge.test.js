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
    fetchRequests: [],
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
      data.fetchRequests.push(args);
      return options.fetch ? options.fetch(...args) : Promise.resolve({ ok: true, text: () => Promise.resolve(captionText), clone: () => ({ text: () => Promise.resolve(captionText) }) });
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
    window, location, URL, AbortController, XMLHttpRequest: XHR,
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

const settle = () => new Promise(setImmediate);
const resultFor = (h, requestId) => h.messages.find(message => message.type === 'captionsResult' && message.requestId === requestId);

test('cold download fetches the current player track without waiting for playback or a native CC request', async () => {
  const h = harness({ initial: response('A', [track()]) });
  h.send({ type: 'loadCaptions', videoId: 'A', requestId: 11, languageCode: 'en', baseUrl: track().baseUrl });
  await settle();
  assert.equal(resultFor(h, 11).ok, true);
  assert.equal(resultFor(h, 11).text, captionText);
  assert.equal(resultFor(h, 11).label, 'download');
  assert.equal(h.data.fetchCalls, 1);
  assert.equal(new URL(h.data.fetchRequests[0][0]).searchParams.get('fmt'), 'json3');
  assert.equal(h.data.fetchRequests[0][1].credentials, 'same-origin');
  assert.equal(h.data.loaded, 0);
  assert.equal(h.data.selected.length, 0);
});

test('download resolves fresh signed URLs from current metadata instead of fetching the URL in a page message', async () => {
  const fresh = { ...track(), baseUrl: `${track().baseUrl}&signature=fresh` };
  const h = harness({ initial: response('A', [fresh]) });
  h.send({ type: 'loadCaptions', videoId: 'A', requestId: 12, languageCode: 'en', baseUrl: `${track().baseUrl}&signature=old` });
  await settle();
  assert.equal(resultFor(h, 12).ok, true);
  assert.equal(new URL(h.data.fetchRequests[0][0]).searchParams.get('signature'), 'fresh');
});

test('download loads a missing caption module and waits for delayed track metadata by itself', async () => {
  const h = harness();
  h.send({ type: 'loadCaptions', videoId: 'A', requestId: 13, languageCode: 'en' });
  assert.equal(h.data.loaded, 1);
  assert.equal(h.data.fetchCalls, 0);
  h.data.response = response('A', [track()]);
  h.tick(250);
  await settle();
  assert.equal(resultFor(h, 13).ok, true);
  assert.equal(h.data.fetchCalls, 1);
});

test('concurrent download acquisitions share one request and future acquisitions reuse captured captions', async () => {
  let finish;
  const h = harness({ initial: response('A', [track()]), fetch: () => new Promise(resolve => { finish = resolve; }) });
  for (const requestId of [14, 15]) h.send({ type: 'loadCaptions', videoId: 'A', requestId, languageCode: 'en', baseUrl: track().baseUrl });
  assert.equal(h.data.fetchCalls, 1);
  finish({ ok: true, text: async () => captionText });
  await settle();
  assert.equal(resultFor(h, 14).ok, true);
  assert.equal(resultFor(h, 15).ok, true);
  h.send({ type: 'loadCaptions', videoId: 'A', requestId: 16, languageCode: 'en', baseUrl: track().baseUrl });
  await settle();
  assert.equal(resultFor(h, 16).label, 'captured');
  assert.equal(h.data.fetchCalls, 1);
});

test('native capture after an empty direct response completes download without enabling playback translation', async () => {
  const h = harness({ initial: response('A', [track()]), fetch: async () => ({ ok: true, text: async () => '' }) });
  h.send({ type: 'loadCaptions', videoId: 'A', requestId: 17, languageCode: 'en', baseUrl: track().baseUrl });
  await settle();
  assert.equal(h.data.loaded, 1);
  const xhr = new h.XHR();
  xhr.open('GET', track().baseUrl);
  xhr.send();
  xhr.status = 200;
  xhr.responseText = captionText;
  xhr.listener();
  h.tick(250);
  await settle();
  assert.equal(resultFor(h, 17).ok, true);
  assert.equal(resultFor(h, 17).label, 'captured');
  assert.equal(h.data.fetchCalls, 1);
});

test('download refuses external, stale and translated metadata tracks and rejects supplied external URLs', async () => {
  for (const baseUrl of ['https://example.com/api/timedtext?v=A&lang=en', `${track().baseUrl}&tlang=zh`, 'https://www.youtube.com/api/timedtext?v=B&lang=en']) {
    const h = harness({ initial: response('A', [{ ...track(), baseUrl }]) });
    h.send({ type: 'loadCaptions', videoId: 'A', requestId: 18, languageCode: 'en' });
    for (let i = 0; i < 40; i++) { h.tick(250); await settle(); }
    assert.equal(resultFor(h, 18).ok, false);
    assert.equal(h.data.fetchCalls, 0);
  }
  const h = harness({ initial: response('A', [track()]) });
  h.send({ type: 'loadCaptions', videoId: 'A', requestId: 19, baseUrl: 'https://example.com/api/timedtext?v=A&lang=en' });
  await settle();
  assert.equal(resultFor(h, 19).error, 'invalid-caption-url');
  assert.equal(h.data.fetchCalls, 0);
});

test('rate-limited caption requests stop once and report the HTTP error rather than requiring playback', async () => {
  const h = harness({ initial: response('A', [track()]), fetch: async () => ({ ok: false, status: 429 }) });
  h.send({ type: 'loadCaptions', videoId: 'A', requestId: 20, languageCode: 'en' });
  await settle();
  h.tick(10000);
  assert.equal(resultFor(h, 20).error, 'caption-http-429');
  assert.equal(h.data.fetchCalls, 1);
});

test('navigation aborts in-flight caption downloads and ignores late old-video results', async () => {
  let finish;
  let signal;
  const h = harness({ initial: response('A', [track()]), fetch: (url, options) => {
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  h.send({ type: 'loadCaptions', videoId: 'A', requestId: 21, languageCode: 'en' });
  h.emit('yt-navigate-start');
  h.location.href = 'https://www.youtube.com/watch?v=B';
  h.emit('yt-navigate-finish');
  assert.equal(signal.aborted, true);
  finish({ ok: true, text: async () => captionText });
  await settle();
  assert.equal(resultFor(h, 21).error, 'stale-video');
  assert.equal(h.messages.some(message => message.type === 'capturedCaptions'), false);
});

test('caption fetch timeout aborts the request and allows a later independent retry', async () => {
  let signal;
  const h = harness({ initial: response('A', [track()]), fetch: (url, options) => {
    signal = options.signal;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  } });
  h.send({ type: 'loadCaptions', videoId: 'A', requestId: 22, languageCode: 'en' });
  h.tick(8000);
  await settle();
  assert.equal(signal.aborted, true);
  assert.equal(resultFor(h, 22).error, 'caption-timeout');
  h.send({ type: 'loadCaptions', videoId: 'A', requestId: 23, languageCode: 'en' });
  assert.equal(h.data.fetchCalls, 2);
  h.tick(8000);
  await settle();
});

test('signed format parameters are preserved and same-language ASR/manual tracks are not mixed', async () => {
  const asr = { ...track(), kind: 'asr', baseUrl: `${track().baseUrl}&kind=asr&fmt=srv3&sparams=v,lang,kind,fmt` };
  const h = harness({ initial: response('A', [track(), asr]) });
  h.send({ type: 'loadCaptions', videoId: 'A', requestId: 24, baseUrl: asr.baseUrl, languageCode: 'en' });
  await settle();
  const url = new URL(h.data.fetchRequests[0][0]);
  assert.equal(url.searchParams.get('kind'), 'asr');
  assert.equal(url.searchParams.get('fmt'), 'srv3');
  assert.equal(resultFor(h, 24).ok, true);
});
