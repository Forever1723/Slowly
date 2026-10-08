/*
 * 扫码配对的测试。
 *
 * 覆盖三种进入方式：
 *   1. 手机相机扫线上版链接  -> #pair=<令牌>&srv=<电脑地址>
 *   2. 电脑网页版链接        -> ?pair=<令牌>
 *   3. 安卓 App 深链         -> slowly://pair?... 由原生解析后调 window.SlowlyPair
 * 以及：令牌是否记入本地、地址是否被填好、校验失败时是否清理干净。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra ? "  -> " + extra : "")); }
};

/* ---------------- sync.js 的纯函数部分 ---------------- */
console.log("1) 解析配对链接（纯函数，不依赖浏览器）");
{
  const sync = require(path.join(ROOT, "public", "sync.js"));

  const a = sync.parsePairHash("#pair=ABC123&srv=http%3A%2F%2F192.168.1.5%3A8787%2F");
  ok(a && a.token === "ABC123", "从 # 片段里读出令牌", a && a.token);
  ok(a && a.serverUrl === "http://192.168.1.5:8787", "地址被解码并规范化", a && a.serverUrl);

  ok(sync.parsePairHash("") === null, "空片段返回 null");
  ok(sync.parsePairHash("#other=1") === null, "没有 pair 参数时返回 null");

  /* 只有令牌没有地址（电脑直连形式）也不能崩 */
  const b = sync.parsePairHash("#pair=XYZ");
  ok(b && b.token === "XYZ" && b.serverUrl === "", "只有令牌时地址为空字符串");

  /* 地址里带端口以外的怪字符也不该抛错 */
  const c = sync.parsePairHash("#pair=T&srv=%E4%B8%AD%E6%96%87");
  ok(c && typeof c.serverUrl === "string", "无法解码的地址不抛错");
}

/* ---------------- 沙箱里跑完整的离线应用 ---------------- */
console.log("\n2) 手机扫码：地址与令牌自动填好");

function makeSandbox(locationHref) {
  const html = fs.readFileSync(path.join(ROOT, "public", "offline.html"), "utf8");
  /* 复用 offline.test.mjs 那种极简 DOM：够 app.js 跑起来即可 */
  function El(tag) {
    const el = {
      tagName: String(tag || "div").toUpperCase(), children: [], attrs: {}, style: {}, dataset: {},
      _text: "", value: "", hidden: false, disabled: false, checked: false, files: [],
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); this.children = []; },
      get innerHTML() { return this._html || ""; },
      set innerHTML(v) { this._html = String(v); this.children = []; },
      getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { this.children.push(c); return c; },
      insertBefore(c) { this.children.unshift(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
      remove() {}, focus() {}, blur() {}, select() {}, scrollIntoView() {},
      addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      closest() { return null; }, contains() { return false; },
      getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
      cloneNode() { return El(this.tagName); },
    };
    return el;
  }

  const byId = new Map();
  const ids = html.match(/id="([a-zA-Z0-9_-]+)"/g) || [];
  for (const raw of ids) byId.set(raw.slice(4, -1), El("div"));
  for (const raw of (fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8").match(/\$\("([a-zA-Z0-9_-]+)"\)/g) || [])) {
    const id = raw.slice(3, -2);
    if (!byId.has(id)) byId.set(id, El("div"));
  }

  const body = El("body");
  body.setAttribute("data-slowly-mode", "offline");
  const documentStub = {
    body, documentElement: El("html"), hidden: false, visibilityState: "visible",
    createElement: (t) => El(t), createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    getElementById: (id) => byId.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };

  const mem = new Map();
  const localStorageStub = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };

  const url = new URL(locationHref);
  const sandbox = {
    document: documentStub,
    location: {
      protocol: url.protocol, host: url.host, href: locationHref,
      origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash,
      replace() {},
    },
    history: { replaceState() { sandbox.__replaced = true; } },
    localStorage: localStorageStub,
    navigator: { userAgent: "Mozilla/5.0 (Linux; Android 14)" },
    fetch: () => Promise.reject(new Error("测试里不该发请求")),
    setTimeout, clearTimeout, setInterval: (f, ms) => setInterval(f, ms), clearInterval,
    console, JSON, Math, Date, Object, Array, String, Number, Boolean, Promise, Error, RegExp,
    encodeURIComponent, decodeURIComponent, isFinite, parseInt, parseFloat, Map, Set,
    AbortController, TextEncoder, TextDecoder,
    requestAnimationFrame: (f) => setTimeout(f, 16),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    alert() {}, confirm: () => true, prompt: () => null,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    __replaced: false,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return { sandbox, mem, byId };
}

/* 场景 A：相机扫线上版链接 */
{
  const href = "https://forever1723.github.io/Slowly/#pair=AB12CD&srv=http%3A%2F%2F192.168.1.5%3A8787%2F";
  const { sandbox, mem } = makeSandbox(href);
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "public", "offline.html"), "utf8")
    .match(/<script>([\s\S]*?)<\/script>/g).join("\n").replace(/<\/?script>/g, ""), sandbox, { filename: "offline-bundle.js" });
  await sleep(200);
  ok(mem.get("slowly.pairToken") === "AB12CD", "扫线上版链接后记下了令牌", mem.get("slowly.pairToken"));
  ok(String(mem.get("slowly.serverUrl") || "").includes("192.168.1.5"),
    "同时记下了电脑地址", mem.get("slowly.serverUrl"));
  ok(sandbox.__replaced === true, "地址栏里的令牌被清掉（不留历史记录）");
}

/* 场景 B：只有 ?pair= 的电脑链接，不该把地址写坏 */
{
  const href = "http://192.168.1.9:8787/?pair=QQ77ZZ";
  const { sandbox, mem } = makeSandbox(href);
  vm.createContext(sandbox);
  const bundle = fs.readFileSync(path.join(ROOT, "public", "offline.html"), "utf8")
    .match(/<script>([\s\S]*?)<\/script>/g).join("\n").replace(/<\/?script>/g, "");
  vm.runInContext(bundle, sandbox, { filename: "offline-bundle.js" });
  await sleep(200);
  ok(mem.get("slowly.pairToken") === "QQ77ZZ", "?pair= 形式也能记下令牌", mem.get("slowly.pairToken"));
}

/* 场景 C：没有配对信息时不该乱写 */
{
  const href = "https://forever1723.github.io/Slowly/";
  const { sandbox, mem } = makeSandbox(href);
  vm.createContext(sandbox);
  const bundle = fs.readFileSync(path.join(ROOT, "public", "offline.html"), "utf8")
    .match(/<script>([\s\S]*?)<\/script>/g).join("\n").replace(/<\/?script>/g, "");
  vm.runInContext(bundle, sandbox, { filename: "offline-bundle.js" });
  await sleep(200);
  ok(!mem.get("slowly.pairToken"), "普通打开时不会写入令牌");
}

console.log("\n3) 安卓深链入口");
{
  const { sandbox } = makeSandbox("file:///android_asset/index.html");
  vm.createContext(sandbox);
  const bundle = fs.readFileSync(path.join(ROOT, "public", "offline.html"), "utf8")
    .match(/<script>([\s\S]*?)<\/script>/g).join("\n").replace(/<\/?script>/g, "");
  vm.runInContext(bundle, sandbox, { filename: "offline-bundle.js" });
  await sleep(200);
  ok(typeof sandbox.SlowlyPair === "function", "暴露了 window.SlowlyPair 供原生调用");

  /* 原生传来的令牌与地址应当被写入本地；这里没有服务器，校验会失败，
     但"写入"这一步必须发生，失败后要清理干净 */
  sandbox.SlowlyPair("ZZ9999", "192.168.1.7:8787");
  await sleep(600);
  ok(!sandbox.localStorage.getItem("slowly.pairToken"),
    "连不上电脑时会清掉令牌（不留一个连不上的状态）");
}

console.log("\n结果：通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
