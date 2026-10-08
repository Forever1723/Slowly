/* =============================================================
   打包工具：
   1) public/offline.html —— 完全自包含的单文件（发给别人 / 安卓工程内嵌用）
   2) docs/               —— 可发布的静态站点（GitHub Pages 直接能用）
      每个人打开网址就能用，数据各存各的设备，不需要服务器
   3) android/            —— WebView 壳工程，供有网络时编译成 APK
   用法：node tools/build-offline.mjs
   ============================================================= */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PUB = path.join(ROOT, "public");
const ASSETS = path.join(ROOT, "assets");

const read = (p) => fs.readFileSync(p, "utf8");
const log = (s) => console.log(s);

/* ---------------- 1. 合成离线单文件 ---------------- */
function buildOfflineHtml() {
  let html = read(path.join(PUB, "index.html"));
  const appJs = read(path.join(PUB, "app.js"));
  const syncJs = read(path.join(PUB, "sync.js"));
  const iconSvg = read(path.join(ASSETS, "slowly-icon.svg"));
  const png32 = fs.readFileSync(path.join(ASSETS, "slowly-32.png")).toString("base64");
  const png256 = fs.readFileSync(path.join(ASSETS, "slowly-256.png")).toString("base64");

  /* 1) 取出内联的 <style>，其余头部标签（manifest / 图标链接）在离线版里没有意义，去掉 */
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  if (!styleMatch) throw new Error("index.html 里没有找到 <style> 块");
  const style = styleMatch[1];

  /* 2) 头部替换：只保留 charset / viewport / theme-color，并声明离线版 */
  const headStart = html.indexOf("<head>");
  const headEnd = html.indexOf("</head>");
  if (headStart < 0 || headEnd < 0) throw new Error("index.html 结构异常");
  const newHead = [
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="theme-color" content="#f7f2ea">',
    '<meta name="description" content="Slowly · 离线也能记，连上电脑就同步">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="Slowly">',
    "<title>Slowly · 慢慢来，比较快</title>",
    "<style>" + style + "</style>",
    "</head>"
  ].join("\n");

  html = html.slice(0, headStart) + newHead + html.slice(headEnd + "</head>".length);

  /* 3) 图标改成内联 data URI（file:// 下相对路径不可靠，且离线层会接管 /assets 请求） */
  html = html.replace(/href="\/assets\/slowly-icon\.svg"/g, 'href="data:image/svg+xml;base64,' + Buffer.from(iconSvg, "utf8").toString("base64") + '"');
  html = html.replace(/href="\/assets\/slowly-256\.png"/g, 'href="data:image/png;base64,' + png256 + '"');
  /* 页面里若直接引用了 32px 图标也一并替换 */
  html = html.replace(/\/assets\/slowly-32\.png/g, "data:image/png;base64," + png32);

  /* 4) 去掉外链脚本，把同步内核与页面脚本内联进同一个文件 */
  html = html.replace(/<script src="\/app\.js"><\/script>/, "");
  const bundle = [
    "<!-- Slowly 离线版：把这两个脚本内联进来，手机不连电脑也能用 -->",
    "<script>" + syncJs + "</script>",
    "<script>" + appJs + "</script>"
  ].join("\n");
  html = html.replace("</body>", bundle + "\n</body>");

  /* 5) 声明这是离线版（离线层也会自己判断，这里是双保险） */
  html = html.replace("<body>", '<body data-slowly-mode="offline">');

  const out = path.join(PUB, "offline.html");
  fs.writeFileSync(out, html, "utf8");
  return { out, size: Buffer.byteLength(html) };
}

/* ---------------- 2. 生成安卓工程 ---------------- */
function writeFile(rel, content) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}

function buildAndroid() {
  const pkgDir = "android/app/src/main/java/com/slowly/app";
  const res = "android/app/src/main/res";
  const made = [];

  /* 工程说明 */
  made.push(writeFile("android/BUILD.md", `# 把 Slowly 编译成安卓 App

这个目录是一个**完整的安卓工程**，界面用的是已经打包好的离线版（\`app/src/main/assets/index.html\`），
装到手机上以后不连电脑也能用，连上电脑点一次「立即同步」就会合并数据。

你在这台电脑上编不了（没有 Java / Android SDK / 网络），需要换一台有网、有 Android Studio 的电脑，
或者用 GitHub Actions 云端编译。三种办法任选：

---

## 办法一：GitHub Actions（不用装任何东西，推荐）

1. 注册/登录 GitHub，新建一个仓库（私有也行）
2. 把整个 \`Slowly\` 文件夹 push 上去
3. 仓库里点 **Actions** → 选 **Build Slowly APK** → **Run workflow**
4. 等 3~5 分钟，在该次运行的 **Artifacts** 里下载 \`slowly-apk\`
5. 解压得到 \`app-release.apk\`，发到手机上安装（首次要允许「安装未知来源应用」）

工作流文件已经放在 \`.github/workflows/build-apk.yml\`，不用自己写。

---

## 办法二：Android Studio（本地编译）

1. 装 [Android Studio](https://developer.android.com/studio)（自带 JDK 与 SDK）
2. \`File → Open\`，选中这个 \`android\` 目录
3. 等它自动同步 Gradle（第一次要下载依赖，需要网络）
4. \`Build → Build Bundle(s) / APK(s) → Build APK(s)\`
5. 产物在 \`app/build/outputs/apk/release/app-release.apk\`

命令行也行：

\`\`\`bash
cd android
./gradlew assembleRelease        # Windows 用 gradlew.bat
\`\`\`

---

## 办法三：不想编译？

直接用打包好的 \`public/offline.html\` 也行 —— 把它传到手机，用浏览器打开，
一样是离线可用 + 能同步，只是没有独立图标和原生外壳。

---

## 装到手机之后

1. 打开 Slowly，底部 **🔗 连接** → **填写电脑地址**
   电脑上的 Slowly 在「连接」页会显示地址，形如 \`192.168.1.5:8787\`，填进去就行
2. 点 **立即同步** —— 手机和电脑的数据会合并成同一份（谁也不覆盖谁）
3. 之后每次打开 App、或回到前台，都会自动试着同步一次；不在同一 WiFi 时它不会报错，
   照样能记，等回到 WiFi 再同步

> 手机和电脑必须在**同一个 WiFi**。第一次连接如果失败，多半是电脑防火墙没放行 ——
> 在电脑上右键 \`让手机能连上（管理员运行）.cmd\` 以管理员身份运行一次。

---

## 关于安全

为了能连电脑上的局域网地址，App 允许明文 HTTP（\`usesCleartextTraffic\`）。
数据只在你自己的局域网里传输，Slowly 服务器也只监听你自己的电脑。
如果你对此介意，可以在电脑上给 Slowly 配置 HTTPS 反向代理后把地址改成 https。
`));

  /* GitHub Actions 工作流。
     GitHub 只认仓库根目录的 .github/workflows/，所以两个位置都写一份：
       - .github/workflows/          Slowly 文件夹就是仓库根目录时用这份
       - android/.github/workflows/  只把 android 的内容当仓库时用这份
     工作流自己会判断工程在根目录还是 Slowly/ 下。 */
  /* GitHub Actions 工作流。
     GitHub 只执行仓库根目录 .github/workflows/ 下的文件，所以只生成这一份。
     这份内容由仓库里的 .github/workflows/build-apk.yml 同步而来 ——
     改工作流时请同时更新这里，否则下次生成会把改动覆盖掉。 */
  const workflow = `name: Build Slowly APK

# 手机端的安卓安装包。三种触发方式：
#   1. 在仓库的 Actions 页面点「Run workflow」手动触发
#   2. 推送到 main 且改动涉及 android/、public/、tools/ 时自动触发
#   3. 改到这个工作流文件本身时
#
# 注意 "on" 必须带引号：YAML 1.1 会把裸写的 on 解析成布尔值 true，
# 而 GitHub 读的是字符串键 "on"。不加引号时整个触发器块失效 ——
# 现象是 Actions 里能看到这个工作流、却永远不会运行，而且 API 会回
# "Workflow does not have 'workflow_dispatch' trigger"。
# 工作流名字退化成文件路径也是同一个原因。
"on":
  workflow_dispatch:
  push:
    paths:
      - 'android/**'
      - 'Slowly/android/**'
      - 'public/**'
      - 'Slowly/public/**'
      - 'tools/**'
      - 'Slowly/tools/**'
      - '.github/workflows/**'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # 工程目录可能在根，也可能在 Slowly/ 下，自动判断
      - name: 定位工程目录
        id: locate
        run: |
          set -e
          if [ -f android/app/build.gradle ]; then
            echo "root=." >> "$GITHUB_OUTPUT"
          elif [ -f Slowly/android/app/build.gradle ]; then
            echo "root=Slowly" >> "$GITHUB_OUTPUT"
          else
            echo "没有找到 android/app/build.gradle" >&2
            exit 1
          fi

      - name: 安装 JDK 17
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'

      # 缓存 Android SDK：首次要下几百 MB，缓存后后续构建快得多
      - name: 缓存 Android SDK
        uses: actions/cache@v4
        with:
          path: /usr/local/lib/android/sdk
          key: android-sdk-\${{ runner.os }}-platform34-bt34

      # 不用 android-actions/setup-android：实测它会卡在交互式的许可确认上
      # （日志里全是 "Accept? (y/N):" 却没有输入），导致这一步直接失败。
      # 这里改成自己装命令行工具，并用 yes 非交互式接受全部许可。
      - name: 安装 Android SDK（非交互）
        run: |
          set -e
          SDK_ROOT=/usr/local/lib/android/sdk
          if [ ! -x "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]; then
            mkdir -p "$SDK_ROOT/cmdline-tools"
            cd /tmp
            curl -fsSL -o tools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
            unzip -q tools.zip -d "$SDK_ROOT/cmdline-tools"
            mv "$SDK_ROOT/cmdline-tools/cmdline-tools" "$SDK_ROOT/cmdline-tools/latest"
          fi
          export ANDROID_HOME="$SDK_ROOT"
          export ANDROID_SDK_ROOT="$SDK_ROOT"
          echo "ANDROID_HOME=$SDK_ROOT" >> "$GITHUB_ENV"
          echo "ANDROID_SDK_ROOT=$SDK_ROOT" >> "$GITHUB_ENV"
          echo "$SDK_ROOT/cmdline-tools/latest/bin" >> "$GITHUB_PATH"
          echo "$SDK_ROOT/platform-tools" >> "$GITHUB_PATH"
          yes | "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" --licenses > /dev/null 2>&1 || true
          "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" "platforms;android-34" "build-tools;34.0.0" "platform-tools"

      # 固定 Gradle 版本：AGP 8.5.2 需要 Gradle 8.7+。
      # 不能用 runner 上碰巧预装的那一版，否则版本一变整个构建就挂。
      - name: 安装并固定 Gradle 8.7
        uses: gradle/actions/setup-gradle@v3
        with:
          gradle-version: '8.7'

      - name: 安装 Node（用来重新生成离线界面）
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      # 保证打进 APK 的 index.html 与 public/ 里的最新代码一致
      - name: 重新生成离线界面
        run: node "\${{ steps.locate.outputs.root }}/tools/build-offline.mjs"

      # 依赖诊断：直接打印 classpath 上的每个文件。
      # 之前的依赖树 grep 一直只能抓到命令回显，看不出真实来源 —— 这次让 Gradle
      # 把**解析结果**列出来，谁在 classpath 上一目了然。
      # 步骤名用纯 ASCII —— 实测带中文的步骤名会被 GitHub 记成 skipped。
      - name: Dependency diagnosis
        working-directory: \${{ steps.locate.outputs.root }}/android
        run: |
          cat >> app/build.gradle <<'EOF'

// ↓↓↓ 临时诊断任务，由 CI 的 Dependency diagnosis 步骤调用 ↓↓↓
tasks.register('printClasspath') {
    doLast {
        def cfg = configurations.findByName('releaseRuntimeClasspath')
        if (cfg == null) { println 'NO releaseRuntimeClasspath'; return }
        println '=== releaseRuntimeClasspath 上的文件（共 ' + cfg.files.size() + ' 个）==='
        cfg.files.sort { it.name }.each { println '  ' + it.name + '   <-  ' + it.absolutePath }
    }
}
EOF
          gradle :app:printClasspath --no-daemon -q 2>&1 | head -60 || true
          echo ""
          echo "=== 工程里有没有源码/目录带进 kotlin ==="
          ls -la libs 2>/dev/null || echo "(没有 libs 目录)"

      - name: Build APK (release)
        working-directory: \${{ steps.locate.outputs.root }}/android
        run: gradle assembleRelease --no-daemon --stacktrace

      - name: Show artifacts
        run: find "\${{ steps.locate.outputs.root }}/android/app/build/outputs/apk" -name '*.apk' -exec ls -lh {} \\;

      - name: Upload APK
        uses: actions/upload-artifact@v4
        with:
          name: slowly-apk
          path: \${{ steps.locate.outputs.root }}/android/app/build/outputs/apk/release/*.apk
          if-no-files-found: error
`;
  /* 只写仓库根目录这一份 —— GitHub 只执行 .github/workflows/ 下的工作流，
     放在 android/.github/ 下永远不会运行，只会让人以为有两条构建途径。 */
  made.push(writeFile(".github/workflows/build-apk.yml", workflow));

  /* Gradle 工程文件 */
  made.push(writeFile("android/settings.gradle", `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "Slowly"
include ':app'
`));

  made.push(writeFile("android/build.gradle", `// 顶层构建脚本
plugins {
    id 'com.android.application' version '8.5.2' apply false
}
`));

  made.push(writeFile("android/gradle.properties", `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
android.nonTransitiveRClass=true
`));

  made.push(writeFile("android/app/build.gradle", `plugins {
    id 'com.android.application'
}

android {
    namespace 'com.slowly.app'
    compileSdk 34

    defaultConfig {
        applicationId "com.slowly.app"
        minSdk 24
        targetSdk 34
        versionCode 1
        versionName "1.0.0"
        resValue "string", "app_name", "Slowly"
    }

    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
            /* 自己装着用，不打算上架 —— 用 debug 签名省掉配密钥库。
               代价：不能上架，也不能覆盖安装用正式签名的版本。 */
            signingConfig signingConfigs.debug
        }
    }

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
}

/*
 * 刻意不依赖任何 AndroidX 库。
 *
 * 一开始用的是 appcompat + webkit，结果 CI 反复失败在重复类检查：
 *   Duplicate class kotlin.collections.jdk8.CollectionsJDK8Kt
 *     kotlin-stdlib-1.8.22.jar        （androidx.webkit 带进来的）
 *     kotlin-stdlib-jdk8-1.6.21.jar   （androidx.lifecycle 带进来的）
 * dependencyInsight 查出的链条是：
 *   kotlin-stdlib-jdk8:1.6.21
 *   +--- kotlinx-coroutines-android:1.6.4
 *        +--- androidx.lifecycle:lifecycle-common:2.6.2
 *             +--- androidx.appcompat:appcompat:1.7.0
 * force / eachDependency / 各种 exclude 都试过，都没能让它消失。
 *
 * 而这个壳工程本身就是个 WebView 容器，一行 Kotlin 都没有，界面全在
 * assets/index.html 里：appcompat 只用到 AppCompatActivity 一个基类，
 * webkit 完全没用到（WebView 的 API 都来自 Android 框架本身）。
 * 两者都不需要，去掉之后依赖图里不再有任何 Kotlin 标准库，
 * 重复类的问题从根上不存在。
 *
 * 配套改动：MainActivity 继承框架的 Activity，主题换成
 * @android:style/Theme.DeviceDefault.Light.NoActionBar。
 * 本项目 minSdk 是 24，失去 AppCompat 垫片的代价很小。
 */
dependencies {
}
`));

  made.push(writeFile("android/app/proguard-rules.pro", `# Slowly 的 WebView 壳不需要额外混淆规则
-keepclassmembers class com.slowly.app.MainActivity$Bridge {
    public *;
}
`));

  /* AndroidManifest */
  made.push(writeFile("android/app/src/main/AndroidManifest.xml", `<?xml version="1.0" encoding="utf-8"?>
<!-- package 与 build.gradle 里的 namespace 保持一致：
     新版 AGP 以 namespace 为准，但保留 package 能让更多在线编译服务也认得 -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.slowly.app">

    <!-- 连电脑上的 Slowly 需要联网；不联网也能正常记录 -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.VIBRATE" />

    <application
        android:allowBackup="true"
        android:fullBackupContent="true"
        android:icon="@mipmap/ic_launcher"
        android:roundIcon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:usesCleartextTraffic="true"
        android:theme="@style/Theme.Slowly">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:configChanges="orientation|screenSize|keyboardHidden|uiMode"
            android:windowSoftInputMode="adjustResize"
            android:label="@string/app_name">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`));

  /* MainActivity：WebView 壳 + 给网页用的原生小能力 */
  made.push(writeFile(pkgDir + "/MainActivity.java", `package com.slowly.app;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * Slowly 的安卓外壳。
 * 界面是打包在 assets/index.html 里的离线版：不连电脑也能记，
 * 连上电脑点一次「立即同步」就把两边合并。
 *
 * 继承框架自带的 Activity —— 本项目不依赖 AppCompat，
 * 原因见 app/build.gradle 里的说明。
 */
public class MainActivity extends Activity {

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        web = findViewById(R.id.web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage：数据就存在这里
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setBackgroundColor(0xFFF7F2EA);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "SlowlyNative");

        // 站内跳转一律留在 App 内，外部链接交给系统浏览器
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("file://") || url.startsWith("about:")) return false;
                try {
                    startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,
                            android.net.Uri.parse(url)));
                } catch (Exception ignored) { }
                return true;
            }
        });

        web.loadUrl("file:///android_asset/index.html");
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    /** 网页里通过 window.SlowlyNative 调用，浏览器里访问不到这些方法也不影响 */
    public class Bridge {
        @JavascriptInterface
        public void vibrate(int ms) {
            try {
                Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
                if (v == null || !v.hasVibrator()) return;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    v.vibrate(VibrationEffect.createOneShot(Math.max(1, ms), 40));
                } else {
                    v.vibrate(Math.max(1, ms));
                }
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public void toast(final String text) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, text, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }
    }
}
`));

  /* 布局与资源 */
  made.push(writeFile(res + "/layout/activity_main.xml", `<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="#F7F2EA"
    android:fitsSystemWindows="true">

    <WebView
        android:id="@+id/web"
        android:layout_width="match_parent"
        android:layout_height="match_parent" />
</FrameLayout>
`));

  made.push(writeFile(res + "/values/strings.xml", `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Slowly</string>
</resources>
`));

  made.push(writeFile(res + "/values/colors.xml", `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="slowly_linen">#F7F2EA</color>
    <color name="slowly_clay">#C96A49</color>
</resources>
`));

  made.push(writeFile(res + "/values/themes.xml", `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.Slowly" parent="@android:style/Theme.DeviceDefault.Light.NoActionBar">
        <item name="android:windowBackground">@color/slowly_linen</item>
        <item name="android:statusBarColor">@color/slowly_linen</item>
        <item name="android:navigationBarColor">@color/slowly_linen</item>
        <item name="android:windowLightStatusBar">true</item>
    </style>
</resources>
`));

  /* 把离线界面放进 assets */
  const offline = read(path.join(PUB, "offline.html"));
  made.push(writeFile("android/app/src/main/assets/index.html", offline));

  /* 图标：把 256 的 PNG 复制成各个密度（简单可靠，APK 会大一点点） */
  const png = fs.readFileSync(path.join(ASSETS, "slowly-256.png"));
  const densities = ["mipmap-mdpi", "mipmap-hdpi", "mipmap-xhdpi", "mipmap-xxhdpi", "mipmap-xxxhdpi"];
  for (const d of densities) {
    const p = path.join(ROOT, "android/app/src/main/res", d, "ic_launcher.png");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, png);
    made.push(p);
  }

  return made;
}

/* ---------------- 3. 生成可发布的静态站点 docs/ ----------------
   任何人打开网址就能用，数据各存各的设备，不需要任何服务器。
   全部用相对路径，放在仓库子目录（GitHub Pages 的 /仓库名/）下也能正常工作。 */
function buildStaticSite() {
  const outDir = path.join(ROOT, "docs");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });

  const appJs = read(path.join(PUB, "app.js"));
  const syncJs = read(path.join(PUB, "sync.js"));
  const html = read(path.join(PUB, "index.html"));

  /* 1) 主页面：把样式与两段脚本内联，去掉所有指向服务器的绝对路径 */
  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1];
  if (!style) throw new Error("index.html 里没有找到 <style> 块");

  const headStart = html.indexOf("<head>");
  const headEnd = html.indexOf("</head>");
  const newHead = [
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="theme-color" content="#f7f2ea">',
    '<meta name="description" content="Slowly · 写下今天的目标，记下完成的事，也记得对自己好一点。数据只存在你自己的设备上。">',
    /* iOS 全屏：加到主屏后没有地址栏 */
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
    '<meta name="apple-mobile-web-app-title" content="Slowly">',
    '<meta name="format-detection" content="telephone=no">',
    "<title>Slowly · 慢慢来，比较快</title>",
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="icon" href="assets/slowly-icon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="assets/slowly-256.png">',
    "<style>" + style + "</style>",
    "</head>"
  ].join("\n");
  let page = html.slice(0, headStart) + newHead + html.slice(headEnd + "</head>".length);
  page = page.replace(/<script src="\/app\.js"><\/script>/, "");
  page = page.replace("</body>",
    "<script>" + syncJs + "</script>\n<script>" + appJs + "</script>\n</body>");
  /* 静态版：告诉脚本这是"装在设备上、没有服务器"的模式 */
  page = page.replace("<body>", '<body data-slowly-mode="static">');
  fs.writeFileSync(path.join(outDir, "index.html"), page, "utf8");

  /* 2) manifest：相对路径，加到主屏后全屏运行 */
  fs.writeFileSync(path.join(outDir, "manifest.webmanifest"), JSON.stringify({
    name: "Slowly · 慢慢来，比较快",
    short_name: "Slowly",
    description: "写下今天的目标，记下完成的事，也记得对自己好一点。数据只存在你自己的设备上。",
    lang: "zh-CN",
    start_url: "./",
    scope: "./",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f7f2ea",
    theme_color: "#f7f2ea",
    icons: [
      { src: "assets/slowly-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "assets/slowly-256.png", sizes: "256x256", type: "image/png", purpose: "any" },
      { src: "assets/slowly-256.png", sizes: "256x256", type: "image/png", purpose: "maskable" },
      { src: "assets/slowly-32.png", sizes: "32x32", type: "image/png" }
    ]
  }, null, 2) + "\n", "utf8");

  /* 3) Service Worker：相对路径缓存，断网也能打开 */
  fs.writeFileSync(path.join(outDir, "sw.js"), `/* Slowly · 离线外壳（静态版） */
const CACHE = "slowly-static-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest",
  "./assets/slowly-icon.svg", "./assets/slowly-256.png", "./assets/slowly-32.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;   // 同步请求（别的地址）不拦
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("./index.html")))
  );
});
`, "utf8");

  /* 4) 图标 */
  for (const f of ["slowly-icon.svg", "slowly-256.png", "slowly-32.png", "slowly.ico"]) {
    fs.copyFileSync(path.join(ASSETS, f), path.join(outDir, "assets", f));
  }

  /* 5) 站点配置：关掉 Jekyll，让 .webmanifest 等文件按原样发布 */
  fs.writeFileSync(path.join(outDir, ".nojekyll"), "", "utf8");

  /* 6) 给访问者看的一句话说明（不打扰，只在需要时展开） */
  fs.writeFileSync(path.join(outDir, "README.md"), `# Slowly 网站文件

这个目录就是可以直接发布的网站。**不要手改这里的内容** ——
它由 \`node tools/build-offline.mjs\` 生成，改了会在下次打包时被覆盖。

## 发布到 GitHub Pages

1. 把整个 Slowly 文件夹 push 到 GitHub
2. 仓库 → Settings → Pages
3. Source 选 **Deploy from a branch**，分支选 \`main\`，目录选 **/docs**
4. 保存后等一两分钟，网址形如 \`https://你的用户名.github.io/仓库名/\`

之后每次改完代码，运行一次 \`node tools/build-offline.mjs\` 再 push 即可。

## 这个网站是怎么工作的

- 每个人打开网址就是一个属于自己的 Slowly，**数据存在自己的浏览器里**，不联网、不上传
- 手机可以「添加到主屏幕」，变成一个全屏应用
- 想换设备带走数据：用里面的「导出备份 / 导入备份」
- 如果你自己也跑着 Slowly 的本地服务器，可以在「连接」页填上那台电脑的地址做同步
`, "utf8");

  return { dir: outDir, size: Buffer.byteLength(page) };
}

/* ---------------- 执行 ---------------- */
log("");
log("  Slowly · 打包");
log("  ─────────────────────────────────────────────");
/* 顺序很重要：先生成离线单文件，再把它复制进安卓工程，
   否则 assets 里会是上一次的版本 */
const off = buildOfflineHtml();
log("  离线单文件： public/offline.html（" + Math.round(off.size / 1024) + " KB）");
const site = buildStaticSite();
log("  可发布站点： docs/（主页面 " + Math.round(site.size / 1024) + " KB，可直接放 GitHub Pages）");
const made = buildAndroid();
log("  安卓工程：   android/（共 " + made.length + " 个文件）");

/* 自检：assets 里的页面必须与刚生成的离线版逐字节一致 */
const assetsCopy = path.join(ROOT, "android", "app", "src", "main", "assets", "index.html");
const same = fs.readFileSync(assetsCopy, "utf8") === fs.readFileSync(off.out, "utf8");
log(same ? "  自检通过：   安卓工程里的离线页面与最新版本一致"
         : "  注意：       安卓工程里的页面与离线版不一致，请重新运行本脚本");
log("");
log("  下一步：");
log("    给所有人用   → 把 Slowly 文件夹 push 到 GitHub，Pages 目录选 /docs");
log("    手机上先试   → 电脑端「连接」页扫码下载独立版");
log("    想要真 App   → 看 android/BUILD.md（GitHub Actions 一键编译）");
log("");
if (!same) process.exitCode = 1;
