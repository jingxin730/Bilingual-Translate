'use strict';

// YouTube 双语字幕翻译。两种字幕来源（自动选择）：
//   A. MAIN world 截获 YouTube 自身 timedtext → 完整 cue 数组 → 批量预翻译（首选）
//   B. DOM watch .ytp-caption-segment → 累积节流 → 批量翻译（兜底）

const BATCH_SIZE = 20;
const PRELOAD_AHEAD = 6;
// i18n 工具
const t = (key) => chrome.i18n.getMessage(key) || key;
// 扩展重载后旧页面的 chrome API 会失效，提前保存错误提示所需文案。
const PANEL_TITLE = t('ytPanelTitle');
const PANEL_CONNECTION_ERROR = t('noConnection');

const VIDEO_CACHE_LIMIT = 10;
const DOM_BATCH_THRESHOLD = 6;     // DOM 模式累积多少条触发一次翻译
const DOM_BATCH_TIMEOUT_MS = 1500; // 不够阈值时多久强制 flush

const state = {
  videoId: null,
  tracks: [],
  pickedTrack: null,
  tracksStatus: 'loading',
  nativeAvailable: false,
  tracksTimer: null,
  navigating: false,
  activationId: 0,
  activationKey: null,
  mode: null,                  // 'cues' | 'dom' | null
  cues: [],
  cache: new Map(),
  active: false,
  buttonEl: null,
  panelEl: null,
  panelOpening: false,
  panelRequestId: 0,
  subtitleEl: null,
  controlsObserver: null,
  autohideObserver: null,
  videoEl: null,
  onTimeUpdate: null,
  captionObserver: null,
  pollTimer: null,
  lastSourceText: '',
  domQueue: [],
  domFlushTimer: null,
  providers: {},
  provider: 'claude',
  targetLang: 'zh'
};

// ============================================================
// Bridge 通信
// ============================================================
const pendingFetches = new Map();
let fetchSeq = 0;

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (d?.source !== 'bilingual-yt-bridge') return;
  if (d.type === 'tracks') onTracksReceived(d.videoId, d.tracks || [], d.status, d.nativeAvailable);
  else if (d.type === 'captionsResult') {
    const cb = pendingFetches.get(d.requestId);
    if (cb) { pendingFetches.delete(d.requestId); cb(d); }
  }
  else if (d.type === 'capturedCaptions') {
    onCapturedCaptions(d.videoId, d.url, d.text);
  }
});

function onCapturedCaptions(videoId, url, text) {
  if (state.navigating || !videoId || videoId !== currentVideoId() || videoId !== state.videoId) return;
  let captionUrl;
  try { captionUrl = new URL(url, location.href); } catch { return; }
  if (captionUrl.searchParams.get('v') && captionUrl.searchParams.get('v') !== videoId) return;
  const languageCode = captionUrl.searchParams.get('lang');
  if (captionUrl.searchParams.has('tlang')) return;
  if (state.pickedTrack && languageCode && state.pickedTrack.languageCode !== languageCode) return;
  if (typeof text !== 'string') return;
  if (state.mode === 'cues') return; // 已经在用 cues 了
  console.log(`[双语翻译] 拦截到 YouTube 自身的字幕请求 (${text.length} 字符)`);
  const rawCues = parseAuto(text);
  if (!rawCues.length) return;
  const cues = mergeIntoSentences(rawCues);
  console.log(`[双语翻译] ✅ 切换到 cues 模式，原始 ${rawCues.length} 条 → 合并为 ${cues.length} 句`);
  if (!state.pickedTrack) {
    state.pickedTrack = {
      baseUrl: url, languageCode: languageCode || '',
      name: languageCode || t('ytNativeCaption'),
      kind: captionUrl.searchParams.get('kind') || '', source: 'captured'
    };
  }
  state.tracksStatus = 'ready';
  clearTimeout(state.tracksTimer);
  let entry = state.cache.get(state.videoId);
  if (!entry || entry.mode !== 'cues') {
    entry = { mode: 'cues', cues, translations: new Map(), batchState: new Map() };
    putCache(state.videoId, entry);
  } else {
    entry.cues = cues;
  }
  refreshPanelCaptionState();
  // 用户未开启翻译时只缓存，避免原生 CC 请求触发后台翻译。
  if (state.active) {
    stopCaptionWatch();
    state.mode = 'cues';
    state.cues = cues;
    mountSubtitleLayer();
    document.documentElement.classList.add('bilingual-yt-active');
    attachTimeListener();
  }
}

// 把 ASR 的细碎 cue 合并成完整句子（流畅显示的关键）
// 合并条件：未遇到句末标点 且 合并后时长 < MAX_MERGE_SEC 且 合并后字数 < MAX_MERGE_CHARS
function mergeIntoSentences(rawCues) {
  const MAX_MERGE_SEC = 8;
  const MAX_MERGE_CHARS = 180;
  const SENTENCE_END = /[.!?。！？]\s*$/;
  const out = [];
  let cur = null;
  for (const c of rawCues) {
    if (!cur) { cur = { ...c }; continue; }
    const merged = `${cur.text} ${c.text}`.replace(/\s+/g, ' ').trim();
    const dur = c.end - cur.start;
    if (SENTENCE_END.test(cur.text) || dur > MAX_MERGE_SEC || merged.length > MAX_MERGE_CHARS) {
      out.push(cur);
      cur = { ...c };
    } else {
      cur.text = merged;
      cur.end = c.end;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function currentVideoId() {
  const url = new URL(location.href);
  return url.searchParams.get('v') || (url.pathname.startsWith('/shorts/') ? url.pathname.split('/')[2] : null);
}

function requestTracks() {
  if (state.navigating) return;
  const videoId = currentVideoId();
  if (state.videoId !== videoId) resetVideoContext(videoId);
  state.tracksStatus = 'loading';
  clearTimeout(state.tracksTimer);
  state.tracksTimer = setTimeout(() => {
    if (state.videoId !== videoId) return;
    state.tracksStatus = 'unavailable';
    refreshPanelCaptionState();
  }, 12000);
  refreshPanelCaptionState();
  window.postMessage({ source: 'bilingual-yt-iso', type: 'requestTracks', videoId }, '*');
}

function requestNativeCaptions(lang) {
  window.postMessage({ source: 'bilingual-yt-iso', type: 'enableCaptions', videoId: state.videoId, languageCode: lang }, '*');
}

function fetchCaptionsViaBridge(baseUrl) {
  return new Promise((resolve) => {
    const id = ++fetchSeq;
    pendingFetches.set(id, resolve);
    window.postMessage({ source: 'bilingual-yt-iso', type: 'fetchCaptions', videoId: state.videoId,
      languageCode: state.pickedTrack?.languageCode, baseUrl, requestId: id }, '*');
    setTimeout(() => {
      if (pendingFetches.has(id)) { pendingFetches.delete(id); resolve({ ok: false, error: 'timeout' }); }
    }, 8000);
  });
}

function onTracksReceived(videoId, tracks, status, nativeAvailable = false) {
  if (state.navigating || videoId !== currentVideoId()) return;
  if (state.videoId !== videoId) resetVideoContext(videoId);
  state.tracks = tracks;
  state.pickedTrack = pickTrack(tracks) || (state.pickedTrack?.source === 'captured' ? state.pickedTrack : null);
  state.nativeAvailable = nativeAvailable;
  state.tracksStatus = status || (tracks.length ? 'ready' : 'unavailable');
  if (state.tracksStatus !== 'loading') clearTimeout(state.tracksTimer);
  console.log(`[双语翻译] 收到 tracks，视频 ${videoId}，共 ${tracks.length} 条轨道，选中:`, state.pickedTrack?.name || '无');
  refreshPanelCaptionState();
  if (state.active && videoId && hasCaptionSource()) activateForCurrentVideo();
}

function hasCaptionSource() {
  return !!(state.pickedTrack || state.nativeAvailable || state.cache.get(state.videoId)?.mode === 'cues');
}

function pickTrack(tracks) {
  if (!tracks.length) return null;
  return (
    tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr') ||
    tracks.find(t => t.languageCode === 'en') ||
    tracks.find(t => t.languageCode?.startsWith('en')) ||
    tracks[0]
  );
}

// ============================================================
// 按钮
// ============================================================
function mountIconButton() {
  if (state.buttonEl?.isConnected) return;
  const right = document.querySelector('.ytp-right-controls');
  if (!right) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bilingual-yt-icon-btn';
  btn.setAttribute('aria-label', '双语字幕翻译');
  btn.setAttribute('aria-expanded', 'false');
  btn.title = '双语字幕翻译';
  btn.innerHTML = '<span class="bilingual-yt-icon-glyph"><img src="' + chrome.runtime.getURL('icons/icon16.png') + '" alt="译"></span>';

  const settings = right.querySelector('.ytp-settings-button');
  const cc = right.querySelector('.ytp-subtitles-button');
  try {
    if (settings?.parentNode) settings.parentNode.insertBefore(btn, settings);
    else if (cc?.parentNode) cc.parentNode.insertBefore(btn, cc.nextSibling);
    else right.insertBefore(btn, right.firstChild);
  } catch (err) {
    right.appendChild(btn);
  }

  btn.addEventListener('click', (e) => { e.stopPropagation(); togglePanel(); });
  state.buttonEl = btn;
  refreshButtonState();
  console.log('[双语翻译] 字幕按钮已挂载，父节点:', btn.parentElement?.className);
}

function refreshButtonState() {
  state.buttonEl?.classList.toggle('is-active', state.active);
}

function ensureControlsObserver() {
  if (state.controlsObserver) return;
  state.controlsObserver = new MutationObserver(() => {
    mountIconButton();
    if (state.active) mountSubtitleLayer();
  });
  state.controlsObserver.observe(document.documentElement, { childList: true, subtree: true });
}

// ============================================================
// 面板
// ============================================================
async function togglePanel() {
  if (state.panelEl?.isConnected || state.panelOpening) { closePanel(); return; }
  const requestId = ++state.panelRequestId;
  state.panelOpening = true;
  try {
    await loadPanelSettings();
    if (requestId !== state.panelRequestId) return;
    renderPanel();
    requestTracks();
  } catch (err) {
    if (requestId !== state.panelRequestId) return;
    console.warn('[双语翻译] 无法打开字幕设置:', err);
    const panel = document.createElement('div');
    panel.className = 'bilingual-yt-panel';
    const message = document.createElement('div');
    message.setAttribute('role', 'alert');
    message.textContent = `${PANEL_TITLE}：${PANEL_CONNECTION_ERROR}`;
    panel.appendChild(message);
    mountPanel(panel);
  } finally {
    if (requestId === state.panelRequestId) state.panelOpening = false;
  }
}

function closePanel() {
  ++state.panelRequestId;
  state.panelOpening = false;
  state.panelEl?.remove();
  state.panelEl = null;
  state.buttonEl?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', onDocClickForPanel, true);
  document.removeEventListener('keydown', onPanelKeyDown, true);
  document.removeEventListener('fullscreenchange', repositionPanel);
  document.removeEventListener('scroll', repositionPanel, true);
  window.removeEventListener('resize', repositionPanel);
}

function onPanelKeyDown(e) {
  if (e.key !== 'Escape') return;
  closePanel();
  e.stopPropagation();
}

function onDocClickForPanel(e) {
  if (!state.panelEl) return;
  if (state.panelEl.contains(e.target) || state.buttonEl?.contains(e.target)) return;
  closePanel();
}

async function loadPanelSettings() {
  // 与网页翻译弹窗共用后台配置，只接收模型名称，不向页面暴露 API Key。
  const [saved, response] = await Promise.all([
    chrome.storage.local.get(['provider', 'targetLang']),
    chrome.runtime.sendMessage({ action: 'getProviders' })
  ]);
  const providers = response?.providers || {};
  const keys = Object.keys(providers);
  if (!keys.length) throw new Error('config.js 中没有可用的模型配置');

  const preferred = saved.provider || state.provider;
  const provider = keys.includes(preferred) ? preferred : keys[0];
  const targetLang = saved.targetLang || state.targetLang;
  const changed = provider !== state.provider || targetLang !== state.targetLang;
  state.providers = providers;
  state.provider = provider;
  state.targetLang = targetLang;
  if (changed) resetTranslationCache();
}

function renderPanel() {
  const panel = document.createElement('div');
  panel.className = 'bilingual-yt-panel';

  const title = document.createElement('div');
  title.className = 'bilingual-yt-panel-title';
  title.textContent = PANEL_TITLE;
  panel.appendChild(title);

  const modelRow = document.createElement('div');
  modelRow.className = 'bilingual-yt-panel-row';
  const modelLabel = document.createElement('span');
  modelLabel.className = 'bilingual-yt-panel-label';
  modelLabel.textContent = t('ytCurrentModel');

  const modelSelect = document.createElement('select');
  modelSelect.className = 'bilingual-yt-model-select';
  modelSelect.setAttribute('aria-label', t('ytCurrentModel'));
  Object.entries(state.providers).forEach(([value, cfg]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = cfg.model;
    modelSelect.appendChild(option);
  });
  modelSelect.value = state.provider;
  modelSelect.addEventListener('change', async () => {
    const provider = modelSelect.value;
    if (provider === state.provider) return;
    state.provider = provider;
    resetTranslationCache();
    await chrome.storage.local.set({ provider });
  });

  modelRow.append(modelLabel, modelSelect);
  panel.appendChild(modelRow);

  const trackInfo = document.createElement('div');
  trackInfo.className = 'bilingual-yt-panel-row';
  const trackLabel = document.createElement('span');
  trackLabel.className = 'bilingual-yt-panel-label';
  trackLabel.textContent = t('ytSubtitleSource');
  const trackValue = document.createElement('span');
  trackValue.className = 'bilingual-yt-panel-value bilingual-yt-caption-source';
  trackInfo.append(trackLabel, trackValue);
  panel.appendChild(trackInfo);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'bilingual-yt-panel-btn';
  action.addEventListener('click', () => {
    if (state.active) { deactivate(); closePanel(); }
    else if (hasCaptionSource()) { activate(); closePanel(); }
    else requestTracks();
  });
  panel.appendChild(action);
  const hint = document.createElement('div');
  hint.className = 'bilingual-yt-caption-hint';
  hint.textContent = t('ytCaptionUnavailableHint');
  panel.appendChild(hint);

  mountPanel(panel);
  refreshPanelCaptionState();
}

function refreshPanelCaptionState() {
  const panel = state.panelEl;
  const source = panel?.querySelector('.bilingual-yt-caption-source');
  if (!source) return;
  const available = hasCaptionSource();
  const loading = state.tracksStatus === 'loading';
  source.textContent = state.pickedTrack
    ? `${state.pickedTrack.name}${state.pickedTrack.kind === 'asr' ? t('ytAutoGenerated') : ''}`
    : available ? t('ytNativeCaption') : loading ? t('ytDetectingCaptions') : t('ytNoCaption');
  const action = panel.querySelector('.bilingual-yt-panel-btn');
  action.textContent = state.active ? t('ytStop') : available ? t('ytStart')
    : loading ? t('ytDetectingCaptions') : t('ytRetryCaptions');
  action.disabled = !state.active && !available && loading;
  panel.querySelector('.bilingual-yt-caption-hint').hidden = available || loading;
  repositionPanel();
}

function mountPanel(panel) {
  state.panelEl = panel;
  // 全屏只显示 fullscreenElement 及其后代；body 上再大的 z-index 也无效。
  repositionPanel();
  if (state.panelEl !== panel) return;
  panel.addEventListener('click', e => e.stopPropagation());
  panel.addEventListener('keydown', e => e.stopPropagation());
  state.buttonEl?.setAttribute('aria-expanded', 'true');
  document.addEventListener('click', onDocClickForPanel, true);
  document.addEventListener('keydown', onPanelKeyDown, true);
  document.addEventListener('fullscreenchange', repositionPanel);
  document.addEventListener('scroll', repositionPanel, true);
  window.addEventListener('resize', repositionPanel);
}

function repositionPanel() {
  const panel = state.panelEl;
  if (!panel) return;
  if (!state.buttonEl?.isConnected) { closePanel(); return; }
  const host = document.fullscreenElement || document.body;
  if (panel.parentElement !== host) host.appendChild(panel);
  positionPanelNearButton(panel);
}

function positionPanelNearButton(panel) {
  const btn = state.buttonEl;
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pw = panel.offsetWidth || 260;
  const ph = panel.offsetHeight || 140;

  // 优先显示在按钮上方，空间不足时显示在下方
  let top = rect.top - ph - 12;
  if (top < 8) top = rect.bottom + 8;
  top = Math.min(top, vh - ph - 8);
  top = Math.max(8, top);

  // 水平方向：右对齐按钮，超出左边界时向右推
  let left = rect.right - pw;
  left = Math.max(8, left);
  left = Math.min(left, vw - pw - 8);

  panel.style.position = 'fixed';
  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
}

// ============================================================
// 激活 / 停用
// ============================================================
function activate() {
  if (!hasCaptionSource() || !state.videoId) return;
  state.active = true;
  document.documentElement.classList.add('bilingual-yt-active');
  refreshButtonState();
  activateForCurrentVideo();
}

function deactivate() {
  ++state.activationId;
  state.activationKey = null;
  state.active = false;
  document.documentElement.classList.remove('bilingual-yt-active');
  unmountSubtitleLayer();
  detachTimeListener();
  stopCaptionWatch();
  state.mode = null;
  refreshButtonState();
}

async function activateForCurrentVideo() {
  if (state.navigating || !state.active || !hasCaptionSource() || !state.videoId || state.videoId !== currentVideoId()) {
    console.warn('[双语翻译] 无可用字幕或视频 ID');
    return;
  }
  const videoId = state.videoId;
  const track = state.pickedTrack;
  const activationKey = `${videoId}:${track?.languageCode || ''}`;
  if (state.activationKey === activationKey) return;
  state.activationKey = activationKey;
  const activationId = ++state.activationId;
  detachTimeListener();
  stopCaptionWatch();
  state.mode = null;
  document.documentElement.classList.add('bilingual-yt-active');
  mountSubtitleLayer();

  let entry = state.cache.get(videoId);
  if (!entry || (!entry.cues && !entry.textTranslations)) {
    // 优先复用 YouTube 已获取的字幕；缓存未命中就立即开启原生 CC 的 DOM 兜底。
    const res = track?.baseUrl ? await fetchCaptionsViaBridge(track.baseUrl) : { ok: false, error: 'no-base-url' };
    if (!state.active || state.videoId !== videoId || state.activationId !== activationId || state.mode === 'cues') return;
    if (res.ok) {
      const cues = mergeIntoSentences(parseAuto(res.text));
      if (cues.length) {
        console.log(`[双语翻译] ✅ cues 模式，${cues.length} 条 (via ${res.label})`);
        entry = { mode: 'cues', cues, translations: new Map(), batchState: new Map() };
        state.mode = 'cues';
        state.cues = cues;
        putCache(state.videoId, entry);
        attachTimeListener();
        return;
      }
    }
    console.warn('[双语翻译] timedtext 不可用，回退到 DOM 模式:', res.error);
    entry = { mode: 'dom', textTranslations: new Map(), pending: new Map() };
    state.mode = 'dom';
    putCache(state.videoId, entry);
    requestNativeCaptions(track?.languageCode);
    startCaptionWatch();
  } else {
    state.mode = entry.mode;
    if (entry.mode === 'cues') {
      state.cues = entry.cues;
      attachTimeListener();
    } else {
      requestNativeCaptions(track?.languageCode);
      startCaptionWatch();
    }
  }
}

function putCache(videoId, entry) {
  state.cache.set(videoId, entry);
  while (state.cache.size > VIDEO_CACHE_LIMIT) {
    const oldest = state.cache.keys().next().value;
    state.cache.delete(oldest);
  }
}

// 模型或目标语言变化后，保留已取得的字幕，只丢弃旧配置生成的译文。
function resetTranslationCache() {
  state.cache.clear();
  if (!state.videoId || !state.mode) return;

  if (state.mode === 'cues') {
    putCache(state.videoId, {
      mode: 'cues',
      cues: state.cues,
      translations: new Map(),
      batchState: new Map()
    });
    const currentTime = state.videoEl?.currentTime;
    if (state.active && typeof currentTime === 'number') renderCurrentCue(currentTime);
    return;
  }

  putCache(state.videoId, {
    mode: 'dom',
    textTranslations: new Map(),
    pending: new Map()
  });
  state.domQueue = [];
  if (state.domFlushTimer) {
    clearTimeout(state.domFlushTimer);
    state.domFlushTimer = null;
  }
  if (state.active && state.lastSourceText) {
    renderDomMode(state.lastSourceText);
    enqueueDomTranslation(state.lastSourceText);
  }
}

// ============================================================
// 字幕格式解析
// ============================================================
function parseAuto(text) {
  const t = text.trimStart();
  if (t.startsWith('{')) { try { return parseJson3(text); } catch {} }
  if (t.startsWith('<')) return parseSrv3(text);
  try { return parseJson3(text); } catch { return parseSrv3(text); }
}

function parseJson3(text) {
  const data = JSON.parse(text);
  const events = data.events || [];
  const cues = [];
  for (const ev of events) {
    if (!ev.segs) continue;
    const t = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const start = (ev.tStartMs || 0) / 1000;
    const end = start + (ev.dDurationMs || 0) / 1000;
    cues.push({ start, end, text: t });
  }
  return cues;
}

function parseSrv3(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) return [];
  let nodes = doc.querySelectorAll('body p');
  if (!nodes.length) nodes = doc.querySelectorAll('p');
  if (!nodes.length) nodes = doc.querySelectorAll('text');
  const cues = [];
  nodes.forEach(n => {
    const startAttr = n.getAttribute('t') ?? n.getAttribute('start');
    const durAttr = n.getAttribute('d') ?? n.getAttribute('dur');
    const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    const isMs = n.hasAttribute('t');
    const start = parseFloat(startAttr || '0') / (isMs ? 1000 : 1);
    const dur = parseFloat(durAttr || '0') / (isMs ? 1000 : 1);
    cues.push({ start, end: start + dur, text: t });
  });
  return cues;
}

// ============================================================
// 字幕层
// ============================================================
function mountSubtitleLayer() {
  if (!state.active) return;
  if (state.subtitleEl?.isConnected) return;
  const player = document.querySelector('#movie_player');
  if (!player) return;

  const layer = document.createElement('div');
  layer.className = 'bilingual-yt-subtitles';
  layer.innerHTML = `
    <div class="bilingual-yt-line bilingual-yt-source"></div>
    <div class="bilingual-yt-line bilingual-yt-target"></div>
  `;
  player.appendChild(layer);
  state.subtitleEl = layer;

  state.autohideObserver?.disconnect();
  state.autohideObserver = new MutationObserver(() => {
    layer.classList.toggle('controls-visible', !player.classList.contains('ytp-autohide'));
  });
  state.autohideObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
  layer.classList.toggle('controls-visible', !player.classList.contains('ytp-autohide'));
}

function unmountSubtitleLayer() {
  state.subtitleEl?.remove();
  state.subtitleEl = null;
  state.autohideObserver?.disconnect();
  state.autohideObserver = null;
}

function setSubtitles(sourceText, targetText, loading) {
  const layer = state.subtitleEl;
  if (!layer) return;
  layer.querySelector('.bilingual-yt-source').textContent = sourceText || '';
  const targetEl = layer.querySelector('.bilingual-yt-target');
  targetEl.textContent = targetText || (loading ? t('ytTranslating') : '');
  targetEl.classList.toggle('is-loading', !!loading);
}

// ============================================================
// 模式 A：cues - 时间驱动
// ============================================================
function getVideoEl() {
  return document.querySelector('#movie_player video') || document.querySelector('video');
}

function attachTimeListener() {
  detachTimeListener();
  const video = getVideoEl();
  if (!video) return;
  state.videoEl = video;
  state.onTimeUpdate = () => renderCurrentCue(video.currentTime);
  video.addEventListener('timeupdate', state.onTimeUpdate);
  video.addEventListener('seeked', state.onTimeUpdate);
  renderCurrentCue(video.currentTime);
}

function detachTimeListener() {
  if (state.videoEl && state.onTimeUpdate) {
    state.videoEl.removeEventListener('timeupdate', state.onTimeUpdate);
    state.videoEl.removeEventListener('seeked', state.onTimeUpdate);
  }
  state.videoEl = null;
  state.onTimeUpdate = null;
}

function findCueIndexAt(t) {
  const cues = state.cues;
  let lo = 0, hi = cues.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (ans >= 0 && t <= cues[ans].end + 0.3) return ans;
  return -1;
}

function renderCurrentCue(t) {
  const layer = state.subtitleEl;
  if (!layer) return;
  const idx = findCueIndexAt(t);
  if (idx < 0) { setSubtitles('', '', false); return; }
  const cue = state.cues[idx];
  const trans = getTranslationFor(idx);
  setSubtitles(cue.text, trans, !trans);
  scheduleBatchTranslate(idx);
}

function getTranslationFor(cueIdx) {
  const entry = state.cache.get(state.videoId);
  if (!entry || entry.mode !== 'cues') return null;
  const batchId = Math.floor(cueIdx / BATCH_SIZE);
  const arr = entry.translations.get(batchId);
  if (!arr) return null;
  return arr[cueIdx - batchId * BATCH_SIZE] || null;
}

function scheduleBatchTranslate(currentIdx) {
  const entry = state.cache.get(state.videoId);
  if (!entry || entry.mode !== 'cues') return;
  const total = state.cues.length;
  const curBatch = Math.floor(currentIdx / BATCH_SIZE);
  ensureBatch(entry, curBatch, total);
  const lastInBatch = curBatch * BATCH_SIZE + BATCH_SIZE - 1;
  if (lastInBatch - currentIdx <= PRELOAD_AHEAD) {
    ensureBatch(entry, curBatch + 1, total);
  }
}

async function ensureBatch(entry, batchId, total) {
  const start = batchId * BATCH_SIZE;
  if (start >= total) return;
  if (entry.batchState.get(batchId) === 'loading' || entry.batchState.get(batchId) === 'done') return;
  entry.batchState.set(batchId, 'loading');

  const end = Math.min(start + BATCH_SIZE, total);
  const texts = state.cues.slice(start, end).map(c => c.text);

  try {
    const translations = await sendTranslateRequest(texts);
    entry.translations.set(batchId, translations);
    entry.batchState.set(batchId, 'done');
    const t = state.videoEl?.currentTime;
    if (typeof t === 'number') renderCurrentCue(t);
  } catch (err) {
    console.error('[双语翻译] 批次错误:', err.message);
    entry.batchState.set(batchId, 'error');
    setTimeout(() => {
      if (entry.batchState.get(batchId) === 'error') entry.batchState.delete(batchId);
    }, 5000);
  }
}

// ============================================================
// 模式 B：DOM watch - 等一句话「稳定」后再翻译，避免半句话发请求
// ============================================================
const DOM_SETTLE_MS = 600;  // 文本停止变化多久算「稳定」

function getCurrentNativeText() {
  const segs = document.querySelectorAll('#movie_player .ytp-caption-segment');
  if (!segs.length) return '';
  return Array.from(segs).map(s => s.textContent.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function startCaptionWatch() {
  stopCaptionWatch();
  const container = document.querySelector('#movie_player');
  if (container) {
    state.captionObserver = new MutationObserver(() => onCaptionChanged());
    state.captionObserver.observe(container, { childList: true, subtree: true, characterData: true });
  }
  state.pollTimer = setInterval(onCaptionChanged, 300);
  onCaptionChanged();
}

function stopCaptionWatch() {
  state.captionObserver?.disconnect();
  state.captionObserver = null;
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  if (state.domFlushTimer) { clearTimeout(state.domFlushTimer); state.domFlushTimer = null; }
  if (state.domSettleTimer) { clearTimeout(state.domSettleTimer); state.domSettleTimer = null; }
  state.lastSourceText = '';
  state.domQueue = [];
  state.domLastSettled = '';
}

function onCaptionChanged() {
  const text = getCurrentNativeText();
  if (text === state.lastSourceText) return;
  state.lastSourceText = text;
  renderDomMode(text);

  // 重置「稳定计时器」：文本仍在变化，等它停下来再翻译
  if (state.domSettleTimer) clearTimeout(state.domSettleTimer);
  if (!text) return;
  state.domSettleTimer = setTimeout(() => {
    state.domSettleTimer = null;
    // 这一刻的文本如果跟「上次已发翻译」不同，发起翻译
    if (state.lastSourceText && state.lastSourceText !== state.domLastSettled) {
      state.domLastSettled = state.lastSourceText;
      enqueueDomTranslation(state.lastSourceText);
    }
  }, DOM_SETTLE_MS);
}

function renderDomMode(sourceText) {
  if (!state.subtitleEl) return;
  if (!sourceText) { setSubtitles('', '', false); return; }
  const entry = state.cache.get(state.videoId);
  const cached = entry?.textTranslations?.get(sourceText);
  setSubtitles(sourceText, cached || '', !cached);
}

function enqueueDomTranslation(sourceText) {
  const entry = state.cache.get(state.videoId);
  if (!entry || entry.mode !== 'dom') return;
  if (entry.textTranslations.has(sourceText)) return;
  if (entry.pending.has(sourceText)) return;
  if (state.domQueue.includes(sourceText)) return;

  state.domQueue.push(sourceText);

  if (state.domQueue.length >= DOM_BATCH_THRESHOLD) {
    flushDomBatch();
  } else if (!state.domFlushTimer) {
    state.domFlushTimer = setTimeout(flushDomBatch, DOM_BATCH_TIMEOUT_MS);
  }
}

async function flushDomBatch() {
  if (state.domFlushTimer) { clearTimeout(state.domFlushTimer); state.domFlushTimer = null; }
  const batch = state.domQueue.splice(0);
  if (!batch.length) return;
  const entry = state.cache.get(state.videoId);
  if (!entry) return;

  batch.forEach(s => entry.pending.set(s, true));
  try {
    const translations = await sendTranslateRequest(batch);
    batch.forEach((src, i) => {
      entry.textTranslations.set(src, translations[i] || '');
      entry.pending.delete(src);
    });
    if (state.lastSourceText && entry.textTranslations.has(state.lastSourceText)) {
      renderDomMode(state.lastSourceText);
    }
  } catch (err) {
    console.warn('[双语翻译] DOM 批次翻译失败:', err.message);
    batch.forEach(s => entry.pending.delete(s));
  }
}

// ============================================================
// 翻译请求（共享）
// ============================================================
function sendTranslateRequest(texts) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'translate', texts, provider: state.provider, targetLang: state.targetLang },
      resp => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (resp?.error) return reject(new Error(resp.error));
        resolve(resp?.translations || new Array(texts.length).fill(''));
      }
    );
  });
}

// ============================================================
// SPA 导航
// ============================================================
function resetVideoContext(videoId) {
  ++state.activationId;
  state.activationKey = null;
  state.videoId = videoId;
  state.tracks = [];
  state.pickedTrack = null;
  state.nativeAvailable = false;
  state.tracksStatus = 'loading';
  clearTimeout(state.tracksTimer);
  for (const resolve of pendingFetches.values()) resolve({ ok: false, error: 'video-changed' });
  pendingFetches.clear();
  state.cues = [];
  state.mode = null;
  detachTimeListener();
  stopCaptionWatch();
  document.documentElement.classList.remove('bilingual-yt-active');
  if (state.subtitleEl) setSubtitles('', '', false);
  refreshPanelCaptionState();
}

window.addEventListener('yt-navigate-start', () => {
  state.navigating = true;
  closePanel();
  resetVideoContext(null);
});

window.addEventListener('yt-navigate-finish', () => {
  state.navigating = false;
  closePanel();
  resetVideoContext(currentVideoId());
  requestTracks();
});

// 与扩展弹窗保持同步：弹窗中切换模型/目标语言后，YouTube 立即使用新配置。
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const nextProvider = changes.provider?.newValue || state.provider;
  const nextTargetLang = changes.targetLang?.newValue || state.targetLang;
  if (nextProvider === state.provider && nextTargetLang === state.targetLang) return;
  state.provider = nextProvider;
  state.targetLang = nextTargetLang;
  const modelSelect = state.panelEl?.querySelector('.bilingual-yt-model-select');
  if (modelSelect && modelSelect.value !== nextProvider) modelSelect.value = nextProvider;
  resetTranslationCache();
});

// ============================================================
// 初始化
// ============================================================
ensureControlsObserver();
mountIconButton();
requestTracks();
