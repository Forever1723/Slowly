/* =============================================================
   Slowly · 前端（原生 JS，无框架、无外部依赖）
   数据不在浏览器里：每次改动都发给本机的 Slowly 服务器，
   服务器写入文件并广播给另一个端（手机 / 电脑）。
   ============================================================= */
(function () {
  "use strict";

  /* =============================================================
     离线层（手机 App / 单文件离线版）
     把 /api/* 的调用接成本地存储，界面代码完全不用改：
     手机没连上电脑时照样能记，连上以后用 SlowlySync 合并回电脑。
     ============================================================= */
  var RAW_FETCH = window.fetch ? window.fetch.bind(window) : null;
  var nativeFetch = window.fetch;
  var LS_KEY = "slowly.data";
  var SYNC = window.SlowlySync || null;

  function readLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return { version: 1, goals: [], moods: {}, notes: {}, tombstones: {}, seed: String(Date.now()) };
      return SYNC ? SYNC.normalize(JSON.parse(raw)) : JSON.parse(raw);
    } catch (e) {
      return { version: 1, goals: [], moods: {}, notes: {}, tombstones: {}, seed: String(Date.now()) };
    }
  }
  function writeLocal(next) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); return true; }
    catch (e) { toast("这台设备的存储写不进去了，请清理一些空间", "warn"); return false; }
  }

  /* 把 /api/* 的请求接管掉：不开服务器也能跑 */
  function makeOfflineFetch() {
    return function (url, options) {
      var path = String(url);
      var method = ((options && options.method) || "GET").toUpperCase();
      var json = function (obj) {
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: function () { return "application/json"; } },
          json: function () { return Promise.resolve(obj); },
          text: function () { return Promise.resolve(JSON.stringify(obj)); }
        });
      };

      if (path.indexOf("/api/state") === 0) {
        var snap = readLocal();
        return json({
          rev: -1, savedAt: 0, lastWriter: "",
          state: snap,
          server: {
            name: "Slowly", version: "1.0.0-offline", offline: true,
            dataFile: "这台设备上的存储",
            lanUrl: SYNC ? (SYNC.getServerUrl() || "") : "",
            clients: 1, uptime: 0
          }
        });
      }

      if (path.indexOf("/api/activity") === 0) {
        try { return json({ activity: JSON.parse(localStorage.getItem("slowly.activity") || "[]") }); }
        catch (e) { return json({ activity: [] }); }
      }

      if (path.indexOf("/api/qr") === 0) {
        /* 离线版没有服务器可生成二维码，给一个空 SVG 占位 */
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>';
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: function () { return "image/svg+xml"; } },
          text: function () { return Promise.resolve(svg); },
          json: function () { return Promise.resolve({}); }
        });
      }

      if (path.indexOf("/api/action") === 0 && method === "POST") {
        var body = {};
        try { body = JSON.parse((options && options.body) || "{}"); } catch (e) { body = {}; }
        var cur = readLocal();
        try { applyLocalAction(cur, body); } catch (e) { return Promise.reject(new Error(e.message)); }
        writeLocal(cur);
        return json({ ok: true, rev: -1, state: cur });
      }

      return Promise.resolve({
        ok: false, status: 404,
        headers: { get: function () { return null; } },
        json: function () { return Promise.resolve({ error: "离线版不支持：" + path }); }
      });
    };
  }

  function applyLocalAction(cur, body) {
    var action = String(body.action || "");
    if (!cur.tombstones) cur.tombstones = {};
    if (action === "goal.add") {
      if (!cur.goals.some(function (g) { return g.id === body.goal.id; })) cur.goals.push(body.goal);
    } else if (action === "goal.update") {
      var i = -1;
      cur.goals.forEach(function (g, idx) { if (g.id === body.goal.id) i = idx; });
      if (i >= 0) cur.goals[i] = Object.assign({}, cur.goals[i], body.goal);
      else cur.goals.push(body.goal);
    } else if (action === "goal.remove") {
      cur.goals = cur.goals.filter(function (g) { return g.id !== body.id; });
      cur.tombstones[body.id] = Date.now();
    } else if (action === "goal.carry") {
      var to = body.to || todayKey();
      cur.goals.forEach(function (g) {
        if (!g.done && g.date < to) { g.date = to; g.carry = Number(g.carry || 0) + 1; g.updatedAt = Date.now(); }
      });
    } else if (action === "mood.set") {
      if (body.mood) cur.moods[body.date] = { k: body.mood, at: Date.now(), device: DEVICE };
      else delete cur.moods[body.date];
    } else if (action === "note.set") {
      if (body.text) cur.notes[body.date] = { text: String(body.text).slice(0, 4000), at: Date.now(), by: DEVICE };
      else delete cur.notes[body.date];
    } else if (action === "state.replace" || action === "demo.seed") {
      var next = SYNC ? SYNC.normalize(body.state) : body.state;
      Object.keys(cur).forEach(function (k) { delete cur[k]; });
      Object.assign(cur, next);
    } else if (action === "state.clear") {
      var marks = body.tombstones || {};
      cur.goals.forEach(function (g) { if (!marks[g.id]) marks[g.id] = Date.now(); });
      cur.goals = []; cur.moods = {}; cur.notes = {}; cur.tombstones = marks;
    } else if (action === "state.merge") {
      var merged = SYNC ? SYNC.merge(cur, body.state) : body.state;
      Object.keys(cur).forEach(function (k) { delete cur[k]; });
      Object.assign(cur, merged);
    } else {
      throw new Error("离线版不认识的操作：" + action);
    }
  }

  var offlineFetch = makeOfflineFetch();
  var remoteFetch = nativeFetch;
  window.fetch = function (url, options) {
    var path = String(url);
    if (ui.offline && path.indexOf("/api/") === 0) return offlineFetch(path, options);
    return remoteFetch(url, options);
  };

  /* 离线状态下的一次"同步"：把本地数据合并回电脑 */
  function syncNow(silent) {
    if (!SYNC) return Promise.resolve(null);
    var url = SYNC.getServerUrl();
    if (!url) {
      if (!silent) toast("先在下面填上电脑的地址，才能同步", "warn");
      return Promise.resolve(null);
    }
    setSyncUI("syncing");
    return SYNC.sync(state, DEVICE).then(function (res) {
      if (res && res.state) {
        state = res.state;
        writeLocal(state);
        renderAll();
      }
      setSyncUI("synced");
      if (!silent) toast(res && res.pushed ? "已与电脑合并（有 " + (res.state.goals || []).length + " 项目标）" : "已从电脑更新", "good");
      return res;
    }).catch(function (err) {
      setSyncUI("offline");
      if (!silent) toast(err.message, "warn");
      return null;
    });
  }

  /* ---------------- 基础工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function fromKey(k) { var p = String(k).split("-"); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  function todayKey() { return iso(new Date()); }
  function shiftKey(offset) { var d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offset); return iso(d); }
  function clampText(s, n) { s = String(s).trim(); return s.length <= n ? s : s.slice(0, n - 1) + "…"; }
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return Math.abs(h);
  }
  var WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  /* 本机存储只用于"这台设备叫什么"，真正的数据都在服务器上 */
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 隐私模式下忽略 */ } }
  };
  var DEVICE = (store.get("slowly.device") || "").slice(0, 20) || guessDevice();
  function guessDevice() {
    var ua = navigator.userAgent || "";
    if (/iPhone|Android|Mobile|iPad/i.test(ua)) return "我的手机";
    return "我的电脑";
  }

  /* ---------------- 文案：情绪价值都在这里 ---------------- */
  var GREET = {
    lateNight: ["夜深了，还醒着的你", "这个点还惦记着目标，挺不容易的"],
    morning: ["早上好呀，今天想做成什么？", "新的一天，先写一件小事就很好", "早，昨天的你已经很努力了"],
    noon: ["中午好，吃饱了再继续", "到中午了，进度怎么样？"],
    afternoon: ["下午好，慢慢来就很快", "这个时段最容易累，喝口水吧"],
    evening: ["晚上好，今天辛苦了", "一天下来，你做到的那些都算数"]
  };
  var SUB = {
    lateNight: ["别硬撑，写下明天第一件事就去睡", "今天剩下的时间，交给休息"],
    morning: ["不用列满，两三条就够", "先写下来，脑子会轻松一点"],
    noon: ["完成一件就算赢", "剩下的时间还够用"],
    afternoon: ["别急，注意力是有限的", "做不完也没关系，你已经做了很多"],
    evening: ["写完就放下手机吧", "今天的分数由你自己打"]
  };
  var DONE_MSG = [
    "做到了！这一小步已经算数 ✅",
    "漂亮，清单上的事真的会变少 ✨",
    "干得不错，记得夸自己一句 👏",
    "又清掉一件，你比昨天更靠近目标了 🌟",
    "这种「完成」的感觉，值得记住 🍀"
  ];
  var UNDONE_MSG = ["没关系，先放着，它还在等你", "撤回也可以，状态不好不是你的错", "允许自己改主意，这也是一种成熟"];
  var ALL_DONE = ["今天的清单全部完成，你真的很了不起 🎉", "全！部！完！成！请给自己一点奖励 🎊", "清单清空，今天可以心安理得地休息了 🌈"];
  var EVENING_NUDGE = ["今天已经完成 {n} 件，剩下的明天再说也来得及。", "{n} 件已经落地了，去休息吧，明天继续。", "完成 {n} 件，够了。把没做完的留给明天的你。"];
  var EMPTY_NUDGE = ["今天还没有目标，写一件最小的事就够（比如「喝够水」）。", "空着也挺好，那就先写一件 5 分钟能做完的事？"];
  var TIPS = [
    "目标写小一点更容易开始，比如「打开文档写 3 行」。",
    "把最难的一件放在精力最好的时段。",
    "完成一件就立刻打个勾，大脑喜欢这个反馈。",
    "没做完不代表失败，只是今天的优先级变了。",
    "连续记录比完美记录更有用。"
  ];
  var NIGHT_CARD = ["今天无论完成多少，你都值得被喜欢。", "把今天的疲惫留在今天，明天是新的。", "你已经比昨天的自己多做了一点点，这就够了。"];

  var MOODS = [
    { k: "great", e: "😄", t: "很棒", w: 5, msg: "状态好就多做一点，这种日子值得记下来。别忘了把功劳给自己，不是运气。" },
    { k: "ok", e: "🙂", t: "还行", w: 4, msg: "平平的一天也算数。稳定本身就是一种能力，你正在积累它。" },
    { k: "tired", e: "😮‍💨", t: "有点累", w: 3, msg: "累了就先休息，清单可以等。你能坚持到这里，已经比「放弃」多走了很远。" },
    { k: "down", e: "😔", t: "不太好", w: 2, msg: "今天难一点也没关系，你没有做错什么。要不只挑最小的一件做完，然后允许自己停下来？" },
    { k: "rough", e: "😣", t: "很糟糕", w: 1, msg: "今天真的很不容易。目标可以先放一放，先照顾自己：喝水、吃饭、洗个热水澡。明天我还在。" }
  ];
  var CAT_NAME = { must: "必须做", should: "想做", bonus: "加分项" };

  /* ---------------- 状态 ---------------- */
  var state = { goals: [], moods: {}, notes: {}, tombstones: {} };
  var meta = { rev: -1, server: {}, savedAt: 0, lastWriter: "", pairing: null };
  var activity = [];
  var ui = { cat: "must", view: "today", ready: false, offline: false };

  /* 随笔在内部统一存成 { text, at }，旧版的纯字符串也认 */
  function noteText(key) {
    var v = state.notes[key];
    if (v && typeof v === "object") return String(v.text || "");
    return typeof v === "string" ? v : "";
  }
  function setNote(key, text) {
    state.notes[key] = { text: String(text), at: Date.now(), by: DEVICE };
  }
  function addTombstone(id) {
    if (!state.tombstones) state.tombstones = {};
    state.tombstones[id] = Date.now();
  }

  function pick(list, salt) {
    return list[hashStr((state.seed || "slowly") + "|" + todayKey() + "|" + salt) % list.length];
  }

  /* ---------------- 与服务器通信 ---------------- */
  var sync = { live: false, retry: 0, pending: 0, everConnected: false, timer: null };

  /* 与电脑通信 */
  var sync = { live: false, retry: 0, pending: 0, everConnected: false, timer: null, hint: "" };

  function setSyncUI(hint) {
    var el = $("sync"), txt = $("syncText");
    if (!el || !txt) return;

    if (ui.offline) {
      var url = SYNC ? SYNC.getServerUrl() : "";
      var last = SYNC ? SYNC.getLastSync() : 0;
      el.classList.toggle("off", !url);
      el.classList.toggle("talking", hint === "syncing");
      txt.textContent = hint === "syncing" ? "正在同步"
        : !url ? "本机模式"
        : last ? "上次同步 " + timeAgo(last)
        : "等待同步";
      el.title = url
        ? "数据存在这台设备上，会与 " + url + " 合并"
        : "数据只存在这台设备上。填上电脑的地址就能同步。";
      return;
    }

    el.classList.toggle("off", !sync.live);
    el.classList.toggle("talking", sync.pending > 0);
    txt.textContent = !sync.live ? (sync.everConnected ? "已断开" : "连接中")
      : sync.pending > 0 ? "正在保存"
      : (meta.server.clients || 1) > 1 ? (meta.server.clients + " 个端在线") : "已同步";
    el.title = sync.live
      ? "数据存在 " + (meta.server.dataFile || "本机") + "，" + (meta.server.clients || 1) + " 个端已连接"
      : "与 Slowly 服务器断开，改动会暂时失败";
  }

  function api(path, options) {
    return fetch(path, options).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.error || ("服务器返回 " + r.status));
        return body;
      });
    });
  }

  function applyServerState(snap) {
    if (snap.state) state = snap.state;
    if (typeof snap.rev === "number") meta.rev = snap.rev;
    if (snap.savedAt) meta.savedAt = snap.savedAt;
    if (typeof snap.lastWriter === "string") meta.lastWriter = snap.lastWriter;
    if (snap.server) meta.server = snap.server;
    if (snap.pairing) meta.pairing = snap.pairing;
    if (Array.isArray(snap.activity)) activity = snap.activity;
  }

  function load() {
    return api("/api/state").then(function (snap) {
      applyServerState(snap);
      ui.ready = true;
      renderAll();
      return api("/api/activity").then(function (a) {
        activity = a.activity || [];
        renderActivity();
      }).catch(function () { /* 活动流失败不影响主界面 */ });
    });
  }

  /* 把一次改动发给服务器；服务器负责落盘并通知另一端。
     离线模式下会拦截成"写本机存储"。 */
  function send(action, payload) {
    sync.pending += 1;
    setSyncUI();
    var body = Object.assign({ action: action }, payload || {});
    return api("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json", "x-slowly-device": encodeURIComponent(DEVICE) },
      body: JSON.stringify(body)
    }).then(function (res) {
      sync.pending -= 1;
      if (res.state) state = res.state;
      meta.rev = res.rev;
      meta.savedAt = Date.now();
      if (ui.offline) {
        /* 离线版自己攒一份活动流，同步到电脑后两边都能看到 */
        try {
          var list = JSON.parse(localStorage.getItem("slowly.activity") || "[]");
          var text = describeAction(body);
          if (text) {
            list.unshift({ at: Date.now(), device: DEVICE, text: text });
            localStorage.setItem("slowly.activity", JSON.stringify(list.slice(0, 30)));
            activity = list.slice(0, 30);
            renderActivity();
          }
        } catch (e) { /* 活动流失败不影响主流程 */ }
        if (body.action !== "note.set") syncNow(true);
      }
      /* 服务器返回的状态才是最终状态（比如示例数据、导入、清空），必须重绘 */
      renderAll();
      setSyncUI();
      return res;
    }).catch(function (err) {
      sync.pending -= 1;
      if (!ui.offline) markOffline();
      setSyncUI();
      toast("没能保存：" + err.message, "warn");
      throw err;
    });
  }

  function markOffline() {
    sync.live = false;
    setSyncUI();
  }

  /* 把一次操作翻译成一句人话，用于活动流 */
  function describeAction(body) {
    var a = body.action;
    if (a === "goal.add") return "新增目标「" + String((body.goal && body.goal.title) || "").slice(0, 24) + "」";
    if (a === "goal.update") return ((body.goal && body.goal.done) ? "完成" : "取消完成") + "「" + String((body.goal && body.goal.title) || "").slice(0, 24) + "」";
    if (a === "goal.remove") return "删除了一个目标";
    if (a === "goal.carry") return "把没做完的事挪到了今天";
    if (a === "mood.set") return body.mood ? "记录了心情（" + body.date + "）" : "取消了心情记录（" + body.date + "）";
    if (a === "state.clear") return "清空了全部记录";
    if (a === "demo.seed") return "装载了示例数据";
    if (a === "state.replace") return "导入了整份数据";
    return "";
  }

  /* ---------------- 实时同步（SSE） ---------------- */
  function connect() {
    if (!window.EventSource) { toast("这个浏览器不支持实时同步，刷新页面即可看到最新数据", "warn"); return; }
    if (sync.timer) { clearTimeout(sync.timer); sync.timer = null; }

    var es = new EventSource("/api/events?device=" + encodeURIComponent(DEVICE));
    window.__slowlyEvents = es;

    es.addEventListener("hello", function (e) {
      var data = safeParse(e.data);
      sync.live = true;
      sync.retry = 0;
      sync.everConnected = true;
      if (data && typeof data.rev === "number" && data.rev > meta.rev) {
        /* 我们落后了：拉一次最新数据 */
        load().catch(function () { /* 忽略 */ });
      }
      setSyncUI();
    });

    es.addEventListener("state", function (e) {
      var data = safeParse(e.data);
      if (!data) return;
      /* 别人的改动 —— 立刻反映到界面上 */
      if (data.goals) state.goals = data.goals;
      if (data.moods) state.moods = data.moods;
      if (data.notes) state.notes = data.notes;
      if (data.tombstones) state.tombstones = data.tombstones;
      if (data.state) state = data.state;
      if (typeof data.rev === "number") meta.rev = data.rev;
      if (data.savedAt) meta.savedAt = data.savedAt;
      if (data.lastWriter) meta.lastWriter = data.lastWriter;
      if (data.activity) {
        activity.unshift(data.activity);
        while (activity.length > 30) activity.pop();
      }
      if (data.goals || data.moods || data.notes || data.state) {
        renderAll();
        if (data.lastWriter && data.lastWriter !== DEVICE) {
          flashRemote(data.lastWriter);
        }
      }
      renderActivity();
    });

    es.onerror = function () {
      sync.live = false;
      setSyncUI();
      try { es.close(); } catch (err) { /* ignore */ }
      var wait = Math.min(15000, 1000 * Math.pow(1.6, sync.retry++));
      sync.timer = setTimeout(connect, wait);
    };
  }

  function safeParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  var lastRemoteToast = 0;
  function flashRemote(device) {
    if (Date.now() - lastRemoteToast < 4000) return;
    lastRemoteToast = Date.now();
    toast(device + " 刚刚更新了数据", "good");
  }

  /* ---------------- 渲染 ---------------- */
  function renderAll() {
    if (!ui.ready) return;
    renderHello();
    renderToday();
    renderWins();
    renderStats();
    renderShare();
    renderActivity();
    setSyncUI();
  }

  function renderHello() {
    var now = new Date(), h = now.getHours();
    var slot = h < 5 ? "lateNight" : h < 11 ? "morning" : h < 14 ? "noon" : h < 18 ? "afternoon" : "evening";
    $("dateLine").textContent = now.getFullYear() + " 年 " + (now.getMonth() + 1) + " 月 " + now.getDate() + " 日 · " + WEEK[now.getDay()];
    $("greetLine").textContent = pick(GREET[slot], "greet");
    $("subLine").textContent = pick(SUB[slot], "sub");
  }

  function goalsOn(key) {
    return state.goals.filter(function (g) { return g.date === key; });
  }
  function doneOn(key) {
    return goalsOn(key).filter(function (g) { return g.done; });
  }
  function isActiveDay(key) {
    return doneOn(key).length > 0 || !!noteText(key) || !!state.moods[key];
  }
  function streak() {
    var n = 0, i = isActiveDay(todayKey()) ? 0 : 1;
    for (; i < 3000; i++) { if (isActiveDay(shiftKey(-i))) n++; else break; }
    return n;
  }

  function renderToday() {
    var key = todayKey();
    var list = goalsOn(key);
    var done = list.filter(function (g) { return g.done; });
    var pct = list.length ? Math.round((done.length / list.length) * 100) : 0;

    var C = 2 * Math.PI * 45;
    var ring = $("ringVal");
    ring.style.strokeDasharray = C;
    ring.style.strokeDashoffset = C * (1 - pct / 100);
    $("ringPct").textContent = pct + "%";

    var numEl = $("progressNum");
    if (!list.length) numEl.innerHTML = "今天还没有目标";
    else if (done.length === list.length) numEl.innerHTML = "全部完成啦 <em>🎉</em>";
    else numEl.innerHTML = "已完成 <em>" + done.length + "</em> / " + list.length + " 件";

    var hour = new Date().getHours();
    var line;
    if (!list.length) line = pick(EMPTY_NUDGE, "empty");
    else if (done.length === list.length) line = "这是今天的满分答卷，剩下的时间都属于你自己。";
    else if (hour >= 19 && done.length > 0) line = pick(EVENING_NUDGE, "eve").replace("{n}", String(done.length));
    else if (hour >= 19) line = "晚上好，如果今天实在没力气，写下明天第一件事也可以。";
    else line = pick(TIPS, "tip");
    $("progressLine").textContent = line;
    $("goalCount").textContent = list.length ? "共 " + list.length + " 件" : "";

    var echo = $("progressEcho");
    var m = state.moods[key];
    if (m && m.w >= 4) {
      echo.hidden = false;
      echo.className = "echo";
      echo.textContent = "今天心情不错，这种日子很适合推进重要的事。";
    } else {
      echo.hidden = true;
    }

    /* 昨天没做完的 */
    var carry = state.goals.filter(function (g) { return !g.done && g.date < key; });
    var box = $("carryBox");
    if (carry.length) {
      box.hidden = false;
      box.innerHTML = '<div class="carry">还有 ' + carry.length + " 件以前没做完的事：" +
        esc(carry.slice(0, 3).map(function (g) { return g.title; }).join("、")) + (carry.length > 3 ? " 等" : "") +
        '。<br>带着它们走也行，留在过去也行 —— 你说了算。' +
        '<br><button class="btn ghost" id="carryBtn" type="button">挪到今天</button></div>';
    } else {
      box.hidden = true;
      box.innerHTML = "";
    }

    /* 目标列表 */
    var host = $("goalList");
    if (!list.length) {
      host.innerHTML = '<div class="empty"><b>清单是空的</b>写下今天最想完成的一件事吧，小到不可能失败的那种。</div>';
    } else {
      var order = { must: 0, should: 1, bonus: 2 };
      var sorted = list.slice().sort(function (a, b) {
        if (!!a.done !== !!b.done) return a.done ? 1 : -1;
        var o = (order[a.cat] || 0) - (order[b.cat] || 0);
        return o !== 0 ? o : (a.created || 0) - (b.created || 0);
      });
      host.innerHTML = sorted.map(function (g) {
        var chips = '<span class="chip ' + (g.cat || "must") + '">' + (CAT_NAME[g.cat] || "目标") + "</span>";
        if (g.carry > 0) chips += '<span class="chip carry">跟了你 ' + g.carry + " 天</span>";
        if (g.by && g.by !== DEVICE) chips += '<span class="chip from">' + esc(g.by) + "</span>";
        var when = g.doneAt ? "完成于 " + esc(g.doneAt) : "";
        return '<div class="goal' + (g.done ? " done" : "") + '" data-id="' + esc(g.id) + '">' +
          '<button class="tick" type="button" data-act="toggle" aria-label="' + (g.done ? "取消完成" : "标记完成") + '">' + (g.done ? "✓" : "") + "</button>" +
          '<div><b>' + esc(g.title) + "</b><small>" + chips + when + "</small></div>" +
          '<button class="del" type="button" data-act="del" aria-label="删除">✕</button>' +
          "</div>";
      }).join("");
    }

    Array.prototype.forEach.call($("cats").querySelectorAll(".cat"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-cat") === ui.cat ? "true" : "false");
    });

    /* 心情 */
    $("moods").innerHTML = MOODS.map(function (mm) {
      var on = m && m.k === mm.k;
      return '<button class="mood" type="button" data-mood="' + mm.k + '" aria-pressed="' + (on ? "true" : "false") + '">' +
        "<em>" + mm.e + "</em><span>" + mm.t + "</span></button>";
    }).join("");
    if (m) {
      var found = MOODS.filter(function (x) { return x.k === m.k; })[0] || MOODS[1];
      $("moodWords").textContent = found.msg;
    }
    if (document.activeElement !== $("noteInput")) {
      $("noteInput").value = noteText(key);
    }
  }

  function renderWins() {
    var key = todayKey();
    var done = doneOn(key);
    $("winsCount").textContent = done.length ? done.length + " 件" : "";
    var host = $("winsList");
    if (!done.length) {
      host.innerHTML = '<div class="empty"><b>还没有成果</b>去「今天」给完成的事打个勾，它就会出现在这里。</div>';
    } else {
      host.innerHTML = done.map(function (g, i) {
        var medal = ["🥇", "🥈", "🥉"][i] || "✅";
        var by = g.by && g.by !== DEVICE ? " · 由 " + esc(g.by) + " 完成" : "";
        return '<div class="victory"><span class="medal">' + medal + "</span><div><b>" + esc(g.title) +
          "</b><small>" + (CAT_NAME[g.cat] || "目标") + (g.doneAt ? " · " + esc(g.doneAt) : "") + by + "</small></div></div>";
      }).join("");
    }

    var hour = new Date().getHours();
    var words;
    if (!done.length) words = "今天还没打勾也没关系，能来这儿看一眼，说明你还在意自己。";
    else if (done.length >= 5) words = "完成 " + done.length + " 件，今天你把自己用得很充分，别忘了也照顾身体。";
    else if (hour >= 21) words = pick(NIGHT_CARD, "night");
    else words = "完成 " + done.length + " 件：分别是用心、坚持和没有放弃。";
    $("winsWords").textContent = words;

    var past = state.goals.filter(function (g) { return g.done && g.date < key; })
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    $("historyCount").textContent = past.length + " 件";
    var hh = $("historyList");
    if (!past.length) {
      hh.innerHTML = '<div class="empty">还没有更早的成果，从今天开始攒。</div>';
    } else {
      hh.innerHTML = past.slice(0, 12).map(function (g) {
        var d = fromKey(g.date);
        return '<div class="victory"><span class="medal">🗓️</span><div><b>' + esc(g.title) + "</b><small>" +
          (d.getMonth() + 1) + " 月 " + d.getDate() + " 日 · " + (CAT_NAME[g.cat] || "目标") + "</small></div></div>";
      }).join("");
    }
  }

  function renderStats() {
    var total = state.goals.filter(function (g) { return g.done; }).length;
    var keys = {};
    state.goals.forEach(function (g) { keys[g.date] = 1; });
    Object.keys(state.moods).forEach(function (k) { keys[k] = 1; });
    Object.keys(state.notes).forEach(function (k) { if (noteText(k)) keys[k] = 1; });
    var activeDays = Object.keys(keys).filter(isActiveDay).length;

    $("statTotal").textContent = total;
    $("statDays").textContent = activeDays;
    $("statStreak").textContent = streak();

    var counts = {};
    state.goals.forEach(function (g) { if (g.done) counts[g.date] = (counts[g.date] || 0) + 1; });

    var today = todayKey();
    var dow = fromKey(today).getDay();
    var startKey = shiftKey(-(77 + dow));
    var cells = [];
    for (var i = 0; i < 84; i++) {
      var k = shiftKeyFrom(startKey, i);
      if (k > today) { cells.push('<i class="future"></i>'); continue; }
      var c = counts[k] || 0;
      var lvl = c === 0 ? "" : c === 1 ? "l1" : c === 2 ? "l2" : c <= 4 ? "l3" : "l4";
      cells.push('<i class="' + lvl + '" title="' + k + " · 完成 " + c + ' 件"></i>');
    }
    $("heat").innerHTML = cells.join("");

    var max = 1;
    var bars = [];
    for (var j = 6; j >= 0; j--) {
      var kk = shiftKey(-j);
      var n = counts[kk] || 0;
      if (n > max) max = n;
      bars.push({ key: kk, n: n, today: j === 0 });
    }
    $("bars").innerHTML = bars.map(function (b) {
      var d = fromKey(b.key);
      return '<div class="bar' + (b.today ? " today" : "") + '"><b>' + (b.n || "") + "</b>" +
        '<u data-h="' + Math.round((b.n / max) * 100) + '"></u><em>' +
        (b.today ? "今天" : WEEK[d.getDay()].slice(1)) + "</em></div>";
    }).join("");
    requestAnimationFrame(function () {
      Array.prototype.forEach.call($("bars").querySelectorAll("u"), function (u) {
        u.style.height = Math.max(3, Number(u.getAttribute("data-h"))) + "%";
      });
    });

    $("report").innerHTML = buildReport(total, activeDays);
  }

  function shiftKeyFrom(startKey, offset) {
    var d = fromKey(startKey);
    d.setDate(d.getDate() + offset);
    return iso(d);
  }

  function buildReport(total, activeDays) {
    var out = [];
    var s = streak();
    var allKeys = {};
    state.goals.forEach(function (g) { allKeys[g.date] = 1; });
    Object.keys(state.moods).forEach(function (k) { allKeys[k] = 1; });
    var days = Object.keys(allKeys).filter(isActiveDay).sort();

    if (days.length < 3) {
      out.push("你才开始记录，不着急。先攒几天数据，我会慢慢认识你。");
    } else if (s >= 3) {
      out.push("你已经连续 " + s + " 天有完成记录了，这种「不断线」比偶尔爆发更难。");
      if (days.length && dayGap(days[days.length - 1], todayKey()) >= 2) out.push("中间断过，但你又回来了 —— 愿意回来的人，最后都留下来了。");
    } else {
      var recent = days.slice(-4);
      var avg = recent.reduce(function (a, k) { return a + doneOn(k).length; }, 0) / (recent.length || 1);
      if (avg >= 4) out.push("这几天你完成得比平时多，注意别把自己用得太狠，留一点力气给明天。");
      else out.push("最近完成得少一些，可能是累了或者事情太杂。不追进度，先找回节奏。");
    }

    var tally = {};
    state.goals.forEach(function (g) {
      var t = String(g.title || "").trim();
      if (t) tally[t] = (tally[t] || 0) + 1;
    });
    var top = Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; })[0];
    if (top && tally[top] >= 2) out.push("「" + top + "」出现过 " + tally[top] + " 次，看来它对你挺重要。");

    var tags = ["累计完成 " + total + " 件", "有记录 " + activeDays + " 天"];
    if (s >= 3) tags.push("连续 " + s + " 天");
    if (total >= 50) tags.push("已经完成 50+ 件了");
    if (meta.server && meta.server.clients > 1) tags.push("此刻有 " + meta.server.clients + " 个端在线");

    return out.map(function (p) { return "<p>" + esc(p) + "</p>"; }).join("") +
      '<div style="margin-top:6px">' + tags.map(function (t) { return '<span class="tagline">' + esc(t) + "</span>"; }).join("") + "</div>" +
      '<p style="margin-top:8px;color:#a2968a">小提示：' + esc(pick(TIPS, "tip2")) + "</p>";
  }

  function dayGap(a, b) { return Math.round((fromKey(b) - fromKey(a)) / 86400000); }

  function renderShare() {
    var s = meta.server || {};
    $("deviceName").textContent = DEVICE;
    $("dataPath").textContent = s.dataFile || "（未知）";
    $("appVersion").textContent = (s.name || "Slowly") + " v" + (s.version || "?") + (s.uptime ? " · 已运行 " + humanUptime(s.uptime) : "");

    if (ui.offline) {
      /* 本机模式：只关心"有没有填电脑地址、上次同步成功没有" */
      $("syncCard").hidden = false;
      var isStatic = ui.mode === "static";
      $("qrHolder").innerHTML = '<div class="tip" style="padding:34px 12px">' +
        (isStatic
          ? "这个网址本身就是完整的 Slowly，数据存在你自己的设备上。<br>用手机浏览器打开同一网址，再选「添加到主屏幕」即可。"
          : "这是装在设备上的独立版，不需要扫码。<br>在下面填一次电脑地址就能双向同步。") +
        "</div>";
      $("lanUrl").textContent = SYNC.getServerUrl() || (isStatic ? location.href : "还没有填写电脑地址");
      $("clientsInfo").textContent = "只在这台设备上";
      $("savedAt").textContent = "改动即时存在这台设备上";
      $("reconnectBtn").textContent = "立即同步";
      $("syncHint").textContent = SYNC.getServerUrl() ? "已设置" : "可选";
      $("syncExplain").textContent = isStatic
        ? "数据默认只存在这台设备上，不同步、不上传。如果你自己也在电脑上跑着 Slowly，可以填上那台电脑的地址，把它当作备份与多设备同步的中转站。"
        : "设备上记的东西先存在本机；填上电脑地址后，回到同一个 WiFi 点一次「立即同步」，两边就会合并成同一份数据 —— 谁也不覆盖谁。";
      var last = SYNC.getLastSync();
      $("serverUrl").textContent = SYNC.getServerUrl() || "（未填写）";
      $("lastSyncAt").textContent = last ? timeAgo(last) : "还没有同步过";
      renderInstallCard();
      return;
    }

    /* 连电脑的网页版：不显示离线同步卡片与安装卡片 */
    $("syncCard").hidden = true;
    if ($("installCard")) $("installCard").hidden = true;
    $("reconnectBtn").textContent = "重新连接";
    $("lanUrl").textContent = s.lanUrl || "（没找到局域网地址，请确认电脑连着 WiFi）";
    $("clientsInfo").textContent = (s.clients || 1) + " 个端连接着";
    $("savedAt").textContent = meta.savedAt ? timeAgo(meta.savedAt) + (meta.lastWriter ? "（" + meta.lastWriter + "）" : "") : "还没有改动";
  }

  /* ---------------- 装到主屏幕 ---------------- */
  var installEvent = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    installEvent = e;
    renderInstallCard();
  });
  window.addEventListener("appinstalled", function () {
    installEvent = null;
    toast("Slowly 已装到主屏幕 🎉", "good");
    renderInstallCard();
  });

  function isStandalone() {
    try {
      return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
        navigator.standalone === true;
    } catch (e) { return false; }
  }

  function renderInstallCard() {
    var card = $("installCard");
    if (!card) return;
    /* 只有"以网址访问、且还没装"的情况才提示 */
    if (!ui.offline || ui.mode !== "static" || isStandalone()) { card.hidden = true; return; }
    card.hidden = false;
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    $("installHint").textContent = isIOS
      ? "点底部的「分享」按钮，再选「添加到主屏幕」"
      : "点浏览器右上角的菜单，选「安装应用」或「添加到主屏幕」";
    $("installBtn").hidden = !installEvent;
  }

  function timeAgo(ts) {
    var d = Math.round((Date.now() - ts) / 1000);
    if (d < 5) return "刚刚";
    if (d < 60) return d + " 秒前";
    if (d < 3600) return Math.round(d / 60) + " 分钟前";
    return Math.round(d / 3600) + " 小时前";
  }
  function humanUptime(sec) {
    if (sec < 60) return sec + " 秒";
    if (sec < 3600) return Math.round(sec / 60) + " 分钟";
    return Math.round(sec / 3600) + " 小时";
  }

  function renderActivity() {
    var host = $("activityList");
    if (!host) return;
    if (!activity.length) { host.innerHTML = "<li>还没有记录</li>"; return; }
    host.innerHTML = activity.slice(0, 12).map(function (a) {
      var who = a.device ? '<span class="who">' + esc(a.device) + "</span>" : "";
      return "<li><span>" + esc(a.text) + "</span>" + who + "</li>";
    }).join("");
  }

  /* ---------------- 交互 ---------------- */
  function focusInput() {
    var el = $("goalInput");
    if (!el || typeof el.focus !== "function") return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }

  function addGoal() {
    var input = $("goalInput");
    var title = input.value.trim();
    if (!title) { focusInput(); toast("先写一句要做的事吧，比如「散步 10 分钟」"); return; }
    var goal = {
      id: "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: clampText(title, 120),
      cat: ui.cat,
      date: todayKey(),
      done: false, doneAt: "",
      created: Date.now(), updatedAt: Date.now(),
      carry: 0,
      by: DEVICE
    };
    input.value = "";
    /* 乐观更新：先显示出来，服务器确认后再以它为准 */
    state.goals.push(goal);
    renderAll();
    focusInput();
    send("goal.add", { goal: goal }).catch(function () {
      state.goals = state.goals.filter(function (g) { return g.id !== goal.id; });
      renderAll();
    });
  }

  function findGoal(id) {
    return state.goals.filter(function (g) { return g.id === id; })[0];
  }

  function toggleGoal(id) {
    var g = findGoal(id);
    if (!g) return;
    var now = new Date();
    var patch = {
      id: g.id, title: g.title,
      done: !g.done,
      doneAt: !g.done ? pad(now.getHours()) + ":" + pad(now.getMinutes()) : "",
      updatedAt: Date.now(),
      by: DEVICE
    };
    var wasDone = g.done;
    Object.assign(g, patch);
    renderAll();

    if (!wasDone) {
      var list = goalsOn(todayKey());
      var allDone = list.length > 0 && list.every(function (x) { return x.done; });
      if (allDone) { toast(pick(ALL_DONE, "alldone"), "good"); confetti(26); }
      else toast(pick(DONE_MSG, "done"), "good");
    } else {
      toast(pick(UNDONE_MSG, "undone"));
    }
    send("goal.update", { goal: patch }).catch(function () {
      var gg = findGoal(id);
      if (gg) { gg.done = wasDone; gg.doneAt = wasDone ? gg.doneAt : ""; renderAll(); }
    });
  }

  function delGoal(id) {
    var g = findGoal(id);
    if (!g) return;
    var backup = g;
    state.goals = state.goals.filter(function (x) { return x.id !== id; });
    addTombstone(id);            // 记下删除时间，手机离线时删掉的东西回到网上也能真删掉
    renderAll();
    toast("已删除「" + clampText(g.title, 14) + "」，放轻松");
    send("goal.remove", { id: id }).catch(function () {
      state.goals.push(backup);
      if (state.tombstones) delete state.tombstones[id];
      renderAll();
    });
  }

  function carryOver() {
    send("goal.carry", { to: todayKey() }).then(function (res) {
      toast("把没做完的事挪到今天了，它们会跟着你到完成那天 🌱", "good");
      return res;
    }).catch(function () { /* 已在 send 内提示 */ });
  }

  function setMood(k) {
    var key = todayKey();
    var cur = state.moods[key];
    var next = cur && cur.k === k ? null : { k: k, at: Date.now() };
    var previous = cur || null;
    if (next) state.moods[key] = next; else delete state.moods[key];
    renderAll();
    if (next) {
      var m = MOODS.filter(function (x) { return x.k === k; })[0];
      if (m) toast(m.w >= 4 ? m.msg : "收到，今天先照顾好自己 🤍", m.w >= 4 ? "good" : "");
    }
    send("mood.set", { date: key, mood: next ? next.k : null }).catch(function () {
      if (previous) state.moods[key] = previous; else delete state.moods[key];
      renderAll();
    });
  }

  var noteTimer = null;
  function onNoteInput() {
    var el = $("noteInput");
    var key = todayKey();
    setNote(key, el.value);
    $("noteSaved").textContent = "正在记…";
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(function () {
      send("note.set", { date: key, text: el.value }).then(function () {
        var t = new Date();
        $("noteSaved").textContent = "已记下 · " + pad(t.getHours()) + ":" + pad(t.getMinutes());
      }).catch(function () {
        $("noteSaved").textContent = ui.offline ? "已存在这台设备上" : "没保存成功，稍后会自动重试";
      });
    }, 600);
  }

  /* ---------------- 小提示与彩带 ---------------- */
  function toast(msg, kind) {
    var host = $("toasts");
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function () {
      el.style.transition = "opacity .4s, transform .4s";
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 420);
    }, 2600);
    while (host.children.length > 3) host.removeChild(host.firstChild);
  }

  function confetti(count) {
    var colors = ["#e8a17c", "#c96a49", "#a8c8a3", "#8fa98c", "#e0b070", "#d9b8a6"];
    for (var i = 0; i < count; i++) {
      var el = document.createElement("i");
      el.className = "confetti";
      el.style.left = Math.random() * 100 + "vw";
      el.style.background = colors[i % colors.length];
      el.style.animationDuration = (1.8 + Math.random() * 1.6) + "s";
      el.style.animationDelay = (Math.random() * 0.35) + "s";
      document.body.appendChild(el);
      (function (node) {
        setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 4200);
      })(el);
    }
  }

  /* ---------------- 视图 ---------------- */
  function showView(name) {
    ui.view = name;
    ["today", "wins", "stats", "share"].forEach(function (v) {
      $("view-" + v).hidden = v !== name;
    });
    Array.prototype.forEach.call($("tabs").querySelectorAll(".tab"), function (b) {
      if (b.getAttribute("data-view") === name) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (name === "share") { loadPairing(); loadQr(); loadOfflineQr(); }
  }

  var qrLoaded = false;
  function loadQr() {
    var holder = $("qrHolder");
    if (!holder) return;
    var url = (meta.server && meta.server.lanUrl) || "";
    if (!url) {
      holder.innerHTML = '<div class="tip" style="padding:40px 10px">还没有找到局域网地址。<br>请确认电脑连着 WiFi，然后点「重新连接」。</div>';
      return;
    }
    if (qrLoaded === url) return;
    fetch("/api/qr?url=" + encodeURIComponent(url))
      .then(function (r) { return r.text(); })
      .then(function (svg) {
        if (svg.indexOf("<svg") !== 0) throw new Error("二维码生成失败");
        holder.innerHTML = svg;
        qrLoaded = url;
      })
      .catch(function () {
        holder.innerHTML = '<div class="tip" style="padding:30px 10px">二维码没生成出来，直接把下面地址输入手机浏览器也一样。</div>';
      });
  }

  /* 手机独立版：给出下载地址与二维码（二维码指向下载接口） */
  var offlineQrLoaded = false;
  function loadOfflineQr() {
    var card = $("offlineCard");
    if (!card || ui.offline) return;
    var lan = (meta.server && meta.server.lanUrl) || "";
    card.hidden = false;
    if (!lan) return;
    var dl = lan.replace(/\/$/, "") + "/api/offline";
    if (offlineQrLoaded === dl) return;
    fetch("/api/qr?url=" + encodeURIComponent(dl))
      .then(function (r) { return r.text(); })
      .then(function (svg) {
        if (svg.indexOf("<svg") !== 0) throw new Error("二维码生成失败");
        $("offlineQr").innerHTML = svg;
        offlineQrLoaded = dl;
      })
      .catch(function () {
        $("offlineQr").innerHTML = '<div class="tip" style="padding:20px 8px">二维码生成失败，可以在手机上打开下面这个地址：<br>' + esc(dl) + "</div>";
      });
  }

  /* ---------------- 扫码配对 ----------------
   *
   * 目的是免去手输电脑地址：手机相机扫一下二维码，地址就带过去了。
   * 两种码各有用处：
   *   1. 线上版链接 —— 手机浏览器直接打开一个已配好的 Slowly，最通用
   *   2. App 深链   —— 已经装了安卓 App 时，一扫码就把地址填进 App
   * 都扫不了时还能手抄那 6 位配对码，比抄 IP 短得多。
   */
  var pairLoaded = "";
  function loadPairing() {
    var card = $("pairCard");
    if (!card) return;
    /* 只有跑在电脑端（有服务器）时才显示这张卡片 */
    if (ui.offline || ui.static) { card.hidden = true; return; }
    var pairing = meta.pairing || (meta.server && meta.server.pairing);
    if (!pairing || !pairing.pairUrl) { card.hidden = true; return; }
    card.hidden = false;

    $("pairCode").textContent = pairing.code || pairing.token || "—";
    $("pairLan").textContent = pairing.lanUrl || "（没找到局域网地址，确认电脑连着 WiFi）";

    /* 深链形状：slowly://pair?token=xxx&srv=http%3A%2F%2F10.0.0.2%3A8787%2F */
    var appUrl = "slowly://pair?token=" + encodeURIComponent(pairing.token) +
      "&srv=" + encodeURIComponent(pairing.lanUrl || "");
    $("pairAppUrl").textContent = appUrl;

    if (pairLoaded === pairing.pairUrl) return;
    pairLoaded = pairing.pairUrl;

    function draw(holderId, target, onFail) {
      var holder = $(holderId);
      if (!holder) return;
      fetch("/api/qr?url=" + encodeURIComponent(target))
        .then(function (r) { return r.text(); })
        .then(function (svg) {
          if (svg.indexOf("<svg") !== 0) throw new Error("二维码生成失败");
          holder.innerHTML = svg;
        })
        .catch(function () { if (onFail) holder.innerHTML = onFail; });
    }

    draw("pairQr", pairing.pairUrl,
      '<div class="tip" style="padding:24px 10px">二维码没生成出来。<br>可以在手机浏览器直接打开：<br>' + esc(pairing.pairUrl) + "</div>");
    draw("pairAppQr", appUrl,
      '<div class="tip" style="padding:24px 10px">二维码没生成出来。<br>装了安卓 App 的话，手输 6 位配对码也行。</div>');
  }

  /* 安卓 App 的扫码配对入口。
     原生那边（MainActivity）解析 slowly://pair?token=..&srv=.. 之后调用
     window.SlowlyPair(令牌, 电脑地址)。浏览器里不存在这个函数也不影响。 */
  function applyNativePair(token, serverUrl) {
    if (!SYNC || !token) return;
    SYNC.setPairToken(String(token).trim().toUpperCase());
    if (serverUrl) SYNC.setServerUrl(SYNC.normalizeUrl(serverUrl));
    toast("正在完成配对…");
    SYNC.verifyPairing().then(function () {
      toast("配对成功，已连上电脑 " + SYNC.getServerUrl(), "good");
      renderShare();
      syncNow(true);
    }).catch(function (err) {
      SYNC.setPairToken("");
      toast("配对没成功：" + err.message + "（确认手机和电脑在同一个 WiFi，然后重新扫码）", "warn");
      renderShare();
    });
  }
  if (typeof window !== "undefined") window.SlowlyPair = applyNativePair;

  /* ---------------- 备份 ---------------- */
  function importState(nextState, action) {
    send(action, { state: nextState }).then(function () {
      toast(action === "demo.seed" ? "示例数据已装载，看看有记录的样子 ✨" : "导入成功，欢迎回来 🌿", "good");
      if (action === "demo.seed") showView("stats");
    });
  }

  function seedDemo() {
    var titles = [
      ["写完周报的前两段", "must"], ["散步 20 分钟", "should"], ["读 10 页书", "should"],
      ["早睡（11 点前放下手机）", "must"], ["整理桌面 10 分钟", "bonus"], ["给家人打个电话", "bonus"],
      ["复习 20 个单词", "should"], ["喝够 8 杯水", "must"], ["复盘今天的一个决定", "bonus"]
    ];
    var goals = state.goals.filter(function (g) { return g.date < shiftKey(-13); });
    var moods = {};
    Object.keys(state.moods).forEach(function (k) { if (k < shiftKey(-13)) moods[k] = state.moods[k]; });
    for (var i = 13; i >= 0; i--) {
      var key = shiftKey(-i);
      var n = i === 0 ? 3 : 1 + Math.floor(Math.random() * 4);
      for (var j = 0; j < Math.min(n, 3); j++) {
        var t = titles[(i * 3 + j) % titles.length];
        var doneFlag = i === 0 ? j < 2 : Math.random() > 0.25;
        goals.push({
          id: "d" + i + "_" + j + "_" + Math.random().toString(36).slice(2, 7),
          title: t[0], cat: t[1], date: key, done: doneFlag,
          doneAt: doneFlag ? pad(9 + j * 3) + ":20" : "",
          created: Date.now() - i * 86400000 + j * 1000,
          updatedAt: Date.now() - i * 86400000,
          carry: 0, by: Math.random() > 0.5 ? "我的手机" : "我的电脑"
        });
      }
      if (Math.random() > 0.4) {
        var mk = MOODS[Math.floor(Math.random() * MOODS.length)];
        moods[key] = { k: mk.k, at: Date.now() - i * 86400000, device: "示例" };
      }
    }
    importState({ version: 1, goals: goals, moods: moods, notes: state.notes, seed: state.seed }, "demo.seed");
  }

  function exportData() {
    var a = document.createElement("a");
    a.href = "/api/export";
    a.download = "slowly-" + todayKey() + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast("备份已开始下载 📦", "good");
  }

  function importFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(String(reader.result)); } catch (e) { toast("这个文件读不出来，确认是 Slowly 的备份吗？", "warn"); return; }
      var payload = data && data.state ? data.state : data;
      if (!payload || !Array.isArray(payload.goals)) { toast("文件里没有找到记录，导入取消了", "warn"); return; }
      importState({
        version: 1,
        goals: payload.goals,
        moods: payload.moods && typeof payload.moods === "object" ? payload.moods : {},
        notes: payload.notes && typeof payload.notes === "object" ? payload.notes : {},
        seed: typeof payload.seed === "string" ? payload.seed : String(Date.now())
      }, "state.replace");
    };
    reader.readAsText(file);
  }

  /* ---------------- 设备名 ---------------- */
  function askDeviceName(force) {
    var modal = $("nameModal");
    if (!force && store.get("slowly.device")) return;
    if (!store.get("slowly.device") || force) {
      $("nameInput").value = force ? DEVICE : "";
      modal.hidden = false;
      setTimeout(function () { try { $("nameInput").focus(); } catch (e) { /* ignore */ } }, 60);
    }
  }
  function saveDeviceName() {
    var v = $("nameInput").value.trim();
    if (v) {
      DEVICE = clampText(v, 20);
      store.set("slowly.device", DEVICE);
      renderShare();
      announceDevice();
      toast("这台设备叫「" + DEVICE + "」了", "good");
    }
    $("nameModal").hidden = true;
  }

  /* 告诉同步内核这台设备叫什么（离线同步到电脑时，活动流里会显示这个名字） */
  function announceDevice() {
    try {
      window.dispatchEvent(new CustomEvent("slowly:device", { detail: DEVICE }));
    } catch (e) { /* 老浏览器忽略即可 */ }
  }

  /* ---------------- 事件绑定 ---------------- */
  $("addBtn").addEventListener("click", addGoal);
  $("goalInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); addGoal(); }
  });
  $("cats").addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest(".cat") : null;
    if (!b) return;
    ui.cat = b.getAttribute("data-cat");
    renderToday();
  });
  $("goalList").addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!btn) return;
    var row = btn.closest(".goal");
    if (!row) return;
    var id = row.getAttribute("data-id");
    if (btn.getAttribute("data-act") === "toggle") toggleGoal(id);
    else delGoal(id);
  });
  $("carryBox").addEventListener("click", function (e) {
    if (e.target && e.target.id === "carryBtn") carryOver();
  });
  $("moods").addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("[data-mood]") : null;
    if (b) setMood(b.getAttribute("data-mood"));
  });
  $("noteInput").addEventListener("input", onNoteInput);
  $("tabs").addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest(".tab") : null;
    if (b) showView(b.getAttribute("data-view"));
  });
  $("exportBtn").addEventListener("click", exportData);
  $("importBtn").addEventListener("click", function () { $("fileInput").click(); });
  $("fileInput").addEventListener("change", function (e) {
    var f = e.target.files && e.target.files[0];
    if (f) importFile(f);
    e.target.value = "";
  });
  $("demoBtn").addEventListener("click", function () {
    if (window.confirm("会用一份示例数据替换最近两周的记录（更早的会保留），确定看看效果吗？")) seedDemo();
  });
  $("clearBtn").addEventListener("click", function () {
    if (!window.confirm("确定清空全部记录吗？清空后无法恢复，建议先导出备份。")) return;
    var tombstones = {};
    state.goals.forEach(function (g) { tombstones[g.id] = Date.now(); });
    state = { goals: [], moods: {}, notes: {}, tombstones: tombstones, seed: state.seed };
    renderAll();
    send("state.clear", { tombstones: tombstones }).then(function () { toast("已清空，从今天重新开始也不迟 🌱"); });
  });
  $("renameBtn").addEventListener("click", function () { askDeviceName(true); });
  $("reconnectBtn").addEventListener("click", function () {
    if (ui.offline) { syncNow(false); return; }
    toast("正在重新连接…");
    if (window.__slowlyEvents) { try { window.__slowlyEvents.close(); } catch (e) { /* ignore */ } }
    load().then(connect).catch(function () { toast("连不上，确认电脑上的 Slowly 还开着", "warn"); });
  });
  if ($("syncNowBtn")) {
    $("syncNowBtn").addEventListener("click", function () { syncNow(false); });
  }
  if ($("setUrlBtn")) {
    $("setUrlBtn").addEventListener("click", function () {
      var cur = SYNC.getServerUrl();
      var hasToken = SYNC.getPairToken && SYNC.getPairToken();
      var v = window.prompt(
        "电脑的地址。\n\n最快的办法是在电脑上的「连接」页扫二维码，地址会自动填好；\n扫不了时再手填，形如 192.168.1.5:8787",
        cur || "192.168.1.5:8787");
      if (v === null) return;
      var url = SYNC.normalizeUrl(v);
      if (!url) { toast("地址没填，已取消", "warn"); return; }
      SYNC.setServerUrl(url);

      /* 电脑「连接」页上还显示着 6 位配对码，填上它就能确认配对了哪台电脑。
         嫌麻烦直接留空也能用（局域网里连得上就行）。 */
      var code = window.prompt(
        "电脑上显示的 6 位配对码（在「扫码配对」卡片里）。\n留空就直接连，不校验配对。",
        hasToken || "");
      if (code === null) code = "";
      code = String(code).trim().toUpperCase();

      if (!code) {
        toast("记下了：" + url + "，正在试连…", "good");
        renderShare();
        autoSyncSoon(true);
        return;
      }

      toast("正在校验配对码…");
      SYNC.pairWithToken(code, url).then(function () {
        toast("配对成功，这台设备已连上 " + url, "good");
        renderShare();
        syncNow(true);
      }).catch(function (err) {
        toast("配对失败：" + err.message, "warn");
        renderShare();
        autoSyncSoon(true);
      });
    });
  }
  if ($("installBtn")) {
    $("installBtn").addEventListener("click", function () {
      if (!installEvent) { toast("请用浏览器菜单里的「添加到主屏幕」", "warn"); return; }
      installEvent.prompt();
      installEvent.userChoice.then(function (r) {
        if (r && r.outcome === "accepted") toast("正在安装…", "good");
        installEvent = null;
        renderInstallCard();
      }).catch(function () { /* 忽略 */ });
    });
  }
  if ($("copyOfflineLink")) {
    $("copyOfflineLink").addEventListener("click", function () {
      var lan = (meta.server && meta.server.lanUrl) || "";
      var dl = lan ? lan.replace(/\/$/, "") + "/api/offline" : "";
      if (!dl) { toast("还没找到局域网地址", "warn"); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(dl).then(function () { toast("下载地址已复制", "good"); },
          function () { window.prompt("手动复制这个地址：", dl); });
      } else {
        window.prompt("手动复制这个地址：", dl);
      }
    });
  }
  $("nameSave").addEventListener("click", saveDeviceName);
  $("nameSkip").addEventListener("click", function () { $("nameModal").hidden = true; });
  $("nameInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); saveDeviceName(); }
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    if (ui.offline) { autoSyncSoon(false); return; }
    if (!sync.live) connect();
    load().catch(function () { /* 忽略 */ });
  });

  /* 离线版：回到前台 / 刚填好地址时自动试一次同步，失败不打扰 */
  var autoSyncTimer = null;
  function autoSyncSoon(loud) {
    if (!ui.offline || !SYNC.getServerUrl()) return;
    if (autoSyncTimer) clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(function () {
      var last = SYNC.getLastSync();
      /* 刚同步过就不重复打扰电脑 */
      if (!loud && Date.now() - last < 60000) return;
      syncNow(!loud);
    }, loud ? 300 : 1200);
  }

  /* 跨天自动翻页 */
  var lastKey = todayKey();
  setInterval(function () {
    if (todayKey() !== lastKey) {
      lastKey = todayKey();
      renderAll();
      toast("新的一天开始了，写一件小事吧 ☀️", "good");
    }
  }, 30000);

  /* ---------------- 启动 ---------------- */
  /* 离线外壳：装了以后即使断网也能打开 */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      try {
        /* 用相对路径注册，放在子目录（如 GitHub Pages 的 /仓库名/）下也能工作 */
        navigator.serviceWorker.register("sw.js").catch(function () {
          navigator.serviceWorker.register("/sw.js").catch(function () { /* 不影响主流程 */ });
        });
      } catch (e) { /* 忽略 */ }
    });
  }

  /* 判断运行环境：
     server  —— 从电脑上的 Slowly 打开的网页版（有服务器可连）
     static  —— 发布在网上的静态站点（每个人各用各的，没有服务器）
     offline —— 存到手机上的单文件 / 安卓 App
     构建时会往 <body> 写 data-slowly-mode，优先读它；读不到再按协议推断。 */
  function detectMode() {
    if (!SYNC) return "server";
    var declared = document.body && document.body.getAttribute
      ? document.body.getAttribute("data-slowly-mode") : null;
    if (declared === "static" || declared === "offline") return declared;
    var proto = location.protocol;
    if (proto === "file:" || proto === "content:" || proto === "capacitor:") return "offline";
    if ((proto === "http:" || proto === "https:") && location.host) return "server";
    return "offline";
  }

  /* 扫码配对：如果当前地址里带着配对信息（#pair=… 或 ?pair=…），
     就在启动时立刻应用 —— 用户扫完码打开页面，地址已经被填好了。
     返回 true 表示这次是"扫码进来的"，界面需要给个提示。 */
  function applyPairingOnBoot() {
    if (!SYNC || typeof SYNC.applyPairingFromLocation !== "function") return null;
    var applied = null;
    try { applied = SYNC.applyPairingFromLocation(); } catch (e) { applied = null; }
    if (!applied) return null;
    /* 地址栏已经清干净了，这里把结果告诉界面 */
    if (applied.serverUrl) {
      meta.server = Object.assign({}, meta.server || {}, { lanUrl: applied.serverUrl });
    }
    return applied;
  }

  function bootLocal(mode) {
    ui.offline = true;
    ui.mode = mode;
    /* 先应用扫码结果，再读本地数据与渲染 */
    var paired = applyPairingOnBoot();
    state = readLocal();
    if (!state.seed) state.seed = String(Date.now());
    writeLocal(state);
    meta.server = {
      name: "Slowly",
      version: "1.0.0",
      offline: true,
      mode: mode,
      dataFile: mode === "static" ? "这台设备的浏览器存储" : "这台设备上的存储",
      lanUrl: SYNC.getServerUrl() || "",
      clients: 1,
      uptime: 0
    };
    ui.ready = true;
    renderAll();
    renderShare();
    setSyncUI();
    if (SYNC.getServerUrl()) {
      setTimeout(function () { syncNow(true); }, 600);
    }
    return true;
  }

  function bootOffline() {
    var mode = detectMode();
    announceDevice();
    if (mode === "server") return false;
    return bootLocal(mode);
  }

  if (!bootOffline()) {
    load().catch(function (err) {
      ui.ready = true;
      $("goalList").innerHTML = '<div class="empty"><b>连不上 Slowly 服务器</b>' +
        "请确认电脑上的 Slowly 还开着，然后刷新这个页面。<br><small>" + esc(err.message) + "</small></div>";
      $("progressNum").textContent = "等待连接…";
      setSyncUI();
    }).finally(function () {
      connect();
      setSyncUI();
      askDeviceName(false);
      handlePairingAfterBoot();
    });
  } else {
    askDeviceName(false);
    handlePairingAfterBoot();
  }

  /* 启动后处理扫码配对。
     两种情况：
       - 从手机相机扫进来的：地址里带着 #pair=…&srv=…，刚才已由
         applyPairingFromLocation 记下了地址与令牌，这里只做一次校验与提示
       - 电脑网页版里点了"配对"：地址是 ?pair=…，用来确认这台设备已配对
     校验失败就把令牌清掉，免得留下一个连不上的状态。 */
  function handlePairingAfterBoot() {
    if (!SYNC || ui.mode === "server") return;
    var token = SYNC.getPairToken && SYNC.getPairToken();
    if (!token) return;
    if (!SYNC.getServerUrl()) return;
    setTimeout(function () {
      SYNC.verifyPairing().then(function () {
        toast("已配对到电脑 " + SYNC.getServerUrl(), "good");
        renderShare();
        syncNow(true);
      }).catch(function (err) {
        SYNC.setPairToken("");
        toast("配对没成功：" + err.message + "（可以重新扫一次码）", "warn");
        renderShare();
      });
    }, 400);
  }
})();
