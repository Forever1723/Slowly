/* 二维码模块自检：编码 -> 独立解码 -> 逐字节比对，并校验 RS 伴随式与格式信息 */
const qr = require("../lib/qr.js");

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra ? "  -> " + extra : "")); }
};

/* 期望的格式信息串（规范表）：L/0=0x77C4, L/1=0x72F3, M/0=0x5412, Q/0=0x355F ... */
console.log("1) 格式信息 BCH 计算");
function fmtBits(ecBits, mask) {
  const five = (ecBits << 3) | mask;
  let rem = five;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((five << 10) | rem) ^ 0x5412;
}
ok(fmtBits(0b01, 0) === 0x77c4, "L/mask0 = 0x77C4", "0x" + fmtBits(0b01, 0).toString(16));
ok(fmtBits(0b01, 1) === 0x72f3, "L/mask1 = 0x72F3", "0x" + fmtBits(0b01, 1).toString(16));
ok(fmtBits(0b00, 0) === 0x5412, "M/mask0 = 0x5412", "0x" + fmtBits(0b00, 0).toString(16));
ok(fmtBits(0b11, 0) === 0x355f, "Q/mask0 = 0x355F", "0x" + fmtBits(0b11, 0).toString(16));
ok(fmtBits(0b10, 5) === 0x0255, "H/mask5 = 0x0255", "0x" + fmtBits(0b10, 5).toString(16).padStart(4, "0"));
/* 31 个合法格式串两两汉明距离必须 >= 7（BCH(15,5) 的纠错能力），这是规范自带的硬约束 */
{
  const words = [];
  for (let ec = 0; ec < 4; ec++) for (let mk = 0; mk < 8; mk++) words.push(fmtBits(ec, mk));
  let minDist = 99;
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j < words.length; j++) {
      let d = 0, x = words[i] ^ words[j];
      while (x) { d += x & 1; x >>= 1; }
      if (d < minDist) minDist = d;
    }
  }
  ok(minDist >= 7, "32 个格式串两两汉明距离 >= 7（实测 " + minDist + "）");
  ok(words.filter((w) => w === 0x5412).length === 1, "M/0 唯一等于 0x5412");
}

console.log("2) 校正图形坐标（规范表）");
ok(JSON.stringify(qr.alignmentPositions(1)) === "[]", "v1 无校正图形");
ok(JSON.stringify(qr.alignmentPositions(2)) === "[6,18]", "v2 = [6,18]", JSON.stringify(qr.alignmentPositions(2)));
ok(JSON.stringify(qr.alignmentPositions(3)) === "[6,22]", "v3 = [6,22]", JSON.stringify(qr.alignmentPositions(3)));
ok(JSON.stringify(qr.alignmentPositions(4)) === "[6,26]", "v4 = [6,26]", JSON.stringify(qr.alignmentPositions(4)));
ok(JSON.stringify(qr.alignmentPositions(5)) === "[6,30]", "v5 = [6,30]", JSON.stringify(qr.alignmentPositions(5)));
ok(JSON.stringify(qr.alignmentPositions(6)) === "[6,34]", "v6 = [6,34]", JSON.stringify(qr.alignmentPositions(6)));
ok(JSON.stringify(qr.alignmentPositions(8)) === "[6,24,42]", "v8 = [6,24,42]", JSON.stringify(qr.alignmentPositions(8)));

console.log("3) 版本选择容量边界（按规范码字总数推导）");
ok(qr.pickVersion(10, "M") === 1, "10 字节可在 v1-M");
ok(qr.pickVersion(14, "M") === 1, "14 字节 -> v1-M", "v" + qr.pickVersion(14, "M"));
ok(qr.pickVersion(15, "M") === 2, "15 字节 -> v2-M", "v" + qr.pickVersion(15, "M"));
ok(qr.pickVersion(26, "M") === 2, "26 字节 -> v2-M", "v" + qr.pickVersion(26, "M"));
ok(qr.pickVersion(27, "M") === 3, "27 字节 -> v3-M", "v" + qr.pickVersion(27, "M"));
ok(qr.pickVersion(42, "M") === 3, "42 字节 -> v3-M", "v" + qr.pickVersion(42, "M"));
ok(qr.pickVersion(43, "M") === 4, "43 字节 -> v4-M", "v" + qr.pickVersion(43, "M"));
ok(qr.pickVersion(62, "M") === 4, "62 字节 -> v4-M", "v" + qr.pickVersion(62, "M"));
ok(qr.pickVersion(63, "M") === 5, "63 字节 -> v5-M", "v" + qr.pickVersion(63, "M"));
ok(qr.pickVersion(84, "M") === 5, "84 字节 -> v5-M", "v" + qr.pickVersion(84, "M"));
ok(qr.pickVersion(85, "M") === 6, "85 字节 -> v6-M", "v" + qr.pickVersion(85, "M"));
ok(qr.pickVersion(106, "M") === 6, "106 字节 -> v6-M（本实现上限）", "v" + qr.pickVersion(106, "M"));
ok(qr.pickVersion(107, "M") === -1, "107 字节超出自持范围，返回 -1");
ok(qr.pickVersion(106, "L") === 5, "106 字节 -> v5-L（L 上限）", "v" + qr.pickVersion(106, "L"));
ok(qr.pickVersion(134, "L") === 6, "134 字节 -> v6-L（L 上限）", "v" + qr.pickVersion(134, "L"));
ok(qr.pickVersion(135, "L") === -1, "135 字节超出 L 上限");
/* 全表交叉验证：不靠手抄容量表，直接用公式推出每个版本的真实字节上限 */
{
  const totalData = (lvl, v) => {
    const [per, a, b] = qr.BLOCK_TABLE[lvl][v];
    return per * (a + b);
  };
  const maxBytes = (lvl, v) => {
    const lenBits = v < 10 ? 8 : 16;
    return Math.floor((totalData(lvl, v) * 8 - 4 - lenBits) / 8);
  };
  let sweepOk = true, detail = "";
  for (const lvl of ["L", "M"]) {
    for (let v = 1; v <= 6; v++) {
      const cap = maxBytes(lvl, v);
      if (cap > 0 && qr.pickVersion(cap, lvl) !== v) {
        sweepOk = false; detail += lvl + v + "(上限" + cap + "->v" + qr.pickVersion(cap, lvl) + ") ";
      }
      if (cap + 1 > 0 && qr.pickVersion(cap + 1, lvl) === v) {
        sweepOk = false; detail += lvl + v + "(超限未升级) ";
      }
    }
  }
  ok(sweepOk, "18 组容量上限逐一实测，版本选择全部落在正确级别", detail);
  ok(maxBytes("M", 1) === 14 && maxBytes("L", 1) === 17, "v1 容量 M=14 / L=17",
     "M=" + maxBytes("M", 1) + " L=" + maxBytes("L", 1));
  ok(maxBytes("M", 6) === 106 && maxBytes("L", 6) === 134, "v6 容量 M=106 / L=134（本实现上限）",
     "M=" + maxBytes("M", 6) + " L=" + maxBytes("L", 6));
}
/* 数据码字总数必须等于总码字数减去纠错码字（交叉验算，防止表写错） */
{
  const TOTAL_CODEWORDS = { 1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172 };
  let tableOk = true, detail = "";
  for (const lvl of ["L", "M"]) {
    for (let v = 1; v <= 6; v++) {
      const [per, a, b] = qr.BLOCK_TABLE[lvl][v];
      const blocks = a + b;
      const calc = per * blocks + qr.EC_PER_BLOCK[lvl][v] * blocks;
      if (calc !== TOTAL_CODEWORDS[v]) { tableOk = false; detail += lvl + v + ":" + calc + "≠" + TOTAL_CODEWORDS[v] + " "; }
    }
  }
  ok(tableOk, "所有版本的数据码字+纠错码字 = 规范总码字", detail);
}

console.log("4) 编码 -> 解码往返（二维码真正要承载的内容）");
const samples = [
  "http://10.114.123.115:8787/",
  "http://10.114.123.115:8787/s?t=abc123",
  "http://192.168.1.100:8787/",
  "http://127.0.0.1:8787/",
  "https://slowly.local:8787/?code=XY9Z",
  "A",
  "http://10.0.0.7:8787/s?t=9f8e7d6c5b4a3210",
  "手机扫码打开 Slowly 慢慢来比较快"
];
for (const s of samples) {
  try {
    const enc = qr.encode(s, "M");
    const dec = qr.decode(enc.modules);
    ok(dec.text === s, "往返一致 (" + s.slice(0, 34) + (s.length > 34 ? "…" : "") + ") v" + dec.version + "-" + dec.ecLevel,
       "得到 " + JSON.stringify(dec.text));
  } catch (e) {
    ok(false, "往返 " + s, e.message);
  }
}

/* 扫码配对用的链接比普通地址长得多（含令牌与完整地址），
   单独特意验证一遍：万一以后地址格式变长，二维码放不下要立刻发现。 */
console.log("4b) 配对链接也能编进二维码并原样解回");
{
  const pairCases = [
    ["线上版配对链接", "https://forever1723.github.io/Slowly/#pair=A1B2C3&srv=http%3A%2F%2F10.114.123.115%3A8787%2F"],
    ["安卓深链", "slowly://pair?token=A1B2C3&srv=http%3A%2F%2F10.114.123.115%3A8787%2F"],
    ["较长的域名与地址", "https://averyverylongname.github.io/Long-Repo-Name/#pair=ABCDEF&srv=http%3A%2F%2F192.168.100.20%3A8787%2F"],
  ];
  for (const [label, text] of pairCases) {
    try {
      const enc = qr.encode(text, "M");
      const dec = qr.decode(enc.modules);
      ok(dec.text === text, label + "可往返（" + text.length + " 字符，版本 " + dec.version + "）",
        "解回的是 " + JSON.stringify(dec.text));
    } catch (e) {
      ok(false, label + "可往返", e.message);
    }
  }
}

console.log("5) 纠错码字本身可被独立验证");
{
  const enc = qr.encode("http://10.114.123.115:8787/", "M");
  let allValid = true;
  for (let b = 0; b < enc.totalBlocks; b++) {
    const full = enc.dataBlocks[b].concat(enc.ecBlocks[b]);
    if (!qr.rsSyndromesValid(full, enc.ecPerBlock)) allValid = false;
  }
  ok(allValid, "所有块的伴随式全为 0（纠错位正确）");
  ok(enc.finalBytes.length === enc.dataBlocks.length * enc.perBlock + enc.totalBlocks * enc.ecPerBlock,
     "交错后的码字总数正确 " + enc.finalBytes.length);
  /* 破坏一个数据码字，校验必须报错（说明校验真的在起作用） */
  const broken = enc.dataBlocks.map((b) => b.slice());
  broken[0][0] ^= 0xff;
  const brokenFull = broken[0].concat(enc.ecBlocks[0]);
  ok(!qr.rsSyndromesValid(brokenFull, enc.ecPerBlock), "篡改数据后伴随式非 0（能检出错误）");
}

console.log("6) 矩阵结构检查");
{
  const enc = qr.encode("http://10.114.123.115:8787/", "M");
  const m = enc.modules, n = enc.size;
  ok(n === enc.version * 4 + 17, "尺寸与版本一致 " + n + "x" + n);
  /* 三个定位图形的角点必须为深色，内部核心为深色，环间为浅色 */
  let finderOk = true;
  for (const [br, bc] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    if (m[br][bc] !== 1 || m[br + 6][bc + 6] !== 1 || m[br + 3][bc + 3] !== 1) finderOk = false;
    if (m[br + 1][bc + 1] !== 0 || m[br + 5][bc + 5] !== 0) finderOk = false;
  }
  ok(finderOk, "定位图形结构正确");
  let timingOk = true;
  for (let i = 8; i < n - 8; i++) {
    if (m[6][i] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
    if (m[i][6] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
  }
  ok(timingOk, "定时图形交替正确");
  ok(m[n - 8][8] === 1, "固定暗模块为深色");
  /* 每行每列都不应整行同色（掩码 0 下极易出现，若出现说明掩码没生效） */
  let flatRows = 0;
  for (let r = 0; r < n; r++) {
    const s = new Set(m[r]);
    if (s.size === 1) flatRows++;
  }
  ok(flatRows === 0, "没有整行同色（掩码已生效）");
}

console.log("7) SVG 输出可用");
{
  const { svg, qr: meta } = qr.toSVG("http://10.114.123.115:8787/", { ecLevel: "M", margin: 2 });
  ok(svg.startsWith("<svg") && svg.endsWith("</svg>"), "SVG 首尾完整");
  ok(svg.includes('viewBox="0 0 ' + (meta.size + 4) + " " + (meta.size + 4) + '"'), "viewBox 含留白");
  ok((svg.match(/<path/g) || []).length === 1, "路径合并为一条");
  ok(svg.length < 20000, "体积可控 " + svg.length + " 字节");
}

console.log("\n结果：通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
