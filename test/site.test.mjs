/* =============================================================
   发布站点验证：把 docs/ 当成真实静态网站跑起来（模拟 GitHub Pages 子目录），
   确认：
   1) 页面能加载，且不会去连一个不存在的服务器
   2) 记录直接落在本机，刷新后还在
   3) manifest / sw / 图标 都能取到（不然装不到主屏、断网打不开）
   ============================================================= */
import fs from "node:fs";
import vm from "node:vm";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DOCS = path.join(ROOT, "docs");

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra ? "  -> " + extra : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(DOCS)) {
  console.log("还没有生成 docs/，先运行 node tools/build-offline.mjs");
  process.exit(1);
}

/* ---------------- 一个静态网站，挂在子目录下（模拟 /仓库名/） ---------------- */
const PREFIX = "/slowly/";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8"
};
const hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.url);
  let p = decodeURIComponent(req.url);
  if (!p.startsWith(PREFIX)) { res.writeHead(404).end("not found"); return; }
  p = p.slice(PREFIX.length);
  if (p === "" || p.endsWith("/")) p += "index.html";
  const file = path.join(DOCS, path.normalize(p).replace(/^([/\\])+/, ""));
  if (!file.startsWith(DOCS) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  const data = fs.readFileSync(file);
  res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
  res.end(data);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const BASE = "http://127.0.0.1:" + PORT + PREFIX;
console.log("静态站点已启动（模拟子目录部署）：" + BASE);

try {
  console.log("1) 静态资源都能取到");
  for (const [p, expect] of [["", "text/html"], ["manifest.webmanifest", "manifest"], ["sw.js", "javascript"],
                             ["assets/slowly-256.png", "png"], ["assets/slowly-icon.svg", "svg"]]) {
    const r = await fetch(BASE + p);
    const ct = r.headers.get("content-type") || "";
    ok(r.ok && ct.includes(expect), "GET " + (p || "(首页)") + " -> " + r.status + " " + ct, "期望含 " + expect);
  }

  /* ---------------- 最小 DOM（与其它测试同一套语义） ---------------- */
  const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
  const byId = new Map();
  const documentStub = { activeElement: null, hidden: false, body: null, documentElement: null };
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.attrs = {}; this._text = ""; this._html = "";
      this.style = {}; this.listeners = {}; this.hidden = false; this.value = ""; this.parentNode = null;
      const self = this;
      this.classList = {
        toggle: (c, on) => {
          const set = new Set((self.attrs.class || "").split(/\s+/).filter(Boolean));
          if (on) set.add(c); else set.delete(c);
          self.attrs.class = Array.from(set).join(" ");
        },
        contains: (c) => (self.attrs.class || "").split(/\s+/).includes(c),
        add: (c) => self.classList.toggle(c, true),
        remove: (c) => self.classList.toggle(c, false)
      };
    }
    get className() { return this.attrs.class || ""; }
    set className(v) { this.attrs.class = String(v); }
    get id() { return this.attrs.id || ""; }
    set id(v) { this.attrs.id = String(v); if (v) byId.set(String(v), this); }
    focus() { documentStub.activeElement = this; }
    blur() { documentStub.activeElement = null; }
    click() { this.fire("click"); }
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
    setAttribute(n, v) { this.attrs[n] = String(v); if (n === "id") byId.set(String(v), this); }
    removeAttribute(n) { delete this.attrs[n]; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    get lastChild() { return this.children.length ? this.children[this.children.length - 1] : null; }
    get textContent() {
      if (this.children.length) return this.children.map((c) => c.textContent).join("");
      return this._text;
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); parseInto(this, this._html); }
    closest(sel) { let n = this; while (n) { if (n.matches(sel)) return n; n = n.parentNode; } return null; }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => { n.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c); }); };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    matches(sel) {
      if (sel.startsWith(".")) return (this.attrs.class || "").split(/\s+/).includes(sel.slice(1));
      if (sel.startsWith("[")) return Object.prototype.hasOwnProperty.call(this.attrs, sel.slice(1, -1).split("=")[0]);
      return this.tagName === sel.toUpperCase();
    }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    fire(type, ev) {
      const e = Object.assign({ type, preventDefault() {}, stopPropagation() {}, target: null }, ev || {});
      if (!e.target) e.target = this;
      (this.listeners[type] || []).slice().forEach((f) => f(e));
      return e;
    }
  }
  function parseInto(root, src) {
    root.children = [];
    const stack = [root];
    const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    let m, last = 0;
    while ((m = re.exec(src))) {
      const text = src.slice(last, m.index);
      if (text.trim()) { const t = new El("#text"); t._text = text; stack[stack.length - 1].appendChild(t); }
      last = re.lastIndex;
      const selfClose = m[2].trim().endsWith("/");
      if (m[0][1] === "/") { if (stack.length > 1) stack.pop(); continue; }
      const tag = m[1].toLowerCase();
      const el = new El(tag);
      const ar = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let a;
      while ((a = ar.exec(m[2]))) el.setAttribute(a[1], a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : "");
      stack[stack.length - 1].appendChild(el);
      if (!VOID.has(tag) && !selfClose) stack.push(el);
    }
    const tail = src.slice(last);
    if (tail.trim()) { const t = new El("#text"); t._text = tail; stack[stack.length - 1].appendChild(t); }
  }

  const pageHtml = await (await fetch(BASE)).text();
  const root = new El("html");
  parseInto(root, pageHtml);
  documentStub.documentElement = root;
  /* 真实浏览器里 document.body 是 <body> 元素（脚本会读它上面的 data-slowly-mode） */
  const findBody = (node) => {
    if (node.tagName === "BODY") return node;
    for (const c of node.children) { const hit = findBody(c); if (hit) return hit; }
    return null;
  };
  documentStub.body = findBody(root) || root;
  documentStub.getElementById = (id) => byId.get(id) || null;
  documentStub.createElement = (t) => new El(t);
  documentStub.querySelectorAll = (sel) => root.querySelectorAll(sel);
  documentStub.addEventListener = () => {};

  /* 访问者的浏览器：地址是 https://用户.github.io/仓库名/ */
  const mem = new Map();
  let networkToUnknownServer = 0;
  const fetchStub = (url, opts) => {
    const target = String(url);
    if (target.startsWith("/api/")) { networkToUnknownServer++; return Promise.reject(new Error("静态站点不应该请求 " + target)); }
    if (/^https?:/.test(target) && !target.startsWith(BASE)) { networkToUnknownServer++; return Promise.reject(new Error("不应请求外部地址")); }
    return fetch(target.startsWith("http") ? target : BASE + target.replace(/^\.?\//, ""), opts).catch((e) => {
      /* 静态站点没有 /api，这类请求在真实浏览器里就是 404 */
      return { ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve(""), json: () => Promise.resolve({}) };
    });
  };

  const sandbox = {
    document: documentStub,
    location: { protocol: "https:", host: "user.github.io", href: BASE, origin: BASE.replace(/\/$/, "") },
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k)
    },
    navigator: { userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome", maxTouchPoints: 5 },
    fetch: fetchStub,
    setTimeout, clearTimeout, setInterval: (f, m) => setInterval(f, m), clearInterval,
    requestAnimationFrame: (f) => f(),
    Image: class {}, FileReader: class { readAsText() {} },
    console, URL, Blob, AbortController,
    confirm: () => true, prompt: () => "", scrollTo() {}, addEventListener() {},
    matchMedia: () => ({ matches: false }),
    serviceWorker: { register: () => Promise.resolve() }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const scripts = Array.from(pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g), (m) => m[1]);
  ok(scripts.length === 2, "页面内联了 2 段脚本");

  const context = vm.createContext(sandbox);
  context.location = sandbox.location;
  context.localStorage = sandbox.localStorage;
  context.fetch = fetchStub;
  context.window = sandbox;
  context.matchMedia = sandbox.matchMedia;
  context.serviceWorker = sandbox.serviceWorker;

  console.log("2) 以静态站点方式打开");
  let bootError = null;
  for (let i = 0; i < scripts.length; i++) {
    try { vm.runInContext(scripts[i], context, { filename: "docs-part" + i + ".js" }); }
    catch (e) { if (!bootError) bootError = e; console.log("     第 " + (i + 1) + " 段脚本异常：" + e.message); }
  }
  ok(!bootError, "页面脚本执行无异常", bootError && bootError.message);
  await sleep(400);

  const g = (id) => byId.get(id);
  const text = (id) => (g(id) ? String(g(id).textContent) : "");
  const htmlOf = (id) => (g(id) ? String(g(id).innerHTML) : "");

  ok(text("syncText").includes("本机"), "识别为静态/本机模式：" + text("syncText"));
  ok(text("progressNum").includes("还没有目标"), "空状态正常：" + JSON.stringify(text("progressNum")));
  ok(networkToUnknownServer === 0, "启动过程没有请求任何服务器（静态站点本来就没有）");

  console.log("3) 记录直接落在本机");
  g("goalInput").value = "今天散步 20 分钟";
  g("addBtn").fire("click");
  await sleep(300);
  ok(htmlOf("goalList").includes("今天散步 20 分钟"), "新增的目标出现在界面上");
  const stored = JSON.parse(mem.get("slowly.data") || "{}");
  ok(stored.goals && stored.goals.length === 1, "已存进浏览器存储（访问者自己的设备）");
  ok(networkToUnknownServer === 0, "记录过程也没有任何网络请求（隐私承诺成立）");

  const moodBtn = g("moods").querySelectorAll(".mood")[0];
  g("moods").fire("click", { target: moodBtn });
  await sleep(300);
  g("noteInput").value = "静态版也能写随笔。";
  g("noteInput").fire("input");
  await sleep(900);
  const stored2 = JSON.parse(mem.get("slowly.data") || "{}");
  ok(Object.keys(stored2.moods).length === 1, "心情已存本机");
  ok(Object.keys(stored2.notes).length === 1, "随笔已存本机");

  console.log("4) 界面引导（给访问者看的）");
  g("tabs").fire("click", { target: g("tabs").querySelectorAll(".tab")[3] });
  await sleep(300);
  ok(g("installCard").hidden === false, "显示「装到主屏幕」引导");
  ok(text("installHint").length > 0, "给出了具体的添加方式：" + text("installHint"));
  ok(g("syncCard").hidden === false, "说明了数据存在本机 / 可选联电脑");
  ok(text("dataPath").includes("浏览器存储"), "如实说明数据存在哪：" + text("dataPath"));
  ok(text("clientsInfo").includes("只在这台设备"), "说明只在这台设备上");

  console.log("5) 刷新后数据还在");
  byId.clear();
  const root2 = new El("html");
  parseInto(root2, pageHtml);
  documentStub.documentElement = root2;
  documentStub.body = findBody(root2) || root2;
  const sandbox2 = Object.assign({}, sandbox, { document: documentStub });
  sandbox2.window = sandbox2;
  const ctx2 = vm.createContext(sandbox2);
  ctx2.location = sandbox.location;
  ctx2.localStorage = sandbox.localStorage;
  ctx2.fetch = fetchStub;
  ctx2.window = sandbox2;
  ctx2.matchMedia = sandbox.matchMedia;
  ctx2.serviceWorker = sandbox.serviceWorker;
  documentStub.getElementById = (id) => byId.get(id) || null;
  documentStub.createElement = (t) => new El(t);
  documentStub.querySelectorAll = (sel) => root2.querySelectorAll(sel);
  for (const s of scripts) vm.runInContext(s, ctx2, { filename: "docs-reload.js" });
  await sleep(400);
  ok(htmlOf("goalList").includes("今天散步 20 分钟"), "刷新后目标还在（数据没丢）");
} catch (err) {
  fail++;
  console.log("  测试抛出异常：" + (err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : err));
} finally {
  server.close();
}

console.log("\n结果：通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);

