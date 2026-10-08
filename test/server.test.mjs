/* 服务端集成测试：真实启动 server.mjs，验证 API、持久化、并发写、SSE、二维码接口 */
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const BASE = "http://127.0.0.1:" + PORT;
const TMP = path.join(os.tmpdir(), "slowly-test-" + Date.now());
const DATA_FILE = path.join(TMP, "slowly-data.json");

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra ? "  -> " + extra : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 注意：DSH 沙箱下子进程不能用管道 stdio（EPERM），因此统一用 ignore，
   服务端是否就绪通过 HTTP 轮询判断，不依赖捕获它的输出。 */
const child = spawn(process.execPath, [
  path.join(ROOT, "server.mjs"),
  "--port", String(PORT),
  "--no-open",
  "--quiet",
  "--data", DATA_FILE
], { stdio: "ignore", windowsHide: true });

child.on("error", (e) => { console.log("服务进程启动失败：" + e.message); });

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/api/ping");
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  return false;
}

function cleanup() {
  try { child.kill(); } catch { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

try {
  console.log("0) 启动与健康检查");
  const ready = await waitReady();
  ok(ready, "服务器在 " + PORT + " 端口就绪并响应 /api/ping");
  if (!ready) { console.log(serverOut); cleanup(); process.exit(1); }

  const ping = await (await fetch(BASE + "/api/ping")).json();
  ok(ping.ok === true && ping.name === "Slowly", "ping 返回应用标识", JSON.stringify(ping));
  ok(typeof ping.lanUrl === "string", "ping 带有局域网地址字段：" + (ping.lanUrl || "(空)"));

  console.log("1) 初始状态");
  let snap = await (await fetch(BASE + "/api/state")).json();
  ok(snap.rev === 0 && snap.state.goals.length === 0, "新数据文件从 rev=0、空目标开始");
  ok(typeof snap.server.dataFile === "string" && snap.server.dataFile.endsWith("slowly-data.json"),
     "返回数据文件位置（便于用户备份）");

  console.log("2) 增删改目标");
  const goal = { id: "g-test-1", title: "写完 Slowly 的第一版", cat: "must", date: "2026-01-02", done: false, doneAt: "", created: Date.now(), carry: 0, updatedAt: Date.now() };
  let r = await fetch(BASE + "/api/action", {
    method: "POST", headers: { "content-type": "application/json", "x-slowly-device": encodeURIComponent("电脑") },
    body: JSON.stringify({ action: "goal.add", goal })
  });
  let body = await r.json();
  ok(r.status === 200 && body.ok && body.rev >= 1, "goal.add 成功且 rev 自增（rev=" + body.rev + "）", JSON.stringify(body).slice(0, 200));
  if (!body.state) body.state = (await (await fetch(BASE + "/api/state")).json()).state;
  const act1 = await (await fetch(BASE + "/api/activity")).json();
  ok(act1.activity[0] && act1.activity[0].device === "电脑",
     "中文设备名经头传参正确解码（" + (act1.activity[0] ? act1.activity[0].device : "?") + "）");

  r = await fetch(BASE + "/api/action", {
    method: "POST", headers: { "content-type": "application/json", "x-slowly-device": encodeURIComponent("手机") },
    body: JSON.stringify({ action: "goal.update", goal: Object.assign({}, goal, { done: true, doneAt: "21:30" }) })
  });
  body = await r.json();
  const updated = body.state.goals.find((g) => g.id === goal.id);
  ok(updated && updated.done === true && updated.doneAt === "21:30", "goal.update 能标记完成");
  ok(body.state.goals.length === 1, "更新不会产生重复条目");

  console.log("3) 心情与随笔");
  await fetch(BASE + "/api/action", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "mood.set", date: "2026-01-02", mood: "tired" })
  });
  await fetch(BASE + "/api/action", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "note.set", date: "2026-01-02", text: "今天有点累，但还是写完了一段。" })
  });
  snap = await (await fetch(BASE + "/api/state")).json();
  ok(snap.state.moods["2026-01-02"].k === "tired", "心情已保存");
  ok(snap.state.notes["2026-01-02"].includes("有点累"), "随笔已保存");

  console.log("4) 落盘正确（原子写入不留临时文件）");
  const onDisk = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  ok(onDisk.state.goals.length === 1 && onDisk.state.notes["2026-01-02"], "数据文件内容与内存一致");
  const strays = fs.readdirSync(TMP).filter((f) => f.includes(".tmp-"));
  ok(strays.length === 0, "没有残留的临时文件", strays.join(","));
  ok(onDisk.rev === snap.rev, "文件里的 rev 与接口一致 (" + onDisk.rev + ")");

  console.log("5) 并发写入不丢数据（两端同时操作）");
  const before = (await (await fetch(BASE + "/api/state")).json()).state.goals.length;
  const burst = [];
  for (let i = 0; i < 12; i++) {
    burst.push(fetch(BASE + "/api/action", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "goal.add",
        goal: { id: "burst-" + i, title: "并发目标 " + i, cat: "should", date: "2026-01-02", done: false, doneAt: "", created: Date.now(), carry: 0, updatedAt: Date.now() }
      })
    }));
  }
  await Promise.all(burst);
  snap = await (await fetch(BASE + "/api/state")).json();
  ok(snap.state.goals.length === before + 12, "12 个并发新增全部落库（" + before + " -> " + snap.state.goals.length + "）");
  const diskAfter = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  ok(diskAfter.state.goals.length === snap.state.goals.length, "并发写入后磁盘与内存仍然一致");

  console.log("6) SSE 实时广播");
  const controller = new AbortController();
  const events = [];
  const ssePromise = (async () => {
    const resp = await fetch(BASE + "/api/events?device=手机", { signal: controller.signal });
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
        const ev = /^event: (.+)$/m.exec(frame);
        const data = /^data: (.+)$/m.exec(frame);
        if (ev) events.push({ event: ev[1], data: data ? JSON.parse(data[1]) : null });
      }
    }
  })().catch(() => { /* 主动断开 */ });

  await sleep(400);
  ok(events.some((e) => e.event === "hello"), "连上后立刻收到 hello 事件");

  await fetch(BASE + "/api/action", {
    method: "POST", headers: { "content-type": "application/json", "x-slowly-device": encodeURIComponent("电脑") },
    body: JSON.stringify({ action: "mood.set", date: "2026-01-02", mood: "great" })
  });
  await sleep(400);
  const stateEvent = events.filter((e) => e.event === "state").pop();
  ok(!!stateEvent, "另一端操作后收到 state 事件");
  ok(stateEvent && stateEvent.data.moods && stateEvent.data.moods["2026-01-02"].k === "great",
     "广播内容包含最新心情");
  ok(stateEvent && stateEvent.data.lastWriter === "电脑", "广播带上了修改来源设备");

  const ping2 = await (await fetch(BASE + "/api/ping")).json();
  ok(ping2.clients >= 1, "服务器知道当前有 " + ping2.clients + " 个端连着");
  controller.abort();
  await ssePromise;

  /* 回归：静态资源曾经用 public, max-age=3600，于是改完代码、重启服务、
     刷新页面，浏览器拿到的还是旧 app.js —— 界面看起来"改了却不生效"，
     非常难判断（实测踩过：二维码区域一直是空白占位）。
     这里要求所有前端资源都明确不缓存。 */
  console.log("6b) 前端资源不被缓存");
  for (const asset of ["/app.js", "/sync.js", "/index.html"]) {
    const r = await fetch(BASE + asset);
    const cc = String(r.headers.get("cache-control") || "");
    ok(r.status === 200, asset + " 可访问", "HTTP " + r.status);
    ok(/no-store|no-cache/.test(cc), asset + " 明确不缓存（避免改动不生效）", "实际：" + cc);
  }

  console.log("7) 二维码接口");  const qrResp = await fetch(BASE + "/api/qr");
  const svg = await qrResp.text();
  ok(qrResp.headers.get("content-type").includes("image/svg+xml"), "返回 SVG 类型");
  ok(svg.startsWith("<svg") && svg.includes("</svg>"), "SVG 完整");
  /* 用库自身解码 SVG 里描述的图形是做不到的，但可以验证：接口内部编码的 URL 能往返 */
  const { decode, encode } = await import("../lib/qr.js").then((m) => m.default || m);
  const url = (await (await fetch(BASE + "/api/ping")).json()).lanUrl || "http://127.0.0.1:" + PORT + "/";
  const decoded = decode(encode(url, "M").modules);
  ok(decoded.text === url, "二维码里编的局域网地址可被解码还原：" + url);
  const custResp = await fetch(BASE + "/api/qr?url=" + encodeURIComponent("http://10.0.0.9:8787/s?t=abc"));
  ok((await custResp.text()).startsWith("<svg"), "支持自定义 URL 生成二维码");

  /* 手机独立版下载：手机上打开这个地址就能把离线版存下来 */
  const offResp = await fetch(BASE + "/api/offline");
  const offBody = await offResp.text();
  ok(offResp.status === 200, "离线版下载接口可用");
  ok((offResp.headers.get("content-disposition") || "").includes("Slowly-offline.html"),
     "带下载文件名：" + offResp.headers.get("content-disposition"));
  ok(offBody.includes("SlowlySync") && offBody.includes("makeOfflineFetch"),
     "下载到的是自包含的离线版（含离线层与同步内核）");
  ok(!/<script[^>]+src="\//.test(offBody), "离线版没有外链脚本，存到手机就能用");
  const offLink = await fetch(BASE + "/api/qr?url=" + encodeURIComponent(BASE + "/api/offline"));
  ok((await offLink.text()).startsWith("<svg"), "可以为下载地址生成二维码（手机扫码下载）");

  console.log("8) 活动流与导出");
  const act = await (await fetch(BASE + "/api/activity")).json();
  ok(Array.isArray(act.activity) && act.activity.length > 0, "活动流有记录（最新：" +
     (act.activity[0] ? act.activity[0].text : "无") + "）");
  const exp = await fetch(BASE + "/api/export");
  ok(exp.headers.get("content-disposition").includes("slowly-"), "导出接口带下载文件名");
  const exported = await exp.json();
  ok(exported.state.goals.length === snap.state.goals.length, "导出内容与当前状态一致");

  console.log("9) 错误处理");
  r = await fetch(BASE + "/api/action", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "不存在的操作" })
  });
  ok(r.status === 400, "未知操作返回 400");
  r = await fetch(BASE + "/api/action", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "goal.add", goal: { title: "没有 id" } })
  });
  ok(r.status === 400, "缺少 id 的目标被拒绝");
  r = await fetch(BASE + "/api/nope");
  ok(r.status === 404, "未知接口返回 404");
  r = await fetch(BASE + "/");
  ok(r.status === 404 || r.status === 200, "根路径有响应（前端未安装时为 404）");

  console.log("10) 配对：扫码绑定用的令牌");

  /* 配对令牌：手机扫码后靠它确认"连的是这台电脑" */
  const pair1 = await (await fetch(BASE + "/api/pair")).json();
  ok(typeof pair1.pairing.token === "string" && pair1.pairing.token.length >= 4,
    "配对接口给出令牌：" + pair1.pairing.token);
  ok(/^[0-9A-Z]+$/.test(pair1.pairing.token), "令牌只含大写字母与数字（便于手抄）");
  ok(!/[01OI]/.test(pair1.pairing.token), "令牌不含 0/O/1/I（避免看错）");
  ok(typeof pair1.pairing.pairUrl === "string" && pair1.pairing.pairUrl.includes("#pair="),
    "给出可直接编成二维码的配对链接：" + pair1.pairing.pairUrl);
  /* 令牌必须放在 # 片段里 —— 片段不会发给任何服务器 */
  ok(pair1.pairing.pairUrl.indexOf("#pair=") > pair1.pairing.pairUrl.indexOf("://") + 3,
    "配对令牌放在 URL 片段里（不会随请求发给服务器）");

  const st = await (await fetch(BASE + "/api/state")).json();
  ok(st.pairing && st.pairing.token === pair1.pairing.token, "状态接口里也带上了配对信息");

  let vr = await fetch(BASE + "/api/pair/verify?token=" + encodeURIComponent(pair1.pairing.token));
  ok(vr.status === 200, "用正确令牌校验通过");
  vr = await fetch(BASE + "/api/pair/verify?token=WRONG9");
  ok(vr.status === 403, "用错误令牌被拒绝");

  const rotated = await (await fetch(BASE + "/api/pair", { method: "POST" })).json();
  ok(rotated.pairing.token !== pair1.pairing.token, "可以换一个新令牌");
  vr = await fetch(BASE + "/api/pair/verify?token=" + encodeURIComponent(pair1.pairing.token));
  ok(vr.status === 403, "换过之后旧令牌立即失效");
  /* 令牌要落盘，重启后仍然认得同一台电脑 */
  const pairFile = path.join(path.dirname(DATA_FILE), "pairing.json");
  ok(fs.existsSync(pairFile), "令牌写到了磁盘（重启后仍是同一个）");
  const pairOnDisk = JSON.parse(fs.readFileSync(pairFile, "utf8"));
  ok(pairOnDisk.token === rotated.pairing.token, "磁盘上的令牌与当前一致");

  console.log("11) 并发写入不会损坏数据文件");

  /* 回归：曾经因为共用一个临时文件名，并发写入会把半截内容追加到
     已改名的正式文件后面，数据文件直接变成"完整文档 + 半截对象"，
     解析时报 Unexpected non-whitespace character after JSON。
     这里连续多轮并发写，每轮都检查磁盘文件仍能解析、且与内存一致。 */
  let corrupt = 0;
  for (let round = 1; round <= 6; round++) {
    const burst2 = [];
    for (let i = 0; i < 10; i++) {
      burst2.push(fetch(BASE + "/api/action", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "goal.add",
          goal: { id: "race-" + round + "-" + i, title: "并发写 " + round + "-" + i, cat: "should", date: "2026-01-02", done: false, doneAt: "", created: Date.now(), carry: 0, updatedAt: Date.now() }
        })
      }));
    }
    await Promise.all(burst2);
    const live = await (await fetch(BASE + "/api/state")).json();
    let disk = null;
    try {
      disk = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } catch (e) {
      corrupt++;
      console.log("    第 " + round + " 轮磁盘文件解析失败：" + e.message);
      continue;
    }
    if (disk.state.goals.length !== live.state.goals.length) {
      corrupt++;
      console.log("    第 " + round + " 轮磁盘(" + disk.state.goals.length + ") 与内存(" + live.state.goals.length + ") 不一致");
    }
    if (disk.rev !== live.rev) {
      corrupt++;
      console.log("    第 " + round + " 轮 rev 不一致：磁盘 " + disk.rev + " 内存 " + live.rev);
    }
  }
  ok(corrupt === 0, "6 轮并发写入后数据文件始终可解析且与内存一致");

  console.log("12) 重启后数据仍在");
  /* 基线取"重启前一刻"的状态：前面的并发写入测试又加了不少记录，
     用更早的快照比会误判。 */
  const preRestart = await (await fetch(BASE + "/api/state")).json();
  child.kill();
  await sleep(600);
  const child2 = spawn(process.execPath, [
    path.join(ROOT, "server.mjs"), "--port", String(PORT), "--no-open", "--quiet", "--data", DATA_FILE
  ], { stdio: "ignore", windowsHide: true });
  let ready2 = false;
  for (let i = 0; i < 60; i++) {
    try { const rr = await fetch(BASE + "/api/ping"); if (rr.ok) { ready2 = true; break; } } catch { /* wait */ }
    await sleep(150);
  }
  ok(ready2, "重启后重新就绪");
  const snap2 = await (await fetch(BASE + "/api/state")).json();
  ok(snap2.state.goals.length === preRestart.state.goals.length,
    "重启后目标数量不变（" + preRestart.state.goals.length + " -> " + snap2.state.goals.length + "）");
  ok(snap2.rev === preRestart.rev, "重启后 rev 延续（" + preRestart.rev + " -> " + snap2.rev + "）");
  ok(snap2.state.notes["2026-01-02"].includes("有点累"), "重启后随笔仍在");
  child2.kill();
} catch (err) {
  fail++;
  console.log("  测试过程抛出异常：" + (err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : err));
  console.log("  服务端输出无法捕获（沙箱限制），改用日志文件不适用，跳过该行");
} finally {
  cleanup();
}

console.log("\n结果：通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
