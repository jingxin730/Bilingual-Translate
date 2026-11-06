const assert = require('node:assert/strict');
const test = require('node:test');
const { harness } = require('./helpers/content-harness');

const article = 'An article paragraph that should only be translated once.';
const comment = 'This is a reader comment loaded after the article has finished translating.';
const reply = 'This reply was only added after clicking Show more replies.';

async function start(h) {
  const work = h.runTranslation('deepseek', 'ja');
  await h.flush();
  await work;
  await h.flush();
}

function conversation(h) {
  const container = h.root.appendChild(h.element('section', '', {
    'aria-label': 'Conversation', 'data-spotim-module': 'conversation'
  }));
  const host = container.appendChild(h.element('ow-comments'));
  const shadowRoot = host.attachShadow();
  const root = shadowRoot.appendChild(h.element('div', '', { 'data-spot-im-class': 'message-text' }));
  return { container, host, root, shadowRoot };
}

test('new paragraphs stay untranslated until the user starts page translation', async () => {
  const h = harness('www.wsj.com');
  h.root.appendChild(h.element('p', comment));
  await h.flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.blocks().length, 0);
});

test('comments added long after the main run translate automatically with the same settings', async () => {
  const h = harness('www.wsj.com');
  h.root.appendChild(h.element('p', article));
  await start(h);
  h.root.appendChild(h.element('p', comment));
  await h.flush();
  assert.deepEqual(h.calls.map(call => Array.from(call.texts)), [[article], [comment]]);
  assert.ok(h.calls.every(call => call.provider === 'deepseek' && call.targetLang === 'ja'));
  assert.equal(h.blocks().length, 2);
  assert.equal(h.pageState.total, 2);
  assert.equal(h.pageState.done, 2);
});

test('WSJ OpenWeb comments in a shadow root and subsequently expanded replies are discovered', async () => {
  const h = harness('www.wsj.com');
  h.root.appendChild(h.element('h1', 'An article headline preceding the comments'));
  await start(h);
  const c = conversation(h);
  c.root.appendChild(h.element('p', comment));
  await h.flush();
  c.root.appendChild(h.element('p', reply));
  await h.flush();
  assert.deepEqual(h.calls.slice(1).map(call => Array.from(call.texts)), [[comment], [reply]]);
  assert.equal(c.root.querySelectorAll('.bilingual-block').length, 2);
  assert.equal(c.shadowRoot.querySelectorAll('.bilingual-styles').length, 1);
});

test('a shadow root attached to an existing host without a mutation is found by discovery', async () => {
  const h = harness();
  const host = h.root.appendChild(h.element('ow-comments'));
  await start(h);
  host.attachShadow().appendChild(h.element('p', comment));
  await h.flush();
  assert.equal(h.calls.length, 0);
  h.tickDiscovery();
  await h.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.blocks().length, 1);
});

test('hidden comments translate only after expanding their container', async () => {
  const h = harness();
  const c = conversation(h);
  h.changeVisibility(c.container, false);
  c.root.appendChild(h.element('p', comment));
  await start(h);
  assert.equal(h.calls.length, 0);
  h.changeVisibility(c.container, true);
  await h.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.blocks().length, 1);
});

test('navigation, dialogs and comment drafts remain excluded across shadow boundaries', async () => {
  const h = harness();
  for (const [tag, attrs] of [['nav', {}], ['div', { role: 'dialog' }], ['div', { contenteditable: 'true' }]]) {
    const host = h.root.appendChild(h.element(tag, '', attrs)).appendChild(h.element('ow-widget'));
    host.attachShadow().appendChild(h.element('p', comment));
  }
  await start(h);
  assert.equal(h.calls.length, 0);
});

test('translation DOM changes and repeated unrelated mutations do not translate old text again', async () => {
  const h = harness();
  h.root.appendChild(h.element('p', article));
  await start(h);
  await h.flush();
  for (let i = 0; i < 10; i++) h.root.appendChild(h.element('button', 'Reply'));
  await h.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.blocks().length, 1);
});

test('See more on an existing comment replaces its old translation with the expanded text', async () => {
  const h = harness();
  const c = conversation(h);
  const p = c.root.appendChild(h.element('p', comment));
  await start(h);
  h.edit(p, `${comment} ${reply}`);
  await h.flush();
  assert.deepEqual(Array.from(h.calls[1].texts), [`${comment} ${reply}`]);
  assert.equal(c.root.querySelectorAll('.bilingual-block').length, 1);
  assert.equal(h.blocks()[0].querySelector('.bilingual-text').textContent, `译文：${comment} ${reply}`);
});

test('hide/show and clearing apply to existing and newly translated shadow comments', async () => {
  const h = harness();
  const c = conversation(h);
  c.root.appendChild(h.element('p', comment));
  await start(h);
  h.toggleVisibility(false);
  c.root.appendChild(h.element('p', reply));
  await h.flush();
  assert.ok(h.blocks().every(block => block.style.display === 'none'));
  h.toggleVisibility(true);
  assert.ok(h.blocks().every(block => block.style.display === ''));
  h.clearAll();
  c.root.appendChild(h.element('p', article));
  await h.flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.blocks().length, 0);
  assert.equal(c.root.querySelectorAll('[data-bilingual-done]').length, 0);
});

test('stopping after the main run disables automatic translation until explicitly restarted', async () => {
  const h = harness();
  h.root.appendChild(h.element('p', article));
  await start(h);
  h.message({ action: 'stopTranslation' });
  h.root.appendChild(h.element('p', comment));
  await h.flush();
  assert.equal(h.calls.length, 1);
  await start(h);
  assert.equal(h.calls.length, 2);
  assert.equal(h.blocks().length, 2);
});

test('new comments during an in-flight main run wait and do not duplicate requests', async () => {
  let release;
  const h = harness('www.wsj.com', (message, count) => count === 1
    ? new Promise(resolve => { release = () => resolve({ translations: ['文章译文'] }); })
    : { translations: message.texts.map(() => '评论译文') });
  h.root.appendChild(h.element('p', article));
  const work = h.runTranslation('deepseek', 'ja');
  await h.flush();
  h.root.appendChild(h.element('p', comment));
  await h.flush();
  assert.equal(h.calls.length, 1);
  release();
  await h.flush();
  await work;
  assert.equal(h.calls.length, 2);
  assert.equal(h.blocks().length, 2);
});

test('clearing while an automatic request is in flight ignores its late result', async () => {
  let release;
  const h = harness('www.wsj.com', (message, count) => count === 1
    ? { translations: ['文章译文'] }
    : new Promise(resolve => { release = () => resolve({ translations: ['迟到的译文'] }); }));
  h.root.appendChild(h.element('p', article));
  await start(h);
  h.root.appendChild(h.element('p', comment));
  await h.flush();
  h.clearAll();
  release();
  await h.flush();
  assert.equal(h.blocks().length, 0);
  assert.equal(h.pageState.translating, false);
  assert.equal(h.pageState.total, 0);
});

test('source changes during a request discard the old response and translate the latest text', async () => {
  let release;
  const h = harness('www.wsj.com', (message, count) => count === 1
    ? new Promise(resolve => { release = () => resolve({ translations: ['旧的截断译文'] }); })
    : { translations: ['完整评论译文'] });
  const p = h.root.appendChild(h.element('p', comment));
  const work = h.runTranslation('deepseek', 'ja');
  await h.flush();
  h.edit(p, `${comment} ${reply}`);
  release();
  await h.flush();
  await work;
  assert.equal(h.calls.length, 2);
  assert.equal(h.blocks().length, 1);
  assert.equal(h.blocks()[0].querySelector('.bilingual-text').textContent, '完整评论译文');
});

test('stop during DOM settling and duplicate start clicks cannot start extra requests', async () => {
  const h = harness();
  h.root.appendChild(h.element('p', article));
  const work = h.runTranslation('deepseek', 'ja');
  await h.runTranslation('deepseek', 'ja');
  h.message({ action: 'stopTranslation' });
  await h.flush();
  await work;
  assert.equal(h.calls.length, 0);
  assert.equal(h.pageState.translating, false);
  assert.equal(h.pageState.stopped, true);
});

test('a reply arriving during an automatic request is translated after that request finishes', async () => {
  let release;
  const h = harness('www.wsj.com', (message, count) => count === 2
    ? new Promise(resolve => { release = () => resolve({ translations: ['评论译文'] }); })
    : { translations: message.texts.map(() => '译文') });
  h.root.appendChild(h.element('p', article));
  await start(h);
  h.root.appendChild(h.element('p', comment));
  await h.flush();
  h.root.appendChild(h.element('p', reply));
  await h.flush();
  assert.equal(h.calls.length, 2);
  release();
  await h.flush();
  assert.equal(h.calls.length, 3);
  assert.equal(h.blocks().length, 3);
});

test('service outages disable the automatic observer instead of continually retrying new comments', async () => {
  const h = harness('www.wsj.com', (message, count) => count === 1
    ? { translations: ['文章译文'] } : { error: 'API 503: Service is too busy.' });
  h.root.appendChild(h.element('p', article));
  await start(h);
  h.root.appendChild(h.element('p', comment));
  await h.flush();
  assert.equal(h.calls.length, 4);
  assert.match(h.pageState.error, /服务繁忙/);
  h.root.appendChild(h.element('p', reply));
  await h.flush();
  assert.equal(h.calls.length, 4);
  assert.equal(h.blocks().length, 1);
});

test('OpenWeb usernames, typing indicators and controls are excluded even when their text changes', async () => {
  const h = harness('www.wsj.com');
  const c = conversation(h);
  const status = c.shadowRoot.appendChild(h.element('div', '1 Person typing'));
  c.shadowRoot.appendChild(h.element('div', 'A reader with a long display name'));
  c.shadowRoot.appendChild(h.element('div', 'Show 12 more replies'));
  await start(h);
  assert.equal(h.calls.length, 0);
  c.root.appendChild(h.element('p', comment));
  await h.flush();
  h.edit(status, '2 People typing');
  await h.flush();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(Array.from(h.calls[0].texts), [comment]);
});

test('short replies in marked OpenWeb comment bodies are translated rather than treated as UI labels', async () => {
  const h = harness('www.wsj.com');
  const c = conversation(h);
  for (const text of ['I agree.', 'LOL', 'OK']) c.root.appendChild(h.element('p', text));
  await start(h);
  assert.deepEqual(h.calls.flatMap(call => Array.from(call.texts)), ['I agree.', 'LOL', 'OK']);
  assert.equal(h.blocks().length, 3);
});

for (const placement of ['shadow', 'light', 'nested-shadow']) {
  test(`OpenWeb ${placement} reply cards translate only message bodies, excluding names, times and more-reply controls`, async () => {
    const h = harness('www.wsj.com');
    const conversation = h.root.appendChild(h.element('section', '', { 'data-spotim-module': 'conversation' }));
    let root = conversation;
    if (placement !== 'light') root = root.appendChild(h.element('ow-comments')).attachShadow();
    if (placement === 'nested-shadow') root = root.appendChild(h.element('ow-replies')).attachShadow();
    const card = root.appendChild(h.element('li'));
    card.appendChild(h.element('span', 'John Thomas Zekany'));
    card.appendChild(h.element('div', '6 hours ago'));
    const body = card.appendChild(h.element('div', comment, { 'data-spot-im-class': 'message-text' }));
    card.appendChild(h.element('span', 'Reply · 204 · Share'));
    const replies = card.appendChild(h.element('li'));
    replies.appendChild(h.element('span', 'WD'));
    replies.appendChild(h.element('span', 'William D'));
    replies.appendChild(h.element('span', '6 hours ago'));
    const shortReply = replies.appendChild(h.element('div', 'lol', { 'data-spot-im-class': 'message-text' }));
    replies.appendChild(h.element('span', 'Reply · 15 · Share'));
    const more = card.appendChild(h.element('div', 'Show 6 more replies'));
    await start(h);
    assert.deepEqual(h.calls.flatMap(call => Array.from(call.texts)), [comment, 'lol']);
    assert.equal(h.blocks().length, 2);
    assert.equal(body.dataset.bilingualDone, 'done');
    assert.equal(shortReply.dataset.bilingualDone, 'done');
    assert.equal(card.dataset.bilingualDone, undefined);
    assert.equal(replies.dataset.bilingualDone, undefined);
    h.edit(more, 'Show 5 more replies');
    await h.flush();
    assert.equal(h.calls.length, 1);
  });
}
