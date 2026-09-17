'use strict';

// YouTube 由专门的 youtube.js 接管，正文翻译在此早退避免冲突
if (/(^|\.)youtube\.com$/i.test(location.hostname)) {
  // no-op
} else {

// ── 分批策略 ────────────────────────────────────────────────
// 批次之间不串行等待：CONCURRENCY 个「工作协程」各自取一批去发请求，
// 谁先返回谁先渲染，首批刻意小一点让第一段译文尽快出现。
// 实测：代理（code.newcli.com）的**总吞吐大致固定**（约 2.6s/段），提高并发并不增加
// 吞吐，只会让每条流变慢——并发 4 时 5 段一批要 58s，还撞上 Cloudflare 网关的 100s
// 上限（API 524）触发重试，单批一路劣化到 223s。所以宁可并发低、批次小：
// 总时长几乎不变，但单批稳定落在超时线内，且译文出现得更零碎、更连续。
const FIRST_BATCH_SIZE = 2;   // 首批段落数（主标题 + 副标题，最先出现）
const BATCH_SIZE = 4;         // 后续批次段落数（按 2.6s/段 估算 ≈ 10s，远离超时线）
const CONCURRENCY = 2;        // 同时在飞的请求数（>2 会触发代理拥塞）
const REQUEST_TIMEOUT = 60000; // 单请求客户端超时，必须短于网关的 100s，否则白等
const BATCH_RETRY = 2;        // 单批失败重试次数（失败只影响该批，不拖累整页）
const RETRY_DELAY = 800;      // 重试基准间隔，逐次递增（并发触发限流时能自己缓过来）
const TOPUP_ROUNDS = 4;       // 主轮后最多补漏几轮（React 重建节点/懒加载/译文被删）

const MIN_LENGTH = 15;
const LINK_RATIO_MAX = 0.6;   // 链接文字占比超过此值 → 导航/推广条，不翻
const DIGIT_RATIO_MAX = 0.3;  // 数字占比超过此值 → 行情/数据条，不翻
const CAPS_LABEL_MAX = 80;    // 全大写且短于此长度 → 栏目标签/按钮，不翻

// 语义化标签选择器（大多数网站用这些做段落）
const QUERY = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th';

// 块级标签集合——用于判断 div 是否为叶子容器
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main',
  'nav', 'ul', 'ol', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'form',
  'fieldset', 'details', 'summary', 'blockquote', 'figure', 'address',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
]);

// 排除这些容器标签内的元素（header 单独判断：见 isArticleHeader）
const EXCLUDED_TAGS = new Set(['nav', 'footer', 'aside', 'script', 'style', 'button',
  'input', 'textarea', 'select', 'code', 'pre', 'noscript']);

// 排除这些 ARIA 区域
const EXCLUDED_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary',
  'menu', 'menubar', 'tablist', 'search', 'dialog']);

// 提取文本时跳过这些子节点（避免广告位的 script 源码被当成正文）
const TEXT_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

// 排除这些 id 对应的区域（如 archive.md 顶部工具栏、分享弹窗）
const EXCLUDED_IDS = new Set(['HEADER', 'DIVSHARE']);

// 站点外壳的常见 class 特征（顶部行情条、面包屑、Cookie 条等）
// 【不要加 paywall】WSJ 用 class="paywall" 包住正文的付费部分（免费预览之后的全部段落），
// 加进来会导致正文从第 3 段起全部不翻——曾经踩过，靠"正文容器内被拦掉的长文本"日志才查出来。
const SHELL_CLASS_RE = /(ticker|marquee|breadcrumb|megamenu|dropdown|site-?nav|toolbar|cookie)/i;

// 正文容器：位于其中的内容不受"标题之上不翻"规则限制
const CONTENT_ROOT_SEL = 'article, main, [role="main"], [itemprop="articleBody"]';

let pageState = {
  translating: false,
  translated: false,
  stopped: false,
  visible: true,
  total: 0,
  done: 0,
  failed: 0,
  error: null
};

// 翻译轮次号：停止后重译、清除时递增，让上一轮在飞的批次自动作废
let runId = 0;

// 最后一次翻译用的模型/目标语言，单段重试按钮复用它
let lastRun = { provider: 'claude', targetLang: 'zh' };

// header 有两种：站点顶栏（不翻）与文章标题区（要翻——WSJ 的主标题/副标题就在这里）。
// 判据：内部有一个够长、且不是链接的 h1/h2 —— 站点顶栏的 h1 通常只是短 logo 文字。
const headerKindCache = new WeakMap();
function isArticleHeader(header) {
  const cached = headerKindCache.get(header);
  if (cached !== undefined) return cached;

  let isArticle = false;
  for (const h of header.querySelectorAll('h1, h2')) {
    if (getVisibleText(h).length >= 20 && linkTextRatio(h) < 0.5) {
      isArticle = true;
      break;
    }
  }
  headerKindCache.set(header, isArticle);
  return isArticle;
}

// allowHeader：标题元素（h1/h2）不受 header 限制，保证文章标题一定被翻译。
// 返回 null 表示不在排除区域，否则返回具体原因（命中的祖先 + 规则）——只统计
// "排除区域 N 个"查不出是哪条规则误伤，曾因此让整段正文漏译很久没定位到。
function excludedReason(el, allowHeader) {
  // class 猜测是"长得像站点外壳就不翻"的模糊规则，只在正文容器之外可靠。
  // 正文容器内命中基本都是误伤：WSJ 就用 class="paywall" 包住正文的付费部分。
  const softRules = !el.closest(CONTENT_ROOT_SEL);
  let node = el.parentElement;
  while (node && node !== document.body) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'header') {
      if (!allowHeader && !isArticleHeader(node)) return '站点 <header>';
    } else if (EXCLUDED_TAGS.has(tag)) {
      return `<${tag}>`;
    }
    const role = node.getAttribute?.('role');
    if (role && EXCLUDED_ROLES.has(role)) return `role="${role}"`;
    if (softRules) {
      // 排除已知 id 的"站点外壳"区域（如 archive.md 顶栏）
      if (node.id && EXCLUDED_IDS.has(node.id)) return `#${node.id}`;
      const cls = typeof node.className === 'string' ? node.className : '';
      const hit = cls && cls.match(SHELL_CLASS_RE);
      if (hit) return `class 含 "${hit[0]}"`;
    }
    node = node.parentElement;
  }
  return null;
}

function isMostlyChinese(text) {
  const zh = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
  return zh / text.length > 0.25;
}

// 链接文字占比：导航条、卡片列表、行情条基本都是 100% 链接文字
function linkTextRatio(el) {
  const total = getVisibleText(el).length;
  if (!total) return 0;
  let linked = 0;
  el.querySelectorAll('a').forEach(a => { linked += getVisibleText(a).length; });
  return Math.min(linked / total, 1);
}

// 行情条/数据条：数字占比过高（"Nikkei 63604.56 -0.64%"）
function isDataStrip(text) {
  const digits = (text.match(/[0-9]/g) || []).length;
  return digits / text.length > DIGIT_RATIO_MAX;
}

// 栏目标签、按钮文字：短且全大写（"SIGN-UP FOR THE FREE NEWSLETTER"）
function isCapsLabel(text) {
  if (text.length > CAPS_LABEL_MAX) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  return text === text.toUpperCase();
}

// 样板文字：混在正文容器里面的非正文内容——版权声明、评论入口、推荐位标题、
// 通讯推广。它们在 article 里面，排除不了区域也不是外壳 class，只能按文字认。
// 每条都必须锚定或足够独特：宁可漏拦一条垃圾，也不能误杀真正提到这些词的正文段落。
const BOILERPLATE_RE = [
  /^copyright\s*©/i,
  /all rights reserved/i,
  /^appeared in the .{0,60}print edition/i,                       // "Appeared in the September 14, 2026, print edition as..."
  /^this copy is for your personal, non-commercial use/i,
  /^(show|view|hide)\s+(conversation|comments)/i,                  // "Show Conversation (283)"
  /^(further reading|you may also like|most popular|more from)\b/i,
  /^related\s+(articles?|stories|reading|coverage|video)/i,
  /^recommended\s+(for you|videos?|reading)/i,
  /copied to clipboard/i                                          // "Embed code copied to clipboard"
];

// 这些特征在正文里也可能正常出现（"he publishes a daily newsletter about..."），
// 只在短文本上生效：推广条、按钮、栏目标签都很短，成段正文几乎不可能这么短。
// 注意不能给 newsletter 那条加前置 \b —— 相邻行内元素的文字会被粘成
// "FREE EXPRESSIONA Daily Newsletter"，"A" 前面并没有词边界。
const BOILERPLATE_SHORT_MAX = 120;
const BOILERPLATE_SHORT_RE = [
  /a (daily|weekly|monthly) newsletter\b/i,                       // "A Daily Newsletter From WSJ Opinion"
  /\b(subscribe|sign up) (to|for) (our|the)\b/i,
  /\bnewsletter sign-?up\b/i
];

function isBoilerplate(text) {
  if (BOILERPLATE_RE.some(re => re.test(text))) return true;
  return text.length <= BOILERPLATE_SHORT_MAX && BOILERPLATE_SHORT_RE.some(re => re.test(text));
}

// 返回 null 表示正常显示，否则返回不显示的原因
function hiddenReason(el) {
  if (el.getAttribute('aria-hidden') === 'true') return '隐藏';
  const cs = window.getComputedStyle(el);
  // 不看 opacity：有站点让正文滚动淡入，初始 opacity 为 0
  if (cs.display === 'none' || cs.visibility === 'hidden') return '隐藏';
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return '零尺寸';
  return null;
}

// 判断 div 是否为叶子文本容器（不含可见块级子元素）
function isLeafDiv(el) {
  for (const child of el.children) {
    // 子树含 script/style 的 div 多半是广告/嵌入位，跳过
    if (TEXT_SKIP_TAGS.has(child.tagName) || child.querySelector('script, style, noscript, template')) return false;
    // display:none 的子元素不算（经济学人广告占位 div）
    const cs = window.getComputedStyle(child);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (BLOCK_TAGS.has(child.tagName.toLowerCase())) return false;
  }
  return true;
}

// 我们自己插进页面的节点。grid/flex 站点（WSJ）的译文块是插在原文段落**内部**的，
// 失败标记和 loading 占位也一样，所以提取原文时必须跳过它们——否则重译时会把
// 上一次的译文、"译文失败"这几个字一起当成原文发给模型。
function isOwnNode(node) {
  const cls = node.classList;
  return !!cls && (cls.contains('bilingual-block') ||
    cls.contains('bilingual-loading') || cls.contains('bilingual-failed'));
}

// 提取元素的可见文本（跳过 script/style 与我们自己插入的节点）
function getVisibleText(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement;
      while (p && p !== el) {
        if (TEXT_SKIP_TAGS.has(p.tagName) || isOwnNode(p)) return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let out = '';
  let node;
  while ((node = walker.nextNode())) out += node.nodeValue;
  return out.trim().replace(/\s+/g, ' ');
}

// 文章主标题：够长、非链接的第一个 h1（站点 logo 型 h1 通常很短）。
// 优先在正文容器里找 —— 侧栏「相关文章」也可能有长 h1，若选中它，
// 整篇正文都会排在"主标题之上"而被误杀。
function findHeadline() {
  const roots = document.querySelectorAll(CONTENT_ROOT_SEL);
  const pick = list => {
    for (const h of list) {
      const text = getVisibleText(h);
      if (text.length >= 20 && !isMostlyChinese(text) && linkTextRatio(h) < 0.5 && !hiddenReason(h)) {
        return h;
      }
    }
    return null;
  };
  for (const root of roots) {
    const h = pick(root.querySelectorAll('h1'));
    if (h) return h;
  }
  return pick(document.querySelectorAll('h1'));
}

function getTranslatableElements() {
  const seen = new Set();
  const result = [];
  const headline = findHeadline();
  // 各条规则拦掉了多少个候选 —— 排查"某段为什么没翻译"时看这个
  const stats = { 已处理: 0, 译文丢失: 0, 标题之上: 0, 排除区域: 0, 链接内: 0, 太短: 0, 中文: 0, 全大写: 0, 样板文字: 0, 数字条: 0, 链接密度: 0, 隐藏: 0, 零尺寸: 0, 嵌套: 0 };
  const bodyDrops = [];   // 正文容器内被拦掉的长文本——漏译的元凶都在这里

  function tryAdd(el) {
    if (seen.has(el)) return;
    if (el.closest('.bilingual-block')) return;

    // 拦掉一个候选。若它在正文容器内且是成段长文本，几乎必然是误伤 —— 单独打出来，
    // 这样"某段为什么没翻译"不用再靠猜（太短的不记：<15 字符不可能是正文段落）。
    // detail 说明是哪条规则命中的，否则同一个"排除区域"里分不清是哪个祖先干的。
    const drop = (reason, text, detail) => {
      stats[reason]++;
      if (bodyDrops.length < 15 && el.closest(CONTENT_ROOT_SEL)) {
        const t = text ?? getVisibleText(el);
        if (t.length >= 40) {
          bodyDrops.push(`  ${reason}${detail ? `(${detail})` : ''}｜<${el.tagName.toLowerCase()}> ${t.slice(0, 70)}`);
        }
      }
    };

    if (el.dataset.bilingualDone) {
      // 'done' 但译文块已被框架删掉 → 用户看到的就是"没翻译"，放行重翻
      if (el.dataset.bilingualDone === 'done' && translationLost(el)) {
        stats.译文丢失++;
        delete el.dataset.bilingualDone;
      } else {
        stats.已处理++;
        return;
      }
    }

    // 站点外壳（顶栏、行情条、推广条）总在文章主标题之上，一律不翻；
    // 正文容器内的元素不受此限，避免误伤没有典型页头的页面
    if (headline && el !== headline &&
        (headline.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) &&
        !el.closest(CONTENT_ROOT_SEL)) { stats.标题之上++; return; }

    const isHeading = el.tagName === 'H1' || el.tagName === 'H2';
    const excluded = excludedReason(el, isHeading);
    if (excluded) { drop('排除区域', undefined, excluded); return; }
    // 整块包在链接里的文字是导航项/卡片/行情条（标题偶尔自链接，故放行）
    if (!isHeading && el.closest('a[href]')) { drop('链接内'); return; }

    const text = getVisibleText(el);
    if (text.length < MIN_LENGTH) { stats.太短++; return; }
    if (isMostlyChinese(text)) { drop('中文', text); return; }
    if (isCapsLabel(text)) { drop('全大写', text); return; }
    if (isBoilerplate(text)) { drop('样板文字', text); return; }
    if (isDataStrip(text)) { drop('数字条', text); return; }
    if (linkTextRatio(el) > LINK_RATIO_MAX) { drop('链接密度', text); return; }
    const hidden = hiddenReason(el);
    if (hidden) { drop(hidden, text); return; }

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

  // 按文档顺序排列：首批就是标题和开头段落，译文自上而下逐段出现
  result.sort((a, b) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);

  // 外层容器让位给更细的内层元素（如 li 里还有 p），避免同段文字翻两遍
  const kept = new Set(result);
  for (const el of result) {
    let p = el.parentElement;
    while (p) {
      if (kept.has(p)) kept.delete(p);
      p = p.parentElement;
    }
  }
  stats.嵌套 = result.length - kept.size;

  const skipped = Object.entries(stats).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join('，');
  console.log(`[双语翻译] 选中 ${kept.size} 段${skipped ? `；跳过：${skipped}` : ''}${headline ? `；主标题「${getVisibleText(headline).slice(0, 30)}」` : '；未识别到主标题'}`);
  if (bodyDrops.length) {
    console.warn(`[双语翻译] 正文容器内被拦掉的长文本（${bodyDrops.length} 条，漏译元凶通常在此）：\n${bodyDrops.join('\n')}`);
  }

  const finalList = result.filter(el => kept.has(el));
  // 逐条列出选中的段落。最后一条是不是文章真正的末段，一眼就能判断
  // "选中 N 段"是全文还是只覆盖了开头——不用再靠猜。
  if (finalList.length) {
    console.log(`[双语翻译] 选中的 ${finalList.length} 段（按文档顺序）：\n` +
      finalList.map((el, i) =>
        `  ${String(i + 1).padStart(2)}. <${el.tagName.toLowerCase()}> ${getVisibleText(el).slice(0, 65)}`
      ).join('\n'));
  }

  return finalList;
}

// 记录每段原文对应的译文块。WSJ 等 React 站点会在水合/重渲染时把译文块删掉，
// 而原文段落上的 dataset.bilingualDone 还是 'done'，补漏轮就会把它当"已处理"永久跳过
// ——表现正是"这一段没翻译，也没有 loading，也没有失败标记"。
// 注意 grid/flex 站点（WSJ）走的是 appendChild 分支，那条路径上没有
// guardSiblingPlacement 守护，所以必须靠这里兜住。
const appliedBlocks = new WeakMap();   // anchor -> block，按元素查
const trackedPairs = new Set();        // {anchor, block}，可遍历，用于批量修复

const REPAIR_WINDOW = 30000;   // 收尾后继续守护多久（React 水合往往晚于翻译完成）
const REPAIR_INTERVAL = 1000;
let repairTimer = null;

// 译文是否还在页面上。只看 isConnected：被框架移到别处仍然算在（用户看得见），
// 只有真被删除才算丢失，避免误判导致同一段翻两遍。
function translationLost(el) {
  const block = appliedBlocks.get(el);
  return !block || !block.isConnected;
}

// 把被框架删掉的译文块塞回去。复用原来的块，不需要重新请求 API——所以极便宜。
function repairLostBlocks() {
  let repaired = 0;
  for (const pair of trackedPairs) {
    const { anchor, block } = pair;
    if (!anchor.isConnected) { trackedPairs.delete(pair); continue; }  // 原文都没了，交给补漏轮
    if (block.isConnected) continue;
    const parent = anchor.parentElement;
    if (!parent) continue;
    const display = window.getComputedStyle(parent).display;
    if (/grid|flex/.test(display)) anchor.appendChild(block);
    else parent.insertBefore(block, anchor.nextSibling);
    repaired++;
  }
  return repaired;
}

// 从翻译一开始就守护，而不是等收尾——某一批卡在重试时（曾见 60s+），
// 其它批次已经写好的译文若被框架删掉，不该干等到那一批结束才修。
// 翻译期间持续续期，收尾后再多守 REPAIR_WINDOW。
function startRepairWatchdog() {
  if (repairTimer) return;
  let until = Date.now() + REPAIR_WINDOW;
  let total = 0;
  repairTimer = setInterval(() => {
    if (pageState.translating) until = Date.now() + REPAIR_WINDOW;
    if (Date.now() > until) {
      clearInterval(repairTimer);
      repairTimer = null;
      if (total) console.log(`[双语翻译] 守护期内修复了 ${total} 处被页面删掉的译文`);
      return;
    }
    total += repairLostBlocks();
  }, REPAIR_INTERVAL);
}

// ── 等页面稳定下来再开工 ─────────────────────────────────────
// WSJ 这类站点在加载后一两秒内会用 React 水合替换正文节点。若在替换前就取到元素引用，
// 译文会被写进已经被丢弃的旧节点：applyTranslation 报告成功（旧节点当时仍 isConnected），
// 但页面上换成了新节点，既没有译文也没有 loading —— 表现为"后边根本没处理"。
const SETTLE_QUIET = 800;   // 正文连续这么久没有 DOM 变动就算稳定
const SETTLE_MAX = 5000;    // 最多等这么久，避免死等不停打广告的页面

function waitForDomSettle() {
  const root = document.querySelector(CONTENT_ROOT_SEL) || document.body;
  return new Promise(resolve => {
    let quietTimer;
    let deadline;
    const obs = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, SETTLE_QUIET);
    });
    function finish() {
      clearTimeout(deadline);
      clearTimeout(quietTimer);
      obs.disconnect();
      resolve();
    }
    obs.observe(root, { childList: true, subtree: true });
    quietTimer = setTimeout(finish, SETTLE_QUIET);
    deadline = setTimeout(finish, SETTLE_MAX);
  });
}

// ── Service Worker 心跳 ─────────────────────────────────────
// MV3 的后台 Service Worker 空闲约 30s 会被 Chrome 回收；流式 fetch 在等首个 chunk
// 期间不算"活动"。SW 被回收时正在等待的 sendResponse 永远不会被调用，这一批（乃至
// 整轮）就会一起卡死到超时。翻译期间每 20s 发一次消息，把回收计时器顶回去。
const KEEPALIVE_INTERVAL = 20000;
let keepAliveTimer = null;

// 心跳是全局共享的，持有者却可能有多个（整页翻译 + 若干并发的单段重试）。
// 必须计数：否则先结束的那个会在 finally 里把还在等待的请求的心跳一起掐掉，
// SW 随即被回收，那个请求的 sendResponse 永不调用 → 白等到超时。
// 用令牌而不是计数器，是因为释放必须幂等：clearAll 会强制清空所有持有者，
// 之后旧一轮的 finally 仍会执行一次释放——计数器会被它减到 0，把新一轮
// 刚建立的心跳误杀；令牌只删自己那一个，早已被清掉就是无操作。
const keepAliveHolders = new Set();

function startKeepAlive() {
  const token = {};
  keepAliveHolders.add(token);
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(() => {
      // 忽略 lastError：SW 正在重启时这条会失败，下一次心跳会补上
      chrome.runtime.sendMessage({ action: 'keepAlive' }, () => void chrome.runtime.lastError);
    }, KEEPALIVE_INTERVAL);
  }
  return token;
}

// token 传 true 表示强制释放全部持有者（清除/重置时用）
function stopKeepAlive(token) {
  if (token === true) keepAliveHolders.clear();
  else keepAliveHolders.delete(token);
  if (!keepAliveHolders.size && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
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

  // 页面在翻译期间重建了这个节点（React 水合、懒加载），写进去也看不见 —— 交给补漏轮次
  if (!el.isConnected || !el.parentElement) {
    el.dataset.bilingualDone = 'detached';
    return false;
  }

  if (!text?.trim()) {
    el.dataset.bilingualDone = 'skip';
    return false;
  }

  const block = document.createElement('div');
  block.className = 'bilingual-block';
  block.setAttribute('aria-label', '译文');
  // 译文字号跟随原文
  block.style.fontSize = window.getComputedStyle(el).fontSize;

  const span = document.createElement('div');
  span.className = 'bilingual-text';
  span.textContent = text;

  block.appendChild(span);

  // 默认插入为兄弟节点（对 Obsidian Web Clipper 等 HTML→Markdown 转换器更友好）
  // 但如果父容器是 grid/flex 布局，多出兄弟节点会破坏列宽计算（如 WSJ 文章页）
  // 此时回退到子节点插入，保持网格单元数不变
  const parentDisplay = window.getComputedStyle(el.parentElement).display;
  const mustAppendInside = parentDisplay === 'grid' || parentDisplay === 'inline-grid' ||
      parentDisplay === 'flex' || parentDisplay === 'inline-flex';
  if (mustAppendInside) {
    el.appendChild(block);
  } else {
    el.parentNode.insertBefore(block, el.nextSibling);
    // 监视 React/Vue 等框架的协调操作。若译文块被移走（substack/newsletter 等
    // 站点会在水合或重渲染时把"非受控"节点统一推到容器末尾），就把它放回去；
    // 若反复被抢，则退回子节点插入，让框架不再把它视为容器的多余兄弟。
    guardSiblingPlacement(el, block);
  }
  el.dataset.bilingualDone = 'done';
  appliedBlocks.set(el, block);
  trackedPairs.add({ anchor: el, block });
  return true;
}

// 共享 observer 注册表：parent -> { observer, watchers: Map<anchor, {block, bounces}> }
const parentObservers = new WeakMap();

function guardSiblingPlacement(anchor, block) {
  const parent = anchor.parentNode;
  if (!parent) return;

  let registry = parentObservers.get(parent);
  if (!registry) {
    registry = { observer: null, watchers: new Map() };
    const observer = new MutationObserver(() => {
      for (const [a, info] of registry.watchers) {
        const b = info.block;
        const dislocated = !b.isConnected || b.previousSibling !== a;
        if (!dislocated) continue;

        if (info.bounces++ < 3 && a.isConnected && a.parentNode === parent) {
          // 拽回原位
          parent.insertBefore(b, a.nextSibling);
        } else {
          // 反复被框架抢——改成 anchor 的子节点，让框架不再把它视作多余兄弟
          if (b.isConnected) b.remove();
          if (a.isConnected) a.appendChild(b);
          registry.watchers.delete(a);
        }
      }
      if (registry.watchers.size === 0) {
        observer.disconnect();
        parentObservers.delete(parent);
      }
    });
    observer.observe(parent, { childList: true });
    registry.observer = observer;
    parentObservers.set(parent, registry);
  }

  registry.watchers.set(anchor, { block, bounces: 0 });
}

// 把错误压成能塞进按钮的短标签，让用户不开 devtools 也知道是哪类问题
function shortReason(message = '') {
  // 重载扩展但没刷新页面时，页面里的 content script 已成孤儿，任何请求都发不出去
  if (/Extension context invalidated|message port closed|Receiving end does not exist/i.test(message)) {
    return '扩展已重载·请刷新页面';
  }
  if (/524/.test(message)) return '网关超时';
  const api = message.match(/API (\d{3})/);
  if (api) return `API ${api[1]}`;
  if (/超时/.test(message)) return '超时';
  if (/未返回|没有返回/.test(message)) return '无译文';
  if (/重建/.test(message)) return '段落已变';
  return '';
}

function failedLabel(message) {
  const r = shortReason(message);
  return `译文失败${r ? `(${r})` : ''} ↻ 重试`;
}

// 失败段落后面的重试入口。整页重译代价太大（还会把已有译文全清掉），
// 单段失败就该能单段补——尤其是模型偶尔漏返回某一段的情况。
function buildRetryButton(el, message) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bilingual-failed';
  btn.textContent = failedLabel(message);
  btn.title = `[双语翻译] ${message || '未知错误'}\n点击只重新翻译这一段`;
  btn.addEventListener('click', ev => {
    ev.preventDefault();
    ev.stopPropagation();   // 段落常整块可点（图注、卡片），别顺带触发页面自己的跳转
    retryElement(el, btn);
  });
  return btn;
}

// 单段重试：不进批次队列、不改 pageState.translating，所以整页翻译早已结束后
// 也能随时点。用最后一次翻译选定的模型和目标语言。
//
// 【必须多试几次，别只发一次】这个代理的实测行为是：第一次请求经常直接挂死、
// 永不返回，重试一次就能在 25~30s 内成功（从日志反算：批 3/4 总耗时 89.8s =
// 60s 空等 + 0.8s 退避 + 29s 真正成功的那次）。批次路径靠 BATCH_RETRY 扛住了这点，
// 早期版本的重试按钮只发一次请求，于是几乎每次都撞在挂死的首次尝试上，从来没成功过。
const MANUAL_RETRY_ATTEMPTS = 3;
// 单段只有一句话，成功的调用远快于整批；超时设短点，好把 3 次尝试压在能忍的等待里
const MANUAL_RETRY_TIMEOUT = 40000;

async function retryElement(el, btn) {
  if (btn.dataset.busy) return;
  btn.dataset.busy = '1';
  btn.disabled = true;

  const source = getVisibleText(el);   // 取一次就好：期间 DOM 里会多出译文块
  let lastErr;
  let fatal = false;   // 再试也不会变的错误（段落已脱离 DOM、扩展已重载）

  const keepAlive = startKeepAlive();   // 单个请求也会撞上 Service Worker 回收
  try {
    for (let attempt = 1; attempt <= MANUAL_RETRY_ATTEMPTS; attempt++) {
      // 进度写在按钮上，否则等待几十秒的按钮看起来像卡死了
      btn.textContent = `重试中… ${attempt}/${MANUAL_RETRY_ATTEMPTS}`;
      try {
        const [text] = await sendTranslateRequest(
          [source], lastRun.provider, lastRun.targetLang, MANUAL_RETRY_TIMEOUT);
        if (!text?.trim()) throw new Error('模型没有返回这一段的译文');

        delete el.dataset.bilingualDone;
        // 先渲染再撤按钮：渲染失败时按钮还在原位，能接着点
        if (!applyTranslation(el, text)) {
          fatal = true;   // 只可能是 detached：这个节点已被页面丢弃，重试多少次都白费
          throw new Error('这一段已被页面重建，请整页重译');
        }
        btn.remove();
        pageState.failed = Math.max(0, pageState.failed - 1);
        console.log(`[双语翻译] 单段重试成功（第 ${attempt} 次尝试）：${source.slice(0, 40)}`);
        return;
      } catch (err) {
        lastErr = err;
        if (/Extension context invalidated/i.test(err.message)) fatal = true;
        console.warn(`[双语翻译] 单段重试第 ${attempt}/${MANUAL_RETRY_ATTEMPTS} 次失败: ${err.message}`);
        if (fatal) break;
        if (attempt < MANUAL_RETRY_ATTEMPTS) {
          await new Promise(r => setTimeout(r, RETRY_DELAY * attempt));
        }
      }
    }

    const msg = lastErr?.message || '未知错误';
    console.error(`[双语翻译] 单段重试失败: ${msg}`);
    if (!btn.isConnected) return;   // 段落已被页面换掉，按钮跟着没了
    btn.disabled = false;
    delete btn.dataset.busy;
    btn.textContent = failedLabel(msg);
    btn.title = `[双语翻译] ${msg}\n${fatal ? '这类错误重试无效' : `已连续尝试 ${MANUAL_RETRY_ATTEMPTS} 次`}\n点击只重新翻译这一段`;
  } finally {
    stopKeepAlive(keepAlive);   // 令牌式，不会掐掉其它还在等待的请求
  }
}

function markError(el, message) {
  el.querySelector('.bilingual-loading')?.remove();
  el.dataset.bilingualDone = 'error';
  // 失败要看得见，否则表现就是"这一段莫名其妙没翻译"；并且要能一键单段重试
  if (el.isConnected && !el.querySelector('.bilingual-failed')) {
    el.appendChild(buildRetryButton(el, message));
  }
}

// 带客户端超时：网关 524 要等满 100s 才回，白占一个工作协程。
// 主动在 60s 放弃并重试，通常重试很快就成功，最坏情况也被限制住。
// （后台的 fetch 无法从这里中止，那次请求会继续跑完但结果被丢弃）
async function sendTranslateRequest(texts, provider, targetLang, timeout = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`请求超时（${Math.round(timeout / 1000)}s 未返回）`));
    }, timeout);

    chrome.runtime.sendMessage(
      { action: 'translate', texts, provider, targetLang },
      resp => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (resp?.error) return reject(new Error(resp.error));
        resolve(resp?.translations || new Array(texts.length).fill(''));
      }
    );
  });
}

// 首批小、后续大：首屏译文来得快，整体请求数又不至于太多
function buildBatches(elements) {
  const batches = [];
  let i = 0;
  let size = FIRST_BATCH_SIZE;
  while (i < elements.length) {
    batches.push(elements.slice(i, i + size));
    i += size;
    size = BATCH_SIZE;
  }
  return batches;
}

// 一个批次的完整生命周期：请求（失败重试 → 仍失败则拆半重试）→ 渲染。
// 失败只标记本批的段落，其它批次照常完成。
// myRun：本批所属的翻译轮次；轮次已作废（停止后重译/清除）时丢弃结果，不写回页面。
// canSplit：允许在最终失败时拆成两半重试（拆出来的半批不再拆，避免无限递归）。
async function processBatch(batch, provider, targetLang, myRun, label, canSplit = true) {
  // 页面可能在排队期间重建了节点，写进去也看不见，交给补漏轮次处理
  const live = batch.filter(el => el.isConnected);
  if (!live.length) {
    console.warn(`[双语翻译] ${label} 的段落已被页面重建，跳过`);
    discardBatch(batch);
    pageState.done += batch.length;
    return;
  }

  const texts = live.map(el => getVisibleText(el));
  const t0 = performance.now();

  for (let attempt = 0; ; attempt++) {
    try {
      const translations = await sendTranslateRequest(texts, provider, targetLang);
      if (myRun !== runId) return discardBatch(batch);

      let applied = 0;
      const missing = [];   // 模型没返回译文的段落（编号没对齐 → 空串）
      live.forEach((el, j) => {
        try {
          if (applyTranslation(el, translations[j])) applied++;
          else if (el.dataset.bilingualDone === 'skip') missing.push(el);
          // 'detached' 的不管，交给补漏轮次
        } catch (e) {
          console.warn(`[双语翻译] ${label} 第 ${j + 1} 段渲染失败: ${e.message}`);
        }
      });
      console.log(`[双语翻译] ${label} 渲染 ${applied}/${live.length} 段，耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);

      if (!missing.length) {
        pageState.done += batch.length;
        return;
      }

      // 请求成功但模型漏了其中几段。这在页面上和翻译失败没有任何区别（既没译文
      // 也没标记），而补漏轮次会把它们当"已处理"永久跳过——所以必须在这里收拾。
      // 单独重发这几段，批小了编号通常就对齐了。
      if (canSplit && !pageState.stopped && myRun === runId) {
        console.warn(`[双语翻译] ${label} 有 ${missing.length} 段模型没返回译文，单独补译`);
        pageState.done += batch.length - missing.length;
        await processBatch(missing, provider, targetLang, myRun, `${label}·补译`, false);
        return;
      }

      missing.forEach(el => markError(el, '模型没有返回这一段的译文'));
      pageState.done += batch.length;
      pageState.failed += missing.length;
      return;
    } catch (err) {
      if (myRun !== runId) return discardBatch(batch);
      if (attempt < BATCH_RETRY && !pageState.stopped) {
        const wait = RETRY_DELAY * (attempt + 1);
        console.warn(`[双语翻译] ${label} 请求失败，${wait}ms 后重试: ${err.message}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.error(`[双语翻译] ${label} 最终失败: ${err.message}`);

      // 整批失败往往是这批太大（撞上网关超时）。拆成两半再试一次：
      // 串行跑，不额外增加在飞请求数——此刻正处在拥塞/超时的状态里。
      if (canSplit && live.length >= 2 && !pageState.stopped && myRun === runId) {
        const mid = Math.ceil(live.length / 2);
        console.warn(`[双语翻译] ${label} 拆半重试（${mid} + ${live.length - mid} 段）`);
        pageState.done += batch.length - live.length; // 已脱离 DOM 的那些先记账
        await processBatch(live.slice(0, mid), provider, targetLang, myRun, `${label}·前半`, false);
        await processBatch(live.slice(mid), provider, targetLang, myRun, `${label}·后半`, false);
        return;
      }

      live.forEach(el => markError(el, err.message));
      pageState.done += batch.length;
      pageState.failed += live.length;
      pageState.error = err.message;
      return;
    }
  }
}

// 作废批次：撤掉 loading 占位，让这些段落可以被下一轮重新选中
function discardBatch(batch) {
  batch.forEach(el => {
    el.querySelector('.bilingual-loading')?.remove();
    if (el.dataset.bilingualDone === 'loading') delete el.dataset.bilingualDone;
  });
}

// 撤掉残留的 loading（停止、或某批次异常退出后留下的），让它们能被重新选中
function clearStaleLoading() {
  const stale = document.querySelectorAll('[data-bilingual-done="loading"]');
  stale.forEach(el => {
    el.querySelector('.bilingual-loading')?.remove();
    delete el.dataset.bilingualDone;
  });
  return stale.length;
}

// 一组元素的分批并发翻译
async function translateElements(elements, provider, targetLang, myRun, tag) {
  elements.forEach(el => showLoading(el));
  const batches = buildBatches(elements);
  console.log(`[双语翻译] ${tag}：${elements.length} 段，分 ${batches.length} 批（首批 ${FIRST_BATCH_SIZE}，其余 ${BATCH_SIZE}），并发 ${CONCURRENCY}`);

  let cursor = 0;

  // 工作协程：取一批 → 发请求 → 回来立刻取下一批。
  // 因此第 1~CONCURRENCY 批几乎同时发出，不必等上一批返回。
  // 整个循环包 try/catch：任何意外都不能让协程死掉，否则后面的批次永远不会被取走。
  const worker = async () => {
    while (!pageState.stopped && myRun === runId) {
      const index = cursor++;
      if (index >= batches.length) return;
      const label = `${tag} 批 ${index + 1}/${batches.length}`;
      try {
        await processBatch(batches[index], provider, targetLang, myRun, label);
      } catch (err) {
        console.error(`[双语翻译] ${label} 意外异常，继续下一批: ${err.message}`, err);
        discardBatch(batches[index]);
        pageState.error = err.message;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker())
  );
}

async function runTranslation(provider, targetLang) {
  if (pageState.translating) return;
  lastRun = { provider, targetLang };   // 单段重试按钮沿用这一轮的选择

  // 先等正文稳定，否则拿到的是水合前的旧节点引用（译文会写进被丢弃的节点）
  const settleT0 = performance.now();
  await waitForDomSettle();
  console.log(`[双语翻译] 等待正文稳定 ${((performance.now() - settleT0) / 1000).toFixed(1)}s`);

  const elements = getTranslatableElements();
  if (!elements.length) {
    pageState.translated = true;
    console.log('[双语翻译] 没有找到可翻译的段落');
    return;
  }

  const myRun = ++runId;
  const keepAlive = startKeepAlive();   // 必须在任何请求发出前就顶住 SW
  startRepairWatchdog();     // 从一开始就守，别等某一批的重试结束
  Object.assign(pageState, {
    translating: true,
    translated: false,
    stopped: false,
    total: elements.length,
    done: 0,
    failed: 0,
    error: null
  });

  try {
    await translateElements(elements, provider, targetLang, myRun, '主轮');

    // 补漏：翻译期间页面可能重新渲染（React 水合）或懒加载出新段落。
    // 先无成本地把被删掉的译文塞回去，剩下真丢了原文的段落才重新请求翻译。
    for (let round = 1; round <= TOPUP_ROUNDS; round++) {
      if (pageState.stopped || myRun !== runId) break;
      const repaired = repairLostBlocks();
      if (repaired) console.log(`[双语翻译] 补漏第 ${round} 轮前修复 ${repaired} 处被页面删掉的译文`);
      clearStaleLoading();
      const more = getTranslatableElements();
      if (!more.length) break;
      pageState.total += more.length;
      await translateElements(more, provider, targetLang, myRun, `补漏第 ${round} 轮`);
    }
  } finally {
    // 只释放自己那一个令牌：并发的单段重试可能还在等，别把它们的心跳一起停掉
    stopKeepAlive(keepAlive);
  }

  if (myRun !== runId) return; // 已被新一轮接管，别覆盖它的状态
  clearStaleLoading();
  repairLostBlocks();
  pageState.translating = false;
  if (!pageState.stopped) pageState.translated = true;

  // 收尾审计：把"页面上真正看得见几条译文"和"我们以为翻了几段"对上账。
  // 两者不一致就说明译文被框架删掉了，而不是请求失败。
  const tally = {};
  document.querySelectorAll('[data-bilingual-done]').forEach(el => {
    const k = el.dataset.bilingualDone;
    tally[k] = (tally[k] || 0) + 1;
  });
  const visible = document.querySelectorAll('.bilingual-block').length;
  const states = Object.entries(tally).map(([k, n]) => `${k} ${n}`).join('，') || '无';
  console.log(`[双语翻译] 结束：共 ${pageState.total} 段，失败 ${pageState.failed} 段${pageState.stopped ? '（已停止）' : ''}；页面上译文块 ${visible} 个；段落状态：${states}`);
}

function toggleVisibility(visible) {
  pageState.visible = visible;
  document.querySelectorAll('.bilingual-block').forEach(el => {
    el.style.display = visible ? '' : 'none';
  });
}

function clearAll() {
  runId++; // 作废在飞批次，避免旧译文在清除后又插回页面
  stopKeepAlive(true); // 清除是全局动作：连正在重试的单段一起收掉心跳
  if (repairTimer) { clearInterval(repairTimer); repairTimer = null; }
  trackedPairs.clear(); // 否则守护逻辑会把刚清掉的译文又塞回来
  document.querySelectorAll('.bilingual-block, .bilingual-loading, .bilingual-failed').forEach(el => el.remove());
  document.querySelectorAll('[data-bilingual-done]').forEach(el => {
    delete el.dataset.bilingualDone;
  });
  Object.assign(pageState, { translating: false, translated: false, stopped: false, visible: true, total: 0, done: 0, failed: 0, error: null });
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
      clearStaleLoading(); // 立刻撤掉未开始批次的占位，在飞批次照常渲染
      // translating 会在在飞批次结束后由 runTranslation 设为 false
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

} // end non-youtube guard
