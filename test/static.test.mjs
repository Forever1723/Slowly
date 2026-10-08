/* 前端静态检查：id 引用、离线层接线、离线 HTML 自包含性 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra ? "  -> " + extra : "")); }
};

const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

console.log("1) app.js 里引用的元素 id 都必须存在于 index.html");
const ids = new Set(Array.from(html.matchAll(/id="([^"]+)"/g), (m) => m[1]));
const used = Array.from(new Set(Array.from(js.matchAll(/\$\("([^"]+)"\)/g), (m) => m[1])));
const guarded = new Set(Array.from(js.matchAll(/if \(\$\("([^"]+)"\)\)/g), (m) => m[1]));
const missing = used.filter((u) => !ids.has(u) && !guarded.has(u));
ok(missing.length === 0, "全部 " + used.length + " 个 id 都有对应元素", missing.join(", "));
ok(guarded.size > 0, "有 " + guarded.size + " 个元素做了存在性保护（离线版会隐藏它们）：" + Array.from(guarded).join(", "));

console.log("2) 离线层接线");
ok(js.includes("makeOfflineFetch"), "存在离线 fetch 适配器");
ok(js.includes("detectMode"), "存在运行环境判断（server / static / offline 三种）");
ok(js.includes("bootLocal"), "本机模式有独立的启动流程");
ok(js.includes('proto === "file:"'), "本地文件/App 内打开会走本机模式");
ok(js.includes("syncNow"), "存在手动同步入口");
ok(js.includes("writeLocal"), "改动会写入本机存储");
ok(/state\.notes\[key\] = \{ text:/.test(js) || js.includes("setNote(key"), "随笔按带时间戳的对象保存（便于两端合并）");
ok(js.includes("addTombstone"), "删除会留墓碑（离线删除才能同步到电脑）");
ok(js.includes("SlowlySync"), "接入了同步内核");
const idx = js.indexOf("var offlineFetch = makeOfflineFetch();");
const use = js.indexOf("if (ui.offline && path.indexOf(\"/api/\") === 0)");
ok(idx >= 0 && use > idx, "适配器先创建后使用（避免暂时性死区）");

console.log("3) sync.js 与服务器合并规则对应");
const sync = fs.readFileSync(path.join(ROOT, "public", "sync.js"), "utf8");
const srv = fs.readFileSync(path.join(ROOT, "server.mjs"), "utf8");
for (const key of ["tombstones", "Tombstone", "updatedAt", "merge"]) {
  ok(sync.includes(key), "sync.js 含 " + key);
}
ok(srv.includes("function mergeStates"), "服务器也有一份 mergeStates（两端互为镜像）");
ok(srv.includes("state.merge"), "服务器支持 state.merge 动作");
ok(srv.includes("TOMBSTONE_KEEP_DAYS"), "墓碑有过期清理");
ok(srv.includes("goal.remove") && srv.includes("state.tombstones[id] = Date.now()"), "服务器删除目标时也留墓碑");

console.log("4) index.html 结构");
ok(html.includes('id="syncCard"'), "连接页含「与电脑同步」卡片");
ok((html.match(/<script/g) || []).length === 1, "页面只引入一个脚本");
ok(html.indexOf("/app.js") > 0, "引入 app.js");

console.log("5) 离线单文件（若已生成）");
const offlinePath = path.join(ROOT, "public", "offline.html");
if (fs.existsSync(offlinePath)) {
  const off = fs.readFileSync(offlinePath, "utf8");
  ok(!/<link[^>]+href="\/[^"]+"/.test(off), "没有指向服务器的 link（图标等已内联或改写）");
  ok(!/<script[^>]+src="\//.test(off), "没有外链脚本");
  ok(off.includes("SlowlySync") && off.includes("makeOfflineFetch"), "内联了同步内核与离线层");
  ok(off.includes("<style"), "样式已内联");
  ok(off.length > 40000, "体积合理：" + Math.round(off.length / 1024) + " KB");
  /* 关键：不能依赖网络上的任何资源 */
  const externals = Array.from(off.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g), (m) => m[1]);
  ok(externals.length === 0, "没有任何外部依赖", externals.slice(0, 5).join(", "));
} else {
  console.log("  （还没有生成 offline.html，跳过）");
}

console.log("6) 发布站点 docs/（GitHub Pages 用）");
const docsDir = path.join(ROOT, "docs");
if (fs.existsSync(docsDir)) {
  const page = fs.readFileSync(path.join(docsDir, "index.html"), "utf8");
  const man = JSON.parse(fs.readFileSync(path.join(docsDir, "manifest.webmanifest"), "utf8"));
  const sw = fs.readFileSync(path.join(docsDir, "sw.js"), "utf8");

  ok(page.includes('data-slowly-mode="static"'), "页面声明为静态版（会被识别成没有服务器的模式）");
  ok(page.includes("makeOfflineFetch") && page.includes("SlowlySync"), "离线层与同步内核已内联");
  ok(page.includes("<style"), "样式已内联");
  const absRefs = Array.from(page.matchAll(/(?:src|href)="(\/[^"]*)"/g), (m) => m[1]);
  ok(absRefs.length === 0, "没有任何以 / 开头的资源引用（子目录部署不会 404）", absRefs.join(", "));
  const externals = Array.from(page.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g), (m) => m[1]);
  ok(externals.length === 0, "不依赖任何外部网址", externals.slice(0, 3).join(", "));
  ok(/<script src=/.test(page) === false || !page.includes('src="/'), "没有外链脚本");

  ok(man.start_url === "./" && man.scope === "./", "manifest 用相对路径（部署到子目录也能装）");
  ok(man.display === "standalone", "装到主屏后全屏运行（无地址栏）");
  ok(Array.isArray(man.icons) && man.icons.length >= 3, "manifest 声明了图标");
  const iconFiles = ["slowly-icon.svg", "slowly-256.png", "slowly-32.png"];
  let iconsOk = true, iconDetail = "";
  for (const f of iconFiles) {
    const p = path.join(docsDir, "assets", f);
    if (!fs.existsSync(p)) { iconsOk = false; iconDetail += f + " 缺失 "; }
  }
  ok(iconsOk, "图标文件都在 assets/ 下", iconDetail);

  ok(sw.includes("slowly-static-v1"), "Service Worker 就绪（断网也能打开）");
  ok(!/caches\.open\([^)]*\)\.then\(\(c\) => c\.addAll\(\["\//.test(sw), "SW 缓存列表用相对路径");
  ok(fs.existsSync(path.join(docsDir, ".nojekyll")), "含 .nojekyll（GitHub Pages 不会漏发文件）");
  ok(fs.existsSync(path.join(docsDir, "README.md")), "含发布说明");

  /* 装到主屏的引导 */
  ok(page.includes('id="installCard"') && page.includes('id="installBtn"'), "页面含装到主屏幕的引导");
  ok(js.includes("beforeinstallprompt"), "监听安卓的安装事件，能一键安装");
  ok(js.includes("添加到主屏幕"), "iOS 给出了手动添加的说明");
  ok(js.includes("isStandalone"), "已安装时不再重复提示");

  /* 静态模式下不能去连不存在的服务器 */
  ok(js.includes('detectMode'), "有运行环境判断（server / static / offline）");
  ok(js.includes('mode === "server"') === false || js.includes('return "server"'), "静态版不会误判成服务器模式");
} else {
  console.log("  （还没有生成 docs/，跳过）");
}

console.log("7) 安卓工程（若已生成）");
const androidDir = path.join(ROOT, "android");
if (fs.existsSync(androidDir)) {
  const manifest = fs.readFileSync(path.join(androidDir, "app", "src", "main", "AndroidManifest.xml"), "utf8");
  ok(/package="com\.slowly\.app"/.test(manifest), "Manifest 声明了包名");
  ok(manifest.includes("android.permission.INTERNET"), "声明了联网权限（同步用）");
  ok(manifest.includes("android.intent.category.LAUNCHER"), "有启动图标入口");
  ok(manifest.includes("usesCleartextTraffic=\"true\""), "允许明文 HTTP（连电脑的局域网地址需要）");
  ok(manifest.includes(".MainActivity"), "指向 MainActivity");

  const activity = fs.readFileSync(path.join(androidDir, "app", "src", "main", "java", "com", "slowly", "app", "MainActivity.java"), "utf8");
  ok(activity.includes("setJavaScriptEnabled(true)"), "WebView 打开了 JavaScript");
  ok(activity.includes("setDomStorageEnabled(true)"), "打开了 DOM Storage（数据存在这里，必须开）");
  ok(activity.includes("file:///android_asset/index.html"), "加载打包进 App 的离线页面");
  ok(activity.includes("JavascriptInterface"), "提供了原生小能力（震动/提示）");
  ok(activity.includes("shouldOverrideUrlLoading"), "处理了链接跳转");

  const assetsHtml = path.join(androidDir, "app", "src", "main", "assets", "index.html");
  ok(fs.existsSync(assetsHtml), "离线页面已打进 assets");
  if (fs.existsSync(assetsHtml)) {
    const a = fs.readFileSync(assetsHtml, "utf8");
    const o = fs.readFileSync(path.join(ROOT, "public", "offline.html"), "utf8");
    ok(a === o, "assets 里的页面与 public/offline.html 完全一致（没有打旧版本）");
    ok(a.includes("makeOfflineFetch") && a.includes("SlowlySync"), "打包页面里含离线层与同步内核");
  }

  let iconsOk = true, iconDetail = "";
  for (const d of ["mipmap-mdpi", "mipmap-hdpi", "mipmap-xhdpi", "mipmap-xxhdpi", "mipmap-xxxhdpi"]) {
    const p = path.join(androidDir, "app", "src", "main", "res", d, "ic_launcher.png");
    if (!fs.existsSync(p)) { iconsOk = false; iconDetail += d + " 缺失 "; continue; }
    const buf = fs.readFileSync(p);
    if (buf.toString("hex", 0, 8) !== "89504e470d0a1a0a") { iconsOk = false; iconDetail += d + " 不是 PNG "; }
  }
  ok(iconsOk, "五个密度的启动图标都是有效 PNG", iconDetail);

  const gradle = fs.readFileSync(path.join(androidDir, "app", "build.gradle"), "utf8");
  ok(/applicationId\s+"com\.slowly\.app"/.test(gradle), "applicationId 为 com.slowly.app");
  ok(/minSdk\s+24/.test(gradle), "minSdk 24（安卓 7.0 及以上都能装）");
  ok(/compileSdk\s+34/.test(gradle), "compileSdk 34");

  /* 工作流只放在仓库根目录 —— GitHub 只执行 .github/workflows/ 下的文件，
     放在 android/.github/ 下永远不会运行，只会让人以为有两条构建途径。 */
  const rootActions = path.join(ROOT, ".github", "workflows", "build-apk.yml");
  ok(fs.existsSync(rootActions), "仓库根目录有 GitHub Actions 一键编译工作流");
  if (fs.existsSync(rootActions)) {
    const wf = fs.readFileSync(rootActions, "utf8");
    ok(wf.includes("assembleRelease"), "工作流会编译 release APK");
    ok(wf.includes("upload-artifact"), "工作流会产出可下载的 APK");
    /* "on" 必须带引号：YAML 会把裸写的 on 解析成布尔值 true，
       GitHub 读的是字符串键 "on"，不加引号会让所有触发器失效 ——
       这个坑真踩过，现象是工作流永远不会运行、名字还退化成文件路径。 */
    ok(/^"on":/m.test(wf), 'on 键带引号（裸写的 on 会被 YAML 当成布尔值，触发器会失效）');
    ok(wf.includes("workflow_dispatch"), "支持手动触发");
    /* android/.github 下的那份副本不该再出现 */
    const strayActions = path.join(androidDir, ".github", "workflows", "build-apk.yml");
    ok(!fs.existsSync(strayActions), "android/.github 下没有多余的工作流副本（那个位置 GitHub 不执行）");
  }

  const buildDoc = path.join(androidDir, "BUILD.md");
  ok(fs.existsSync(buildDoc), "附带编译说明 BUILD.md");
  if (fs.existsSync(buildDoc)) {
    const doc = fs.readFileSync(buildDoc, "utf8");
    ok(doc.includes("GitHub Actions") && doc.includes("Android Studio"), "说明了两种编译方式");
    ok(doc.includes("同一 WiFi") || doc.includes("同一个 WiFi"), "提醒了手机与电脑要同网");
  }
} else {
  console.log("  （还没有生成 android/，跳过）");
}

console.log("\n结果：通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
