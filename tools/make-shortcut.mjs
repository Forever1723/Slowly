/* =============================================================
   在桌面创建 Slowly 快捷方式（Windows .lnk，由 JS 直接写二进制，零依赖）
   用法：node tools/make-shortcut.mjs [--desktop <目录>] [--all]
   ============================================================= */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const argVal = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/* ---------- 可执行文件路径（优先用 node.exe 直接跑服务器，避免依赖 .cmd 关联） ---------- */
function nodeExe() {
  return process.execPath;
}

/* ---------- 极简 Shell Link (.lnk) 二进制写入 ---------- */
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; }

/* .lnk 结构（按 [MS-SHLLINK]）
   ShellLinkHeader(0x4C) + ExtraData[] + LinkTargetIDList + LinkInfo + StringData[]
   LinkInfo 采用 VolumeIDAndLocalBasePath 形式，
   LocalBasePath 放完整路径、CommonPathSuffix 省略（偏移写 0）。 */
function buildLnk({ target, args, workdir, icon, iconIndex = 0, description, name }) {
  /* IDListSize(2) = ItemIDList 内容长度；
     内容是「我的电脑」+「C:\」两个 ItemID，最后接 TerminatorID(0x0000)。
     ItemID 结构：Size(2) + 数据；数据本身已经以 UTF-16 的 0 结尾。 */
  const itemRoot = Buffer.from([0x1f, 0x50]);            // 我的电脑：Size=0x001F(31) + CLSID 占位
  const itemRootData = Buffer.alloc(29);                 // 31 - 2 = 29 字节数据
  const itemDrive = Buffer.concat([
    Buffer.from([0x2f, 0x43, 0x3a, 0x5c, 0x00, 0x00]),  // "/C:\" + 结尾 0
    Buffer.alloc(19)                                     // 补到 25 字节（Size=0x0019）
  ]);
  const itemIdList = Buffer.concat([itemRoot, itemRootData, itemDrive, Buffer.from([0x00, 0x00])]);
  const idListBlock = Buffer.concat([u16(itemIdList.length), itemIdList]);

  const strData = (s) => {
    const data = Buffer.from(s || "", "utf16le");
    return Buffer.concat([u16((s || "").length), data]);
  };

  const needsIcon = !!icon;
  const flags = 0x00000001 | 0x00000002 | 0x00000004 | (needsIcon ? 0x00000040 : 0) | 0x00000080;

  /* ShellLinkHeader 偏移必须与规范严格对齐：
     0x00 Size | 0x04 CLSID(16) | 0x14 LinkFlags | 0x18 FileAttributes
     0x1C CreationTime | 0x24 AccessTime | 0x2C WriteTime
     0x34 FileSize | 0x38 IconIndex | 0x3C ShowCommand | 0x40 HotKey | 0x42 Reserved */
  const header = Buffer.concat([
    u32(0x0000004c),                                              // 0x00 Size
    Buffer.from("0114020000000000c000000000000046", "hex"),        // 0x04 LinkCLSID
    u32(flags),                                                   // 0x14 LinkFlags
    u32(0x00000020),                                              // 0x18 FileAttributes = ARCHIVE
    u32(0), u32(0),                                               // 0x1C CreationTime
    u32(0), u32(0),                                               // 0x24 AccessTime
    u32(0), u32(0),                                               // 0x2C WriteTime
    u32(0),                                                       // 0x34 FileSize
    u32(iconIndex),                                               // 0x38 IconIndex
    u32(1),                                                       // 0x3C ShowCommand = SW_SHOWNORMAL
    u16(0),                                                       // 0x40 HotKey
    u16(0),                                                       // 0x42 Reserved1（共 2 字节）
    u32(0),                                                       // 0x44 Reserved2
    u32(0)                                                        // 0x48 Reserved3 → 头部共 76 字节
  ]);

  /* ExtraData：每个块 = BlockSize(4 字节，只有低 16 位有效) + BlockType(4 字节) + 数据
     BlockSize 不计自身的 8 字节头。定长块的数据是 520 字节缓冲。 */
  const workBlock = Buffer.alloc(4 + 4 + 520);
  workBlock.writeUInt32LE(520, 0);                                // 0x0208
  workBlock.writeUInt32LE(0xa0000005, 4);
  Buffer.from(workdir || "", "utf16le").copy(workBlock, 8);

  const argStr = Buffer.from(args || "", "utf16le");
  const argBlock = Buffer.alloc(4 + 4 + argStr.length);
  argBlock.writeUInt32LE(argStr.length, 0);
  argBlock.writeUInt32LE(0xa0000002, 4);
  argStr.copy(argBlock, 8);

  const envBlock = Buffer.alloc(4 + 4 + 520);
  envBlock.writeUInt32LE(520, 0);
  envBlock.writeUInt32LE(0xa0000001, 4);
  Buffer.from(workdir || "", "utf16le").copy(envBlock, 8);

  const iconBlock = needsIcon
    ? (() => {
        const s = Buffer.from(icon, "utf16le");
        const buf = Buffer.alloc(4 + 4 + s.length);
        buf.writeUInt32LE(s.length, 0);
        buf.writeUInt32LE(0xa0000007, 4);
        s.copy(buf, 8);
        return buf;
      })()
    : Buffer.alloc(0);

  /* 末尾 4 字节 0 表示 ExtraData 结束 */
  const extraData = Buffer.concat([workBlock, argBlock, envBlock, iconBlock, u32(0)]);

  /* LinkInfo：指向真实的目标文件
     LocalBasePath 是 NUL 结尾的 UTF-16 字符串 —— 结尾必须是两个 0 字节 */
  const localPath = Buffer.from(target + "\0", "utf16le");
  const linkInfoSize = 0x1c + localPath.length;
  const linkInfoHeader = Buffer.alloc(0x1c);
  linkInfoHeader.writeUInt32LE(linkInfoSize, 0);                  // LinkInfoSize
  linkInfoHeader.writeUInt32LE(0x1c, 4);                          // LinkInfoHeaderSize
  linkInfoHeader.writeUInt32LE(0x00000001, 8);                    // VolumeIDAndLocalBasePath
  linkInfoHeader.writeUInt32LE(0, 12);                            // VolumeIDOffset（0=不带卷信息）
  linkInfoHeader.writeUInt32LE(0x1c, 16);                         // LocalBasePathOffset
  linkInfoHeader.writeUInt32LE(0, 20);                            // CommonNetworkRelativeLinkOffset
  linkInfoHeader.writeUInt32LE(0, 24);                            // CommonPathSuffixOffset（0=省略）
  const linkInfo = Buffer.concat([linkInfoHeader, localPath]);

  const nameStr = strData(name || description || "");
  const iconStr = needsIcon ? strData(icon) : Buffer.alloc(0);

  return Buffer.concat([header, extraData, idListBlock, linkInfo, nameStr, iconStr]);
}

export { buildLnk };

/* ---------- 主流程：只有直接运行本文件时才执行（被 import 时不动作） ---------- */
if (import.meta.main) {
  const desktopDirs = () => {
    const home = os.homedir();
    const candidates = [
      path.join(home, "Desktop"),
      path.join(home, "OneDrive", "Desktop"),
      path.join(home, "OneDrive", "桌面"),
      path.join(home, "桌面")
    ];
    return candidates.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  };

  const wanted = argVal("--desktop", "");
  const outDirs = wanted ? [wanted] : desktopDirs();
  if (!outDirs.length) {
    console.log("没有找到桌面目录。可以手动指定：node tools/make-shortcut.mjs --desktop \"C:\\Users\\你\\Desktop\"");
    process.exit(1);
  }

  const target = nodeExe();
  const launcher = path.join(ROOT, "server.mjs");
  const icon = path.join(ROOT, "assets", "slowly.ico");
  const args = '"' + launcher + '" --app';

  let made = 0;
  for (const dir of outDirs) {
    const lnk = path.join(dir, "Slowly.lnk");
    try {
      const buf = buildLnk({
        target, args, workdir: ROOT, icon, iconIndex: 0,
        description: "Slowly · 慢慢来，比较快", name: "Slowly"
      });
      fs.writeFileSync(lnk, buf);
      made++;
      console.log("已创建：" + lnk + "（" + buf.length + " 字节）");
    } catch (e) {
      console.log("创建失败：" + lnk + " -> " + e.message);
    }
  }
  console.log(made ? "\n完成。桌面上的 Slowly 图标现在可以直接双击。" : "\n没有创建任何快捷方式。");
}

/* 被当作模块 import 时（测试用）不执行上面的创建流程 */
export const __moduleLoaded = true;
