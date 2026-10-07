# 把 Slowly 编译成安卓 App

这个目录是一个**完整的安卓工程**，界面用的是已经打包好的离线版（`app/src/main/assets/index.html`），
装到手机上以后不连电脑也能用，连上电脑点一次「立即同步」就会合并数据。

你在这台电脑上编不了（没有 Java / Android SDK / 网络），需要换一台有网、有 Android Studio 的电脑，
或者用 GitHub Actions 云端编译。三种办法任选：

---

## 办法一：GitHub Actions（不用装任何东西，推荐）

1. 注册/登录 GitHub，新建一个仓库（私有也行）
2. 把整个 `Slowly` 文件夹 push 上去
3. 仓库里点 **Actions** → 选 **Build Slowly APK** → **Run workflow**
4. 等 3~5 分钟，在该次运行的 **Artifacts** 里下载 `slowly-debug-apk`
5. 解压得到 `app-debug.apk`，发到手机上安装（首次要允许「安装未知来源应用」）

工作流文件已经放在 `.github/workflows/build-apk.yml`，不用自己写。

---

## 办法二：Android Studio（本地编译）

1. 装 [Android Studio](https://developer.android.com/studio)（自带 JDK 与 SDK）
2. `File → Open`，选中这个 `android` 目录
3. 等它自动同步 Gradle（第一次要下载依赖，需要网络）
4. `Build → Build Bundle(s) / APK(s) → Build APK(s)`
5. 产物在 `app/build/outputs/apk/debug/app-debug.apk`

命令行也行：

```bash
cd android
./gradlew assembleDebug        # Windows 用 gradlew.bat
```

---

## 办法三：不想编译？

直接用打包好的 `public/offline.html` 也行 —— 把它传到手机，用浏览器打开，
一样是离线可用 + 能同步，只是没有独立图标和原生外壳。

---

## 装到手机之后

1. 打开 Slowly，底部 **🔗 连接** → **填写电脑地址**
   电脑上的 Slowly 在「连接」页会显示地址，形如 `192.168.1.5:8787`，填进去就行
2. 点 **立即同步** —— 手机和电脑的数据会合并成同一份（谁也不覆盖谁）
3. 之后每次打开 App、或回到前台，都会自动试着同步一次；不在同一 WiFi 时它不会报错，
   照样能记，等回到 WiFi 再同步

> 手机和电脑必须在**同一个 WiFi**。第一次连接如果失败，多半是电脑防火墙没放行 ——
> 在电脑上右键 `让手机能连上（管理员运行）.cmd` 以管理员身份运行一次。

---

## 关于安全

为了能连电脑上的局域网地址，App 允许明文 HTTP（`usesCleartextTraffic`）。
数据只在你自己的局域网里传输，Slowly 服务器也只监听你自己的电脑。
如果你对此介意，可以在电脑上给 Slowly 配置 HTTPS 反向代理后把地址改成 https。
