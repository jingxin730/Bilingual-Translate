'use strict';

importScripts('config.js'); // API_TOKEN 和 PROVIDERS 在 config.js 中定义，已被 .gitignore 排除

function buildPrompt(texts, targetLang) {
  const langMap = { zh: '简体中文', 'zh-TW': '繁体中文', en: '英文', ja: '日文' };
  const lang = langMap[targetLang] || '简体中文';
  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return `将以下编号文本翻译为${lang}，严格按编号格式返回，只输出译文，不要解释：\n\n${numbered}`;
}

function parseTranslations(text, count) {
  const results = new Array(count).fill('');
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^(\d+)[.、)]\s*(.+)/);
    if (m) {
      const i = parseInt(m[1]) - 1;
      if (i >= 0 && i < count) results[i] = m[2].trim();
    }
  }
  return results;
}

// 流式读取 OpenAI 兼容接口（Claude / ChatGPT）
async function callOpenAIStream(texts, cfg, targetLang) {
  const resp = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 4000,
      stream: true,
      messages: [{ role: 'user', content: buildPrompt(texts, targetLang) }]
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`API ${resp.status}: ${err.slice(0, 300)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let collected = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (trimmed.startsWith('data: ')) {
        try {
          const chunk = JSON.parse(trimmed.slice(6));
          const piece = chunk.choices?.[0]?.delta?.content || '';
          collected += piece;
        } catch {}
      }
    }
  }

  // 处理剩余 buffer
  if (buffer.trim().startsWith('data: ')) {
    try {
      const chunk = JSON.parse(buffer.trim().slice(6));
      const piece = chunk.choices?.[0]?.delta?.content || '';
      collected += piece;
    } catch {}
  }

  return collected;
}

// Gemini 原生接口（非流式）
async function callGemini(texts, cfg, targetLang) {
  const resp = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': API_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(texts, targetLang) }] }],
      generationConfig: { maxOutputTokens: 4000 }
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${err.slice(0, 300)}`);
  }

  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function translate(texts, provider, targetLang = 'zh') {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`未知模型: ${provider}`);

  const raw = cfg.type === 'gemini'
    ? await callGemini(texts, cfg, targetLang)
    : await callOpenAIStream(texts, cfg, targetLang);

  console.log(`[双语翻译] ${provider} 返回 ${raw.length} 字符，预览: ${raw.slice(0, 100)}`);
  return parseTranslations(raw, texts.length);
}

// 处理来自 content script 的翻译请求
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'translate') {
    translate(msg.texts, msg.provider, msg.targetLang)
      .then(translations => sendResponse({ translations }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // 保持消息通道异步打开
  }
});

// 快捷键触发翻译
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'translate-page') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const { provider = 'claude', targetLang = 'zh' } = await chrome.storage.local.get(['provider', 'targetLang']);
  chrome.tabs.sendMessage(tab.id, { action: 'translatePage', provider, targetLang });
});
