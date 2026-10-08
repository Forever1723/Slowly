/* =============================================================
   Slowly · 本地服务器（零依赖，只用 Node 内置模块）

   作用：把 Slowly 的数据放在这台电脑上，电脑浏览器与手机连同一个地址，
        任何一端的改动都会立刻同步给另一端。
   数据文件：%APPDATA%\Slowly\slowly-data.json（可用 SLOWLY_DATA 覆盖）

   启动：node server.mjs [--port 8787] [--no-open] [--data <路径>]
   ============================================================= */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const qr = require("./lib/qr.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const ASSETS_DIR = path.join(HERE, "assets");
const APP_NAME = "Slowly";
const VERSION = "1.0.0";

/* ---------------- 命令行参数 ---------------- */
const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const PORT = Number(argValue("--port", process.env.SLOWLY_PORT || 8787));
const NO_OPEN = argv.includes("--no-open");
const WANT_APP_WINDOW = argv.includes("--app");
const QUIET = argv.includes("--quiet");

/* ---------------- 数据文件 ---------------- */
function defaultDataDir() {
  if (process.env.SLOWLY_DATA) return path.dirname(process.env.SLOWLY_DATA);
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, APP_NAME);
  return path.join(os.homedir(), "." + APP_NAME.toLowerCase());
}
/* --data 与 SLOWLY_DATA 都支持；前者优先 */
const DATA_ARG = argValue("--data", process.env.SLOWLY_DATA || "");
let DATA_FILE = DATA_ARG ? path.resolve(DATA_ARG) : path.join(defaultDataDir(), "slowly-data.json");
let DATA_DIR = path.dirname(DATA_FILE);
let BACKUP_DIR = path.join(DATA_DIR, "backups");
let dataFallback = false;

/* 启动自检：确认数据目录真的能写。写不了就退回到程序目录下的 data\，
   免得用户记了一整天，第一次保存才发现存不下。 */
function ensureDataDirWritable() {
  const probe = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    const test = path.join(dir, ".write-test-" + process.pid);
    fs.writeFileSync(test, "ok");
    fs.unlinkSync(test);
  };
  try {
    probe(DATA_DIR);
    return true;
  } catch (err) {
    if (DATA_ARG) {
      console.log("  指定的数据目录不可写：" + DATA_DIR + "（" + err.message + "）");
      return false;
    }
    const fallbackDir = path.join(HERE, "data");
    try {
      probe(fallbackDir);
      DATA_FILE = path.join(fallbackDir, "slowly-data.json");
      DATA_DIR = fallbackDir;
      BACKUP_DIR = path.join(DATA_DIR, "backups");
      dataFallback = true;
      console.log("  默认数据目录不可写，已改用：" + DATA_FILE);
      return true;
    } catch (e2) {
      console.log("  数据目录都不可写，Slowly 无法保存：" + e2.message);
      return false;
    }
  }
}

function emptyState() {
  return { version: 1, goals: [], moods: {}, notes: {}, tombstones: {}, seed: String(Date.now()) };
}

/* 删除标记（墓碑）保留天数。手机离线期间删掉的东西，
   回到网上必须能真正删掉，所以删除要留下带时间的痕迹。 */
const TOMBSTONE_KEEP_DAYS = 90;

/* 时间戳下限：2019-01-01。设备时间错乱时宁可保留数据，也不要把记录当成过期墓碑清掉 */
const MIN_VALID_TS = 1546300800000;

function pruneTombstones(map) {
  const out = {};
  const cutoff = Date.now() - TOMBSTONE_KEEP_DAYS * 86400000;
  for (const [k, v] of Object.entries(map || {})) {
    const t = Number(v);
    if (Number.isFinite(t) && t >= MIN_VALID_TS && t >= cutoff) out[k] = t;
  }
  return out;
}

/* ---------------- 三方合并（电脑、手机、离线数据都走这一套） ----------------
   规则：
   - 目标按 id 去重，updatedAt 新的胜出
   - 墓碑时间晚于目标的 updatedAt 才算真删除
   - 心情 / 随笔按时间戳新的胜出
   同一份逻辑两端各有一份实现，测试里会交叉验证它们结果一致。 */
function mergeStates(base, incoming) {
  const a = normalizeState(base);
  const b = normalizeState(incoming);

  const tombstones = Object.assign({}, a.tombstones);
  for (const [id, t] of Object.entries(b.tombstones)) {
    tombstones[id] = Math.max(Number(t) || 0, Number(tombstones[id]) || 0);
  }

  const byId = new Map();
  for (const g of a.goals) byId.set(g.id, g);
  for (const g of b.goals) {
    const old = byId.get(g.id);
    if (!old) { byId.set(g.id, g); continue; }
    const oldT = Number(old.updatedAt || old.created || 0);
    const newT = Number(g.updatedAt || g.created || 0);
    if (newT >= oldT) byId.set(g.id, g);
  }
  const goals = Array.from(byId.values()).filter((g) => {
    const dead = Number(tombstones[g.id] || 0);
    return !(dead && dead >= Number(g.updatedAt || g.created || 0));
  });

  const moods = Object.assign({}, a.moods);
  for (const [k, v] of Object.entries(b.moods)) {
    const oldAt = Number((moods[k] || {}).at || 0);
    if (Number(v.at || 0) >= oldAt) moods[k] = v;
  }
  const notes = Object.assign({}, a.notes);
  const noteAt = (s) => Number((s && s.at) || 0);
  for (const [k, v] of Object.entries(b.notes)) {
    const isObj = v && typeof v === "object";
    const oldIsObj = notes[k] && typeof notes[k] === "object";
    if (isObj) {
      if (!oldIsObj || noteAt(v) >= noteAt(notes[k])) notes[k] = v;
    } else if (!oldIsObj) {
      notes[k] = v;   // 旧版纯字符串：对象形式优先
    }
  }

  return { version: 1, goals, moods, notes, tombstones: pruneTombstones(tombstones), seed: b.seed || a.seed };
}

let state = emptyState();
let rev = 0;                 // 每次写入自增，客户端据此判断是否落后
let lastWriter = "";         // 最近一次写入来自哪个设备（用于提示"手机刚更新"）
let savedAt = 0;

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyState();
  return {
    version: 1,
    goals: Array.isArray(raw.goals) ? raw.goals.filter((g) => g && typeof g === "object" && typeof g.id === "string") : [],
    moods: raw.moods && typeof raw.moods === "object" && !Array.isArray(raw.moods) ? raw.moods : {},
    notes: raw.notes && typeof raw.notes === "object" && !Array.isArray(raw.notes) ? raw.notes : {},
    tombstones: raw.tombstones && typeof raw.tombstones === "object" && !Array.isArray(raw.tombstones) ? pruneTombstones(raw.tombstones) : {},
    seed: typeof raw.seed === "string" ? raw.seed : String(Date.now())
  };
}

function loadFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      state = normalizeState(parsed.state ? parsed.state : parsed);
      rev = typeof parsed.rev === "number" ? parsed.rev : 0;
      savedAt = typeof parsed.savedAt === "number" ? parsed.savedAt : 0;
      lastWriter = typeof parsed.lastWriter === "string" ? parsed.lastWriter : "";
      return true;
    }
  } catch (err) {
    log("数据文件读取失败，改用空白数据启动：" + err.message);
    /* 坏文件先留一份，避免用户数据被静默覆盖 */
    try {
      const bad = DATA_FILE + ".broken-" + Date.now();
      fs.copyFileSync(DATA_FILE, bad);
      log("已将无法解析的文件另存为 " + path.basename(bad));
    } catch { /* 尽力而为 */ }
  }
  return false;
}

/* 线上版地址：二维码优先指向它。
   为什么用线上版而不是直接指向电脑：线上版装过一次就一直存在手机主屏上，
   以后离开 WiFi 也能记，回家同步即可；而且扫码后由线上版自己完成配对，
   手机浏览器和安卓 App 用的是同一套逻辑。留空则退回直接指向电脑的地址。 */
const HOSTED_APP = String(process.env.SLOWLY_HOSTED || "https://forever1723.github.io/Slowly/").trim();

/* ---------------- 配对令牌 ----------------
 *
 * 为什么需要它：手机要同步，就得知道电脑的地址。手输 IP 又长又容易错。
 * 这里的做法是把「地址 + 一个令牌」编进二维码，手机扫一下就把
 * 电脑的地址记下来了 —— 一个字符都不用敲。
 *
 * 令牌存在数据目录下的 pairing.json，跟着数据走：换数据目录就等于换一套配对。
 * 它只是个"局域网里的握手凭据"，不是账号密码 —— 拿到它的人仍然必须
 * 处在同一个局域网里才能连上这台电脑。
 */
const PAIR_FILE = () => path.join(DATA_DIR, "pairing.json");

function makeToken() {
  /* 去掉容易看错的 0/O/1/I，方便用户需要时手抄 */
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(6);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

let pairToken = "";
let pairCreatedAt = 0;

async function loadPairToken() {
  try {
    const raw = await fsp.readFile(PAIR_FILE(), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.token === "string" && parsed.token.length >= 4) {
      pairToken = parsed.token;
      pairCreatedAt = Number(parsed.createdAt) || 0;
      return;
    }
  } catch { /* 首次运行没有这个文件，属正常 */ }
  pairToken = makeToken();
  pairCreatedAt = Date.now();
  await savePairToken();
}

async function savePairToken() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = PAIR_FILE() + ".tmp-" + process.pid;
    await fsp.writeFile(tmp, JSON.stringify({ token: pairToken, createdAt: pairCreatedAt }, null, 2), "utf8");
    await fsp.rename(tmp, PAIR_FILE());
  } catch { /* 写不进去也不该影响主流程，下次启动会重新生成 */ }
}

async function rotatePairToken() {
  pairToken = makeToken();
  pairCreatedAt = Date.now();
  await savePairToken();
  return pairToken;
}

function pairingSnapshot() {
  const lan = lanUrl();
  const token = pairToken;
  /* 扫码后打开的地址：优先线上版，带上令牌与电脑地址。
     令牌放在 # 里 —— 片段不会发给任何服务器，只有手机本地能读到。 */
  let pairUrl = "";
  if (HOSTED_APP) {
    const base = HOSTED_APP.replace(/#.*$/, "");
    const parts = ["pair=" + encodeURIComponent(token)];
    if (lan) parts.push("srv=" + encodeURIComponent(lan));
    pairUrl = base + "#" + parts.join("&");
  } else if (lan) {
    pairUrl = lan + "?pair=" + encodeURIComponent(token);
  }
  return {
    token: token,
    code: token,
    createdAt: pairCreatedAt,
    lanUrl: lan,
    lanUrls: lanAddresses().filter((a) => !a.virtual).map((a) => "http://" + a.address + ":" + PORT + "/"),
    hosted: HOSTED_APP,
    /* 二维码就编这个地址 */
    pairUrl: pairUrl,
  };
}

/*
 * 原子写入：先写临时文件再改名，避免断电/崩溃留下半个文件。
 *
 * 两个要点，都是踩过的坑：
 *
 * 1) **必须串行**。并发请求会同时进来，如果几个 persist 并行跑，
 *    它们会争同一个临时文件：A 改名成功之后，B 仍然握着那个路径继续写，
 *    于是把半截内容追加到了已经改名的正式文件后面 —— 数据文件直接损坏
 *    （实测出现过 "Unexpected non-whitespace character after JSON"，
 *     文件里是"一个完整文档 + 半截对象"）。所以这里用一条 promise 链
 *    把写入排队，谁先来谁先写。
 *
 * 2) **临时文件名必须唯一**。原来用 DATA_FILE + ".tmp-" + pid，
 *    同一进程内的并发写入会撞名。加上递增序号区分。
 */
let writeChain = Promise.resolve();
let writeSeq = 0;

function persist(writer) {
  /* 排队：即使上一次写失败，也不能卡住后面的写入 */
  const task = writeChain.then(() => doPersist(writer), () => doPersist(writer));
  writeChain = task.catch(() => { });
  return task;
}

async function doPersist(writer) {
  rev += 1;
  savedAt = Date.now();
  lastWriter = writer || "";
  const payload = JSON.stringify({ rev, savedAt, lastWriter, state }, null, 2);
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp-" + process.pid + "-" + (writeSeq++);
  try {
    await fsp.writeFile(tmp, payload, "utf8");
    await fsp.rename(tmp, DATA_FILE);
  } catch (e) {
    /* 写失败时清掉可能残留的临时文件，别在数据目录里越积越多 */
    try { await fsp.unlink(tmp); } catch { /* 本来就没写出来 */ }
    throw e;
  }
  /* 每天首次写入时留一份备份，最多保留 14 份 */
  await maybeBackup();
  return rev;
}

let lastBackupDay = "";
async function maybeBackup() {
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (day === lastBackupDay) return;
    lastBackupDay = day;
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    const target = path.join(BACKUP_DIR, "slowly-" + day + ".json");
    if (!fs.existsSync(target)) await fsp.copyFile(DATA_FILE, target);
    const files = (await fsp.readdir(BACKUP_DIR)).filter((f) => f.startsWith("slowly-")).sort();
    while (files.length > 14) {
      const victim = files.shift();
      await fsp.unlink(path.join(BACKUP_DIR, victim));
    }
  } catch { /* 备份失败不影响主流程 */ }
}

/* ---------------- 局域网地址 ---------------- */
function lanAddresses() {
  const list = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      /* 198.18.0.0/15 是基准测试保留网段，常见于虚拟网卡/代理，手机连不上，排到后面 */
      const isVirtual = /^198\.1[89]\./.test(a.address) || /^169\.254\./.test(a.address);
      list.push({ name, address: a.address, virtual: isVirtual });
    }
  }
  list.sort((x, y) => Number(x.virtual) - Number(y.virtual));
  return list;
}

function lanUrl() {
  const best = lanAddresses().find((a) => !a.virtual);
  return best ? "http://" + best.address + ":" + PORT + "/" : "";
}

/* ---------------- SSE 广播 ---------------- */
const clients = new Set();

function broadcast(event, data, exceptId) {
  const payload = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
  for (const c of clients) {
    if (exceptId && c.id === exceptId) continue;
    try { c.res.write(payload); } catch { /* 断开的连接会在 close 时清理 */ }
  }
}

function sseHandler(req, res, url) {
  const id = url.searchParams.get("device") || crypto.randomBytes(4).toString("hex");
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  res.write("retry: 2000\n\n");
  const client = { id, res, device: url.searchParams.get("device") || "" };
  clients.add(client);
  res.write("event: hello\ndata: " + JSON.stringify({ rev, clients: clients.size }) + "\n\n");
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* ignore */ } }, 25000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

/* ---------------- 活动流（谁在什么时候做了什么） ---------------- */
const activity = [];
function pushActivity(entry) {
  activity.push(Object.assign({ at: Date.now() }, entry));
  while (activity.length > 60) activity.shift();
}

/* ---------------- 请求处理 ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";
  /* /assets 单独映射到应用自带的资源目录（图标等），其余走 public */
  let baseDir = PUBLIC_DIR;
  if (rel === "/assets" || rel.startsWith("/assets/")) {
    baseDir = ASSETS_DIR;
    rel = rel.slice("/assets".length) || "/";
  }
  const target = path.join(baseDir, path.normalize(rel).replace(/^([/\\])+/, ""));
  if (!target.startsWith(baseDir)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await fsp.readFile(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      "content-length": data.length
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("没有这个文件：" + rel);
  }
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error("JSON 解析失败：" + e.message)); }
    });
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

/* ---------------- 请求处理 ---------------- */
function applyAction(action, body, device) {
  const changed = { goals: false, moods: false, notes: false };
  switch (action) {
    case "goal.add": {
      const g = body.goal;
      if (!g || typeof g.id !== "string") throw new Error("缺少 goal.id");
      if (!state.goals.some((x) => x.id === g.id)) state.goals.push(g);
      changed.goals = true;
      pushActivity({ device, text: "新增目标「" + String(g.title || "").slice(0, 24) + "」" });
      break;
    }
    case "goal.update": {
      const g = body.goal;
      if (!g || typeof g.id !== "string") throw new Error("缺少 goal.id");
      const idx = state.goals.findIndex((x) => x.id === g.id);
      if (idx >= 0) state.goals[idx] = Object.assign({}, state.goals[idx], g);
      else state.goals.push(g);
      changed.goals = true;
      pushActivity({ device, text: (g.done ? "完成" : "取消完成") + "「" + String(g.title || "").slice(0, 24) + "」" });
      break;
    }
    case "goal.remove": {
      const id = body.id;
      const target = state.goals.find((x) => x.id === id);
      state.goals = state.goals.filter((x) => x.id !== id);
      state.tombstones[id] = Date.now();   // 留墓碑，离线设备同步时才不会把它带回来
      changed.goals = true;
      if (target) pushActivity({ device, text: "删除「" + String(target.title || "").slice(0, 24) + "」" });
      break;
    }
    case "goal.carry": {
      const to = body.to || new Date().toISOString().slice(0, 10);
      const moved = [];
      for (const g of state.goals) {
        if (!g.done && g.date < to) {
          g.date = to;
          g.carry = Number(g.carry || 0) + 1;
          g.updatedAt = Date.now();
          moved.push(g);
        }
      }
      changed.goals = true;
      if (moved.length) pushActivity({ device, text: "把 " + moved.length + " 件没做完的事挪到了 " + to });
      break;
    }
    case "mood.set": {
      const key = body.date;
      if (body.mood) state.moods[key] = { k: body.mood, at: Date.now(), device };
      else delete state.moods[key];
      changed.moods = true;
      pushActivity({ device, text: body.mood ? "记录了心情（" + key + "）" : "取消了心情记录（" + key + "）" });
      break;
    }
    case "note.set": {
      const key = body.date;
      if (body.text) state.notes[key] = String(body.text).slice(0, 4000);
      else delete state.notes[key];
      changed.notes = true;
      break;
    }
    case "state.merge": {
      /* 手机离线期间攒下的数据并回电脑：按 id 与时间戳合并，谁也不覆盖谁 */
      const next = mergeStates(state, body.state);
      state = next;
      changed.goals = changed.moods = changed.notes = true;
      pushActivity({ device, text: "同步了设备上的离线数据" });
      break;
    }
    case "state.replace": {
      const next = normalizeState(body.state);
      state = next;
      changed.goals = changed.moods = changed.notes = true;
      pushActivity({ device, text: "导入了整份数据" });
      break;
    }
    case "demo.seed": {
      const next = normalizeState(body.state);
      state = next;
      changed.goals = changed.moods = changed.notes = true;
      pushActivity({ device, text: "装载了示例数据" });
      break;
    }
    case "state.clear": {
      /* 清空也要留墓碑，否则离线手机一同步就把删掉的东西带回来了 */
      const marks = body.tombstones && typeof body.tombstones === "object" ? body.tombstones : {};
      const now = Date.now();
      state.goals.forEach((g) => { if (!marks[g.id]) marks[g.id] = now; });
      state = emptyState();
      state.tombstones = pruneTombstones(marks);
      changed.goals = changed.moods = changed.notes = true;
      pushActivity({ device, text: "清空了全部记录" });
      break;
    }
    default:
      throw new Error("不认识的操作：" + action);
  }
  return changed;
}

async function handleApi(req, res, url) {
  const action = url.pathname.slice("/api/".length);
  /* 设备名走 HTTP 头，按规范必须是 Latin-1，所以客户端用 encodeURIComponent 编码 */
  const rawDevice = String(req.headers["x-slowly-device"] || url.searchParams.get("device") || "");
  let device = rawDevice;
  if (/%/.test(rawDevice)) {
    try { device = decodeURIComponent(rawDevice); } catch { device = rawDevice; }
  }
  device = device.slice(0, 40);

  if (action === "ping" && req.method === "GET") {
    return json(res, 200, { ok: true, name: APP_NAME, version: VERSION, rev, lanUrl: lanUrl(), clients: clients.size });
  }

  if (action === "state" && req.method === "GET") {
    return json(res, 200, {
      rev, savedAt, lastWriter,
      state,
      server: {
        name: APP_NAME, version: VERSION,
        dataFile: DATA_FILE,
        lanUrl: lanUrl(),
        addresses: lanAddresses(),
        clients: clients.size,
        uptime: Math.round(process.uptime())
      },
      pairing: pairingSnapshot()
    });
  }

  /* 配对：手机扫码后由网页调这个接口，把「地址 + 令牌」登记成自己的同步目标。
     GET 返回配对信息（令牌本身就是局域网内的握手凭据）；POST 用于换一个令牌。 */
  if (action === "pair" && req.method === "GET") {
    return json(res, 200, { ok: true, pairing: pairingSnapshot() });
  }

  if (action === "pair" && req.method === "POST") {
    await rotatePairToken();
    return json(res, 200, { ok: true, pairing: pairingSnapshot() });
  }

  /* 校验一个令牌对不对：手机提交后调用，确认"确实配对到了这台电脑" */
  if (action === "pair/verify" && req.method === "GET") {
    const given = String(url.searchParams.get("token") || "");
    const okToken = given && given.toUpperCase() === String(pairToken).toUpperCase();
    return json(res, okToken ? 200 : 403, { ok: Boolean(okToken) });
  }

  if (action === "events" && req.method === "GET") return sseHandler(req, res, url);

  if (action === "activity" && req.method === "GET") {
    return json(res, 200, { activity: activity.slice(-30).reverse() });
  }

  if (action === "offline" && req.method === "GET") {
    /* 把打包好的离线单文件发给手机：手机浏览器打开这个地址就能存下来 */
    try {
      const file = path.join(PUBLIC_DIR, "offline.html");
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": 'attachment; filename="Slowly-offline.html"',
        "cache-control": "no-store",
        "content-length": data.length
      });
      return res.end(data);
    } catch {
      return json(res, 404, { error: "还没有生成离线版，先在电脑上运行 node tools/build-offline.mjs" });
    }
  }

  if (action === "qr" && req.method === "GET") {
    const wanted = url.searchParams.get("url") || lanUrl() || ("http://127.0.0.1:" + PORT + "/");
    try {
      const { svg } = qr.toSVG(wanted, { ecLevel: "M", margin: 2, dark: "#2f2a26", light: "#ffffff" });
      res.writeHead(200, {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(svg)
      });
      return res.end(svg);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (action === "action" && req.method === "POST") {
    let body;
    try { body = await readBody(req); }
    catch (e) { return json(res, 413, { error: e.message }); }
    const act = String(body.action || "");
    try {
      const changed = applyAction(act, body, device);
      const newRev = await persist(device);
      const changedAny = changed.goals || changed.moods || changed.notes;
      broadcast("state", {
        rev: newRev, savedAt,
        lastWriter: device,
        changed,
        /* 只发变化的部分，减少两端来回搬运的数据量 */
        goals: changed.goals ? state.goals : null,
        moods: changed.moods ? state.moods : null,
        notes: changed.notes ? state.notes : null,
        tombstones: changedAny ? state.tombstones : null,
        activity: activity.slice(-1)[0] || null
      }, url.searchParams.get("client"));
      return json(res, 200, { ok: true, rev: newRev, state });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (action === "export" && req.method === "GET") {
    const body = JSON.stringify({ rev, savedAt, state }, null, 2);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="slowly-' + new Date().toISOString().slice(0, 10) + '.json"',
      "content-length": Buffer.byteLength(body)
    });
    return res.end(body);
  }

  return json(res, 404, { error: "未知接口：" + url.pathname });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json(res, 405, { error: "只支持 GET" });
    }
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

/* ---------------- 打印与启动 ---------------- */
function log(...args) {
  if (!QUIET) console.log(...args);
}

function banner() {
  const local = "http://127.0.0.1:" + PORT + "/";
  const lan = lanUrl();
  const lines = [
    "",
    "  Slowly · 慢慢来，比较快",
    "  ─────────────────────────────────────────────",
    "  电脑上打开： " + local,
    lan ? "  手机上打开： " + lan + "  （需与电脑同一 WiFi）" : "  手机上打开： 未找到局域网地址，请确认已连接 WiFi",
    "  数据文件：   " + DATA_FILE + (dataFallback ? "   （默认位置不可写，已回退）" : ""),
    "  版本：       v" + VERSION + "   （Ctrl+C 停止）",
    ""
  ];
  lines.forEach((l) => log(l));
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch (e) {
    log("没能自动打开浏览器，请手动访问：" + url);
    return false;
  }
}

/* Edge / Chrome 的"应用模式"：没有地址栏，看起来就是一个独立软件 */
function findChromium() {
  const candidates = [
    process.env["PROGRAMFILES"] && path.join(process.env["PROGRAMFILES"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["LOCALAPPDATA"] && path.join(process.env["LOCALAPPDATA"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["PROGRAMFILES"] && path.join(process.env["PROGRAMFILES"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env["LOCALAPPDATA"] && path.join(process.env["LOCALAPPDATA"], "Google", "Chrome", "Application", "chrome.exe")
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function openAppWindow(url) {
  const browser = findChromium();
  if (!browser) return openBrowser(url);
  const profileDir = path.join(DATA_DIR, "window-profile");
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* ignore */ }
  const args = [
    "--app=" + url,
    "--user-data-dir=" + profileDir,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=960,820",
    "--window-position=120,60"
  ];
  try {
    const child = spawn(browser, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch (e) {
    log("应用窗口启动失败，改用普通浏览器：" + e.message);
    return openBrowser(url);
  }
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log("");
    log("  端口 " + PORT + " 已经被占用了。");
    log("  可能 Slowly 已经在运行 —— 先试试打开 http://127.0.0.1:" + PORT + "/");
    log("  或者换一个端口：node server.mjs --port 8899");
    log("");
    process.exit(1);
  }
  throw err;
});

/* 先确认数据能写下，再把磁盘上的数据读进来，最后才开始监听 */
ensureDataDirWritable();
loadFromDisk();

/* 配对令牌：二维码里要带它，所以启动时先准备好 */
await loadPairToken();

server.listen(PORT, "0.0.0.0", () => {
  banner();
  const url = "http://127.0.0.1:" + PORT + "/";
  if (!NO_OPEN) {
    const ok = WANT_APP_WINDOW ? openAppWindow(url) : openBrowser(url);
    if (!ok) log("  请手动打开上面的网址");
  }
});

process.on("SIGINT", () => {
  log("\n  Slowly 已停止，数据都好好存着。明天见。\n");
  process.exit(0);
});

export { server, DATA_FILE, lanUrl, lanAddresses, pairingSnapshot, rotatePairToken };
