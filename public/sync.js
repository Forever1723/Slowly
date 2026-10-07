/* =============================================================
   Slowly · 离线同步内核
   安卓 App / 单文件离线版用它把手机上的数据与电脑合并。
   合并规则与 server.mjs 里的 mergeStates 完全一致（两个实现互相校验）。
   ============================================================= */
(function (root) {
  "use strict";

  var TOMBSTONE_KEEP_DAYS = 90;
  var URL_KEY = "slowly.serverUrl";
  var LAST_SYNC_KEY = "slowly.lastSync";

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  /* 时间戳下限：2019-01-01。设备时间错乱（回到 1970）时，
     宁可保留数据也不要把用户的记录当成过期墓碑清掉 */
  var MIN_VALID_TS = 1546300800000;

  function pruneTombstones(map) {
    var out = {};
    var cutoff = Date.now() - TOMBSTONE_KEEP_DAYS * 86400000;
    Object.keys(map || {}).forEach(function (k) {
      var t = num(map[k]);
      /* 太老（早于保留期）或明显不合理的时间戳都丢掉 */
      if (t >= MIN_VALID_TS && t >= cutoff) out[k] = t;
    });
    return out;
  }

  function emptyState(seed) {
    return { version: 1, goals: [], moods: {}, notes: {}, tombstones: {}, seed: seed || String(Date.now()) };
  }

  function normalize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyState();
    return {
      version: 1,
      goals: Array.isArray(raw.goals) ? raw.goals.filter(function (g) { return g && typeof g === "object" && typeof g.id === "string"; }) : [],
      moods: raw.moods && typeof raw.moods === "object" && !Array.isArray(raw.moods) ? raw.moods : {},
      notes: raw.notes && typeof raw.notes === "object" && !Array.isArray(raw.notes) ? raw.notes : {},
      tombstones: raw.tombstones && typeof raw.tombstones === "object" && !Array.isArray(raw.tombstones) ? pruneTombstones(raw.tombstones) : {},
      seed: typeof raw.seed === "string" ? raw.seed : String(Date.now())
    };
  }

  /* 与 server.mjs 的 mergeStates 逐条对应：
     目标按 id 去重、updatedAt 新者胜；墓碑时间晚于目标更新时间才算删掉；
     心情 / 随笔按时间戳新者胜。 */
  function merge(base, incoming) {
    var a = normalize(base);
    var b = normalize(incoming);

    var tombstones = Object.assign({}, a.tombstones);
    Object.keys(b.tombstones).forEach(function (id) {
      tombstones[id] = Math.max(num(b.tombstones[id]), num(tombstones[id]));
    });

    var byId = {};
    a.goals.forEach(function (g) { byId[g.id] = g; });
    b.goals.forEach(function (g) {
      var old = byId[g.id];
      if (!old) { byId[g.id] = g; return; }
      if (num(g.updatedAt || g.created) >= num(old.updatedAt || old.created)) byId[g.id] = g;
    });
    var goals = Object.keys(byId).map(function (k) { return byId[k]; }).filter(function (g) {
      var dead = num(tombstones[g.id]);
      return !(dead && dead >= num(g.updatedAt || g.created));
    });

    var moods = Object.assign({}, a.moods);
    Object.keys(b.moods).forEach(function (k) {
      if (num(b.moods[k] && b.moods[k].at) >= num(moods[k] && moods[k].at)) moods[k] = b.moods[k];
    });

    var notes = Object.assign({}, a.notes);
    Object.keys(b.notes).forEach(function (k) {
      var v = b.notes[k];
      var isObj = v && typeof v === "object";
      var oldIsObj = notes[k] && typeof notes[k] === "object";
      if (isObj) {
        if (!oldIsObj || num(v.at) >= num(notes[k] && notes[k].at)) notes[k] = v;
      } else if (!oldIsObj) {
        notes[k] = v;
      }
    });

    return { version: 1, goals: goals, moods: moods, notes: notes, tombstones: pruneTombstones(tombstones), seed: b.seed || a.seed };
  }

  /* 有没有本地独有的东西需要推给电脑（避免每次开 App 都白写一次磁盘） */
  function hasLocalNews(local, remote) {
    var r = normalize(remote);
    var remoteIds = {};
    r.goals.forEach(function (g) { remoteIds[g.id] = num(g.updatedAt || g.created); });
    for (var i = 0; i < local.goals.length; i++) {
      var g = local.goals[i];
      var rt = remoteIds[g.id];
      if (rt === undefined || num(g.updatedAt || g.created) > rt) return true;
    }
    var keys = Object.keys(local.tombstones);
    for (var j = 0; j < keys.length; j++) {
      if (num(local.tombstones[keys[j]]) > num(r.tombstones[keys[j]])) return true;
    }
    var nk = Object.keys(local.notes);
    for (var k = 0; k < nk.length; k++) {
      var v = local.notes[nk[k]];
      var rv = r.notes[nk[k]];
      if (typeof v === "object") {
        if (!rv || num(v.at) > num(rv && rv.at)) return true;
      } else if (typeof rv !== "string") {
        return true;
      }
    }
    return false;
  }

  /* ---------------- 与电脑通信 ---------------- */

  function normalizeUrl(raw) {
    var u = String(raw || "").trim();
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "http://" + u;
    u = u.replace(/\/+$/, "");
    /* 允许用户只填 IP，自动补默认端口 */
    if (!/:\d+$/.test(u.replace(/^https?:\/\//i, ""))) u += ":8787";
    return u;
  }

  function getServerUrl() {
    try { return localStorage.getItem(URL_KEY) || ""; } catch (e) { return ""; }
  }
  function setServerUrl(url) {
    try {
      if (url) localStorage.setItem(URL_KEY, url);
      else localStorage.removeItem(URL_KEY);
    } catch (e) { /* 忽略 */ }
  }
  function getLastSync() {
    try { return Number(localStorage.getItem(LAST_SYNC_KEY) || 0); } catch (e) { return 0; }
  }
  function markSynced() {
    try { localStorage.setItem(LAST_SYNC_KEY, String(Date.now())); } catch (e) { /* 忽略 */ }
  }

  /* 页面脚本知道这台设备叫什么名字，用事件递过来（浏览器与 App 都通用）。
     这样电脑上的活动流会显示"我的手机"而不是笼统的"手机"。 */
  var deviceName = "";
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("slowly:device", function (e) {
      if (e && e.detail) deviceName = String(e.detail).slice(0, 20);
    });
  }
  function currentDevice() {
    return deviceName || "手机";
  }

  function request(url, options, timeoutMs) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, timeoutMs || 6000);
    var opts = Object.assign({}, options || {});
    if (ctl) opts.signal = ctl.signal;
    return fetch(url, opts).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.error || ("电脑返回 " + r.status));
        return body;
      });
    }, function (err) {
      clearTimeout(timer);
      throw new Error(err && err.name === "AbortError" ? "连接超时（手机和电脑要在同一个 WiFi）" : "连不上电脑：" + (err && err.message ? err.message : err));
    });
  }

  /* 拉电脑上的数据 */
  function pull(url) {
    return request(url + "/api/state", { method: "GET" }, 6000).then(function (snap) {
      return { state: normalize(snap.state), rev: snap.rev, server: snap.server || {} };
    });
  }

  /* 把自己的数据并给电脑 */
  function push(url, localState, deviceName) {
    return request(url + "/api/action", {
      method: "POST",
      headers: { "content-type": "application/json", "x-slowly-device": encodeURIComponent(deviceName || "手机") },
      body: JSON.stringify({ action: "state.merge", state: localState })
    }, 15000);
  }

  /* 一次完整同步：先拉、合并、需要时再推，最后返回合并后的结果 */
  function sync(localState, device) {
    var url = getServerUrl();
    if (!url) return Promise.reject(new Error("还没有设置电脑地址"));
    var who = device || currentDevice();
    var local = normalize(localState);
    var remote = null;
    var pushed = false;

    return pull(url).then(function (snap) {
      remote = snap.state;
      var needPush = hasLocalNews(local, remote);
      var merged = merge(remote, local);
      if (!needPush) {
        markSynced();
        return { state: merged, pushed: false, server: snap.server, rev: snap.rev };
      }
      return push(url, merged, who).then(function (res) {
        pushed = true;
        markSynced();
        var finalState = normalize(res.state || merged);
        return { state: finalState, pushed: true, server: snap.server, rev: res.rev };
      });
    });
  }

  /* 能不能连上（用于界面上的状态小点） */
  function ping(url) {
    return request(url + "/api/ping", { method: "GET" }, 4000);
  }

  var api = {
    emptyState: emptyState,
    normalize: normalize,
    merge: merge,
    pruneTombstones: pruneTombstones,
    hasLocalNews: hasLocalNews,
    normalizeUrl: normalizeUrl,
    getServerUrl: getServerUrl,
    setServerUrl: setServerUrl,
    getLastSync: getLastSync,
    markSynced: markSynced,
    currentDevice: currentDevice,
    pull: pull,
    push: push,
    sync: sync,
    ping: ping,
    URL_KEY: URL_KEY,
    LAST_SYNC_KEY: LAST_SYNC_KEY
  };

  /* 浏览器 / WebView 里挂到全局；Node 里走 module.exports（测试要用） */
  var G = typeof window !== "undefined" ? window
    : typeof self !== "undefined" ? self
    : typeof globalThis !== "undefined" ? globalThis
    : root;
  G.SlowlySync = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
