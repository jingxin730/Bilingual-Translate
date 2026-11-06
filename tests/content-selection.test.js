const assert = require('node:assert/strict');
const test = require('node:test');
const { harness } = require('./helpers/content-harness');

const title = 'Smart Ring Maker Oura Becomes Latest Company to Delay Its US IPO';
const summary = 'The wearable tech startup and its shareholders were looking to raise funds in the US IPO.';

for (const [tag, attrs] of [
  ['span', { class: 'story-card-module__headline__large' }],
  ['div', { 'data-component': 'headline' }],
  ['span', { 'data-testid': 'headline' }],
  ['div', { role: 'heading', 'aria-level': '3' }]
]) {
  test(`selects a linked ${tag} headline (${JSON.stringify(attrs)}) separately from its summary`, () => {
    const h = harness();
    const card = h.root.appendChild(h.element('div'));
    const link = card.appendChild(h.element('a', '', { href: '/news/story' }));
    link.appendChild(h.element(tag, title, attrs));
    card.appendChild(h.element('p', summary));
    assert.deepEqual(h.texts(), [title, summary]);
  });
}

test('selects a standalone title link within a list card without dropping its summary', () => {
  const h = harness();
  const card = h.root.appendChild(h.element('li'));
  const headline = card.appendChild(h.element('div'));
  headline.appendChild(h.element('a', title, { href: '/news/story' }));
  card.appendChild(h.element('p', summary));
  assert.deepEqual(h.texts(), [title, summary]);
});

test('selects a block title link directly within a list card', () => {
  const h = harness();
  const card = h.root.appendChild(h.element('li'));
  card.appendChild(h.element('a', title, { href: '/news/story' }, 'block'));
  card.appendChild(h.element('p', summary));
  assert.deepEqual(h.texts(), [title, summary]);
});

test('splits a list card headline and span summary instead of translating both under the summary', () => {
  const h = harness();
  const card = h.root.appendChild(h.element('li')).appendChild(h.element('div'));
  const link = card.appendChild(h.element('a', '', { href: '/news/story' }));
  link.appendChild(h.element('span', title, { class: 'story-card-module__headline' }));
  card.appendChild(h.element('span', summary));
  assert.deepEqual(h.texts(), [title, summary]);
});

test('keeps the summary when the entire card is linked and its title is a marked span', () => {
  const h = harness();
  const card = h.root.appendChild(h.element('a', '', { href: '/news/story' }));
  card.appendChild(h.element('span', title, { 'data-component': 'headline' }));
  card.appendChild(h.element('p', summary));
  assert.deepEqual(h.texts(), [title, summary]);
});

test('selects an unlinked span headline beside its separate summary', () => {
  const h = harness();
  const card = h.root.appendChild(h.element('div'));
  card.appendChild(h.element('span', title, { class: 'Headline_title' }));
  card.appendChild(h.element('p', summary));
  assert.deepEqual(h.texts(), [title, summary]);
});

test('top-up scans do not reselect card containers or title links around processed title and summary nodes', () => {
  const h = harness();
  const card = h.root.appendChild(h.element('li')).appendChild(h.element('div'));
  card.appendChild(h.element('a', '', { href: '/news/story' }))
    .appendChild(h.element('span', title, { class: 'story-card-module__headline' }));
  card.appendChild(h.element('span', summary));
  const selected = h.selected();
  assert.deepEqual(h.texts(), [title, summary]);
  selected.forEach(el => { el.dataset.bilingualDone = 'loading'; });
  assert.deepEqual(h.selected(), []);
});

for (const tag of ['p', 'li', 'blockquote', 'td']) {
  test(`preserves the full ${tag} when a long title is linked within a sentence`, () => {
    const h = harness();
    const paragraph = h.root.appendChild(h.element(tag, 'Read the detailed report and our analysis of the market reaction: '));
    paragraph.appendChild(h.element('span')).appendChild(h.element('a', title, { href: '/news/story' }));
    assert.deepEqual(h.selected(), [paragraph]);
  });
}

test('does not translate marked headlines in navigation or hidden cards', () => {
  const h = harness();
  const nav = h.root.appendChild(h.element('nav'));
  nav.appendChild(h.element('span', title, { 'data-component': 'headline' }));
  const hidden = h.root.appendChild(h.element('span', title, { class: 'Headline_title' }));
  hidden.computed.display = 'none';
  assert.deepEqual(h.selected(), []);
});

test('does not duplicate semantic headings or mistake headline shells for individual titles', () => {
  const h = harness();
  const shell = h.root.appendChild(h.element('div', '', { class: 'headline-container' }));
  shell.appendChild(h.element('h3')).appendChild(h.element('a', title, { href: '/news/story' }));
  shell.appendChild(h.element('p', summary));
  assert.deepEqual(h.texts(), [title, summary]);
});

test('WSJ card span summaries are selected alongside headlines and exclude metadata', () => {
  const h = harness('www.wsj.com');
  const card = h.root.appendChild(h.element('div'));
  card.appendChild(h.element('h3')).appendChild(h.element('a', title, { href: '/articles/story' }));
  card.appendChild(h.element('span', summary, { class: 'WSJTheme--summaryText--fixture' }));
  card.appendChild(h.element('div')).appendChild(h.element('span', '45 min ago'));
  assert.deepEqual(h.texts(), [title, summary]);
});

test('WSJ flexcard-text paragraphs inside aria-hidden links remain translatable', () => {
  const h = harness('www.wsj.com');
  const card = h.root.appendChild(h.element('div'));
  const heading = card.appendChild(h.element('h3'));
  heading.appendChild(h.element('a', title, { href: '/articles/story' }));
  const link = card.appendChild(h.element('div')).appendChild(h.element('a', '', {
    href: '/articles/story', 'aria-hidden': 'true', tabindex: '-1', 'data-fclink': ''
  }));
  const paragraph = link.appendChild(h.element('span')).appendChild(h.element('p', summary, {
    'data-testid': 'flexcard-text', class: 'css-l79pis'
  }));
  assert.deepEqual(h.selected(), [heading, paragraph]);
  heading.dataset.bilingualDone = 'loading';
  assert.deepEqual(h.selected(), [paragraph]);
  paragraph.dataset.bilingualDone = 'loading';
  assert.deepEqual(h.selected(), []);
});

test('a flexcard-text paragraph hidden on the element itself is still excluded', () => {
  const h = harness('www.wsj.com');
  h.root.appendChild(h.element('p', summary, { 'data-testid': 'flexcard-text', 'aria-hidden': 'true' }));
  assert.deepEqual(h.selected(), []);
});

test('WSJ linked summary paragraphs are not discarded for high link density', () => {
  const h = harness('www.wsj.com');
  const card = h.root.appendChild(h.element('div'));
  card.appendChild(h.element('h3')).appendChild(h.element('a', title, { href: '/articles/story' }));
  const deck = card.appendChild(h.element('div', '', { class: 'WSJTheme--summary--fixture' }));
  const paragraph = deck.appendChild(h.element('p'));
  paragraph.appendChild(h.element('a', summary, { href: '/articles/story', 'aria-hidden': 'true' }));
  assert.deepEqual(h.selected(), [card.children[0], paragraph]);
});

test('WSJ summary can be recovered when its headline has already been processed', () => {
  const h = harness('www.wsj.com');
  const card = h.root.appendChild(h.element('a', '', { href: '/articles/story' }));
  const heading = card.appendChild(h.element('h3', title));
  const deck = card.appendChild(h.element('span', summary, { 'data-testid': 'summary' }));
  heading.dataset.bilingualDone = 'loading';
  assert.deepEqual(h.selected(), [deck]);
  deck.dataset.bilingualDone = 'loading';
  assert.deepEqual(h.selected(), []);
});

test('summary containers with nested divs select only the text span', () => {
  const h = harness('www.wsj.com');
  const card = h.root.appendChild(h.element('div'));
  card.appendChild(h.element('h3', title));
  const deck = card.appendChild(h.element('div', '', { 'data-component': 'summary' }));
  deck.appendChild(h.element('div')).appendChild(h.element('span', summary));
  assert.deepEqual(h.texts(), [title, summary]);
});

test('summary markers do not bypass navigation, promotional, or hidden-content filters', () => {
  const h = harness('www.wsj.com');
  const nav = h.root.appendChild(h.element('nav'));
  nav.appendChild(h.element('span', summary, { class: 'summary' }));
  const hidden = h.root.appendChild(h.element('span', summary, { class: 'summary' }));
  hidden.computed.display = 'none';
  h.root.appendChild(h.element('span', 'Sign up for our daily newsletter to keep up with the latest stories.', { class: 'summary' }));
  assert.deepEqual(h.selected(), []);
});

test('a summary-named card shell is not mistaken for a separate summary', () => {
  const h = harness('www.wsj.com');
  const card = h.root.appendChild(h.element('div', '', { class: 'SummaryCard' }));
  card.appendChild(h.element('h3', title));
  card.appendChild(h.element('p', summary));
  assert.deepEqual(h.texts(), [title, summary]);
});
