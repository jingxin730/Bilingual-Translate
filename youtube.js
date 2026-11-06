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
  domCurrentCue: null,
  domLastTime: null,
  downloadJob: null,
  downloadMessage: '',
  downloadFormat: 'srt',
  downloadContent: 'bilingual',
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
  if (state.cache.get(videoId)?.mode === 'cues') return; // 保持已缓存分句和译文的对应关系
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

function fetchCaptionsViaBridge(baseUrl, load = false) {
  return new Promise((resolve) => {
    const id = ++fetchSeq;
    pendingFetches.set(id, resolve);
    window.postMessage({ source: 'bilingual-yt-iso', type: load ? 'loadCaptions' : 'fetchCaptions', videoId: state.videoId,
      languageCode: state.pickedTrack?.languageCode, kind: state.pickedTrack?.kind, baseUrl, requestId: id }, '*');
    setTimeout(() => {
      if (pendingFetches.has(id)) { pendingFetches.delete(id); resolve({ ok: false, error: 'timeout' }); }
    }, load ? 28000 : 8000);
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
  const preferred = saved.provider || state.provider;
  const provider = keys.includes(preferred) ? preferred : keys[0] || preferred;
  const targetLang = saved.targetLang || state.targetLang;
  const changed = provider !== state.provider || targetLang !== state.targetLang;
  state.providers = providers;
  state.provider = provider;
  state.targetLang = targetLang;
  if (!keys.length) state.downloadContent = 'original';
  if (changed) resetTranslationCache();
}

function renderPanel() {
  const panel = document.createElement('div');
  panel.className = 'bilingual-yt-panel';

  const title = document.createElement('div');
  title.className = 'bilingual-yt-panel-title';
  title.textContent = PANEL_TITLE;
  panel.appendChild(title);

  const playback = document.createElement('section');
  playback.className = 'bilingual-yt-panel-section bilingual-yt-playback-section';
  playback.setAttribute('aria-label', t('ytPlaybackSection'));
  const playbackTitle = document.createElement('div');
  playbackTitle.className = 'bilingual-yt-section-title';
  playbackTitle.textContent = t('ytPlaybackSection');
  playback.appendChild(playbackTitle);

  const modelRow = document.createElement('div');
  modelRow.className = 'bilingual-yt-panel-row';
  const modelLabel = document.createElement('span');
  modelLabel.className = 'bilingual-yt-panel-label';
  modelLabel.textContent = t('ytCurrentModel');

  const modelSelect = document.createElement('select');
  modelSelect.className = 'bilingual-yt-model-select bilingual-yt-provider-select';
  modelSelect.setAttribute('aria-label', t('ytCurrentModel'));
  Object.entries(state.providers).forEach(([value, cfg]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = cfg.model;
    modelSelect.appendChild(option);
  });
  if (!Object.keys(state.providers).length) {
    const option = document.createElement('option');
    option.value = state.provider;
    option.textContent = t('ytModelUnavailable');
    modelSelect.appendChild(option);
    modelSelect.disabled = true;
  }
  modelSelect.value = state.provider;
  modelSelect.addEventListener('change', async () => {
    const provider = modelSelect.value;
    if (provider === state.provider) return;
    state.provider = provider;
    resetTranslationCache();
    await chrome.storage.local.set({ provider });
  });

  modelRow.append(modelLabel, modelSelect);
  playback.appendChild(modelRow);

  const trackInfo = document.createElement('div');
  trackInfo.className = 'bilingual-yt-panel-row';
  const trackLabel = document.createElement('span');
  trackLabel.className = 'bilingual-yt-panel-label';
  trackLabel.textContent = t('ytSubtitleSource');
  const trackValue = document.createElement('span');
  trackValue.className = 'bilingual-yt-panel-value bilingual-yt-caption-source';
  trackInfo.append(trackLabel, trackValue);
  panel.appendChild(trackInfo);
  panel.appendChild(playback);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'bilingual-yt-panel-btn bilingual-yt-playback-btn';
  action.addEventListener('click', () => {
    if (state.active) { deactivate(); closePanel(); }
    else if (hasCaptionSource()) { activate(); closePanel(); }
    else requestTracks();
  });
  playback.appendChild(action);
  const hint = document.createElement('div');
  hint.className = 'bilingual-yt-caption-hint';
  hint.textContent = t('ytCaptionUnavailableHint');
  playback.appendChild(hint);

  const downloads = document.createElement('section');
  downloads.className = 'bilingual-yt-panel-section bilingual-yt-download-section';
  downloads.setAttribute('aria-label', t('ytDownloadSection'));
  const downloadTitle = document.createElement('div');
  downloadTitle.className = 'bilingual-yt-section-title';
  downloadTitle.textContent = t('ytDownloadSection');
  downloads.appendChild(downloadTitle);
  panel.appendChild(downloads);

  const downloadOptions = document.createElement('div');
  downloadOptions.className = 'bilingual-yt-download-options';
  downloads.appendChild(downloadOptions);
  const contentRow = document.createElement('label');
  contentRow.className = 'bilingual-yt-download-field';
  const contentLabel = document.createElement('span');
  contentLabel.className = 'bilingual-yt-panel-label';
  contentLabel.textContent = t('ytDownloadContent');
  const contentSelect = document.createElement('select');
  contentSelect.className = 'bilingual-yt-select bilingual-yt-download-content';
  contentSelect.setAttribute('aria-label', t('ytDownloadContent'));
  for (const [value, key] of [['original', 'ytOriginalOnly'], ['bilingual', 'ytOriginalAndTranslation']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = t(key);
    option.disabled = value === 'bilingual' && !Object.keys(state.providers).length;
    contentSelect.appendChild(option);
  }
  contentSelect.value = state.downloadContent;
  contentSelect.addEventListener('change', () => {
    state.downloadContent = contentSelect.value === 'original' ? 'original' : 'bilingual';
    state.downloadMessage = '';
    refreshDownloadState();
  });
  contentRow.append(contentLabel, contentSelect);
  downloadOptions.appendChild(contentRow);

  const formatRow = document.createElement('label');
  formatRow.className = 'bilingual-yt-download-field';
  const formatLabel = document.createElement('span');
  formatLabel.className = 'bilingual-yt-panel-label';
  formatLabel.textContent = t('ytDownloadFormat');
  const formatSelect = document.createElement('select');
  formatSelect.className = 'bilingual-yt-select bilingual-yt-download-format';
  formatSelect.setAttribute('aria-label', t('ytDownloadFormat'));
  for (const [value, label] of [['srt', 'SRT (.srt)'], ['md', 'Markdown (.md)']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    formatSelect.appendChild(option);
  }
  formatSelect.value = state.downloadFormat;
  formatSelect.addEventListener('change', () => {
    state.downloadFormat = formatSelect.value === 'md' ? 'md' : 'srt';
    state.downloadMessage = '';
    refreshDownloadState();
  });
  formatRow.append(formatLabel, formatSelect);
  downloadOptions.appendChild(formatRow);

  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'bilingual-yt-panel-btn bilingual-yt-download-btn';
  download.addEventListener('click', downloadSubtitles);
  downloads.appendChild(download);
  const downloadHint = document.createElement('div');
  downloadHint.className = 'bilingual-yt-download-hint';
  downloadHint.setAttribute('role', 'status');
  downloadHint.setAttribute('aria-live', 'polite');
  downloads.appendChild(downloadHint);

  mountPanel(panel);
  refreshPanelCaptionState();
}

function refreshPanelCaptionState() {
  const panel = state.panelEl;
  const source = panel?.querySelector('.bilingual-yt-caption-source');
  if (!source) return;
  const available = hasCaptionSource();
  const loading = state.tracksStatus === 'loading';
  const autoLabel = t('ytAutoGenerated');
  const autoName = autoLabel.replace(/[()（）]/g, '').trim();
  source.textContent = state.pickedTrack
    ? `${state.pickedTrack.name}${state.pickedTrack.kind === 'asr' && !state.pickedTrack.name.includes(autoName) ? autoLabel : ''}`
    : available ? t('ytNativeCaption') : loading ? t('ytDetectingCaptions') : t('ytNoCaption');
  source.title = source.textContent;
  const action = panel.querySelector('.bilingual-yt-playback-btn');
  action.textContent = state.active ? t('ytStop') : available ? t('ytStart')
    : loading ? t('ytDetectingCaptions') : t('ytRetryCaptions');
  action.disabled = !state.active && ((!available && loading) || (available && !Object.keys(state.providers).length));
  panel.querySelector('.bilingual-yt-caption-hint').hidden = available || loading;
  refreshDownloadState();
  repositionPanel();
}

function refreshDownloadState() {
  const button = state.panelEl?.querySelector('.bilingual-yt-download-btn');
  if (!button) return;
  const partial = state.cache.get(state.videoId)?.mode === 'dom';
  const markdown = state.downloadFormat === 'md';
  const original = state.downloadContent === 'original';
  button.textContent = state.downloadJob ? t('ytDownloadPreparing')
    : original ? `${t(partial ? 'ytDownloadWatchedOriginal' : 'ytDownloadOriginal')} (${markdown ? 'MD' : 'SRT'})`
      : partial ? t(markdown ? 'ytDownloadWatchedMarkdown' : 'ytDownloadWatched')
        : t(markdown ? 'ytDownloadMarkdown' : 'ytDownloadSubtitles');
  button.disabled = !!state.downloadJob || !hasCaptionSource() || (!original && !Object.keys(state.providers).length);
  state.panelEl.querySelector('.bilingual-yt-download-format').disabled = !!state.downloadJob;
  state.panelEl.querySelector('.bilingual-yt-download-content').disabled = !!state.downloadJob;
  state.panelEl.querySelector('.bilingual-yt-download-hint').textContent = state.downloadMessage
    || [t(original ? 'ytDownloadOriginalHint' : 'ytDownloadHint'), partial ? t('ytDownloadPartialHint') : ''].filter(Boolean).join(' ');
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
  const pw = panel.offsetWidth || 344;
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
  // 仅原文下载与模型和目标语言无关，切换翻译设置时继续获取字幕。
  if (state.downloadJob?.content !== 'original') cancelSubtitleDownload();
  const previous = state.cache.get(state.videoId);
  state.cache.clear();
  if (!state.videoId || !previous) return;

  if (previous.mode === 'cues') {
    putCache(state.videoId, {
      mode: 'cues',
      cues: previous.cues,
      translations: new Map(),
      batchState: new Map()
    });
    const currentTime = state.videoEl?.currentTime;
    if (state.active && typeof currentTime === 'number') renderCurrentCue(currentTime);
    return;
  }

  putCache(state.videoId, {
    mode: 'dom',
    cues: previous.cues || [],
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
  if (entry.batchState.get(curBatch) !== 'error') ensureBatch(entry, curBatch, total).catch(() => {});
  const lastInBatch = curBatch * BATCH_SIZE + BATCH_SIZE - 1;
  if (lastInBatch - currentIdx <= PRELOAD_AHEAD) {
    if (entry.batchState.get(curBatch + 1) !== 'error') ensureBatch(entry, curBatch + 1, total).catch(() => {});
  }
}

function ensureBatch(entry, batchId, total = entry.cues.length) {
  const start = batchId * BATCH_SIZE;
  if (start >= total || entry.batchState.get(batchId) === 'done') return Promise.resolve();
  entry.batchRequests ||= new Map();
  if (entry.batchRequests.has(batchId)) return entry.batchRequests.get(batchId);
  entry.batchState.set(batchId, 'loading');

  const end = Math.min(start + BATCH_SIZE, total);
  const translations = entry.translations.get(batchId)?.slice() || new Array(end - start).fill('');
  const missing = Array.from({ length: end - start }, (_, i) => i).filter(i => !translations[i]);
  const texts = missing.map(i => entry.cues[start + i].text);

  const request = sendTranslateRequest(texts, entry, partial => {
    missing.forEach((index, i) => { if (partial[i]) translations[index] = partial[i]; });
    entry.translations.set(batchId, translations.slice());
    const time = state.videoEl?.currentTime;
    if (state.active && state.cache.get(state.videoId) === entry && typeof time === 'number') renderCurrentCue(time);
  }).then(() => {
    entry.batchState.set(batchId, 'done');
    const time = state.videoEl?.currentTime;
    if (state.active && state.cache.get(state.videoId) === entry && typeof time === 'number') renderCurrentCue(time);
  }).catch(err => {
    console.error('[双语翻译] 批次错误:', err.message);
    entry.batchState.set(batchId, 'error');
    setTimeout(() => {
      if (entry.batchState.get(batchId) === 'error') entry.batchState.delete(batchId);
    }, 5000);
    throw err;
  }).finally(() => entry.batchRequests.delete(batchId));
  entry.batchRequests.set(batchId, request);
  return request;
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
  state.domCurrentCue = null;
  state.domLastTime = null;
}

function onCaptionChanged() {
  const text = getCurrentNativeText();
  recordDomCue(text);
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

// DOM 兜底没有完整轨道，记录实际展示的文本和视频时间，保留重复台词。
function recordDomCue(text) {
  const entry = state.cache.get(state.videoId);
  const time = getVideoEl()?.currentTime;
  if (entry?.mode !== 'dom' || !Number.isFinite(time)) return;
  recordNativeCue(entry, text, time, state);
}

function recordNativeCue(entry, text, time, tracker) {
  entry.cues ||= [];
  const jumped = tracker.domLastTime !== null && (time < tracker.domLastTime || time - tracker.domLastTime > 1.5);
  const current = tracker.domCurrentCue;
  if (current && !jumped) current.end = Math.max(current.end, time);
  if (jumped || current?.text !== text) {
    tracker.domCurrentCue = text ? { start: time, end: time, text } : null;
    if (tracker.domCurrentCue) entry.cues.push(tracker.domCurrentCue);
    refreshDownloadState();
  }
  tracker.domLastTime = time;
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

  try {
    await ensureDomTranslations(entry, batch);
  } catch (err) {
    console.warn('[双语翻译] DOM 批次翻译失败:', err.message);
  }
}

async function ensureDomTranslations(entry, texts) {
  const waiting = [...new Set(texts.map(text => entry.pending.get(text)).filter(Boolean))];
  const missing = [...new Set(texts)].filter(text => !entry.textTranslations.get(text) && !entry.pending.has(text));
  if (missing.length) {
    const request = sendTranslateRequest(missing, entry, partial => {
      missing.forEach((text, i) => { if (partial[i]) entry.textTranslations.set(text, partial[i]); });
      if (state.active && state.cache.get(state.videoId) === entry && state.lastSourceText) renderDomMode(state.lastSourceText);
    }).then(() => {
      if (state.active && state.cache.get(state.videoId) === entry && state.lastSourceText) renderDomMode(state.lastSourceText);
    }).finally(() => missing.forEach(text => entry.pending.delete(text)));
    missing.forEach(text => entry.pending.set(text, request));
    waiting.push(request);
  }
  await Promise.all(waiting);
}

// ============================================================
// 翻译请求（共享）
// ============================================================
async function sendTranslateRequest(texts, entry, onProgress) {
  const context = { videoId: state.videoId, provider: state.provider, targetLang: state.targetLang, entry };
  const assertCurrent = () => {
    if (state.navigating || state.videoId !== context.videoId || currentVideoId() !== context.videoId
      || state.provider !== context.provider || state.targetLang !== context.targetLang
      || state.cache.get(context.videoId) !== entry) throw new Error(t('ytDownloadCancelled'));
  };
  const translations = new Array(texts.length).fill('');
  // 最多三轮：原批次 → 每组最多 5 条 → 单条。只重试缺项，成功项不重新生成。
  const sizes = [Math.max(1, texts.length), 5, 1];
  for (const [round, size] of sizes.entries()) {
    const missing = texts.map((_, i) => i).filter(i => !translations[i]);
    if (!missing.length) return translations;
    assertCurrent();
    if (round > 0 && state.downloadJob?.entry === entry) {
      state.downloadMessage = `${t('ytDownloadRepairing')} ${missing.length}/${texts.length}`;
      refreshDownloadState();
    }
    for (let start = 0; start < missing.length; start += size) {
      assertCurrent();
      const indices = missing.slice(start, start + size);
      const partial = await sendTranslationAttempt(indices.map(i => texts[i]), context);
      assertCurrent();
      indices.forEach((index, i) => {
        if (typeof partial[i] === 'string' && partial[i].trim()) translations[index] = partial[i];
      });
      onProgress?.(translations);
    }
  }
  const missingCount = translations.filter(text => !text).length;
  if (missingCount) throw new Error(`${t('ytTranslationIncomplete')} (${missingCount}/${texts.length})`);
  return translations;
}

function sendTranslationAttempt(texts, context) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, translations) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (error) reject(error);
      else resolve(translations);
    };
    const timeout = setTimeout(() => finish(new Error(t('ytTranslationTimeout'))), 120000);
    const heartbeat = setInterval(() => {
      try { chrome.runtime.sendMessage({ action: 'keepAlive' }, () => { void chrome.runtime.lastError; }); } catch {}
    }, 20000);
    try {
      chrome.runtime.sendMessage(
        { action: 'translate', texts, provider: context.provider, targetLang: context.targetLang },
        resp => {
          if (chrome.runtime.lastError) return finish(new Error(chrome.runtime.lastError.message));
          if (resp?.error) return finish(new Error(resp.error));
          const translations = resp?.translations;
          // 缺项保留原索引；过多的返回项无法可靠对齐，不按位置写入缓存。
          finish(null, Array.isArray(translations) && translations.length <= texts.length ? translations : []);
        }
      );
    } catch (err) { finish(err); }
  });
}

// ============================================================
// 下载：与实时字幕共用分句、批次和译文缓存
// ============================================================
function cancelSubtitleDownload() {
  state.downloadJob = null;
  state.downloadMessage = '';
  refreshDownloadState();
}

function assertDownloadCurrent(job) {
  if (state.downloadJob !== job || state.navigating || state.videoId !== job.videoId
    || currentVideoId() !== job.videoId || (job.content !== 'original' && (state.provider !== job.provider
      || state.targetLang !== job.targetLang || (job.entry && state.cache.get(job.videoId) !== job.entry)))) {
    throw new Error(t('ytDownloadCancelled'));
  }
}

async function getDownloadEntry(job) {
  let entry = state.cache.get(job.videoId);
  if (entry?.cues?.length) return entry;
  const track = state.pickedTrack;
  const stopCapture = collectDownloadCaptions(job);
  try {
    const response = await fetchCaptionsViaBridge(track?.baseUrl, true);
    assertDownloadCurrent(job);
    entry = state.cache.get(job.videoId);
    if (entry?.mode === 'cues' && entry.cues.length) return entry;
    if (response.ok) {
      onCapturedCaptions(job.videoId, response.url || track?.baseUrl, response.text);
      entry = state.cache.get(job.videoId);
      if (entry?.mode === 'cues' && entry.cues.length) return entry;
    }
    // 原生 DOM 字幕由下载流程独立收集，无需先开启观看翻译。
    if (entry?.mode === 'dom' && entry.cues?.length) return entry;
    const httpStatus = response.error?.match(/^caption-http-(\d+)$/)?.[1];
    if (httpStatus) throw new Error(`${t('ytDownloadFetchFailed')} (HTTP ${httpStatus})`);
    if (response.error === 'timeout' || response.error === 'caption-timeout') throw new Error(t('ytDownloadCaptionTimeout'));
    throw new Error(t('ytDownloadNoData'));
  } finally { stopCapture(); }
}

function collectDownloadCaptions(job) {
  let entry = null;
  const tracker = { domCurrentCue: null, domLastTime: null };
  const sample = () => {
    if (state.downloadJob !== job || state.navigating || state.active || state.videoId !== job.videoId || currentVideoId() !== job.videoId) return;
    const current = state.cache.get(job.videoId);
    if (current?.mode === 'cues') return;
    const text = getCurrentNativeText();
    const time = getVideoEl()?.currentTime;
    if (!Number.isFinite(time) || (!text && !tracker.domCurrentCue)) return;
    if (entry !== current) {
      tracker.domCurrentCue = null;
      tracker.domLastTime = null;
    }
    entry = current || { mode: 'dom', cues: [], textTranslations: new Map(), pending: new Map() };
    if (!current) putCache(job.videoId, entry);
    recordNativeCue(entry, text, time, tracker);
  };
  const observer = new MutationObserver(sample);
  const player = document.querySelector('#movie_player');
  if (player) observer.observe(player, { childList: true, subtree: true, characterData: true });
  const timer = setInterval(sample, 250);
  sample();
  return () => {
    sample();
    observer.disconnect();
    clearInterval(timer);
  };
}

function formatSrtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

function buildSubtitleSrt(cues, translations, holdTail = false) {
  const clean = text => text.replace(/\r\n?/g, '\n').replace(/\n\s*\n/g, '\n').trim();
  return cues.map((cue, index) => {
    const end = getSubtitleEnd(cues, index, holdTail);
    const text = translations ? `${clean(cue.text)}\n${clean(translations[index])}` : clean(cue.text);
    return `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(end)}\n${text}\n`;
  }).join('\n');
}

function getSubtitleEnd(cues, index, holdTail) {
  // 实时模式保留 0.3 秒尾帧；下一句开始后立即换句，两种格式沿用此规则。
  const cue = cues[index];
  const nextStart = cues[index + 1]?.start ?? Infinity;
  return Math.max(cue.start + 0.001, Math.min(cue.end + (holdTail ? 0.3 : 0), nextStart));
}

function getSubtitleTitle(videoId) {
  return (document.querySelector('h1.ytd-watch-metadata')?.textContent || document.title || videoId).trim();
}

function buildSubtitleMarkdown(cues, translations, job, partial) {
  // 按纯文本导出，避免字幕中的 Markdown 或 HTML 被误渲染成标题、链接等。
  const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+\-.!|~]/g, '\\$&');
  const paragraph = text => text.replace(/\r\n?/g, '\n').trim().split('\n').map(escape).join('  \n');
  const time = seconds => formatSrtTime(seconds).replace(',', '.');
  const videoUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(job.videoId)}`;
  const header = `# ${paragraph(getSubtitleTitle(job.videoId))}\n\n[${t('ytDownloadVideoLink')}](${videoUrl})\n\n`;
  const scope = partial ? `> ${t('ytDownloadPartialHint')}\n\n` : '';
  return header + scope + cues.map((cue, index) => {
    const end = getSubtitleEnd(cues, index, !partial);
    const link = `${videoUrl}&t=${Math.floor(cue.start)}s`;
    const text = translations ? `${paragraph(cue.text)}\n\n${paragraph(translations[index])}` : paragraph(cue.text);
    return `## [${time(cue.start)} – ${time(end)}](${link})\n\n${text}\n`;
  }).join('\n---\n\n');
}

function saveSubtitleFile(content, job, partial) {
  const title = getSubtitleTitle(job.videoId);
  const safe = value => value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[.\s]+$/g, '').slice(0, 100) || 'YouTube';
  const original = job.content === 'original';
  const language = original ? job.sourceLang : job.targetLang;
  const filename = `${safe(title)}.${safe(job.videoId)}.${language ? `${safe(language)}.` : ''}${partial ? 'watched.' : ''}${original ? 'original' : 'bilingual'}.${job.format}`;
  const markdown = job.format === 'md';
  const url = URL.createObjectURL(new Blob([markdown ? '' : '\uFEFF', content], {
    type: markdown ? 'text/markdown;charset=utf-8' : 'application/x-subrip;charset=utf-8'
  }));
  const link = document.createElement('a');
  link.hidden = true;
  link.href = url;
  link.download = filename;
  // 合成点击也会触发面板外点击检测，放进面板以保留下载进度和结果提示。
  (state.panelEl || document.body).appendChild(link);
  try { link.click(); }
  finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function downloadSubtitles() {
  if (state.downloadJob || !state.videoId || !hasCaptionSource()) return;
  const job = {
    videoId: state.videoId, provider: state.provider, targetLang: state.targetLang,
    format: state.downloadFormat === 'md' ? 'md' : 'srt',
    content: state.downloadContent === 'original' ? 'original' : 'bilingual', entry: null
  };
  state.downloadJob = job;
  state.downloadMessage = t('ytDownloadPreparing');
  refreshDownloadState();
  try {
    const entry = await getDownloadEntry(job);
    assertDownloadCurrent(job);
    job.entry = entry;
    job.sourceLang = state.pickedTrack?.languageCode || '';
    // 下载期间播放继续推进，DOM 导出范围固定为点击时已记录的字幕。
    const cues = entry.cues.map(cue => ({ ...cue })).filter(cue => Number.isFinite(cue.start)
      && Number.isFinite(cue.end) && cue.start >= 0 && cue.end >= cue.start && cue.text);
    if (!cues.length) throw new Error(t('ytDownloadNoData'));
    // 完整轨道的索引必须与实时翻译缓存严格对齐。
    if (entry.mode === 'cues' && cues.length !== entry.cues.length) throw new Error(t('ytDownloadInvalidData'));
    if (entry.mode === 'dom') cues.sort((a, b) => a.start - b.start || a.end - b.end);
    const original = job.content === 'original';
    for (let start = 0; !original && start < cues.length; start += BATCH_SIZE) {
      assertDownloadCurrent(job);
      if (entry.mode === 'cues') await ensureBatch(entry, start / BATCH_SIZE);
      else await ensureDomTranslations(entry, cues.slice(start, start + BATCH_SIZE).map(cue => cue.text));
      assertDownloadCurrent(job);
      state.downloadMessage = `${t('ytDownloadPreparing')} ${Math.min(start + BATCH_SIZE, cues.length)}/${cues.length}`;
      refreshDownloadState();
    }
    const translations = original ? null : cues.map((cue, i) => entry.mode === 'cues'
      ? entry.translations.get(Math.floor(i / BATCH_SIZE))?.[i % BATCH_SIZE] : entry.textTranslations.get(cue.text));
    if (translations?.some(text => typeof text !== 'string' || !text.trim())) throw new Error(t('ytTranslationIncomplete'));
    assertDownloadCurrent(job);
    const partial = entry.mode === 'dom';
    const content = job.format === 'md' ? buildSubtitleMarkdown(cues, translations, job, partial)
      : buildSubtitleSrt(cues, translations, !partial);
    saveSubtitleFile(content, job, partial);
    state.downloadMessage = t(partial ? 'ytDownloadPartialComplete' : original ? 'ytDownloadOriginalComplete' : 'ytDownloadComplete');
  } catch (err) {
    if (state.downloadJob === job) state.downloadMessage = `${t('ytDownloadFailed')} ${err.message}`;
  } finally {
    if (state.downloadJob === job) {
      state.downloadJob = null;
      refreshDownloadState();
    }
  }
}

// ============================================================
// SPA 导航
// ============================================================
function resetVideoContext(videoId) {
  cancelSubtitleDownload();
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
  const modelSelect = state.panelEl?.querySelector('.bilingual-yt-provider-select');
  if (modelSelect && modelSelect.value !== nextProvider) modelSelect.value = nextProvider;
  resetTranslationCache();
});

// ============================================================
// 初始化
// ============================================================
ensureControlsObserver();
mountIconButton();
requestTracks();
