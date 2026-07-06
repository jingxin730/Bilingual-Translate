'use strict';

// ── i18n helpers ──────────────────────────────────────────
const t = (key, ...subs) => {
  let msg = chrome.i18n.getMessage(key) || key;
  subs.forEach((s, i) => { msg = msg.replace(`$${i + 1}`, s); });
  return msg;
};

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
}

// ── DOM refs ──────────────────────────────────────────────
const translateBtn    = document.getElementById('translateBtn');
const btnLabel        = document.getElementById('btnLabel');
const providerSelect  = document.getElementById('providerSelect');
const targetLangSelect = document.getElementById('targetLang');
const toggleBtn       = document.getElementById('toggleBtn');
const toggleLabel     = document.getElementById('toggleLabel');
const clearBtn        = document.getElementById('clearBtn');
const progressWrap    = document.getElementById('progressWrap');
const progressBar     = document.getElementById('progressBar');
const progressText    = document.getElementById('progressText');
const statusMsg       = document.getElementById('statusMsg');

let currentTab = null;
let pollingTimer = null;
let translationVisible = true;
let isTranslating = false;

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
  if (!total) { progressWrap.classList.add('hidden'); return; }
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
    btnLabel.textContent = t('stopTranslation');
  } else {
    translateBtn.classList.remove('translate-btn-stop');
  }
}

function stopPolling() {
  if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
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
        showStatus(t('stopped', status.done), 'success');
        btnLabel.textContent = t('resumeTranslation');
      } else if (status.error) {
        showStatus(t('errorPrefix') + status.error, 'error');
        btnLabel.textContent = t('retranslate');
      } else if (status.translated) {
        showStatus(t('translated', status.total), 'success');
        btnLabel.textContent = t('retranslate');
      }
    }
  }, 600);
}

translateBtn.addEventListener('click', async () => {
  if (isTranslating) {
    await sendToContent({ action: 'stopTranslation' });
    setTranslatingUI(false);
    stopPolling();
    const status = await sendToContent({ action: 'getStatus' });
    progressWrap.classList.add('hidden');
    showStatus(t('stopped', status?.done ?? 0), 'success');
    btnLabel.textContent = t('resumeTranslation');
    return;
  }

  const provider = providerSelect.value;
  const targetLang = targetLangSelect.value;
  chrome.storage.local.set({ provider, targetLang });

  setTranslatingUI(true);
  showStatus('');
  setProgress(0, 0);
  progressWrap.classList.remove('hidden');
  progressBar.style.setProperty('--pct', '0%');
  progressText.textContent = '0 / ?';

  const status = await sendToContent({ action: 'getStatus' });
  if (status?.translated || status?.stopped) await sendToContent({ action: 'clear' });

  sendToContent({ action: 'translatePage', provider, targetLang }).then(resp => {
    if (resp === null) {
      setTranslatingUI(false);
      translateBtn.disabled = false;
      btnLabel.textContent = t('translate');
      showStatus(t('noConnection'), 'error');
      stopPolling();
      progressWrap.classList.add('hidden');
    }
  });

  startPolling();
});

toggleBtn.addEventListener('click', async () => {
  translationVisible = !translationVisible;
  await sendToContent({ action: 'toggleVisibility', visible: translationVisible });
  toggleLabel.textContent = t(translationVisible ? 'hideTranslation' : 'showTranslation');
});

clearBtn.addEventListener('click', async () => {
  stopPolling();
  await sendToContent({ action: 'stopTranslation' });
  await sendToContent({ action: 'clear' });
  setTranslatingUI(false);
  translateBtn.disabled = false;
  btnLabel.textContent = t('translate');
  translationVisible = true;
  toggleLabel.textContent = t('hideTranslation');
  progressWrap.classList.add('hidden');
  showStatus('');
});

async function init() {
  applyI18n();
  const saved = await chrome.storage.local.get(['provider', 'targetLang']);
  if (saved.provider) providerSelect.value = saved.provider;
  if (saved.targetLang) targetLangSelect.value = saved.targetLang;

  const status = await sendToContent({ action: 'getStatus' });
  if (status?.translating) {
    setTranslatingUI(true);
    startPolling();
  } else if (status?.stopped) {
    btnLabel.textContent = t('resumeTranslation');
    showStatus(t('stopped', status.done), 'success');
    translationVisible = status.visible;
    toggleLabel.textContent = t(translationVisible ? 'hideTranslation' : 'showTranslation');
  } else if (status?.translated) {
    btnLabel.textContent = t('retranslate');
    showStatus(t('translated', status.total), 'success');
    translationVisible = status.visible;
    toggleLabel.textContent = t(translationVisible ? 'hideTranslation' : 'showTranslation');
  }
}

init();
