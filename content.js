'use strict';

const BATCH_SIZE = 8;
const MIN_LENGTH = 15;

// 语义化标签选择器（大多数网站用这些做段落）
const QUERY = 'p, h1, h2, h3, h4, h5, li, blockquote, figcaption, td, th';

// 块级标签集合——用于判断 div 是否为叶子容器
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main',
  'nav', 'ul', 'ol', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'form',
  'fieldset', 'details', 'summary', 'blockquote', 'figure', 'address',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
]);

// 排除这些容器标签内的元素
const EXCLUDED_TAGS = new Set(['nav', 'header', 'footer', 'script', 'style', 'button',
  'input', 'textarea', 'select', 'code', 'pre', 'noscript']);

// 排除这些 id 对应的区域（如 archive.md 顶部工具栏、分享弹窗）
const EXCLUDED_IDS = new Set(['HEADER', 'DIVSHARE']);

let pageState = {
  translating: false,
  translated: false,
  stopped: false,
  visible: true,
  total: 0,
  done: 0,
  error: null
};

function isInExcluded(el) {
  let node = el.parentElement;
  while (node && node !== document.body) {
    const tag = node.tagName.toLowerCase();
    if (EXCLUDED_TAGS.has(tag)) return true;
    // 排除 role=navigation/banner/contentinfo 等 ARIA 区域
    const role = node.getAttribute?.('role');
    if (role && ['navigation', 'banner', 'contentinfo', 'complementary'].includes(role)) return true;
    // 排除已知 id 的"站点外壳"区域（如 archive.md 顶栏）
    if (node.id && EXCLUDED_IDS.has(node.id)) return true;
    node = node.parentElement;
  }
  return false;
}

function isMostlyChinese(text) {
  const zh = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
  return zh / text.length > 0.25;
}

// 判断 div 是否为叶子文本容器（不含可见块级子元素）
function isLeafDiv(el) {
  for (const child of el.children) {
    // display:none 的子元素不算（经济学人广告占位 div）
    const cs = window.getComputedStyle(child);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (BLOCK_TAGS.has(child.tagName.toLowerCase())) return false;
  }
  return true;
}

function getTranslatableElements() {
  const seen = new Set();
  const result = [];

  function tryAdd(el) {
    if (seen.has(el)) return;
    if (el.dataset.bilingualDone) return;
    if (el.closest('.bilingual-block')) return;
    if (isInExcluded(el)) return;

    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    if (text.length < MIN_LENGTH) return;
    if (isMostlyChinese(text)) return;

    seen.add(el);
    result.push(el);
  }

  // 第一遍：语义化标签
  document.querySelectorAll(QUERY).forEach(tryAdd);

  // 第二遍：叶子 div（Modern 网站如经济学人用 div 做段落）
  document.querySelectorAll('div').forEach(el => {
    if (!isLeafDiv(el)) return;
    tryAdd(el);
  });

  return result;
}

function showLoading(el) {
  const span = document.createElement('span');
  span.className = 'bilingual-loading';
  span.setAttribute('aria-hidden', 'true');
  el.appendChild(span);
  el.dataset.bilingualDone = 'loading';
}

function applyTranslation(el, text) {
  // 清除 loading 占位符
  el.querySelector('.bilingual-loading')?.remove();

  if (!text?.trim()) {
    el.dataset.bilingualDone = 'skip';
    return;
  }

  const block = document.createElement('span');
  block.className = 'bilingual-block';
  block.setAttribute('aria-label', '译文');

  const span = document.createElement('span');
  span.className = 'bilingual-text';
  span.textContent = text;

  block.appendChild(span);
  el.appendChild(block);
  el.dataset.bilingualDone = 'done';
}

function markError(el) {
  el.querySelector('.bilingual-loading')?.remove();
  el.dataset.bilingualDone = 'error';
}

async function sendTranslateRequest(texts, provider, targetLang) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'translate', texts, provider, targetLang },
      resp => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (resp?.error) return reject(new Error(resp.error));
        resolve(resp?.translations || new Array(texts.length).fill(''));
      }
    );
  });
}

async function runTranslation(provider, targetLang) {
  if (pageState.translating) return;

  const elements = getTranslatableElements();
  if (!elements.length) {
    pageState.translated = true;
    return;
  }

  pageState.translating = true;
  pageState.translated = false;
  pageState.stopped = false;
  pageState.total = elements.length;
  pageState.done = 0;
  pageState.error = null;

  // 先显示所有 loading 占位
  elements.forEach(el => showLoading(el));

  for (let i = 0; i < elements.length; i += BATCH_SIZE) {
    // 检查停止标志，退出循环（已显示的 loading 会留着，清除它们）
    if (pageState.stopped) {
      elements.slice(i).forEach(el => {
        el.querySelector('.bilingual-loading')?.remove();
        delete el.dataset.bilingualDone;
      });
      break;
    }

    const batch = elements.slice(i, i + BATCH_SIZE);
    const texts = batch.map(el => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' '));

    try {
      const translations = await sendTranslateRequest(texts, provider, targetLang);
      batch.forEach((el, j) => applyTranslation(el, translations[j]));
    } catch (err) {
      console.error('[双语翻译] 批次错误:', err.message);
      batch.forEach(el => markError(el));
      pageState.error = err.message;
    }

    pageState.done = Math.min(i + BATCH_SIZE, elements.length);
  }

  pageState.translating = false;
  if (!pageState.stopped) pageState.translated = true;
}

function toggleVisibility(visible) {
  pageState.visible = visible;
  document.querySelectorAll('.bilingual-block').forEach(el => {
    el.style.display = visible ? '' : 'none';
  });
}

function clearAll() {
  document.querySelectorAll('.bilingual-block, .bilingual-loading').forEach(el => el.remove());
  document.querySelectorAll('[data-bilingual-done]').forEach(el => {
    delete el.dataset.bilingualDone;
  });
  Object.assign(pageState, { translating: false, translated: false, stopped: false, visible: true, total: 0, done: 0, error: null });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'translatePage':
      runTranslation(msg.provider, msg.targetLang)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'stopTranslation':
      pageState.stopped = true;
      // translating 会在当前批次结束后由 runTranslation 设为 false
      sendResponse({ success: true, done: pageState.done });
      break;

    case 'toggleVisibility':
      toggleVisibility(msg.visible);
      sendResponse({ success: true });
      break;

    case 'clear':
      clearAll();
      sendResponse({ success: true });
      break;

    case 'getStatus':
      sendResponse({ ...pageState });
      break;
  }
});
