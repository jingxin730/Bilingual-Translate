'use strict';

// MAIN world：在 YouTube 自己的脚本之前 hook 网络请求，截获 timedtext 响应。
// 这样无需自己 fetch（PoToken 签名问题）— 直接利用 YouTube 自己已经成功的请求。
(function () {
  // ========== 网络拦截（必须最早执行）==========
  function notifyCaption(url, text) {
    if (!text || text.length < 30) return;
    window.postMessage({
      source: 'bilingual-yt-bridge',
      type: 'capturedCaptions',
      url,
      text
    }, '*');
  }

  // Hook fetch
  const _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input?.url || '';
      const p = _fetch.apply(this, arguments);
      if (url.includes('/api/timedtext')) {
        p.then(resp => {
          if (!resp || !resp.ok) return;
          resp.clone().text().then(text => notifyCaption(url, text)).catch(() => {});
        }).catch(() => {});
      }
      return p;
    };
  }

  // Hook XHR
  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__biCapture = typeof url === 'string' && url.includes('/api/timedtext');
    this.__biUrl = url;
    return _xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__biCapture) {
      this.addEventListener('load', () => {
        if (this.status >= 200 && this.status < 300) notifyCaption(this.__biUrl, this.responseText);
      });
    }
    return _xhrSend.apply(this, arguments);
  };

  // ========== 原有功能 ==========
  function currentVideoId() {
    const url = new URL(location.href);
    return url.searchParams.get('v') || (location.pathname.startsWith('/shorts/') ? location.pathname.split('/')[2] : null);
  }

  function readTracks() {
    const r = window.ytInitialPlayerResponse;
    const tracks = r?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks)) return [];
    return tracks.map(t => ({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode,
      name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
      kind: t.kind || ''
    }));
  }

  function sendTracks() {
    window.postMessage({
      source: 'bilingual-yt-bridge',
      type: 'tracks',
      videoId: currentVideoId(),
      tracks: readTracks()
    }, '*');
  }

  function enableNativeCaptions(lang) {
    const player = document.getElementById('movie_player');
    if (!player) return;
    try {
      player.loadModule?.('captions');
      setTimeout(() => {
        try {
          const tracklist = player.getOption?.('captions', 'tracklist');
          if (Array.isArray(tracklist) && tracklist.length) {
            const track = tracklist.find(t => t.languageCode === lang) || tracklist[0];
            player.setOption?.('captions', 'track', track);
            console.log('[bilingual-yt-bridge] setOption track ok');
          }
        } catch {}
      }, 200);
    } catch {}
    setTimeout(() => {
      if (document.querySelector('.ytp-caption-segment')) return;
      const btn = document.querySelector('.ytp-subtitles-button');
      if (btn && btn.getAttribute('aria-pressed') !== 'true') {
        console.log('[bilingual-yt-bridge] 兜底：点击 CC 按钮');
        btn.click();
      }
    }, 800);
  }

  let tries = 0;
  const timer = setInterval(() => {
    if (window.ytInitialPlayerResponse || tries++ > 20) {
      clearInterval(timer);
      sendTracks();
    }
  }, 100);

  window.addEventListener('yt-navigate-finish', () => setTimeout(sendTracks, 100));

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'bilingual-yt-iso') return;
    const d = e.data;
    if (d.type === 'requestTracks') sendTracks();
    if (d.type === 'enableCaptions') enableNativeCaptions(d.languageCode);
  });
})();
