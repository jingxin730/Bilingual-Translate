const assert = require('node:assert/strict');
const test = require('node:test');
const { harness } = require('./helpers/content-harness');

function post(h, tag = 'div') {
  const card = h.root.appendChild(h.element('article', '', { 'data-testid': 'tweet' }));
  card.appendChild(h.element('span', '@Jason', { 'data-testid': 'User-Name' }));
  return card.appendChild(h.element(tag, '', { 'data-testid': 'tweetText' }));
}

async function start(h) {
  const work = h.runTranslation('deepseek', 'ja');
  await h.flush();
  await work;
  await h.flush();
}

function readingOrder(node) {
  if (node.classList?.contains('bilingual-x-anchor')) {
    const block = node.querySelector('.bilingual-text');
    return block ? [block.textContent] : [];
  }
  if (node.nodeType === 3) return node.nodeValue.trim() ? [node.nodeValue.trim()] : [];
  return node.childNodes.flatMap(readingOrder);
}

for (const hostname of ['x.com', 'twitter.com', 'mobile.twitter.com']) {
  test(`${hostname} interleaves translations sentence by sentence, including sentences in the same span`, async () => {
    const h = harness(hostname);
    const body = post(h);
    body.appendChild(h.element('span', 'The floor is in. Inflation drops. Markets set new records.'));
    await start(h);
    assert.deepEqual(h.calls.flatMap(call => Array.from(call.texts)), [
      'The floor is in.', 'Inflation drops.', 'Markets set new records.'
    ]);
    assert.deepEqual(readingOrder(body), [
      'The floor is in.', '译文：The floor is in.',
      'Inflation drops.', '译文：Inflation drops.',
      'Markets set new records.', '译文：Markets set new records.'
    ]);
    assert.equal(h.blocks().length, 3);
  });
}

test('numbered lines, blank lines and br elements split without losing the number prefix', async () => {
  const h = harness('x.com');
  const body = post(h);
  body.appendChild(h.element('span', 'Here is what happens:\n\n1. Inflation drops\n\n2. Markets rise.'));
  body.appendChild(h.element('br'));
  body.appendChild(h.element('span', 'Bookmark this'));
  await start(h);
  assert.deepEqual(h.calls.flatMap(call => Array.from(call.texts)), [
    'Here is what happens:', '1. Inflation drops', '2. Markets rise.', 'Bookmark this'
  ]);
  assert.equal(readingOrder(body).at(-1), '译文：Bookmark this');
});

test('inline mentions, ticker links and long headline-like links stay intact within the corresponding source sentence', async () => {
  const h = harness('x.com');
  const body = post(h);
  body.appendChild(h.element('span', 'I agree with '));
  const mention = body.appendChild(h.element('a', '@realDonaldTrump', { href: '/realDonaldTrump' }));
  body.appendChild(h.element('span', ' about '));
  const link = body.appendChild(h.element('a', 'the detailed report about the technology market', { href: 'https://example.com/report' }));
  body.appendChild(h.element('span', '.\nBuy '));
  const ticker = body.appendChild(h.element('a', '$TSLA', { href: '/search?q=TSLA' }));
  body.appendChild(h.element('span', '.'));
  await start(h);
  assert.deepEqual(h.calls.flatMap(call => Array.from(call.texts)), [
    'I agree with @realDonaldTrump about the detailed report about the technology market.', 'Buy $TSLA.'
  ]);
  for (const original of [mention, link, ticker]) {
    assert.equal(original.parentNode, body);
    assert.equal(original.querySelector('.bilingual-block'), null);
  }
  assert.equal(h.blocks().length, 2);
});

test('link text containing punctuation stays one source and translation is placed outside the original link', async () => {
  const h = harness('x.com');
  const body = post(h);
  const link = body.appendChild(h.element('a', 'The first linked sentence. The second linked sentence.', { href: '/report' }));
  await start(h);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(Array.from(h.calls[0].texts), ['The first linked sentence. The second linked sentence.']);
  assert.equal(link.nextSibling.className, 'bilingual-x-anchor');
  assert.equal(link.querySelector('.bilingual-block'), null);
});

test('X div wrappers around stock tickers stay in the sentence instead of becoming separate paragraphs', async () => {
  const h = harness('x.com');
  const body = post(h);
  body.appendChild(h.element('span', 'Every spare dollar I can find in the couch goes into '));
  const tickers = ['$tsla', '$SPCX', '$UBER', '$AMZN', '$SHOP', '$MSFT'];
  const links = tickers.map((ticker, index) => {
    const wrapper = body.appendChild(h.element('div', '', {}, index % 2 ? 'inline-flex' : 'flex'));
    const link = wrapper.appendChild(h.element('a', ticker, { href: '/search?q=ticker' }));
    body.appendChild(h.element('span', index === tickers.length - 1 ? '.' : ' '));
    return link;
  });
  await start(h);
  assert.deepEqual(h.calls.flatMap(call => Array.from(call.texts)), [
    `Every spare dollar I can find in the couch goes into ${tickers.join(' ')}.`
  ]);
  assert.equal(h.blocks().length, 1);
  assert.ok(links.every(link => !link.parentNode.querySelector('.bilingual-x-anchor')));
});

test('div wrappers around mentions stay with the numbered sentence that follows the ellipsis', async () => {
  const h = harness('x.com');
  const body = post(h);
  body.appendChild(h.element('span', '5. Ballroom reaches completion... '));
  body.appendChild(h.element('div', '', {}, 'inline-flex'))
    .appendChild(h.element('a', '@realDonaldTrump', { href: '/realDonaldTrump' }));
  body.appendChild(h.element('span', ' throws a year of ragers. Third win for his legacy'));
  await start(h);
  const sources = h.calls.flatMap(call => Array.from(call.texts));
  assert.ok(sources.some(source => source.includes('@realDonaldTrump throws a year of ragers.')));
  assert.ok(!sources.includes('@realDonaldTrump'));
});

test('nested paragraph blocks and span post roots receive translations at their own sentence endings', async () => {
  const h = harness('x.com');
  const body = post(h, 'span');
  body.appendChild(h.element('div', 'The first point without punctuation'));
  body.appendChild(h.element('p', 'The second point without punctuation'));
  await start(h);
  assert.deepEqual(readingOrder(body), [
    'The first point without punctuation', '译文：The first point without punctuation',
    'The second point without punctuation', '译文：The second point without punctuation'
  ]);
});

test('short and uppercase posts are translated and hidden posts, navigation and drafts stay untouched', async () => {
  const h = harness('x.com');
  for (const text of ['I agree.', 'BUY THE DIP']) post(h).appendChild(h.element('span', text));
  for (const [tag, attrs] of [['nav', {}], ['div', { contenteditable: 'true' }], ['div', { role: 'textbox' }]]) {
    h.root.appendChild(h.element(tag, '', attrs))
      .appendChild(h.element('div', 'An excluded post body with enough text.', { 'data-testid': 'tweetText' }));
  }
  const hidden = post(h);
  hidden.appendChild(h.element('span', 'A hidden post with enough text.'));
  hidden.computed.display = 'none';
  await start(h);
  assert.deepEqual(h.calls.flatMap(call => Array.from(call.texts)), ['I agree.', 'BUY THE DIP']);
  assert.equal(hidden.querySelector('.bilingual-x-anchor'), null);
});

test('expansion rebuilds sentence anchors, new replies translate, and hide/show/clear work without changing original links', async () => {
  const h = harness('x.com');
  const body = post(h);
  const text = body.appendChild(h.element('span', 'The initial post.'));
  await start(h);
  // X replaces the expanded text, preserving the post container.
  text.remove();
  body.appendChild(h.element('span', 'The expanded post. A new conclusion.'));
  await h.flush();
  assert.deepEqual(readingOrder(body), [
    'The expanded post.', '译文：The expanded post.', 'A new conclusion.', '译文：A new conclusion.'
  ]);
  h.toggleVisibility(false);
  assert.equal(body.getAttribute('data-bilingual-x-layout'), null);
  const reply = post(h);
  const link = reply.appendChild(h.element('a', 'A newly loaded reply.', { href: '/reply' }));
  await h.flush();
  assert.ok(h.blocks().every(block => block.style.display === 'none'));
  h.toggleVisibility(true);
  assert.equal(body.getAttribute('data-bilingual-x-layout'), 'compact');
  assert.ok(h.blocks().every(block => block.style.display === ''));
  assert.ok(h.calls.every(call => call.provider === 'deepseek' && call.targetLang === 'ja'));
  h.clearAll();
  assert.equal(h.blocks().length, 0);
  assert.equal(body.querySelector('.bilingual-x-anchor'), null);
  assert.equal(body.getAttribute('data-bilingual-x-layout'), null);
  assert.equal(reply.querySelector('.bilingual-x-anchor'), null);
  assert.equal(link.parentNode, reply);
  assert.equal(h.getVisibleText(body), 'The expanded post. A new conclusion.');
  await start(h);
  assert.equal(h.blocks().length, 3);
});

test('other hosts keep the generic extraction behavior', () => {
  const h = harness('example.com');
  const body = post(h);
  body.appendChild(h.element('span', 'OK'));
  assert.equal(h.selected().includes(body), false);
  assert.equal(body.querySelector('.bilingual-x-anchor'), null);
});

test('an expansion during an in-flight request discards stale sentence translations', async () => {
  let release;
  const h = harness('x.com', (message, count) => count === 1
    ? new Promise(resolve => { release = () => resolve({ translations: ['过期译文'] }); })
    : { translations: message.texts.map(text => `译文：${text}`) });
  const body = post(h);
  const text = body.appendChild(h.element('span', 'The initial post.'));
  const work = h.runTranslation('deepseek', 'ja');
  await h.flush();
  text.remove();
  body.appendChild(h.element('span', 'The expanded post. The full conclusion.'));
  release();
  await h.flush();
  await work;
  await h.flush();
  assert.deepEqual(readingOrder(body), [
    'The expanded post.', '译文：The expanded post.', 'The full conclusion.', '译文：The full conclusion.'
  ]);
  assert.equal(h.blocks().length, 2);
});
