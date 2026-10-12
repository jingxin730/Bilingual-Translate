const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function harness() {
  const observers = [];
  const listeners = new Map();
  const allNodes = [];
  function element(tag = 'div', left = 0, width = 1000) {
    const node = {
      tagName: tag.toUpperCase(), children: [], style: {}, dataset: {}, className: '',
      parentNode: null, textContent: '', connected: false,
      computed: { display: 'block', maxWidth: 'none', fontSize: '20px' },
      rect: { left, right: left + width, width, height: 40 },
      get parentElement() { return this.parentNode; },
      get isConnected() { return this.parentNode ? this.parentNode.isConnected : this.connected; },
      get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; },
      get previousSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) - 1] || null; },
      get classList() { return { contains: name => this.className.split(' ').includes(name) }; },
      setAttribute() {},
      getBoundingClientRect() { return this.rect; },
      appendChild(child) { return this.insertBefore(child, null); },
      insertBefore(child, next) {
        child.remove();
        child.parentNode = this;
        const index = next ? this.children.indexOf(next) : this.children.length;
        this.children.splice(index, 0, child);
        return child;
      },
      remove() {
        if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
      },
      querySelector(selector) {
        for (const child of this.children) {
          if (child.className === selector.slice(1)) return child;
          const found = child.querySelector(selector);
          if (found) return found;
        }
        return null;
      }
    };
    allNodes.push(node);
    return node;
  }
  const document = {
    createElement: element,
    querySelectorAll(selector) {
      return allNodes.filter(node => node.isConnected && (selector.startsWith('[data-')
        ? node.dataset.bilingualDone !== undefined
        : selector.split(', ').some(cls => node.className === cls.slice(1))));
    },
    createTreeWalker(root, _type, filter) {
      const texts = [];
      function walk(node) {
        if (node.textContent) {
          const text = { parentElement: node, nodeValue: node.textContent };
          if (filter.acceptNode(text) === 1) texts.push(text);
        }
        node.children.forEach(walk);
      }
      walk(root);
      return { nextNode: () => texts.shift() || null };
    }
  };
  const context = {
    document, location: { hostname: 'www.bloomberg.com' }, console,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    window: {
      getComputedStyle: node => node.computed,
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: name => listeners.delete(name)
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    },
    clearInterval() {},
    chrome: { runtime: { onMessage: { addListener() {} } } }
  };
  vm.runInNewContext(code.replace(/\n} \/\/ end non-youtube guard/, `
    globalThis.api = { applyTranslation, repairLostBlocks, clearAll, toggleVisibility, getVisibleText };
  } // end non-youtube guard`), context);
  const parent = element('article');
  parent.connected = true;
  const anchor = element('p');
  anchor.textContent = 'Original paragraph with enough text to translate.';
  parent.appendChild(anchor);
  return {
    ...context.api, parent, anchor, element, listeners,
    block: () => allNodes.find(node => node.className === 'bilingual-block'),
    mutate: () => observers.filter(observer => observer.active).forEach(observer => observer.callback())
  };
}

test('centered article paragraphs retain their own reading column', () => {
  const h = harness();
  h.anchor.rect = { left: 200, right: 800, width: 600, height: 40 };
  assert.equal(h.applyTranslation(h.anchor, '译文内容'), true);
  assert.equal(h.block().parentNode, h.anchor);
  assert.equal(h.getVisibleText(h.anchor), h.anchor.textContent);
  const block = h.block();
  block.remove();
  assert.equal(h.repairLostBlocks(), 1);
  assert.equal(block.parentNode, h.anchor);
  assert.equal(h.block(), block);
});

test('max-width remains attached even when a narrow viewport fills the parent', () => {
  const h = harness();
  h.anchor.computed.maxWidth = '600px';
  h.applyTranslation(h.anchor, '译文内容');
  assert.equal(h.block().parentNode, h.anchor);
});

test('paragraph padding and indentation also constrain translation placement', () => {
  const h = harness();
  h.anchor.computed.paddingLeft = '80px';
  h.applyTranslation(h.anchor, '译文内容');
  assert.equal(h.block().parentNode, h.anchor);
});

test('a full-width paragraph within a padded container keeps a sibling translation', () => {
  const h = harness();
  h.parent.computed.paddingLeft = h.parent.computed.paddingRight = '20px';
  h.parent.computed.borderLeftWidth = h.parent.computed.borderRightWidth = '2px';
  h.anchor.rect = { left: 22, right: 978, width: 956, height: 40 };
  h.applyTranslation(h.anchor, '译文内容');
  assert.equal(h.anchor.nextSibling, h.block());
  h.block().remove();
  h.mutate();
  assert.equal(h.anchor.nextSibling, h.block());
});

for (const display of ['grid', 'inline-grid', 'flex', 'inline-flex']) {
  test(`${display} articles preserve their layout item count when translating and repairing`, () => {
    const h = harness();
    h.parent.computed.display = display;
    h.applyTranslation(h.anchor, '译文内容');
    assert.equal(h.parent.children.length, 1);
    h.block().remove();
    h.repairLostBlocks();
    assert.equal(h.block().parentNode, h.anchor);
    assert.equal(h.parent.children.length, 1);
  });
}

test('responsive layout changes move existing translations into the paragraph without guard interference', () => {
  const h = harness();
  h.applyTranslation(h.anchor, '译文内容');
  assert.equal(h.anchor.nextSibling, h.block());
  h.anchor.rect = { left: 200, right: 800, width: 600, height: 40 };
  h.listeners.get('resize')();
  h.mutate();
  assert.equal(h.block().parentNode, h.anchor);
  h.anchor.rect = h.parent.rect;
  h.block().remove();
  h.repairLostBlocks();
  assert.equal(h.block().parentNode, h.anchor);
});

test('a repeated framework relocation stays inside the paragraph after repair', () => {
  const h = harness();
  h.applyTranslation(h.anchor, '译文内容');
  const other = h.element();
  h.parent.appendChild(other);
  for (let i = 0; i < 4; i++) {
    other.appendChild(h.block());
    h.mutate();
  }
  assert.equal(h.block().parentNode, h.anchor);
  h.block().remove();
  h.repairLostBlocks();
  assert.equal(h.block().parentNode, h.anchor);
});

test('visibility and clearing work for both placements without restoring cleared blocks', () => {
  for (const constrained of [false, true]) {
    const h = harness();
    if (constrained) h.anchor.computed.maxWidth = '600px';
    h.applyTranslation(h.anchor, '译文内容');
    h.toggleVisibility(false);
    assert.equal(h.block().style.display, 'none');
    h.toggleVisibility(true);
    assert.equal(h.block().style.display, '');
    h.clearAll();
    h.mutate();
    h.repairLostBlocks();
    assert.equal(h.block().isConnected, false);
    assert.equal(h.listeners.has('resize'), false);
    assert.equal(h.anchor.dataset.bilingualDone, undefined);
    assert.equal(h.anchor.textContent, 'Original paragraph with enough text to translate.');
  }
});
