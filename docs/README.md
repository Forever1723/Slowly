# Slowly 网站文件

这个目录就是可以直接发布的网站。**不要手改这里的内容** ——
它由 `node tools/build-offline.mjs` 生成，改了会在下次打包时被覆盖。

## 发布到 GitHub Pages

1. 把整个 Slowly 文件夹 push 到 GitHub
2. 仓库 → Settings → Pages
3. Source 选 **Deploy from a branch**，分支选 `main`，目录选 **/docs**
4. 保存后等一两分钟，网址形如 `https://你的用户名.github.io/仓库名/`

之后每次改完代码，运行一次 `node tools/build-offline.mjs` 再 push 即可。

## 这个网站是怎么工作的

- 每个人打开网址就是一个属于自己的 Slowly，**数据存在自己的浏览器里**，不联网、不上传
- 手机可以「添加到主屏幕」，变成一个全屏应用
- 想换设备带走数据：用里面的「导出备份 / 导入备份」
- 如果你自己也跑着 Slowly 的本地服务器，可以在「连接」页填上那台电脑的地址做同步
