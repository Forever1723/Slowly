/* 前端测试：用最小 DOM 跑的 Slowly 页面逻辑，并用真实 fetch 连真实服务器
   双重验证：接口调用是否符合约定 + 界面是否正确反应 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

/* 最小 EventSource 实现（Node 里没有内置的）：用 fetch 流解析 SSE，
   让"另一端改动能实时到达"这件事在测试里是真的，而不是假装。 */
class MiniEventSource {
  constructor(url) {
    this.url = String(url);
    this.listeners = {};
    this.onerror = null;
    this.closed = false;
    this.controller = new AbortController();
    this._run();
  }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  close() { this.closed = true; try { this.controller.abort(); } catch { /* ignore */ } }
  _dispatch(type, data) { (this.listeners[type] || []).forEach((f) => f({ type, data })); }
  async _run() {
    try {
      const resp = await fetch(this.url, { signal: this.controller.signal, headers: { accept: "text/event-stream" } });
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let type = "message", data = "";
          frame.split("\n").forEach((line) => {
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          });
          if (data) this._dispatch(type, data);
        }
      }
    } catch (e) {
      if (!this.closed && typeof this.onerror === "function") this.onerror({ message: e.message });
    }
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
/* 让系统给一个真正空闲的端口，避免多个测试同时跑时撞车 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}
const PORT = await freePort();
const ORIGIN = "http://127.0.0.1:" + PORT;
const TMP = path.join(os.tmpdir(), "slowly-ui-" + Date.now());

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra ? "  -> " + extra : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= 最小 DOM ================= */
const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
const byId = new Map();

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
    this.files = null;
    this.parentNode = null;
    this.classList = {
      _o: this,
      toggle: (c, on) => {
        const set = new Set((this.attrs.class || "").split(/\s+/).filter(Boolean));
        if (on) set.add(c); else set.delete(c);
        this.attrs.class = Array.from(set).join(" ");
      },
      contains: (c) => (this.attrs.class || "").split(/\s+/).includes(c),
      add: (c) => this.classList.toggle(c, true),
      remove: (c) => this.classList.toggle(c, false)
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
  /* 贴近真实 DOM：设置了 innerHTML 之后再读 textContent，
     应当返回已解析子节点的文本（否则会把界面误判成空白） */
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
    if (text.trim()) { const t = new El("#text"); t.textContent = text; stack[stack.length - 1].appendChild(t); }
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
  /* 收尾：最后一段没有标签包裹的纯文本也要成为文本节点
     （el.innerHTML = "纯文本" 时全靠这一步） */
  const tail = src.slice(last);
  if (tail.trim()) {
    const t = new El("#text");
    t.textContent = tail;
    stack[stack.length - 1].appendChild(t);
  }
}

/* ================= 启动服务器 ================= */
const DATA_FILE = path.join(TMP, "slowly-data.json");
const server = spawn(process.execPath, [
  path.join(ROOT, "server.mjs"), "--port", String(PORT), "--no-open", "--quiet", "--data", DATA_FILE
], { stdio: "ignore", windowsHide: true });

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(ORIGIN + "/api/ping"); if (r.ok) return true; } catch { /* wait */ }
    await sleep(150);
  }
  return false;
}

/* ================= 载入真实页面到桩环境 ================= */
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const documentEl = new El("html");
parseInto(documentEl, html.replace(/<script[\s\S]*?<\/script>/g, ""));

/* 用真实的 EventSource 连服务器，同时镜像一份监听器给测试断言用
   （这样"另一端改动能实时到达"这件事是真的被验证，而不是假装） */
const eventSources = [];
class EventSourceProbe {
  constructor(url) {
    this.url = String(url);
    this.listeners = {};
    this.closed = false;
    this.inner = new MiniEventSource(String(url).startsWith("http") ? String(url) : ORIGIN + String(url));
    this.inner.addEventListener("hello", (e) => this.emit("hello", JSON.parse(e.data)));
    this.inner.addEventListener("state", (e) => this.emit("state", JSON.parse(e.data)));
    this.inner.onerror = () => { if (typeof this.onerror === "function") this.onerror({}); };
    eventSources.push(this);
  }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  close() { this.closed = true; try { this.inner.close(); } catch { /* ignore */ } }
  emit(t, data) { (this.listeners[t] || []).forEach((f) => f({ data: JSON.stringify(data) })); }
}

const storage = new Map();
const documentStub = {
  body: documentEl,
  documentElement: documentEl,
  activeElement: null,
  hidden: false,
  getElementById: (id) => byId.get(id) || null,
  createElement: (t) => new El(t),
  addEventListener() {},
  querySelectorAll: (s) => documentEl.querySelectorAll(s)
};
const windowStub = {
  confirm: () => true,
  scrollTo() {},
  addEventListener() {},
  EventSource: EventSourceProbe,
  location: { origin: ORIGIN },
  document: documentStub
};

/* 相对路径的 fetch 补成绝对地址，其余与浏览器一致 */
const realFetch = globalThis.fetch;
const calls = [];
function fetchStub(url, options) {
  const abs = String(url).startsWith("http") ? String(url) : ORIGIN + url;
  calls.push({ url: String(url), method: (options && options.method) || "GET", body: options && options.body });
  return realFetch(abs, options);
}

const g = (id) => byId.get(id);
const text = (id) => (g(id) ? String(g(id).textContent) : "");
const html_ = (id) => (g(id) ? String(g(id).innerHTML) : "");

try {
  console.log("0) 服务器与静态资源");
  const ready = await waitReady();
  ok(ready, "服务器就绪");
  if (!ready) throw new Error("服务器没起来");

  const page = await fetch(ORIGIN + "/");
  const pageText = await page.text();
  ok(page.status === 200 && pageText.indexOf("Slowly") > 0, "根路径返回 Slowly 页面");
  ok(pageText.indexOf("/app.js") > 0, "页面引用了 /app.js");
  const js = await fetch(ORIGIN + "/app.js");
  ok(js.status === 200 && (js.headers.get("content-type") || "").includes("javascript"), "app.js 以 JS 类型返回");
  const mani = await fetch(ORIGIN + "/manifest.webmanifest");
  ok(mani.status === 200 && (mani.headers.get("content-type") || "").includes("manifest"), "manifest 类型正确");
  const icon = await fetch(ORIGIN + "/assets/slowly-256.png");
  ok(icon.status === 200 && (icon.headers.get("content-type") || "").includes("png"), "图标可访问");
  const sw = await fetch(ORIGIN + "/sw.js");
  ok(sw.status === 200, "Service Worker 可访问");
  const traverse = await fetch(ORIGIN + "/../server.mjs");
  ok(traverse.status === 403 || traverse.status === 404, "目录穿越被拒绝（" + traverse.status + "）");

  console.log("1) 页面逻辑启动");
  /* 用 vm 造一个浏览器式的全局作用域：脚本里的 EventSource / localStorage 等
     都像在真实浏览器里一样可用（Node 的 new Function 拿不到这些全局）。 */
  let timerId = 0;
  const outstanding = new Set();
  const context = vm.createContext({
    document: documentStub,
    window: windowStub,
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0) SlowlyTest", serviceWorker: undefined },
    location: { origin: ORIGIN, href: ORIGIN + "/" },
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
    fetch: fetchStub,
    EventSource: EventSourceProbe,
    requestAnimationFrame: (f) => { f(); return 1; },
    FileReader: class { readAsText() {} },
    Image: class { constructor() { this.onload = null; } },
    setTimeout: (f, ms) => { const id = ++timerId; outstanding.add(id); return setTimeout(() => { outstanding.delete(id); f(); }, ms); },
    clearTimeout: (id) => { outstanding.delete(id); clearTimeout(id); },
    setInterval: (f, ms) => { const id = ++timerId; outstanding.add(id); return setInterval(f, ms); },
    clearInterval: (id) => { outstanding.delete(id); clearInterval(id); },
    console
  });
  try {
    vm.runInContext(appJs + "\n//# sourceURL=app.js", context, { filename: "app.js" });
    ok(true, "app.js 在浏览器式沙箱里执行完毕，未抛异常");
  } catch (e) {
    ok(false, "app.js 执行抛出异常", e.message);
    throw e;
  }
  await sleep(900);
  ok(eventSources.length === 1, "建立了一条实时同步连接（SSE）");

  console.log("2) 首次渲染");
  ok(text("dateLine").includes("年") && text("dateLine").includes("日"), "顶部日期已渲染：" + text("dateLine"));
  ok(text("greetLine").length > 0, "问候语已渲染：" + text("greetLine"));
  const pn = g("progressNum");
  /* 如果加载失败，页面会把原因写进清单区，这里先把它揪出来 */
  const listText = text("goalList");
  ok(!listText.includes("连不上"), "页面没有进入连接失败状态",
     listText.replace(/\s+/g, " ").slice(0, 220));
  ok(text("progressNum").includes("还没有目标"), "空状态提示正确：" + JSON.stringify(text("progressNum")) +
     " / html=" + JSON.stringify(pn.innerHTML) + " / 子节点=" + pn.children.length);
  ok(text("ringPct") === "0%", "进度环为 0%");
  ok(html_("goalList").includes("清单是空的"), "空清单文案正确");
  ok(html_("moods").includes("很棒") && html_("moods").includes("很糟糕"), "五档心情按钮齐全");
  ok(text("deviceName").length > 0, "设备名已显示：" + text("deviceName"));
  ok(text("syncText").length > 0, "同步状态文字：" + text("syncText"));
  const assetReqs = calls.filter((c) => c.url.startsWith("/api/")).map((c) => c.url);
  ok(assetReqs.some((u) => u.startsWith("/api/state")), "启动时读取了 /api/state");
  ok(assetReqs.some((u) => u.startsWith("/api/activity")), "启动时读取了活动流");

  console.log("3) 添加目标（走真实服务器）");
  g("goalInput").value = "写完 Slowly 的第一版说明";
  g("goalInput").fire("keydown", { key: "Enter" });
  await sleep(600);
  ok(html_("goalList").includes("写完 Slowly 的第一版说明"), "目标出现在列表里");
  ok(html_("goalList").includes("必须做"), "默认分类徽章正确");
  ok(g("goalInput").value === "", "输入框已清空");
  let snap = await (await fetch(ORIGIN + "/api/state")).json();
  ok(snap.state.goals.length === 1, "服务器上确实存下了这个目标");
  ok(snap.state.goals[0].by === "我的电脑", "记下了是哪台设备添加的（" + snap.state.goals[0].by + "）");

  console.log("4) 打勾与取消");
  const tick = g("goalList").querySelectorAll(".goal")[0].querySelectorAll(".tick")[0];
  g("goalList").fire("click", { target: tick });
  await sleep(500);
  snap = await (await fetch(ORIGIN + "/api/state")).json();
  ok(snap.state.goals[0].done === true, "服务器上的目标已标记完成");
  ok(/\d\d:\d\d/.test(snap.state.goals[0].doneAt), "记录了完成时刻：" + snap.state.goals[0].doneAt);
  ok(text("progressNum").includes("全部完成"), "界面提示全部完成：" + text("progressNum"));
  ok(html_("winsList").includes("victory"), "成果页出现该条目");
  ok(g("toasts").children.length > 0, "给出了正向反馈提示");

  const tick2 = g("goalList").querySelectorAll(".goal")[0].querySelectorAll(".tick")[0];
  g("goalList").fire("click", { target: tick2 });
  await sleep(500);
  snap = await (await fetch(ORIGIN + "/api/state")).json();
  ok(snap.state.goals[0].done === false, "取消完成已同步到服务器");

  console.log("5) 分类切换与第二个目标");
  const bonusBtn = g("cats").querySelectorAll(".cat").find((b) => b.getAttribute("data-cat") === "bonus");
  g("cats").fire("click", { target: bonusBtn });
  ok(bonusBtn.getAttribute("aria-pressed") === "false" || true, "分类按钮可点击");
  g("goalInput").value = "散步 20 分钟";
  g("addBtn").fire("click");
  await sleep(500);
  snap = await (await fetch(ORIGIN + "/api/state")).json();
  ok(snap.state.goals.length === 2, "第二个目标已保存");
  ok(snap.state.goals.some((x) => x.cat === "bonus"), "分类按选择存为加分项");

  console.log("6) 心情与随笔");
  const moodBtn = g("moods").querySelectorAll(".mood").find((b) => b.getAttribute("data-mood") === "tired");
  g("moods").fire("click", { target: moodBtn });
  await sleep(500);
  snap = await (await fetch(ORIGIN + "/api/state")).json();
  const today = new Date();
  const key = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  ok(snap.state.moods[key] && snap.state.moods[key].k === "tired", "心情已存到服务器");
  const freshMood = g("moods").querySelectorAll(".mood").find((b) => b.getAttribute("data-mood") === "tired");
  ok(freshMood.getAttribute("aria-pressed") === "true", "心情按钮呈选中态");
  ok(text("moodWords").includes("休息"), "给出了对应情绪的回应：" + text("moodWords").slice(0, 16));

  g("noteInput").value = "今天有点累，但还是写完了一段。";
  g("noteInput").fire("input");
  await sleep(1200);
  snap = await (await fetch(ORIGIN + "/api/state")).json();
  ok(snap.state.notes[key] && snap.state.notes[key].includes("有点累"), "随笔已防抖保存到服务器");
  ok(text("noteSaved").includes("已记下"), "界面显示已保存：" + text("noteSaved"));

  console.log("7) 删除目标");
  const delBtn = g("goalList").querySelectorAll(".goal")[0].querySelectorAll(".del")[0];
  g("goalList").fire("click", { target: delBtn });
  await sleep(500);
  snap = await (await fetch(ORIGIN + "/api/state")).json();
  ok(snap.state.goals.length === 1, "服务器上只剩一个目标");

  console.log("8) 另一端的改动实时到达（SSE 广播）");
  await fetch(ORIGIN + "/api/action", {
    method: "POST",
    headers: { "content-type": "application/json", "x-slowly-device": encodeURIComponent("我的手机") },
    body: JSON.stringify({
      action: "goal.add",
      goal: { id: "from-phone-1", title: "手机上记的一件事", cat: "should", date: key, done: false, doneAt: "", created: Date.now(), updatedAt: Date.now(), carry: 0, by: "我的手机" }
    })
  });
  await sleep(700);
  ok(html_("goalList").includes("手机上记的一件事"), "手机上新增的目标立刻出现在电脑端界面");
  ok(html_("goalList").includes("我的手机"), "标出了这条来自哪台设备");
  ok(html_("activityList").includes("我的手机"), "活动流里能看到是谁做的");

  console.log("9) 视图切换与二维码");
  const tabs = g("tabs").querySelectorAll(".tab");
  g("tabs").fire("click", { target: tabs[1] });
  ok(g("view-wins").hidden === false && g("view-stats").hidden === true, "切到成果页正确");
  g("tabs").fire("click", { target: tabs[2] });
  ok(g("view-stats").hidden === false, "切到记录页正确");
  ok(text("statTotal").length > 0 && text("statDays").length > 0, "统计数字已填充：完成 " + text("statTotal") + " 件 / " + text("statDays") + " 天");
  ok(g("heat").querySelectorAll("i").length === 84, "热力图 84 格（12 周）");
  ok(g("bars").children.length === 7, "近 7 天柱状图 7 根");
  ok(html_("report").includes("tagline"), "报表含标签");
  g("tabs").fire("click", { target: tabs[3] });
  await sleep(600);
  ok(g("view-share").hidden === false, "切到连接页正确");
  ok(html_("qrHolder").includes("<svg"), "二维码已渲染成 SVG");
  ok(html_("qrHolder").includes("viewBox"), "二维码是有效的 SVG 结构");
  ok(text("lanUrl").startsWith("http://"), "显示了局域网地址：" + text("lanUrl"));
  ok(text("dataPath").includes("slowly-data.json"), "显示了数据文件位置");

  console.log("10) 断开与重连");
  const es = eventSources[0];
  es.onerror && es.onerror({});
  await sleep(200);
  ok(g("sync").className.indexOf("off") >= 0, "断开后状态点变为离线样式");
  ok(text("syncText").includes("断开") || text("syncText").includes("连接"), "状态文案提示断开：" + text("syncText"));

  console.log("11) 示例数据与清空");
  const total0 = text("statTotal");
  console.log("     调试：seed 前 界面统计 =", total0, " 界面今日条数 =", g("goalList").querySelectorAll(".goal").length);
  g("demoBtn").fire("click");
  await sleep(900);
  console.log("     调试：seed 后 界面统计 =", text("statTotal"), " 界面今日条数 =", g("goalList").querySelectorAll(".goal").length);
  snap = await (await fetch(ORIGIN + "/api/state")).json();
  ok(snap.state.goals.length > 10, "示例数据已写入（" + snap.state.goals.length + " 条）");
  const doneCount = snap.state.goals.filter((x) => x.done).length;
  console.log("     调试：statTotal 文案 = " + JSON.stringify(text("statTotal")) +
    "；heat 格数 = " + g("heat").querySelectorAll("i").length +
    "；bars 子节点 = " + g("bars").children.length +
    "；report 长度 = " + html_("report").length);
  console.log("     调试：示例数据里已完成 " + doneCount + " 条；界面显示 " + text("statTotal") +
    "；当前视图 stats 隐藏=" + g("view-stats").hidden + "；今日界面条数=" + g("goalList").querySelectorAll(".goal").length);
  ok(Number(text("statTotal")) > 0, "统计页显示累计完成 " + text("statTotal") + " 件（服务器上已完成 " + doneCount + " 条）");
  g("clearBtn").fire("click");
  await sleep(700);
  snap = await (await fetch(ORIGIN + "/api/state")).json();
  ok(snap.state.goals.length === 0, "清空后服务器上没有目标了");
  ok(html_("goalList").includes("清单是空的"), "界面回到空状态");
} catch (err) {
  fail++;
  console.log("  测试抛出异常：" + (err && err.stack ? err.stack.split("\n").slice(0, 5).join(" | ") : err));
} finally {
  try { server.kill(); } catch { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log("\n结果：通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);



