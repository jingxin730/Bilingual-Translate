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

function harness({ translate } = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const listeners = new Map();
  const storageListeners = [];
  const messages = [];
  const runtimeMessages = [];
  const downloads = [];
  const blobs = new Map();
  const revokedUrls = [];
  class DownloadURL extends URL {
    static createObjectURL(blob) { const url = `blob:fixture-${blobs.size}`; blobs.set(url, blob); return url; }
    static revokeObjectURL(url) { revokedUrls.push(url); }
  }
  const location = { href: 'https://www.youtube.com/watch?v=A' };
  const player = element();
  const video = element('video');
  video.currentTime = 0;
  const document = {
    body: element('body'), documentElement: element('html'), segments: [],
    createElement(tag) {
      const node = element(tag);
      if (tag === 'a') node.click = () => downloads.push({ filename: node.download, blob: blobs.get(node.href) });
      return node;
    },
    addEventListener() {}, removeEventListener() {},
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
    window, document, location, URL: DownloadURL, Blob, console: { log() {}, warn() {}, error() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (callback, ms) => schedule(callback, ms), clearTimeout: id => timers.delete(id),
    setInterval: (callback, ms) => schedule(callback, ms, true), clearInterval: id => timers.delete(id),
    chrome: {
      i18n: { getMessage: key => key },
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener(callback) { storageListeners.push(callback); } } },
      runtime: {
        sendMessage(message, callback) {
          runtimeMessages.push(JSON.parse(JSON.stringify(message)));
          if (message.action === 'getProviders') return Promise.resolve({ providers: { claude: { model: 'fixture-model' } } });
          if (message.action === 'translate') {
            if (translate) translate(message, callback);
            else callback({ translations: message.texts.map(text => `Translated: ${text}`) });
          }
        }
      }
    }
  };
  vm.runInNewContext(`${code}\nglobalThis.api = { state, activate, deactivate, togglePanel, downloadSubtitles, buildBilingualSrt, buildBilingualMarkdown, formatSrtTime, onCaptionChanged };`, context);
  const { api } = context;
  api.state.buttonEl = element('button');
  api.state.buttonEl.isConnected = true;
  const changeStorage = changes => storageListeners.forEach(listener => listener(changes, 'local'));
  return { ...api, document, video, location, emit, send, tick, messages, runtimeMessages, downloads, revokedUrls, changeStorage };
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

const fullCaptionText = (count = 45) => JSON.stringify({ events: Array.from({ length: count }, (_, i) => ({
  tStartMs: i * 2000, dDurationMs: 1800, segs: [{ utf8: `Sentence ${i + 1}.` }]
})) });
const capture = (h, text = fullCaptionText()) => h.send({ type: 'capturedCaptions', videoId: 'A', url: track.baseUrl, text });
const translateMessages = h => h.runtimeMessages.filter(message => message.action === 'translate');

test('download exports the complete bilingual SRT using playback sentences and cached translations', async () => {
  const h = harness();
  capture(h);
  h.activate();
  await settle();
  assert.equal(translateMessages(h).length, 1);
  const source = h.state.subtitleEl.querySelector('.bilingual-yt-source').textContent;
  const translation = h.state.subtitleEl.querySelector('.bilingual-yt-target').textContent;
  await h.downloadSubtitles();
  assert.equal(translateMessages(h).length, 3);
  assert.deepEqual(translateMessages(h).map(message => message.texts.length), [20, 20, 5]);
  const [download] = h.downloads;
  assert.match(download.filename, /A\.A\.zh\.bilingual\.srt$/);
  const text = await download.blob.text();
  assert.ok(text.startsWith(`1\n00:00:00,000 --> 00:00:02,000\n${source}\n${translation}\n`));
  assert.match(text, /45\n00:01:28,000 --> 00:01:30,100\nSentence 45\.\nTranslated: Sentence 45\./);
  assert.equal(h.state.downloadMessage, 'ytDownloadComplete');
  h.video.currentTime = 82;
  h.state.onTimeUpdate();
  await settle();
  assert.equal(translateMessages(h).length, 3);
  await h.downloadSubtitles();
  assert.equal(h.downloads.length, 2);
  assert.equal(translateMessages(h).length, 3);
  h.tick(60000);
  assert.equal(h.revokedUrls.length, 2);
  assert.equal(h.document.body.children.filter(node => node.tagName === 'a').length, 0);
});

test('ASR sentence merging is shared by playback and download', async () => {
  const h = harness();
  const events = [
    { tStartMs: 0, dDurationMs: 700, segs: [{ utf8: 'Hello' }] },
    { tStartMs: 700, dDurationMs: 1000, segs: [{ utf8: 'world.' }] },
    { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'Next sentence.' }] }
  ];
  capture(h, JSON.stringify({ events }));
  await h.downloadSubtitles();
  assert.deepEqual(translateMessages(h)[0].texts, ['Hello world.', 'Next sentence.']);
  const text = await h.downloads[0].blob.text();
  assert.match(text, /00:00:00,000 --> 00:00:02,000\nHello world\.\nTranslated: Hello world\./);
  assert.equal(h.state.active, false);
  assert.equal(h.state.subtitleEl, null);
});

test('download waits for a playback batch and double clicks do not duplicate work', async () => {
  const pending = [];
  const h = harness({ translate: (message, callback) => pending.push({ message, callback }) });
  capture(h, fullCaptionText(25));
  h.activate();
  const download = h.downloadSubtitles();
  await settle();
  await h.downloadSubtitles();
  assert.equal(pending.length, 1);
  assert.equal(h.downloads.length, 0);
  pending[0].callback({ translations: pending[0].message.texts.map(text => `Shared: ${text}`) });
  await settle();
  assert.equal(pending.length, 2);
  pending[1].callback({ translations: pending[1].message.texts.map(text => `Shared: ${text}`) });
  await download;
  assert.equal(h.downloads.length, 1);
  assert.equal(translateMessages(h).length, 2);
  assert.match(await h.downloads[0].blob.text(), /Sentence 1\.\nShared: Sentence 1\./);
  assert.equal(h.state.subtitleEl.querySelector('.bilingual-yt-target').textContent, 'Shared: Sentence 1.');
});

for (const failure of ['API error', 'missing translation', 'timeout']) {
  test(`download refuses incomplete files after ${failure} and retries with successful batches preserved`, async () => {
    let requests = 0;
    let retry = false;
    const h = harness({ translate(message, callback) {
      requests++;
      if (requests !== 2 || retry) callback({ translations: message.texts.map(text => `Saved: ${text}`) });
      else if (failure === 'API error') callback({ error: 'fixture failure' });
      else if (failure === 'missing translation') callback({ translations: [''] });
    } });
    capture(h, fullCaptionText(25));
    const download = h.downloadSubtitles();
    await settle();
    if (failure === 'timeout') h.tick(120000);
    await download;
    assert.equal(h.downloads.length, 0);
    assert.equal(h.state.downloadJob, null);
    assert.match(h.state.downloadMessage, /ytDownloadFailed/);
    assert.equal(h.state.cache.get('A').batchState.get(0), 'done');
    retry = true;
    await h.downloadSubtitles();
    assert.equal(h.downloads.length, 1);
    assert.equal(requests, 3);
  });
}

test('navigation during translation cancels download and does not translate the next batch', async () => {
  let reply;
  const h = harness({ translate: (message, callback) => { reply = callback; } });
  capture(h);
  const download = h.downloadSubtitles();
  await settle();
  h.emit('yt-navigate-start');
  h.location.href = 'https://www.youtube.com/watch?v=B';
  h.emit('yt-navigate-finish');
  reply({ translations: translateMessages(h)[0].texts.map(text => `Old: ${text}`) });
  await download;
  assert.equal(h.downloads.length, 0);
  assert.equal(h.state.downloadJob, null);
  assert.equal(translateMessages(h).length, 1);
  assert.equal(h.state.videoId, 'B');
});

test('model changes discard old translations, preserve inactive captions, and cancel preparation', async () => {
  let reply;
  const h = harness({ translate: (message, callback) => { reply = callback; } });
  capture(h, fullCaptionText(1));
  const download = h.downloadSubtitles();
  await settle();
  await h.togglePanel();
  const select = h.state.panelEl.querySelector('.bilingual-yt-model-select');
  select.value = 'chatgpt';
  await select.listeners.get('change')();
  reply({ translations: ['Old model translation'] });
  await download;
  assert.equal(h.downloads.length, 0);
  assert.equal(h.state.cache.get('A').cues.length, 1);
  assert.equal(h.state.cache.get('A').translations.size, 0);
  const next = h.downloadSubtitles();
  await settle();
  assert.equal(translateMessages(h).at(-1).provider, 'chatgpt');
  reply({ translations: ['New model translation'] });
  await next;
  assert.match(await h.downloads[0].blob.text(), /New model translation/);
});

test('DOM download records repeated lines and seek timing, reuses translations, and labels partial coverage', async () => {
  const h = harness();
  h.send({ type: 'tracks', videoId: 'A', tracks: [], status: 'unavailable', nativeAvailable: true });
  h.document.segments = ['Repeated line.'];
  h.activate();
  h.tick(2100);
  await settle();
  h.video.currentTime = 1;
  h.onCaptionChanged();
  h.video.currentTime = 2;
  h.document.segments = ['Second line.'];
  h.onCaptionChanged();
  h.video.currentTime = 3;
  h.onCaptionChanged();
  h.video.currentTime = 100;
  h.document.segments = ['Repeated line.'];
  h.onCaptionChanged();
  h.video.currentTime = 101;
  h.onCaptionChanged();
  await h.togglePanel();
  assert.equal(h.state.panelEl.querySelector('.bilingual-yt-download-btn').textContent, 'ytDownloadWatched');
  await h.downloadSubtitles();
  const text = await h.downloads[0].blob.text();
  assert.match(h.downloads[0].filename, /watched\.bilingual\.srt$/);
  assert.match(text, /1\n00:00:00,000 --> 00:00:02,000\nRepeated line\.\nTranslated: Repeated line\./);
  assert.match(text, /2\n00:00:02,000 --> 00:00:03,000\nSecond line\./);
  assert.match(text, /3\n00:01:40,000 --> 00:01:41,000\nRepeated line\./);
  assert.equal(translateMessages(h).length, 2);
  assert.deepEqual(translateMessages(h)[1].texts, ['Second line.']);
  assert.equal(h.state.downloadMessage, 'ytDownloadPartialComplete');
});

test('download enables native captions and waits for captured data without enabling translation', async () => {
  const h = harness();
  h.send({ type: 'tracks', videoId: 'A', tracks: [track], status: 'ready' });
  const download = h.downloadSubtitles();
  const request = h.messages.find(message => message.type === 'fetchCaptions');
  h.send({ type: 'captionsResult', requestId: request.requestId, ok: false, error: 'not-captured' });
  await settle();
  assert.equal(h.messages.at(-1).type, 'enableCaptions');
  capture(h, fullCaptionText(1));
  h.tick(250);
  await download;
  assert.equal(h.downloads.length, 1);
  assert.equal(h.state.active, false);
  assert.equal(h.state.mode, null);
});

test('no full or recorded captions reports a recoverable error without downloading', async () => {
  const h = harness();
  h.send({ type: 'tracks', videoId: 'A', tracks: [], status: 'unavailable', nativeAvailable: true });
  const download = h.downloadSubtitles();
  for (let i = 0; i < 40; i++) { h.tick(250); await settle(); }
  await download;
  assert.equal(h.downloads.length, 0);
  assert.equal(h.state.downloadMessage, 'ytDownloadFailed ytDownloadNoData');
});

test('SRT timestamps carry milliseconds and subtitle lines cannot create empty cue separators', () => {
  const h = harness();
  assert.equal(h.formatSrtTime(3599.9996), '01:00:00,000');
  assert.equal(h.formatSrtTime(3661.005), '01:01:01,005');
  const text = h.buildBilingualSrt([{ start: 1, end: 1, text: 'A\r\n\r\nB' }], ['甲\n\n乙']);
  assert.equal(text, '1\n00:00:01,000 --> 00:00:01,001\nA\nB\n甲\n乙\n');
});

test('target language changes cancel old downloads and use the new language on retry', async () => {
  let reply;
  const h = harness({ translate: (message, callback) => { reply = callback; } });
  capture(h, fullCaptionText(1));
  const oldDownload = h.downloadSubtitles();
  await settle();
  h.changeStorage({ targetLang: { newValue: 'ja' } });
  reply({ translations: ['Old language'] });
  await oldDownload;
  assert.equal(h.downloads.length, 0);
  const download = h.downloadSubtitles();
  await settle();
  assert.equal(translateMessages(h).at(-1).targetLang, 'ja');
  reply({ translations: ['日本語字幕'] });
  await download;
  assert.match(h.downloads[0].filename, /\.ja\.bilingual\.srt$/);
  assert.match(await h.downloads[0].blob.text(), /日本語字幕/);
});

test('DOM download awaits an existing live translation and shares its exact result', async () => {
  let reply;
  const h = harness({ translate: (message, callback) => { reply = callback; } });
  h.send({ type: 'tracks', videoId: 'A', tracks: [], status: 'unavailable', nativeAvailable: true });
  h.document.segments = ['Live line.'];
  h.activate();
  h.tick(2100);
  const download = h.downloadSubtitles();
  await settle();
  assert.equal(translateMessages(h).length, 1);
  assert.equal(h.downloads.length, 0);
  reply({ translations: ['共享实时译文'] });
  await download;
  assert.equal(translateMessages(h).length, 1);
  assert.match(await h.downloads[0].blob.text(), /Live line\.\n共享实时译文/);
  assert.equal(h.state.subtitleEl.querySelector('.bilingual-yt-target').textContent, '共享实时译文');
});

test('download button restores its state and keeps the panel open after export', async () => {
  const h = harness();
  capture(h, fullCaptionText(1));
  await h.togglePanel();
  const panel = h.state.panelEl;
  const button = panel.querySelector('.bilingual-yt-download-btn');
  const download = button.listeners.get('click')();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'ytDownloadPreparing');
  await download;
  assert.equal(h.state.panelEl, panel);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'ytDownloadSubtitles');
  assert.equal(panel.querySelector('.bilingual-yt-download-hint').textContent, 'ytDownloadComplete');
  assert.equal(panel.children.filter(node => node.tagName === 'a').length, 0);
});

test('invalid cue timing is rejected before translation or download', async () => {
  const h = harness();
  capture(h, JSON.stringify({ events: [{ tStartMs: -1000, dDurationMs: 1000, segs: [{ utf8: 'Invalid.' }] }] }));
  await h.downloadSubtitles();
  assert.equal(h.downloads.length, 0);
  assert.equal(translateMessages(h).length, 0);
  assert.match(h.state.downloadMessage, /ytDownloadNoData|ytDownloadInvalidData/);
});

test('Markdown is selectable in the panel and reuses the SRT translation cache', async () => {
  const h = harness();
  capture(h, fullCaptionText(2));
  await h.downloadSubtitles();
  await h.togglePanel();
  const select = h.state.panelEl.querySelector('.bilingual-yt-download-format');
  assert.deepEqual(select.children.map(option => option.value), ['srt', 'md']);
  assert.equal(select.value, 'srt');
  select.value = 'md';
  select.listeners.get('change')();
  const button = h.state.panelEl.querySelector('.bilingual-yt-download-btn');
  assert.equal(button.textContent, 'ytDownloadMarkdown');
  await button.listeners.get('click')();
  assert.equal(translateMessages(h).length, 1);
  const download = h.downloads[1];
  assert.match(download.filename, /\.zh\.bilingual\.md$/);
  assert.equal(download.blob.type, 'text/markdown;charset=utf-8');
  const text = await download.blob.text();
  assert.ok(text.startsWith('# A\n\n[ytDownloadVideoLink](https://www.youtube.com/watch?v=A)\n\n'));
  assert.ok(text.includes('## [00:00:00.000 – 00:00:02.000](https://www.youtube.com/watch?v=A&t=0s)'));
  assert.ok(text.includes('Sentence 1\\.\n\nTranslated: Sentence 1\\.'));
  assert.ok(text.includes('## [00:00:02.000 – 00:00:04.100](https://www.youtube.com/watch?v=A&t=2s)'));
  assert.equal(text.includes('ytDownloadPartialHint'), false);
  assert.equal(h.downloads[0].blob.type, 'application/x-subrip;charset=utf-8');
  await h.togglePanel();
  await h.togglePanel();
  assert.equal(h.state.panelEl.querySelector('.bilingual-yt-download-format').value, 'md');
});

test('Markdown partial downloads label their scope in the panel, filename, and document', async () => {
  const h = harness();
  h.send({ type: 'tracks', videoId: 'A', tracks: [], status: 'unavailable', nativeAvailable: true });
  h.document.segments = ['Recorded line.'];
  h.activate();
  h.tick(2100);
  await settle();
  h.video.currentTime = 1;
  h.onCaptionChanged();
  await h.togglePanel();
  const select = h.state.panelEl.querySelector('.bilingual-yt-download-format');
  select.value = 'md';
  select.listeners.get('change')();
  assert.equal(h.state.panelEl.querySelector('.bilingual-yt-download-btn').textContent, 'ytDownloadWatchedMarkdown');
  await h.downloadSubtitles();
  assert.match(h.downloads[0].filename, /\.watched\.bilingual\.md$/);
  const text = await h.downloads[0].blob.text();
  assert.ok(text.includes('> ytDownloadPartialHint\n\n'));
  assert.ok(text.includes('00:00:00.000 – 00:00:01.000'));
  assert.ok(text.includes('Recorded line\\.\n\nTranslated: Recorded line\\.'));
  assert.equal(translateMessages(h).length, 1);
});

test('Markdown preserves subtitle text containing formatting characters and HTML as literal text', () => {
  const h = harness();
  h.document.title = 'Title [one] <two>';
  const text = h.buildBilingualMarkdown(
    [{ start: 61.25, end: 62, text: '# title\r\n[link](https://example.com) & <b>bold</b>\n*word*' }],
    ['译文 **加粗**\n`code`'], { videoId: 'A', targetLang: 'zh' }, false
  );
  assert.ok(text.startsWith('# Title \\[one\\] &lt;two&gt;\n'));
  assert.ok(text.includes('\\# title  \n\\[link\\]\\(https://example\\.com\\) &amp; &lt;b&gt;bold&lt;/b&gt;  \n\\*word\\*'));
  assert.ok(text.includes('译文 \\*\\*加粗\\*\\*  \n\\`code\\`'));
  assert.ok(text.includes('[00:01:01.250 – 00:01:02.300](https://www.youtube.com/watch?v=A&t=61s)'));
});

test('the format selector stays disabled through preparation and restores after completion', async () => {
  let reply;
  const h = harness({ translate: (message, callback) => { reply = callback; } });
  capture(h, fullCaptionText(1));
  await h.togglePanel();
  let select = h.state.panelEl.querySelector('.bilingual-yt-download-format');
  select.value = 'md';
  select.listeners.get('change')();
  const download = h.downloadSubtitles();
  await settle();
  assert.equal(select.disabled, true);
  await h.togglePanel();
  await h.togglePanel();
  select = h.state.panelEl.querySelector('.bilingual-yt-download-format');
  assert.equal(select.value, 'md');
  assert.equal(select.disabled, true);
  reply({ translations: ['Ready'] });
  await download;
  assert.equal(select.disabled, false);
  assert.match(h.downloads[0].filename, /\.md$/);
});
