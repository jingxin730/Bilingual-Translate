'use strict';

const STORAGE_KEYS = { provider: 'claude', targetLang: 'zh' };

// DOM 引用
const translateBtn = document.getElementById('translateBtn');
const btnLabel = document.getElementById('btnLabel');
const providerSelect = document.getElementById('providerSelect');
const targetLangSelect = document.getElementById('targetLang');
const toggleBtn = document.getElementById('toggleBtn');
const toggleLabel = document.getElementById('toggleLabel');
const clearBtn = document.getElementById('clearBtn');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const statusMsg = document.getElementById('statusMsg');

let currentTab = null;
let pollingTimer = null;
let translationVisible = true;
let isTranslating = false; // 本地标志，控制按钮行为

async function getTab() {
  if (currentTab) return currentTab;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  return tab;
}

async function sendToContent(msg) {
  const tab = await getTab();
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tab.id, msg, resp => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

function showStatus(text, type = '') {
  statusMsg.textContent = text;
  statusMsg.className = 'status-msg' + (type ? ` ${type}` : '');
}

function setProgress(done, total) {
  if (!total) {
    progressWrap.classList.add('hidden');
    return;
  }
  progressWrap.classList.remove('hidden');
  const pct = Math.round((done / total) * 100);
  progressBar.style.setProperty('--pct', `${pct}%`);
  progressText.textContent = `${done} / ${total}`;
}

function setTranslatingUI(on) {
  isTranslating = on;
  if (on) {
    translateBtn.disabled = false;
    translateBtn.classList.add('translate-btn-stop');
    btnLabel.textContent = '停止翻译';
  } else {
    translateBtn.classList.remove('translate-btn-stop');
  }
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

function startPolling() {
  stopPolling();
  pollingTimer = setInterval(async () => {
    const status = await sendToContent({ action: 'getStatus' });
    if (!status) { stopPolling(); return; }

    setProgress(status.done, status.total);

    if (!status.translating) {
      stopPolling();
      setTranslatingUI(false);
      translateBtn.disabled = false;
      progressWrap.classList.add('hidden');

      if (status.stopped) {
        showStatus(`已停止，保留了前 ${status.done} 段译文`, 'success');
        btnLabel.textContent = '继续翻译';
      } else if (status.error) {
        showStatus(`翻译出错: ${status.error}`, 'error');
        btnLabel.textContent = '重新翻译';
      } else if (status.translated) {
        showStatus(`已翻译 ${status.total} 个段落`, 'success');
        btnLabel.textContent = '重新翻译';
      }
    }
  }, 600);
}

// 翻译/停止 按钮
translateBtn.addEventListener('click', async () => {
  if (isTranslating) {
    // 停止翻译
    await sendToContent({ action: 'stopTranslation' });
    setTranslatingUI(false);
    stopPolling();
    const status = await sendToContent({ action: 'getStatus' });
    progressWrap.classList.add('hidden');
    showStatus(`已停止，保留了前 ${status?.done ?? 0} 段译文`, 'success');
    btnLabel.textContent = '继续翻译';
    return;
  }

  // 开始翻译
  const provider = providerSelect.value;
  const targetLang = targetLangSelect.value;
  chrome.storage.local.set({ provider, targetLang });

  setTranslatingUI(true);
  showStatus('');
  setProgress(0, 0);
  progressWrap.classList.remove('hidden');
  progressBar.style.setProperty('--pct', '0%');
  progressText.textContent = '0 / ?';

  // 如果已翻译，先清除再重新翻译
  const status = await sendToContent({ action: 'getStatus' });
  if (status?.translated || status?.stopped) {
    await sendToContent({ action: 'clear' });
  }

  sendToContent({ action: 'translatePage', provider, targetLang })
    .then(resp => {
      if (resp === null) {
        setTranslatingUI(false);
        translateBtn.disabled = false;
        btnLabel.textContent = '翻译';
        showStatus('无法连接到页面，请刷新后重试', 'error');
        stopPolling();
        progressWrap.classList.add('hidden');
      }
    });

  startPolling();
});

// 切换译文显示/隐藏
toggleBtn.addEventListener('click', async () => {
  translationVisible = !translationVisible;
  await sendToContent({ action: 'toggleVisibility', visible: translationVisible });
  toggleLabel.textContent = translationVisible ? '隐藏译文' : '显示译文';
});

// 清除翻译
clearBtn.addEventListener('click', async () => {
  stopPolling();
  await sendToContent({ action: 'stopTranslation' });
  await sendToContent({ action: 'clear' });
  setTranslatingUI(false);
  translateBtn.disabled = false;
  btnLabel.textContent = '翻译';
  translationVisible = true;
  toggleLabel.textContent = '隐藏译文';
  progressWrap.classList.add('hidden');
  showStatus('');
});

// 初始化：读取存储的偏好并同步页面状态
async function init() {
  const saved = await chrome.storage.local.get(['provider', 'targetLang']);
  if (saved.provider) providerSelect.value = saved.provider;
  if (saved.targetLang) targetLangSelect.value = saved.targetLang;

  const status = await sendToContent({ action: 'getStatus' });
  if (status?.translating) {
    setTranslatingUI(true);
    startPolling();
  } else if (status?.stopped) {
    btnLabel.textContent = '继续翻译';
    showStatus(`已停止，保留了前 ${status.done} 段译文`, 'success');
    translationVisible = status.visible;
    toggleLabel.textContent = translationVisible ? '隐藏译文' : '显示译文';
  } else if (status?.translated) {
    btnLabel.textContent = '重新翻译';
    showStatus(`已翻译 ${status.total} 个段落`, 'success');
    translationVisible = status.visible;
    toggleLabel.textContent = translationVisible ? '隐藏译文' : '显示译文';
  }
}

init();

