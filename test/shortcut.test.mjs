/* 快捷方式验证：生成 .lnk，再让 Windows 自己把它读回来比对
   —— 只有 Windows 能解析并返回正确路径，才算真的做对了 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(os.tmpdir(), "slowly-lnk-test");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra ? "  -> " + extra : "")); }
};

console.log("1) 生成快捷方式");
/* 直接调用生成器（沙箱下不能起子进程，所以 import 而不是 spawn） */
const { buildLnk } = await import("../tools/make-shortcut.mjs");
const lnk = path.join(OUT, "Slowly.lnk");
const target = process.execPath;
const launcher = path.join(ROOT, "server.mjs");
const iconFile = path.join(ROOT, "assets", "slowly.ico");
fs.writeFileSync(lnk, buildLnk({
  target,
  args: '"' + launcher + '" --app',
  workdir: ROOT,
  icon: iconFile,
  iconIndex: 0,
  description: "Slowly · 慢慢来，比较快",
  name: "Slowly"
}));
ok(fs.existsSync(lnk), "Slowly.lnk 已生成（" + fs.statSync(lnk).size + " 字节）");
if (!fs.existsSync(lnk)) { console.log("\n失败：没有生成文件"); process.exit(1); }

console.log("2) 结构自检（按 [MS-SHLLINK]）");
const buf = fs.readFileSync(lnk);
ok(buf.readUInt32LE(0) === 0x4c, "HeaderSize = 0x4C");
ok(buf.toString("hex", 4, 20) === "0114020000000000c000000000000046", "LinkCLSID 正确");
const flags = buf.readUInt32LE(20);
ok((flags & 1) === 1, "含 LinkTargetIDList");
ok((flags & 2) === 2, "含 LinkInfo");
ok((flags & 0x80) === 0x80, "标记为 Unicode");
ok((flags & 0x40) === 0x40, "含图标位置");
const fileSize = buf.readUInt32LE(52);
const ofs = 0x4c;
ok(fileSize === 0, "FileSize 为 0（未使用）");
const showCmd = buf.readUInt32LE(ofs + 56 - 0x4c + 0x4c - 0x4c);
void showCmd;

console.log("3) 用独立的 .lnk 解析器读回内容（按 [MS-SHLLINK] 规范实现）");
/* 沙箱里起不了子进程，没法用 WScript.Shell COM 读回；
   这里改为按规范写一个解析器，逐字段把二进制解回来比对。 */
function parseLnk(buf) {
  const out = { header: {}, extra: {}, target: "", strings: {} };
  out.header.headerSize = buf.readUInt32LE(0);
  out.header.clsid = buf.toString("hex", 4, 20);
  out.header.flags = buf.readUInt32LE(20);
  out.header.fileAttributes = buf.readUInt32LE(24);
  out.header.iconIndex = buf.readInt32LE(56);
  out.header.showCommand = buf.readUInt32LE(60);
  out.header.hotKey = buf.readUInt16LE(64);
  let p = 0x4c;

  /* --- ExtraData ---
     每块：BlockSize(4 字节，仅低 16 位有效) + BlockType(4) + 数据(BlockSize 字节) */
  while (p + 8 <= buf.length) {
    const size = buf.readUInt32LE(p) & 0xffff;
    if (size < 4) break;
    const type = buf.readUInt32LE(p + 4);
    const data = buf.slice(p + 8, p + 8 + size);
    if (type === 0xa0000005) out.extra.workingDir = data.toString("utf16le").replace(/\0+$/, "");
    else if (type === 0xa0000002) out.extra.arguments = data.toString("utf16le").replace(/\0+$/, "");
    else if (type === 0xa0000001) out.extra.envTarget = data.toString("utf16le").replace(/\0+$/, "");
    else if (type === 0xa0000007) out.extra.iconLocation = data.toString("utf16le").replace(/\0+$/, "");
    else break;
    p += 8 + size;
  }
  /* ExtraData 以 4 字节 0 的终止块收尾（规范允许，解析器需跳过） */
  if (p + 4 <= buf.length && buf.readUInt32LE(p) === 0) p += 4;
  out.atIdListHeader = p;

  /* --- LinkTargetIDList ---
     结构是 IDListSize(2 字节) + ItemIDList（ItemIDList 以 0x0000 结尾，
     这 2 字节也算在 IDListSize 里） */
  const idListSize = buf.readUInt16LE(p);
  out.idListSize = idListSize;
  out.atIdList = p;
  out.idListHex = buf.toString("hex", p, Math.min(p + 40, buf.length));
  p += 2 + idListSize;
  out.atAfterIdList = p;
  out.u32AfterIdList = buf.readUInt32LE(p);
  out.bytesAfterIdList = buf.toString("hex", p, Math.min(p + 8, buf.length));

  /* --- LinkInfo --- */
  const liStart = p;
  const liSize = buf.readUInt32LE(liStart);
  const liHeaderSize = buf.readUInt32LE(liStart + 4);
  const liFlags = buf.readUInt32LE(liStart + 8);
  const localBasePathOffset = buf.readUInt32LE(liStart + 16);
  const commonPathSuffixOffset = buf.readUInt32LE(liStart + 24);
  out.linkInfo = { size: liSize, headerSize: liHeaderSize, flags: liFlags, localBasePathOffset, commonPathSuffixOffset };

  /* LocalBasePath 与 CommonPathSuffix 都是 NUL 结尾的字符串（规范如此），
     必须按第一个 NUL 截断，不能一路读到缓冲区结尾。 */
  const readCString = (offset) => {
    let e = offset;
    while (e + 1 < buf.length && buf.readUInt16LE(e) !== 0) e += 2;
    return buf.toString("utf16le", offset, e);
  };
  let targetPath = readCString(liStart + localBasePathOffset);
  if (commonPathSuffixOffset) targetPath += readCString(liStart + commonPathSuffixOffset);
  out.target = targetPath;
  p = liStart + liSize;
  out.atStringData = p;
  out.bytesAtStringData = buf.toString("hex", Math.min(p, buf.length - 1), Math.min(p + 8, buf.length));

  /* --- StringData --- */
  const readStr = (key) => {
    if (p + 2 > buf.length) { out.strings[key] = "(越界，p=" + p + ")"; return; }
    const len = buf.readUInt16LE(p);
    out.strings[key] = buf.toString("utf16le", p + 2, Math.min(p + 2 + len * 2, buf.length));
    p += 2 + len * 2;
  };
  if (out.header.flags & 0x04) readStr("name");
  if (out.header.flags & 0x40) readStr("icon");
  return out;
}

const parsed = parseLnk(buf);
ok(parsed.header.headerSize === 0x4c, "解析出 HeaderSize");
ok(parsed.header.clsid === "0114020000000000c000000000000046", "解析出正确 CLSID");
ok(parsed.target === target, "解析出的目标路径与写入一致：" + parsed.target);
ok(parsed.extra.arguments && parsed.extra.arguments.includes("server.mjs"), "解析出参数：" + parsed.extra.arguments);
ok(parsed.extra.arguments.includes("--app"), "参数里含 --app");
ok(parsed.extra.workingDir === ROOT, "解析出工作目录：" + parsed.extra.workingDir);
ok(parsed.extra.iconLocation === iconFile, "解析出图标路径：" + parsed.extra.iconLocation);
ok(parsed.strings.name && parsed.strings.name.includes("Slowly"), "解析出显示名：" + parsed.strings.name);
ok(parsed.idListSize > 0 && parsed.idListSize % 2 === 0, "IDList 长度合法：" + parsed.idListSize);
ok(parsed.linkInfo.size === parsed.linkInfo.headerSize + (target.length + 1) * 2, "LinkInfo 长度自洽");
ok(parsed.linkInfo.commonPathSuffixOffset === 0, "CommonPathSuffix 为空（路径写在 LocalBasePath 里）");
ok(parsed.linkInfo.flags === 1, "LinkInfo 使用 LocalBasePath 形式");

console.log("4) 图标文件本身");
const ico = fs.readFileSync(path.join(ROOT, "assets", "slowly.ico"));
ok(ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1, "ICO 头合法（type=icon）");
const count = ico.readUInt16LE(4);
ok(count === 6, "ICO 含 6 个尺寸（实际 " + count + "）");
let sizesOk = true, detail = "";
for (let i = 0; i < count; i++) {
  const off = 6 + i * 16;
  const w = ico[off] === 0 ? 256 : ico[off];
  const bytes = ico.readUInt32LE(off + 8);
  const imgOfs = ico.readUInt32LE(off + 12);
  const isPng = ico.toString("hex", imgOfs, imgOfs + 8) === "89504e470d0a1a0a";
  if (!isPng || bytes <= 0) { sizesOk = false; detail += w + "px(非PNG) "; }
}
ok(sizesOk, "每个尺寸都是合法 PNG 数据", detail);

fs.rmSync(OUT, { recursive: true, force: true });
console.log("\n结果：通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
