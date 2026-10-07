# 发布到网上，让所有人打开就能用

Slowly 已经准备好了：`docs/` 目录就是网站本身。它不需要服务器、不需要数据库、不需要花钱 ——
**每个人打开网址就是一个属于自己的 Slowly，数据存在自己的浏览器里，不联网、不上传。**

---

## 用 GitHub Pages 发布（免费，5 分钟）

### 1. 建仓库并上传

1. 打开 <https://github.com/new>，建一个仓库（比如叫 `slowly`）
   - Public（公开）或 Private（私有）都可以，Pages 两种都支持
2. 把这个 `Slowly` 文件夹里的内容上传上去（网页版上传、GitHub Desktop、或 git 命令都行）

```bash
cd Slowly
git init
git add .
git commit -m "Slowly"
git branch -M main
git remote add origin https://github.com/你的用户名/slowly.git
git push -u origin main
```

### 2. 开启 Pages

仓库页面 → **Settings** → 左侧 **Pages**：

- **Source** 选 `Deploy from a branch`
- **Branch** 选 `main`，目录选 **`/docs`**
- 点 **Save**

### 3. 等一两分钟

网址形如：

```
https://你的用户名.github.io/slowly/
```

把这个链接发给任何人，他们打开就能用。

> 如果是私有仓库，Pages 需要 GitHub Pro 才能公开访问；想让所有人用，建议用 Public 仓库。

---

## 别人打开后会看到什么

- 一个可以直接开始写目标的 Slowly，**不需要注册、不需要登录、不需要装任何东西**
- 数据存在他自己设备的浏览器里；页面里到处都写清楚了这一点
- 手机浏览器打开后，「🔗 连接」页会引导他**添加到主屏幕** —— 之后就是全屏应用，有图标、没地址栏
- 断网也能打开（Service Worker 缓存了界面）
- 想换手机/电脑带走数据：用「导出备份 / 导入备份」

**每个人的数据是彼此隔离的**：没有服务器，也就没有"看到别人数据"这回事。

---

## 改完代码怎么更新

```bash
node tools/build-offline.mjs     # 重新生成 docs/ 与单文件版
git add -A && git commit -m "update" && git push
```

GitHub Pages 会自动重新发布（等一两分钟）。

---

## 这些内容是怎么生成的

`docs/` 里的东西**不要手改**，它由 `tools/build-offline.mjs` 从 `public/` 生成：

| 文件 | 说明 |
|---|---|
| `docs/index.html` | 单文件应用：样式与脚本全部内联，无外部依赖 |
| `docs/manifest.webmanifest` | 加到主屏后全屏运行，相对路径（子目录也能装） |
| `docs/sw.js` | 离线外壳，断网也能打开 |
| `docs/assets/*` | 图标 |
| `docs/.nojekyll` | 让 GitHub Pages 原样发布所有文件 |

---

## 关于"多设备同步"（可选，不是必须）

静态站点本身**不做云同步** —— 这是刻意的：一旦上云就要有服务器、账号和数据保管责任。

如果使用者自己也在电脑上跑着 Slowly 的本地服务器（也就是这个项目里的 `server.mjs`），
可以在「🔗 连接」页填上那台电脑的地址，把它当作自己私人的同步中转站。
两台设备会按条合并数据，冲突取更新的那一份，删除会留痕迹、不会被复活。

---

## 想做成手机 App 安装包？

`android/` 里是一份完整的安卓工程（WebView 外壳 + 已经打包好的离线界面 + 图标），
用 GitHub Actions 云端编译 3~5 分钟就能得到 APK，步骤见 [`../android/BUILD.md`](../android/BUILD.md)。

---

## 其他静态托管也行

`docs/` 是纯静态文件，放到哪都能用：

- **Vercel**：导入仓库，Root Directory 填 `docs`，Framework 选 Other
- **Netlify**：拖拽 `docs` 文件夹到部署面板即可
- **Cloudflare Pages**：构建输出目录填 `docs`
- **自己的服务器**：把 `docs/` 里的文件拷到网站根目录

唯一要注意的是：**必须用 HTTPS 或 localhost**，否则浏览器不允许"添加到主屏幕"和离线缓存。
