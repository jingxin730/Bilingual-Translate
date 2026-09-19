'use strict';

// MAIN world：只截获 YouTube 自己的字幕请求，沿用播放器的认证和签名。
(function () {
  const DISCOVERY_INTERVAL_MS = 300;
  const DISCOVERY_ATTEMPTS = 34;
  const captured = new Map();
  let discoveryTimer = null;
  let discoveryGeneration = 0;
  let enableGeneration = 0;
  let lastTracksSignature = '';

  function currentVideoId() {
    const url = new URL(location.href);
    return url.searchParams.get('v') || (url.pathname.startsWith('/shorts/') ? url.pathname.split('/')[2] : null);
  }

  function post(message) {
    window.postMessage({ source: 'bilingual-yt-bridge', ...message }, '*');
  }

  function captionUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (!['https:', 'http:'].includes(url.protocol)) return null;
      if (url.hostname !== 'youtube.com' && !url.hostname.endsWith('.youtube.com')) return null;
      return url.pathname === '/api/timedtext' ? url : null;
    } catch { return null; }
  }

  function notifyCaption(url, text, requestVideoId) {
    const parsed = captionUrl(url);
    const videoId = parsed?.searchParams.get('v') || requestVideoId;
    if (!parsed || !videoId || videoId !== requestVideoId || videoId !== currentVideoId()) return;
    if (typeof text !== 'string' || text.length < 30) return;
    const result = { type: 'capturedCaptions', videoId, url: parsed.href, text };
    captured.set(parsed.href, result);
    while (captured.size > 8) captured.delete(captured.keys().next().value);
    post(result);
  }

  // 在请求发起时记录视频，避免旧视频的延迟响应污染 SPA 导航后的状态。
  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (input) {
      const url = captionUrl(typeof input === 'string' ? input : input?.url || input?.href);
      const videoId = currentVideoId();
      const promise = originalFetch.apply(this, arguments);
      if (url) {
        promise.then(response => {
          if (!response?.ok) return;
          return response.clone().text().then(text => notifyCaption(url.href, text, videoId));
        }).catch(() => {});
      }
      return promise;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__biCaptionUrl = captionUrl(url)?.href || null;
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__biCaptionUrl;
    const videoId = currentVideoId();
    if (url) {
      this.addEventListener('load', () => {
        if (this.status < 200 || this.status >= 300) return;
        try {
          const text = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
          notifyCaption(url, text, videoId);
        } catch {}
      }, { once: true });
    }
    return originalSend.apply(this, arguments);
  };

  function normalizeTracks(tracks) {
    if (!Array.isArray(tracks)) return [];
    return tracks.filter(track => track && typeof track.languageCode === 'string').map(track => {
      const label = track.name || track.languageName;
      return {
        baseUrl: typeof track.baseUrl === 'string' ? track.baseUrl : '',
        languageCode: track.languageCode,
        name: typeof label === 'string' ? label : label?.simpleText || label?.runs?.map(run => run.text || '').join('') || track.languageCode,
        kind: track.kind || ''
      };
    });
  }

  function readTracks(videoId) {
    if (!videoId) return { tracks: [], nativeAvailable: false };
    const player = document.getElementById('movie_player');
    let playerVideoId = null;
    let response = null;
    try { playerVideoId = player?.getVideoData?.()?.video_id; } catch {}
    try { response = player?.getPlayerResponse?.(); } catch {}
    const responseId = response?.videoDetails?.videoId;
    // getPlayerResponse 在站内切换后会更新；initial response 常常仍属于上一个视频。
    if (responseId !== videoId && !(response && !responseId && playerVideoId === videoId)) response = null;
    const initial = window.ytInitialPlayerResponse;
    const sources = [response, initial?.videoDetails?.videoId === videoId ? initial : null];
    for (const source of sources) {
      const tracks = normalizeTracks(source?.captions?.playerCaptionsTracklistRenderer?.captionTracks);
      if (tracks.length) return { tracks, nativeAvailable: true };
    }
    if ((playerVideoId || responseId) !== videoId) return { tracks: [], nativeAvailable: false };
    try {
      // 某些播放器响应没有 captions，但已加载的字幕模块仍有轨道。
      const tracks = normalizeTracks(player?.getOption?.('captions', 'tracklist'));
      if (tracks.length) return { tracks, nativeAvailable: true };
    } catch {}
    const cc = player?.querySelector?.('.ytp-subtitles-button');
    const nativeAvailable = !!cc && !cc.disabled && cc.getAttribute('aria-disabled') !== 'true' &&
      !cc.hidden && cc.style?.display !== 'none';
    return { tracks: [], nativeAvailable };
  }

  function discoverTracks(videoId = currentVideoId()) {
    if (videoId !== currentVideoId()) return;
    clearTimeout(discoveryTimer);
    const generation = ++discoveryGeneration;
    let attempt = 0;
    // 每个 requestTracks 都至少回应一次，晚注入的 isolated script 也能收到已有结果。
    lastTracksSignature = '';
    function poll() {
      if (generation !== discoveryGeneration || videoId !== currentVideoId()) return;
      const data = readTracks(videoId);
      const status = data.tracks.length ? 'ready' : !videoId || ++attempt >= DISCOVERY_ATTEMPTS ? 'unavailable' : 'loading';
      const message = { type: 'tracks', videoId, ...data, status };
      const signature = JSON.stringify(message);
      if (signature !== lastTracksSignature) {
        lastTracksSignature = signature;
        post(message);
      }
      if (status === 'loading') discoveryTimer = setTimeout(poll, DISCOVERY_INTERVAL_MS);
    }
    poll();
  }

  function enableNativeCaptions(lang, videoId) {
    const generation = ++enableGeneration;
    const player = document.getElementById('movie_player');
    if (!player || !videoId || videoId !== currentVideoId()) return;
    const isCurrent = () => {
      if (generation !== enableGeneration || videoId !== currentVideoId() || player !== document.getElementById('movie_player')) return false;
      try {
        const playerVideoId = player.getVideoData?.()?.video_id;
        if (playerVideoId && playerVideoId !== videoId) return false;
      } catch {}
      return true;
    };
    if (!isCurrent()) return;
    try { player.loadModule?.('captions'); } catch {}
    let attempt = 0;
    function selectTrack() {
      if (!isCurrent()) return;
      try {
        const tracks = player.getOption?.('captions', 'tracklist');
        if (Array.isArray(tracks) && tracks.length) {
          const track = tracks.find(item => item.languageCode === lang) || tracks[0];
          player.setOption?.('captions', 'track', track);
          discoverTracks(videoId);
          return;
        }
      } catch {}
      if (++attempt < 10) setTimeout(selectTrack, 200);
    }
    setTimeout(selectTrack, 200);
    setTimeout(() => {
      if (!isCurrent() || player.querySelector?.('.ytp-caption-segment')) return;
      const button = player.querySelector?.('.ytp-subtitles-button');
      if (button && button.getAttribute('aria-pressed') !== 'true' && button.getAttribute('aria-disabled') !== 'true' && !button.disabled) {
        button.click();
      }
    }, 800);
  }

  function replyCaptured(d) {
    const videoId = d.videoId || currentVideoId();
    if (!videoId || videoId !== currentVideoId()) {
      post({ type: 'captionsResult', requestId: d.requestId, videoId, ok: false, error: 'stale-video' });
      return;
    }
    const requested = d.baseUrl ? captionUrl(d.baseUrl) : null;
    if (d.baseUrl && (!requested || (requested.searchParams.get('v') && requested.searchParams.get('v') !== videoId))) {
      post({ type: 'captionsResult', requestId: d.requestId, videoId, ok: false, error: 'invalid-caption-url' });
      return;
    }
    const language = d.languageCode || requested?.searchParams.get('lang');
    const result = [...captured.values()].reverse().find(item => {
      if (item.videoId !== videoId) return false;
      const url = new URL(item.url);
      if (language && url.searchParams.get('lang') !== language) return false;
      // 同语言的人工、ASR 和已翻译轨道不能互相冒充。
      return ['kind', 'name', 'tlang'].every(key => (url.searchParams.get(key) || '') === (requested?.searchParams.get(key) || ''));
    });
    post(result
      ? { type: 'captionsResult', requestId: d.requestId, videoId, ok: true, text: result.text, url: result.url, label: 'captured' }
      : { type: 'captionsResult', requestId: d.requestId, videoId, ok: false, error: 'not-captured' });
  }

  window.addEventListener('yt-navigate-start', () => {
    ++discoveryGeneration;
    ++enableGeneration;
    clearTimeout(discoveryTimer);
    captured.clear();
  });
  window.addEventListener('yt-navigate-finish', () => discoverTracks());
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.source !== 'bilingual-yt-iso') return;
    const d = event.data;
    if (d.type === 'requestTracks') discoverTracks(d.videoId || currentVideoId());
    if (d.type === 'enableCaptions') enableNativeCaptions(d.languageCode, d.videoId || currentVideoId());
    // 不对页面消息传入的 URL 发网络请求；缓存未命中就立即启用原生字幕兜底。
    if (d.type === 'fetchCaptions') replyCaptured(d);
  });
  discoverTracks();
})();
