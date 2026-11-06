const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', '..', 'content.js'), 'utf8');

function harness(hostname = 'www.bloomberg.com', respond = message => ({ translations: message.texts.map(text => `译文：${text}`) })) {
  const observers = [];
  const timeouts = new Map();
  const intervals = new Map();
  const calls = [];
  let timerId = 0;
  let onMessage;
  function notify(record) {
    queueMicrotask(() => {
      for (const observer of observers) {
        if (observer.target && (observer.target === record.target ||
            (observer.options.subtree && observer.target.contains(record.target)))) observer.callback([record]);
      }
    });
  }
  function descendants(node) {
    return node.children.flatMap(child => [child, ...descendants(child)]);
  }
  function element(tag, text = '', attrs = {}, display) {
    const node = {
      nodeType: 1, tagName: tag.toUpperCase(), textContent: text, attrs: { ...attrs }, children: [],
      dataset: {}, parentNode: null, id: attrs.id || '', className: attrs.class || '',
      get childNodes() {
        if (this.nodeType === 3) return [];
        if (!this.textContent) return this.children;
        if (!this.fixtureText) {
          const owner = this;
          this.fixtureText = {
            nodeType: 3, parentNode: owner, parentElement: owner,
            get nodeValue() { return owner.textContent; },
            get nextSibling() { return owner.children[0] || null; }
          };
        }
        return [this.fixtureText, ...this.children];
      },
      style: { setProperty(name, value) { this[name] = value; } },
      computed: { display: display || (['a', 'span'].includes(tag) ? 'inline' : 'block'), visibility: 'visible',
        maxWidth: 'none', fontSize: '16px', color: 'rgb(34, 34, 34)' },
      get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; },
      get isConnected() { return this.host ? this.host.isConnected : this === document.body || !!this.parentNode?.isConnected; },
      get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; },
      get previousSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) - 1] || null; },
      getRootNode() { return this.parentNode ? this.parentNode.getRootNode() : this.host ? this : document; },
      get classList() { return { contains: name => this.className.split(' ').includes(name) }; },
      getAttribute(name) {
        if (name === 'data-bilingual-done') return this.dataset.bilingualDone ?? null;
        return name === 'class' ? this.className : this.attrs[name] ?? null;
      },
      setAttribute(name, value) { this.attrs[name] = value; },
      removeAttribute(name) { delete this.attrs[name]; },
      addEventListener() {},
      matches(selector) {
        return selector.split(',').some(part => {
          const s = part.trim();
          if (s === '*') return true;
          if (s.startsWith('.')) return this.classList.contains(s.slice(1));
          const match = s.match(/^([a-z0-9]+)?(?:\[([\w-]+)(\*?=)?(?:"([^"]*)")?\])?$/i);
          if (!match) throw new Error(`Unsupported fixture selector: ${s}`);
          const [, tagName, attr, op, value] = match;
          if (tagName && this.tagName !== tagName.toUpperCase()) return false;
          if (!attr) return true;
          const actual = this.getAttribute(attr);
          return op === '*=' ? actual?.includes(value) : op === '=' ? actual === value : actual !== null;
        });
      },
      closest(selector) {
        for (let n = this; n; n = n.parentElement) if (n.matches(selector)) return n;
        return null;
      },
      contains(other) { return other === this || descendants(this).includes(other); },
      querySelectorAll(selector) { return descendants(this).filter(child => child.nodeType === 1 && child.matches(selector)); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      appendChild(child) { return this.insertBefore(child, null); },
      insertBefore(child, next) {
        child.remove();
        child.parentNode = this;
        const index = next ? this.children.indexOf(next) : this.children.length;
        this.children.splice(index, 0, child);
        notify({ type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
        return child;
      },
      remove() {
        if (!this.parentNode) return;
        const parent = this.parentNode;
        parent.children.splice(parent.children.indexOf(this), 1);
        this.parentNode = null;
        notify({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] });
      },
      attachShadow() {
        const root = element('shadow-root');
        root.nodeType = 11;
        root.host = this;
        this.shadowRoot = root;
        return root;
      },
      getBoundingClientRect: () => ({ left: 0, right: 600, width: 600, height: 40 }),
      compareDocumentPosition(other) {
        if (this.getRootNode() !== other.getRootNode()) return 3;
        const root = this.getRootNode();
        const nodes = descendants(root === document ? document.body : root);
        return nodes.indexOf(this) < nodes.indexOf(other) ? 4 : 2;
      }
    };
    return node;
  }
  const document = {
    body: element('body'),
    createElement: element,
    createTextNode(text) {
      const node = element('text', text);
      node.nodeType = 3;
      Object.defineProperty(node, 'nodeValue', { get() { return this.textContent; } });
      return node;
    },
    createRange() {
      let target, offset, after;
      return {
        setStart(node, index) { target = node; offset = index; after = false; },
        setStartAfter(node) { target = node; after = true; },
        collapse() {},
        insertNode(anchor) {
          const parent = target.parentNode;
          if (after && parent.children.includes(target)) {
            parent.insertBefore(anchor, target.nextSibling);
            return;
          }
          const text = target.nodeValue;
          const index = after ? text.length : offset;
          const next = target.nextSibling;
          if (parent.fixtureText === target) parent.textContent = text.slice(0, index);
          else target.textContent = text.slice(0, index);
          parent.insertBefore(anchor, next);
          if (index < text.length) parent.insertBefore(document.createTextNode(text.slice(index)), next);
        }
      };
    },
    querySelectorAll(selector) { return this.body.querySelectorAll(selector); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    createTreeWalker(root, _type, filter) {
      const textNodes = node => node.nodeType === 3 ? [node] : node.childNodes.flatMap(textNodes);
      const texts = textNodes(root);
      const accepted = texts.filter(n => filter.acceptNode(n) === 1);
      return { nextNode: () => accepted.shift() || null };
    }
  };
  const logs = [];
  const context = {
    document, location: { hostname }, performance,
    setTimeout(fn, delay) { const id = ++timerId; timeouts.set(id, { fn, delay }); return id; },
    clearTimeout: id => timeouts.delete(id),
    setInterval(fn, delay) { const id = ++timerId; intervals.set(id, { fn, delay }); return id; },
    clearInterval: id => intervals.delete(id),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; }
      disconnect() { this.target = null; }
    },
    window: { getComputedStyle: node => node.computed, addEventListener() {}, removeEventListener() {} },
    console: { log: message => logs.push(message), warn: message => logs.push(message), error: message => logs.push(message) },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_DISCONNECTED: 1 },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    chrome: { runtime: { onMessage: { addListener(fn) { onMessage = fn; } },
      getURL: file => `chrome-extension://fixture/${file}`,
      sendMessage(message, callback) {
        if (message.action === 'keepAlive') { callback({ alive: true }); return; }
        calls.push(message);
        Promise.resolve(respond(message, calls.length)).then(callback);
      }
    } }
  };
  vm.runInNewContext(code.replace(/\n} \/\/ end non-youtube guard/, `
    globalThis.api = { getTranslatableElements, getVisibleText, runTranslation, pageState,
      clearAll, toggleVisibility, applyTranslation, translationNodes };
  } // end non-youtube guard`), context);
  const root = document.body.appendChild(element('main'));
  return {
    ...context.api, element, root, logs, calls, document,
    edit(el, text) {
      el.textContent = text;
      notify({ type: 'characterData', target: { nodeType: 3, parentElement: el } });
      // 测试 DOM 的 contains 不包含合成 Text 节点，用等效 childList 通知父容器。
      notify({ type: 'childList', target: el, addedNodes: [{ nodeType: 3 }], removedNodes: [] });
    },
    changeVisibility(el, visible) {
      el.computed.display = visible ? 'block' : 'none';
      notify({ type: 'attributes', target: el });
    },
    message: msg => onMessage(msg, {}, () => {}),
    tickDiscovery() { for (const timer of intervals.values()) if (timer.delay === 2000) timer.fn(); },
    async flush() {
      for (let step = 0; step < 100; step++) {
        await Promise.resolve();
        for (const [id, timer] of timeouts) {
          if (timer.delay > 2000) continue;
          timeouts.delete(id);
          timer.fn();
        }
      }
    },
    blocks: () => Array.from(context.api.translationNodes('.bilingual-block')),
    selected: () => Array.from(context.api.getTranslatableElements()),
    texts: () => Array.from(context.api.getTranslatableElements(), el => context.api.getVisibleText(el))
  };
}

module.exports = { harness };
