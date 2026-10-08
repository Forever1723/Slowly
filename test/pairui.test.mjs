/*
 * 严格端到端验证：起真实服务器，把 index.html 的真实 DOM 结构搭出来，
 * 模拟点击「连接」标签（含 document 级事件委托），然后检查：
 *   1. 扫码配对卡片是否出现
 *   2. 两张二维码是否真的画成了 SVG
 *   3. 配对码与地址是否显示正确
 *
 * 这个复现是为了在让用户重试之前，先确认"重启后一定能看到二维码"。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, l, e) => { if (c) { pass++; console.log("  ok   " + l) } else { fail++; console.log("  FAIL " + l + (e ? "  -> " + e : "")) } };

const indexHtml = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const syncJs = fs.readFileSync(path.join(ROOT, "public", "sync.js"), "utf8");

/* ---------- DOM：支持事件委托，才能模拟真实点击 ---------- */
function makeEl(tag) {
  const listeners = {};
  const el = {
    tagName: String(tag || "div").toUpperCase(), children: [], attrs: {}, style: {}, dataset: {},
    _text: "", _html: "", value: "", hidden: false, disabled: false, checked: false, files: [],
    __listeners: listeners, __parent: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children = []; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { c.__parent = this; this.children.push(c); return c; },
    insertBefore(c) { c.__parent = this; this.children.unshift(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() {}, focus() {}, blur() {}, select() {}, scrollIntoView() {},
    addEventListener(t, f) { (listeners[t] || (listeners[t] = [])).push(f) },
    removeEventListener() {},
    /* 沿父链找带 data-view 的祖先，模拟真实冒泡 */
    findViewAncestor() {
      let n = this;
      while (n) {
        if (n.attrs && n.attrs["data-view"]) return n;
        n = n.__parent;
      }
      return null;
    },
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return this.findViewAncestor() },
    contains() { return false },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 } },
    cloneNode() { return makeEl(this.tagName) },
  };
  return el;
}

function buildPage(serverBase) {
  const byId = new Map();
  /* 按 index.html 里的 id 建元素（保留 hidden 初值） */
  const idRe = /<(\w+)([^>]*\bid="([a-zA-Z0-9_-]+)"[^>]*)>/g;
  let m;
  while ((m = idRe.exec(indexHtml))) {
    const el = makeEl(m[1]);
    if (/\bhidden\b/.test(m[2])) el.hidden = true;
    byId.set(m[3], el);
  }
  for (const raw of (appJs.match(/\$\("([a-zA-Z0-9_-]+)"\)/g) || [])) {
    const id = raw.slice(3, -2);
    if (!byId.has(id)) byId.set(id, makeEl("div"));
  }

  /* 导航标签：真实页面里是 <div id="tabs"> 里的 <button class="tab" data-view="..">。
     app.js 把监听挂在 #tabs 上，并用 closest(".tab") 匹配 —— 两样都要还原。 */
  const body = makeEl("body");
  body.setAttribute("data-slowly-mode", "server");
  const navWrap = makeEl("div");
  navWrap.setAttribute("id", "tabs");
  navWrap.attrs.class = "tabs";
  /* closest(".tab") 需要按类名匹配祖先 */
  navWrap.matches = (sel) => String(sel).replace(/^\./, "") === "tab";
  body.appendChild(navWrap);
  const tabs = [];
  const tabRe = /<button[^>]*class="tab"[^>]*data-view="([a-zA-Z0-9_-]+)"[^>]*>/g;
  let t;
  while ((t = tabRe.exec(indexHtml))) {
    const el = makeEl("button");
    el.attrs.class = "tab";
    el.setAttribute("data-view", t[1]);
    el.matches = (sel) => String(sel).replace(/^\./, "") === "tab";
    navWrap.appendChild(el);
    tabs.push(el);
  }
  /* #tabs 本身也可能被 app.js 通过 $() 取到，挂进 byId */
  byId.set("tabs", navWrap);

  const docListeners = {};
  const mem = new Map();
  const calls = [];

  const documentStub = {
    body, documentElement: body, hidden: false, visibilityState: "visible",
    createElement: (x) => makeEl(x),
    createTextNode: (x) => ({ nodeType: 3, textContent: String(x) }),
    getElementById: (id) => byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: (sel) => (String(sel).includes("data-view") ? tabs : []),
    addEventListener(t, f) { (docListeners[t] || (docListeners[t] = [])).push(f) },
    removeEventListener() {},
    /* 模拟点击：真实页面里监听在 #tabs 上，事件从按钮冒泡上去 */
    __click(el) {
      const target = el.findViewAncestor() || el;
      const ev = { target, preventDefault() {}, stopPropagation() {} };
      /* 先触发 #tabs 上的监听（真实行为），再兜底触发 document 上的 */
      const wrapListeners = (navWrap.__listeners && navWrap.__listeners.click) || [];
      for (const f of wrapListeners) f(ev);
      if (!wrapListeners.length) {
        for (const f of (docListeners.click || [])) f(ev);
      }
    },
  };

  const sandbox = {
    document: documentStub,
    location: { protocol: "http:", host: serverBase.replace(/^https?:\/\//, ""), href: serverBase + "/", origin: serverBase, pathname: "/", search: "", hash: "" },
    history: { replaceState() {} },
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k), clear: () => mem.clear(),
    },
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0)" },
    fetch: (url, opts) => { const u = String(url); calls.push(u); return fetch(u.startsWith("/") ? serverBase + u : u, opts) },
    setTimeout, clearTimeout, setInterval: (f, ms) => setInterval(f, ms), clearInterval,
    console, JSON, Math, Date, Object, Array, String, Number, Boolean, Promise, Error, RegExp,
    encodeURIComponent, decodeURIComponent, isFinite, parseInt, parseFloat, Map, Set,
    AbortController, TextEncoder, TextDecoder,
    requestAnimationFrame: (f) => setTimeout(f, 16),
    scrollTo() {}, scrollBy() {}, scroll() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    alert() {}, confirm: () => true, prompt: () => null,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return { sandbox, byId, tabs, calls, documentStub };
}

/* ---------- 起真实服务器 ---------- */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qrverify-"));
const PORT = 8853;
const child = spawn(process.execPath, [path.join(ROOT, "server.mjs"), "--port", String(PORT), "--no-open", "--quiet", "--data", path.join(dataDir, "d.json")], {
  stdio: "ignore", windowsHide: true,
});
const BASE = "http://127.0.0.1:" + PORT;
let ready = false;
for (let i = 0; i < 50; i++) {
  try { const r = await fetch(BASE + "/api/ping"); if (r.ok) { ready = true; break } } catch { }
  await sleep(150);
}
if (!ready) { console.log("  服务器没起来"); process.exit(1) }
console.log("  真实服务器就绪 " + BASE);

try {
  const { sandbox, byId, tabs, calls, documentStub } = buildPage(BASE);
  vm.createContext(sandbox);
  vm.runInContext(syncJs, sandbox, { filename: "sync.js" });
  vm.runInContext(appJs, sandbox, { filename: "app.js" });
  await sleep(1500);

  console.log("\n1) 点「连接」标签");
  const shareTab = tabs.find((b) => b.getAttribute("data-view") === "share");
  ok(Boolean(shareTab), "页面里有「连接」标签");
  documentStub.__click(shareTab);
  await sleep(1200);

  console.log("\n2) 扫码配对卡片");
  const pairCard = byId.get("pairCard");
  ok(pairCard && pairCard.hidden === false, "配对卡片显示了", "hidden=" + (pairCard && pairCard.hidden));

  const codeEl = byId.get("pairCode");
  ok(codeEl && /^[0-9A-Z]{6}$/.test(String(codeEl.textContent || "")),
    "显示了 6 位配对码：" + (codeEl && codeEl.textContent));

  const lanEl = byId.get("pairLan");
  ok(lanEl && /^https?:\/\//.test(String(lanEl.textContent || "")),
    "显示了电脑地址：" + (lanEl && lanEl.textContent));

  console.log("\n3) 两张二维码");
  const pairQr = String((byId.get("pairQr") || {}).innerHTML || "");
  ok(pairQr.includes("<svg"), "第一张（线上版）画成了 SVG", "长度 " + pairQr.length + " 内容 " + JSON.stringify(pairQr.slice(0, 50)));
  const appQr = String((byId.get("pairAppQr") || {}).innerHTML || "");
  ok(appQr.includes("<svg"), "第二张（App 深链）画成了 SVG", "长度 " + appQr.length + " 内容 " + JSON.stringify(appQr.slice(0, 50)));

  const qrCalls = calls.filter((c) => c.includes("qr"));
  ok(qrCalls.length >= 2, "确实请求了二维码接口（" + qrCalls.length + " 次）");

  console.log("\n4) 旧的扫码卡片也还在（手机扫码打开）");
  const holder = String((byId.get("qrHolder") || {}).innerHTML || "");
  ok(holder.includes("<svg") || holder.includes("tip"),
    "要么画出二维码，要么给出明确提示（不是空白）", JSON.stringify(holder.slice(0, 60)));

  console.log("\n5) 二维码内容能被解回（和服务器给的配对链接一致）");
  const st = await (await fetch(BASE + "/api/state")).json();
  const qrLib = await import("../lib/qr.js").then((m) => m.default || m);
  const enc = qrLib.encode(st.pairing.pairUrl, "M");
  const dec = qrLib.decode(enc.modules);
  ok(dec.text === st.pairing.pairUrl, "配对链接可往返：" + st.pairing.pairUrl.slice(0, 60) + "…");
} finally {
  child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log("\n结果：通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
