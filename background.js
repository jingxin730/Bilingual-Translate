'use strict';

importScripts('config.js'); // API_TOKEN 和 PROVIDERS 在 config.js 中定义，已被 .gitignore 排除

function buildPrompt(texts, targetLang) {
  const langMap = { zh: '简体中文', 'zh-TW': '繁体中文', en: '英文', ja: '日文' };
  const lang = langMap[targetLang] || '简体中文';
  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return `将以下编号文本翻译为${lang}，严格按编号格式返回，只输出译文，不要解释：\n\n${numbered}`;
}

// 把编号译文对齐回原文顺序。这里必须尽量宽容：解析失败的表现是译文变空串，
// 而空串在页面上和"这段没翻译"一模一样，比报错更难查（曾出现整批 渲染 0/2 段）。
// 兼容：**1.** 包裹、行首缩进、全角标点、1) / 1、/ 1: 等分隔符、一段译文被断成多行。
function parseTranslations(text, count) {
  const results = new Array(count).fill('');
  let current = -1;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    // 行首可能有 markdown 修饰（**、##、>）；编号限 1~3 位，避免把 "2024:" 当编号
    const m = line.match(/^[*_#>\s]*(\d{1,3})\s*[.、)．：:]\s*(.*)$/);
    if (m) {
      const i = parseInt(m[1], 10) - 1;
      if (i >= 0 && i < count) {
        current = i;
        results[i] = m[2].replace(/^[*_\s]+|[*_\s]+$/g, '');
        continue;
      }
    }

    // 没有编号的行视为上一条的续行（模型偶尔把长译文断成多行）
    if (current >= 0) results[current] += (results[current] ? ' ' : '') + line;
  }

  // 编号完全没对上（模型直接输出了 count 行纯译文）：按行序兜底，
  // 总比整批返回空串好——空串会让这些段落静默地"没翻译"
  if (count > 0 && results.every(t => !t)) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === count) return lines;
  }

  return results;
}

// 每个 provider 可以带自己的 token：DeepSeek 官方 API 用的是 DeepSeek 自家的 key，
// 和中转站那个 API_TOKEN 不通用。没配 cfg.token 就回退到全局 API_TOKEN。
// 占位符（config.example.js 里的 your-xxx）当成没填，报错比让接口返 401 好读。
function resolveToken(cfg, provider) {
  const token = cfg.token || API_TOKEN || '';
  if (!token || token.startsWith('your-')) {
    throw new Error(`${provider} 没有可用的 API Key，请在 config.js 中填写`);
  }
  return token;
}

function resolveEndpoint(cfg) {
  const url = cfg.url.replace(/\/+$/, '');

  if (cfg.type === 'gemini') {
    if (/:generateContent$/.test(url)) return url;
    return `${url}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
  }

  if (/\/chat\/completions$/.test(url)) return url;
  return /\/v1$/.test(url)
    ? `${url}/chat/completions`
    : `${url}/v1/chat/completions`;
}

// 流式读取 OpenAI 兼容接口（Claude / ChatGPT / DeepSeek）
async function callOpenAIStream(texts, cfg, targetLang, token) {
  const resp = await fetch(resolveEndpoint(cfg), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 4000,
      stream: true,
      messages: [{ role: 'user', content: buildPrompt(texts, targetLang) }],
      ...cfg.extraBody   // 各家的私有参数，如 DeepSeek 的 thinking 开关
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
          // 只取 content：思考模式下 DeepSeek 会同级返回 reasoning_content，那是思维链不是译文
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
async function callGemini(texts, cfg, targetLang, token) {
  const resp = await fetch(resolveEndpoint(cfg), {
    method: 'POST',
    headers: {
      'x-goog-api-key': token,
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
  const token = resolveToken(cfg, provider);

  const raw = cfg.type === 'gemini'
    ? await callGemini(texts, cfg, targetLang, token)
    : await callOpenAIStream(texts, cfg, targetLang, token);

  console.log(`[双语翻译] ${provider} 返回 ${raw.length} 字符，预览: ${raw.slice(0, 100)}`);
  return parseTranslations(raw, texts.length);
}

// 处理来自 content script 的翻译请求
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 心跳：MV3 的 Service Worker 空闲约 30s 就被回收，而流式 fetch 等首个 chunk
  // 期间不算"活动"。SW 一死，正在等的 sendResponse 永远不会被调用，content script
  // 那边表现为请求永不返回。翻译期间由 content script 定时发心跳把 SW 顶住。
  if (msg.action === 'keepAlive') {
    sendResponse({ alive: true });
    return;
  }

  if (msg.action === 'getProviders') {
    const providers = Object.fromEntries(
      Object.entries(PROVIDERS).map(([key, cfg]) => [key, { model: cfg.model }])
    );
    sendResponse({ providers });
    return;
  }

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
