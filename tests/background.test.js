const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function harness(fetch = async () => { throw new Error('Unexpected fetch'); }) {
  const context = {
    importScripts() {},
    API_TOKEN: 'fixture-token',
    PROVIDERS: {
      deepseek: { url: 'https://fixture.invalid', model: 'deepseek-flash', type: 'openai', extraBody: { thinking: { type: 'disabled' } } },
      gemini: { url: 'https://fixture.invalid', model: 'fixture', type: 'gemini' }
    },
    fetch, TextDecoder, AbortController, setTimeout, clearTimeout, console: { log() {} },
    chrome: { runtime: { onMessage: { addListener() {} } }, commands: { onCommand: { addListener() {} } } }
  };
  vm.runInNewContext(`${code}\nglobalThis.api = { parseTranslations, translate };`, context);
  return context.api;
}

const formats = ['1. 甲\n2. 乙', '**1.** 甲\n**2.** 乙', '**1**: 甲\n**2**: 乙', '1）甲\n2）乙',
  '（1）甲\n（2）乙', '(1) 甲\n(2) 乙', '[1] 甲\n[2] 乙', '【1】甲\n【2】乙',
  '1。甲\n2。乙', '1、甲\n2、乙', '- 1. 甲\n- 2. 乙', '1\n甲\n2\n乙',
  '```text\n1. 甲\n2. 乙\n```', '```json\n["甲", "乙"]\n```', '甲\n乙'];
for (const [index, raw] of formats.entries()) {
  test(`translation parser aligns numbered/structured output variant ${index + 1}`, () => {
    assert.deepEqual(Array.from(harness().parseTranslations(raw, 2)), ['甲', '乙']);
  });
}

test('missing and repeated indices stay empty instead of shifting or overwriting translations', () => {
  const { parseTranslations } = harness();
  assert.deepEqual(Array.from(parseTranslations('1. 甲\n3. 丙', 3)), ['甲', '', '丙']);
  assert.deepEqual(Array.from(parseTranslations('1. 甲\n1. 重复\n2. 乙', 2)), ['', '乙']);
  assert.deepEqual(Array.from(parseTranslations('2. 编号错误', 1)), ['']);
  assert.deepEqual(Array.from(parseTranslations('[]', 1)), ['']);
});

test('single subtitle recovery accepts multiline unnumbered output and keeps years in the body', () => {
  const { parseTranslations } = harness();
  assert.deepEqual(Array.from(parseTranslations('第一行\n第二行', 1)), ['第一行 第二行']);
  assert.deepEqual(Array.from(parseTranslations('1. 第一行\n2024: 继续\n2. 第二条', 2)), ['第一行 2024: 继续', '第二条']);
});

function sseResponse(raw, finishReason = 'stop', trailingNewline = true) {
  const events = [
    { choices: [{ delta: { reasoning_content: 'Internal reasoning is not translation' } }] },
    { choices: [{ delta: { content: raw } }] },
    { choices: [{ delta: {}, finish_reason: finishReason }] }
  ];
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]' + (trailingNewline ? '\n' : '');
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  return { ok: true, body: { getReader: () => ({ async read() {
    if (offset >= bytes.length) return { done: true };
    const value = bytes.slice(offset, offset + 7);
    offset += 7;
    return { done: false, value };
  } }) } };
}

test('DeepSeek SSE numbered results parse across UTF-8 chunk boundaries, ignoring reasoning', async () => {
  let request;
  const { translate } = harness(async (url, options) => {
    request = JSON.parse(options.body);
    return sseResponse('（1）第一条译文\n（2）第二条译文');
  });
  assert.deepEqual(Array.from(await translate(['First.', 'Second.'], 'deepseek')), ['第一条译文', '第二条译文']);
  assert.equal(request.thinking.type, 'disabled');
  assert.match(request.messages[0].content, /不得合并、遗漏或重复编号/);
});

test('a token-limited response keeps complete entries and leaves the cut-off entry for recovery', async () => {
  const { translate } = harness(async () => sseResponse('1. 完整译文\n2. 尚未完成', 'length', false));
  assert.deepEqual(Array.from(await translate(['First.', 'Second.', 'Third.'], 'deepseek')), ['完整译文', '', '']);
});

test('Gemini output limits also exclude the last potentially truncated translation', async () => {
  const { translate } = harness(async () => ({ ok: true, json: async () => ({ candidates: [{
    content: { parts: [{ text: '1. 完整译文\n' }, { text: '2. 尚未完成' }] }, finishReason: 'MAX_TOKENS'
  }] }) }));
  assert.deepEqual(Array.from(await translate(['First.', 'Second.'], 'gemini')), ['完整译文', '']);
});

test('backend timeout aborts a stalled fetch instead of leaving the old request running', async () => {
  let signal;
  const { translate } = harness(async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  await assert.rejects(translate(['Hello.'], 'deepseek', 'zh', 1000), /请求超时.*已取消后台请求/);
  assert.equal(signal.aborted, true);
});

test('backend timeout also aborts a stream that stalls after receiving headers', async () => {
  let signal;
  const { translate } = harness(async (_url, options) => {
    signal = options.signal;
    return { ok: true, body: { getReader: () => ({ read: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) }) } };
  });
  await assert.rejects(translate(['Hello.'], 'deepseek', 'zh', 1000), /请求超时.*已取消后台请求/);
  assert.equal(signal.aborted, true);
});

test('service overload is returned with its HTTP status for the page to stop queued requests', async () => {
  const { translate } = harness(async () => ({ ok: false, status: 503, text: async () => 'Service is too busy.' }));
  await assert.rejects(translate(['Hello.'], 'deepseek'), /API 503: Service is too busy/);
});
