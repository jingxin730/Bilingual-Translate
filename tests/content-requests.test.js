const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function harness(respond) {
  const calls = [];
  const budgets = [];
  const context = {
    location: { hostname: 'www.wsj.com' },
    console: { log() {}, warn() {}, error() {} }, performance,
    // 不等待重试退避；保留请求超时，以验证真实的消息/批次路径。
    setTimeout: (fn, ms) => setTimeout(fn, ms < 10000 ? 0 : ms), clearTimeout,
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage(message, callback) {
      calls.push(message.texts);
      budgets.push(message.timeoutMs);
      Promise.resolve(respond(message, calls.length)).then(callback);
    } } }
  };
  vm.runInNewContext(code.replace(/\n} \/\/ end non-youtube guard/, `
    getVisibleText = el => el.text;
    showLoading = el => { el.dataset.bilingualDone = 'loading'; };
    markError = (el, message) => { el.error = message; el.dataset.bilingualDone = 'error'; };
    applyTranslation = (el, text) => {
      el.translation = text;
      el.dataset.bilingualDone = text ? 'done' : 'skip';
      return !!text;
    };
    globalThis.api = {
      pageState,
      async run(elements) {
        serviceFailure = null;
        const current = ++runId;
        Object.assign(pageState, { done: 0, failed: 0, error: null });
        await translateElements(elements, 'deepseek', 'zh', current, 'test');
      }
    };
  } // end non-youtube guard`), context);
  return { ...context.api, calls, budgets };
}

const paragraphs = count => Array.from({ length: count }, (_, i) => ({
  text: `Original paragraph ${i}`, isConnected: true, dataset: {}
}));

test('persistent 503 errors stop queued requests without splitting every failed batch', async () => {
  const h = harness(() => ({ error: 'API 503: Service is too busy.' }));
  const elements = paragraphs(30);
  await h.run(elements);
  assert.ok(h.calls.length >= 3 && h.calls.length <= 6); // 两个工作协程，每个最多请求三次。
  assert.equal(h.pageState.done, 30);
  assert.equal(h.pageState.failed, 30);
  assert.match(h.pageState.error, /服务繁忙.*切换模型/);
  assert.ok(elements.every(el => el.dataset.bilingualDone === 'error'));
  assert.ok(h.budgets.every(ms => ms === 55000));
});

test('repeated timeouts do not fan out into more split requests', async () => {
  const h = harness(() => ({ error: '请求超时（55s 未返回，已取消后台请求）' }));
  await h.run(paragraphs(20));
  assert.ok(h.calls.length >= 3 && h.calls.length <= 6);
  assert.equal(h.pageState.failed, 20);
  assert.match(h.pageState.error, /请求超时/);
});

test('a transient overload retries successfully and later translation runs recover', async () => {
  let unavailable = true;
  const h = harness(message => unavailable
    ? { error: 'API 503: Service is too busy.' }
    : { translations: message.texts.map(() => '译文') });
  await h.run(paragraphs(10));
  unavailable = false;
  const elements = paragraphs(10);
  await h.run(elements);
  assert.equal(h.pageState.failed, 0);
  assert.equal(h.pageState.error, null);
  assert.ok(elements.every(el => el.translation === '译文'));

  const transient = harness((message, call) => call <= 2
    ? { error: 'API 503: Service is too busy.' }
    : { translations: message.texts.map(() => '译文') });
  await transient.run(paragraphs(10));
  assert.equal(transient.pageState.failed, 0);
  assert.equal(transient.pageState.done, 10);
});

test('successful translations are preserved when another batch encounters a service outage', async () => {
  const h = harness((message, call) => call === 1
    ? { translations: message.texts.map(() => '已完成的译文') }
    : { error: 'API 503: Service is too busy.' });
  const elements = paragraphs(20);
  await h.run(elements);
  assert.ok(elements.slice(0, 2).every(el => el.translation === '已完成的译文'));
  assert.equal(h.pageState.failed, 18);
  assert.equal(h.pageState.done, 20);
});
