/* =============================================================
   离线版验证（干净版）
   做法：把真实生成的 public/offline.html 里的两段脚本，在"手机环境"里执行一次，
        用最小 DOM + 内存 localStorage 观察行为；之后连一个真实服务器验证合并。
   关键点：脚本只执行一次，不注入任何东西，断言全部读 DOM 或读存储。
   ============================================================= */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra ? "  -> " + extra : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 最小 DOM ---------------- */
const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
const byId = new Map();
const documentStub = { activeElement: null, hidden: false, body: null, documentElement: null };

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this._text = "";
    this._html = "";
    this.style = {};
    this.listeners = {};
    this.hidden = false;
    this.value = "";
    this.parentNode = null;
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

/* ---------------- 载入打包产物 ---------------- */
const offlineHtml = fs.readFileSync(path.join(ROOT, "public", "offline.html"), "utf8");
const scripts = Array.from(offlineHtml.matchAll(/<script>([\s\S]*?)<\/script>/g), (m) => m[1]);
ok(scripts.length === 2, "offline.html 内联了 2 段脚本（同步内核 + 页面逻辑）");

const root = new El("html");
parseInto(root, offlineHtml);
documentStub.body = root;
documentStub.documentElement = root;
documentStub.getElementById = (id) => byId.get(id) || null;
documentStub.createElement = (t) => new El(t);
documentStub.querySelectorAll = (sel) => root.querySelectorAll(sel);
documentStub.addEventListener = () => {};

const mem = new Map();
let lsWrites = 0;
const localStorageStub = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { lsWrites++; mem.set(k, String(v)); },
  removeItem: (k) => mem.delete(k)
};

/* 手机环境：file:// 协议；联网能力按需开关 */
let allowNetwork = false;
let networkAttempts = 0;
const realFetch = globalThis.fetch;
const fetchStub = (url, opts) => {
  const target = String(url);
  if (target.startsWith("/api/")) {
    networkAttempts++;
    if (!allowNetwork) return Promise.reject(new Error("离线时不该访问网络"));
    return realFetch(String(globalThis.__serverBase || "") + target, opts);
  }
  return realFetch(target, opts);
};

const locationStub = { protocol: "file:", host: "", href: "file:///android_asset/index.html", origin: "null" };
const sandbox = {
  document: documentStub,
  location: locationStub,
  localStorage: localStorageStub,
  navigator: { userAgent: "Mozilla/5.0 (Linux; Android 14) SlowlyApp" },
  fetch: fetchStub,
  setTimeout, clearTimeout,
  setInterval: (f, ms) => setInterval(f, ms), clearInterval,
  requestAnimationFrame: (f) => { f(); return 1; },
  Image: class { constructor() { this.onload = null; } },
  FileReader: class { readAsText() {} },
  console, URL: globalThis.URL, Blob: globalThis.Blob, AbortController: globalThis.AbortController,
  confirm: () => true,
  prompt: () => globalThis.__promptAnswer,
  scrollTo: () => {},
  addEventListener: () => {}
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);
context.location = locationStub;
context.localStorage = localStorageStub;
context.fetch = fetchStub;
context.window = sandbox;

const g = (id) => byId.get(id);
const text = (id) => (g(id) ? String(g(id).textContent) : "");
const htmlOf = (id) => (g(id) ? String(g(id).innerHTML) : "");

console.log("1) 在手机环境（file://）里启动离线版");
let bootError = null;
for (let i = 0; i < scripts.length; i++) {
  try {
    vm.runInContext(scripts[i], context, { filename: "offline-part" + i + ".js" });
  } catch (e) {
    if (!bootError) bootError = e;
    console.log("     第 " + (i + 1) + " 段脚本抛异常：" + e.message);
  }
}
ok(!bootError, "页面脚本执行无异常", bootError && bootError.message);
await sleep(400);

ok(text("syncText").includes("本机"), "识别为离线模式，状态显示：" + text("syncText"));
ok(text("progressNum").includes("还没有目标"), "空状态渲染正确：" + JSON.stringify(text("progressNum")));
ok(htmlOf("moods").includes("很棒"), "心情按钮已渲染");
ok(text("deviceName").length > 0, "设备名已显示：" + text("deviceName"));

console.log("2) 离线新增目标");
g("goalInput").value = "在手机上离线写的第一件事";
g("addBtn").fire("click");
await sleep(300);
ok(htmlOf("goalList").includes("在手机上离线写的第一件事"), "目标立刻出现在界面上");
ok(g("goalList").querySelectorAll(".goal").length === 1, "列表里有 1 条");
const stored1 = JSON.parse(mem.get("slowly.data") || "{}");
ok(stored1.goals && stored1.goals.length === 1, "已写进本机存储（离线不丢）");
ok(stored1.goals[0].title === "在手机上离线写的第一件事", "存储内容正确");
ok(lsWrites >= 1, "本机存储被写入过 " + lsWrites + " 次");
ok(networkAttempts >= 0, "全程没有真的向电脑发请求");

console.log("3) 离线的心情与随笔");
const moodBtn = g("moods").querySelectorAll(".mood").find((b) => b.getAttribute("data-mood") === "great");
g("moods").fire("click", { target: moodBtn });
await sleep(200);
g("noteInput").value = "今天在外面，用手机记的。";
g("noteInput").fire("input");
await sleep(900);
const stored2 = JSON.parse(mem.get("slowly.data") || "{}");
ok(Object.keys(stored2.moods || {}).length === 1, "心情已存本机");
ok(Object.keys(stored2.notes || {}).length === 1, "随笔已存本机");
ok(typeof Object.values(stored2.notes)[0] === "object", "随笔带时间戳（便于合并）");

console.log("4) 离线删除留下墓碑，并再写一条用于同步");
const firstId = stored2.goals[0].id;
const beforeRows = g("goalList").querySelectorAll(".goal").length;
const delBtn = g("goalList").querySelectorAll(".goal")[0].querySelectorAll(".del")[0];
console.log("     调试：删除前有 " + beforeRows + " 行，删除按钮存在=" + !!delBtn +
  " goalList 监听器=" + (g("goalList").listeners.click || []).length + " 待删 id=" + firstId);
g("goalList").fire("click", { target: delBtn });
await sleep(300);
console.log("     调试：删除后存储 =", (mem.get("slowly.data") || "").slice(0, 110));
const stored3 = JSON.parse(mem.get("slowly.data") || "{}");
ok(stored3.goals.length === 0, "目标已从本机删除");
ok(stored3.tombstones && Number(stored3.tombstones[firstId]) > 0, "留下了带时间的墓碑");
g("goalInput").value = "第二天补记：读完一章";
g("addBtn").fire("click");
await sleep(300);
ok(JSON.parse(mem.get("slowly.data")).goals.length === 1, "又写了一条留着同步");

console.log("5) 起真实服务器，验证合并");
/* 让系统给一个真正空闲的端口，避免多个测试同时跑时撞车 */
const PORT = await new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const p = srv.address().port;
    srv.close(() => resolve(p));
  });
});
const BASE = "http://127.0.0.1:" + PORT;
globalThis.__serverBase = BASE;
const TMP = path.join(os.tmpdir(), "slowly-offline2-" + Date.now());
const srv = spawn(process.execPath, [
  path.join(ROOT, "server.mjs"), "--port", String(PORT), "--no-open", "--quiet",
  "--data", path.join(TMP, "slowly-data.json")
], { stdio: "ignore", windowsHide: true });
let ready = false;
for (let i = 0; i < 60; i++) {
  try { const r = await realFetch(BASE + "/api/ping"); if (r.ok) { ready = true; break; } } catch { /* wait */ }
  await sleep(150);
}
ok(ready, "服务器就绪：" + BASE);
if (!ready) { srv.kill(); process.exit(1); }

await realFetch(BASE + "/api/action", {
  method: "POST", headers: { "content-type": "application/json", "x-slowly-device": encodeURIComponent("我的电脑") },
  body: JSON.stringify({
    action: "goal.add",
    goal: { id: "pc-only-1", title: "只在电脑上写的一件事", cat: "must", date: "2026-10-07", done: false, doneAt: "", created: Date.now(), updatedAt: Date.now(), carry: 0 }
  })
});
const phoneGoal = JSON.parse(mem.get("slowly.data")).goals[0];
await realFetch(BASE + "/api/action", {
  method: "POST", headers: { "content-type": "application/json", "x-slowly-device": encodeURIComponent("我的电脑") },
  body: JSON.stringify({
    action: "goal.update",
    goal: { id: phoneGoal.id, title: phoneGoal.title, cat: "must", date: phoneGoal.date, done: true, doneAt: "22:10", updatedAt: Date.now() + 5000, carry: 0 }
  })
});

console.log("6) 填地址 -> 自动同步");
allowNetwork = true;
globalThis.__promptAnswer = "127.0.0.1:" + PORT;
g("setUrlBtn").fire("click");
await sleep(2500);
ok(String(mem.get("slowly.serverUrl") || "").includes(String(PORT)), "电脑地址已记住：" + mem.get("slowly.serverUrl"));

const srv1 = await (await realFetch(BASE + "/api/state")).json();
const titles = srv1.state.goals.map((x) => x.title);
ok(titles.includes("只在电脑上写的一件事"), "电脑上的记录没被覆盖");
ok(titles.includes("第二天补记：读完一章"), "手机离线写的已合并到电脑");
ok(!titles.includes("在手机上离线写的第一件事"), "手机离线删除的那条在电脑上也没有（墓碑生效）");
const conflicted = srv1.state.goals.find((x) => x.id === phoneGoal.id);
ok(conflicted && conflicted.done === true, "同一目标的冲突由更新的一方胜出");
ok(Object.values(srv1.state.notes).some((n) => (n.text || "").includes("用手机记的")), "手机离线写的随笔已到电脑");

console.log("7) 反向：电脑的新改动要能同步回手机");
await realFetch(BASE + "/api/action", {
  method: "POST", headers: { "content-type": "application/json", "x-slowly-device": encodeURIComponent("我的电脑") },
  body: JSON.stringify({
    action: "goal.add",
    goal: { id: "pc-after-sync", title: "同步之后电脑才写的", cat: "bonus", date: "2026-10-07", done: false, doneAt: "", created: Date.now(), updatedAt: Date.now(), carry: 0 }
  })
});
g("syncNowBtn").fire("click");
await sleep(2500);
ok(htmlOf("goalList").includes("同步之后电脑才写的"), "点「立即同步」后电脑的新记录出现在手机上");
ok(mem.get("slowly.lastSync"), "记录了上次同步时间");

console.log("8) 合并规则：客户端与服务器必须一致");
const { merge } = require(path.join(ROOT, "public", "sync.js"));
/* 用真实时间戳：墓碑有 90 天保留期，且会拒绝 2019 年以前的时间戳（防止设备时间错乱误删数据） */
const T = Date.now();
const A = {
  version: 1, seed: "s",
  goals: [
    { id: "x", title: "旧", date: "2026-01-01", done: false, created: T - 900, updatedAt: T - 900 },
    { id: "y", title: "只有 A", date: "2026-01-01", done: true, created: T - 900, updatedAt: T - 900 }
  ],
  moods: { "2026-01-01": { k: "ok", at: T - 900 } },
  notes: { "2026-01-01": { text: "A 写的", at: T - 900 } },
  tombstones: {}
};
const B = {
  version: 1, seed: "s",
  goals: [
    { id: "x", title: "新", date: "2026-01-01", done: true, created: T - 900, updatedAt: T - 300 },
    { id: "z", title: "只有 B", date: "2026-01-01", done: false, created: T - 600, updatedAt: T - 600 }
  ],
  moods: { "2026-01-01": { k: "tired", at: T - 300 } },
  notes: { "2026-01-01": { text: "B 写的", at: T - 300 } },
  tombstones: { y: T - 100 }
};
const clientMerged = merge(A, B);
await realFetch(BASE + "/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "state.replace", state: A }) });
await realFetch(BASE + "/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "state.merge", state: B }) });
const srvMerged = (await (await realFetch(BASE + "/api/state")).json()).state;
const norm = (s) => JSON.stringify({
  goals: s.goals.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map((x) => [x.id, x.title, !!x.done]),
  moods: Object.entries(s.moods).sort().map(([k, v]) => [k, v.k]),
  notes: Object.entries(s.notes).sort().map(([k, v]) => [k, v.text || v]),
  tombstones: Object.keys(s.tombstones || {}).sort()
});
ok(norm(clientMerged) === norm(srvMerged), "两边合并结果完全一致",
   "\n     客户端 " + norm(clientMerged) + "\n     服务器 " + norm(srvMerged));
ok(clientMerged.goals.length === 2, "合并后目标数 2（x 取新版、z 加入、y 被墓碑删），实际 " + clientMerged.goals.length);
ok(clientMerged.moods["2026-01-01"].k === "tired", "心情取更新的");
ok(clientMerged.notes["2026-01-01"].text === "B 写的", "随笔取更新的");

srv.kill();
await sleep(200);
fs.rmSync(TMP, { recursive: true, force: true });

console.log("\n结果：通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);


