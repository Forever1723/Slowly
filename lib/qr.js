/* =============================================================
   Slowly · 迷你二维码编码器（零依赖）
   - 字节模式（UTF-8），纠错等级 L / M，版本 1~6
   - 固定使用掩码 0（规范允许任意选择掩码，只要格式信息一致）
   - 同时导出 decode() 供自检使用：反向解析并校验里德-所罗门校验位
   ============================================================= */

/* =============================================================
   每个版本 / 纠错等级的分块结构：[每块数据码字, 块数A, 块数B]
   数据码字总数 = 总码字数 - 纠错码字/块 × 块数（按规范表核对）
   v1: 26 总  | v2: 44  | v3: 70  | v4: 100 | v5: 134 | v6: 172
   ============================================================= */
const BLOCK_TABLE = {
  L: {
    1: [19, 1, 0], 2: [34, 1, 0], 3: [55, 1, 0],
    4: [80, 1, 0], 5: [108, 1, 0], 6: [68, 2, 0]
  },
  M: {
    1: [16, 1, 0], 2: [28, 1, 0], 3: [44, 1, 0],
    4: [32, 2, 0], 5: [43, 2, 0], 6: [27, 4, 0]
  }
};
const EC_PER_BLOCK = {
  L: { 1: 7, 2: 10, 3: 15, 4: 20, 5: 26, 6: 18 },
  M: { 1: 10, 2: 16, 3: 26, 4: 18, 5: 24, 6: 16 }
};

/* ---------------- GF(256) ---------------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // QR 的本原多项式
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/* 生成多项式 (x-a^0)(x-a^1)...(x-a^(n-1)) */
function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gmul(poly[j], 1);
      next[j + 1] ^= gmul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}
/* 计算 n 个校验码字 */
function rsEncode(data, n) {
  const gen = rsGenerator(n);
  const res = new Array(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < n; i++) res[i] ^= gmul(gen[i + 1], factor);
  }
  return res;
}
/* 校验：对完整码字（数据+校验）求伴随式，全 0 即有效 */
function rsSyndromesValid(codeword, n) {
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (const c of codeword) acc = gmul(acc, EXP[i]) ^ c;
    if (acc !== 0) return false;
  }
  return true;
}

/* =============================================================
   格式信息 15 位的精确坐标（按规范，务必避开定时图形的第 6 行 / 第 6 列）
   位序 i 与坐标一一对应，三份拷贝内容相同
   ============================================================= */
function formatCoords(size) {
  return {
    /* 左上角：绕着定位图形呈 L 形 */
    topLeft: [
      [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],   // i = 0..5
      [7, 8], [8, 8], [8, 7],                            // i = 6,7,8
      [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]     // i = 9..14
    ],
    /* 右上角：第 8 行靠右 8 格（i = 0..7） */
    topRight: Array.from({ length: 8 }, (_, i) => [8, size - 1 - i]),
    /* 左下角：第 8 列靠下 7 格（i = 8..14） */
    bottomLeft: Array.from({ length: 7 }, (_, k) => [size - 7 + k, 8])
  };
}
/* =============================================================
   ZigZag 遍历用的列对（从右向左两列一组，整组跳过第 6 列定时线）
   正确做法是先算好列对，而不是在循环里 col -= 2：
   否则 {7,6} -> col=5 处理 {5,4} 后 col 又变 3，第 4 列会被遍历两遍。
   ============================================================= */
function columnPairs(size) {
  const pairs = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    pairs.push([right, right - 1]);
  }
  return pairs;
}

/* ---------------- 位缓冲 ---------------- */
class BitBuffer {
  constructor() { this.bits = []; }
  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
}

/* ---------------- 版本与容量 ---------------- */
function alignmentPositions(version) {
  if (version === 1) return [];
  const num = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((size - 13) / (num * 2 - 2)) * 2;
  const pos = [6];
  for (let i = num - 1; i >= 1; i--) pos.splice(1, 0, size - 7 - (num - 1 - i) * step);
  return pos.sort((a, b) => a - b);
}

function pickVersion(byteLength, ecLevel) {
  for (let v = 1; v <= 6; v++) {
    const [perBlock, a, b] = BLOCK_TABLE[ecLevel][v];
    const totalData = perBlock * (a + b);
    const lenBits = v < 10 ? 8 : 16;
    const need = 4 + lenBits + byteLength * 8;
    if (need <= totalData * 8) return v;
  }
  return -1;
}

/* ---------------- 编码 ---------------- */
function encode(text, ecLevel = "M") {
  const bytes = Array.from(Buffer.from(String(text), "utf8"));
  const version = pickVersion(bytes.length, ecLevel);
  if (version < 0) throw new Error("内容太长，二维码放不下");

  const [perBlock, blocksA, blocksB] = BLOCK_TABLE[ecLevel][version];
  const totalBlocks = blocksA + blocksB;
  const totalData = perBlock * totalBlocks;
  const ecPerBlock = EC_PER_BLOCK[ecLevel][version];
  const lenBits = version < 10 ? 8 : 16;

  /* 1. 数据位流 */
  const buf = new BitBuffer();
  buf.put(0b0100, 4);              // 字节模式
  buf.put(bytes.length, lenBits);
  for (const b of bytes) buf.put(b, 8);
  const capacityBits = totalData * 8;
  const terminator = Math.min(4, capacityBits - buf.length);
  buf.put(0, terminator);
  while (buf.length % 8 !== 0) buf.bits.push(0);
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (buf.length < capacityBits) {
    buf.put(padBytes[padIndex++ % 2], 8);
  }
  const dataBytes = [];
  for (let i = 0; i < buf.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | buf.bits[i + j];
    dataBytes.push(v);
  }

  /* 2. 分块 + 纠错 */
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < totalBlocks; i++) {
    const block = dataBytes.slice(offset, offset + perBlock);
    offset += perBlock;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }

  /* 3. 交错 */
  const finalBytes = [];
  for (let i = 0; i < perBlock; i++) {
    for (const block of dataBlocks) finalBytes.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) finalBytes.push(block[i]);
  }

  /* 4. 矩阵 */
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(0));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFn = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = v ? 1 : 0;
    reserved[r][c] = true;
  };

  /* 定位图形 */
  for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = br + r, cc = bc + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                       (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setFn(rr, cc, inRing || inCore ? 1 : 0);
      }
    }
  }
  /* 定时图形 */
  for (let i = 8; i < size - 8; i++) {
    setFn(6, i, i % 2 === 0 ? 1 : 0);
    setFn(i, 6, i % 2 === 0 ? 1 : 0);
  }
  /* 校正图形 */
  const centers = alignmentPositions(version);
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFn(r + dr, c + dc, on ? 1 : 0);
        }
      }
    }
  }
  /* 先写格式信息，再补固定暗模块。
     注意：版本 2 时暗模块 (size-8, 8) 与格式位 (8, size-9) 落在同一格，
     规范要求该格为深色，所以必须放在格式信息之后写，否则会覆盖一个格式位。 */
  const ecBits = ecLevel === "L" ? 0b01 : 0b00;
  const mask = 0;
  let fmt = (ecBits << 3) | mask;
  let rem = fmt;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const fmtBits = ((fmt << 10) | rem) ^ 0x5412;
  const bitAt = (i) => (fmtBits >>> i) & 1;

  /* 格式信息在左上角占用 15 格，必须避开定时图形所在的行 6 / 列 6；
     (8,6)、(6,8)、(8,8) 属于定时图形，不承载格式位。
     右上角与左下角各有一份完全相同的副本（同样避开定时行列）。 */
  const fc = formatCoords(size);
  fc.topLeft.forEach(([r, c], i) => setFn(r, c, bitAt(i)));
  fc.topRight.forEach(([r, c], i) => setFn(r, c, bitAt(i)));
  fc.bottomLeft.forEach(([r, c], k) => setFn(r, c, bitAt(8 + k)));

  /* 5.5 固定暗模块（必须在格式信息之后，见上） */
  setFn(size - 8, 8, 1);

  /* 6. 版本信息（版本 >= 7 才需要，这里用不到但仍保留正确姿态） */
  if (version >= 7) {
    let v = version;
    let r2 = v;
    for (let i = 0; i < 12; i++) r2 = (r2 << 1) ^ ((r2 >>> 11) * 0x1f25);
    const vBits = (v << 12) | r2;
    for (let i = 0; i < 18; i++) {
      const bit = (vBits >>> i) & 1;
      const a = Math.floor(i / 3), b = i % 3;
      setFn(a, size - 11 + b, bit);
      setFn(size - 11 + b, a, bit);
    }
  }

  /* 7. 数据填充：右下角起，两列一组，蛇形向上/向下 */
  let bitIndex = 0;
  const totalBits = finalBytes.length * 8;
  const nextBit = () => {
    const byte = finalBytes[bitIndex >> 3];
    const bit = (byte >>> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit;
  };
  let upward = true;
  const trace = process.env.QR_TRACE === "1" ? [] : null;
  for (const pair of columnPairs(size)) {
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of pair) {
        if (reserved[row][c]) continue;
        if (trace) trace.push([row, c]);
        modules[row][c] = bitIndex < totalBits ? nextBit() : 0;
      }
    }
    upward = !upward;
  }
  if (trace) globalThis.__qrTrace = trace;

  /* 8. 掩码 0：(row + col) % 2 === 0 */
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      if ((r + c) % 2 === 0) modules[r][c] ^= 1;
    }
  }

  return { size, modules, version, ecLevel, mask, finalBytes, totalBlocks, perBlock, ecPerBlock, dataBlocks, ecBlocks };
}

/* ---------------- 解码（自检用，独立走一遍反向流程） ---------------- */
function decode(matrix) {
  const size = matrix.length;
  /* 1. 读格式信息（左上角那一份，位序与 formatCoords 一致） */
  const fcRead = formatCoords(size);
  let raw = 0;
  fcRead.topLeft.forEach(([r, c], i) => { raw |= matrix[r][c] << i; });
  const unmasked = raw ^ 0x5412;

  /* 遍历 32 种合法格式串，取汉明距离最小者 */
  let best = null;
  for (let ec = 0; ec < 4; ec++) {
    for (let mk = 0; mk < 8; mk++) {
      const five = (ec << 3) | mk;
      let rem = five;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const candidate = (five << 10) | rem;
      let dist = 0;
      for (let i = 0; i < 15; i++) {
        if (((candidate >>> i) & 1) !== ((unmasked >>> i) & 1)) dist++;
      }
      if (!best || dist < best.dist) best = { dist, ec, mask: mk, five };
    }
  }
  if (best.dist !== 0) throw new Error("格式信息无法识别，距离 " + best.dist);

  const ecLevel = (["M", "L", "H", "Q"])[best.ec];
  /* 用矩阵尺寸反推版本并重建功能图形占位 */
  const version = (function detectVersion() {
    for (let v = 1; v <= 40; v++) if (v * 4 + 17 === size) return v;
    throw new Error("矩阵尺寸不合法：" + size);
  })();
  const reserved = (function rebuildReservations() {
    const ver = version;
    const res = Array.from({ length: size }, () => new Array(size).fill(false));
    const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) res[r][c] = true; };
    for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(br + r, bc + c);
    }
    for (let i = 8; i < size - 8; i++) { mark(6, i); mark(i, 6); }
    const centers = alignmentPositions(ver);
    for (const r of centers) {
      for (const c of centers) {
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
      }
    }
    /* 格式信息：三份拷贝的全部格子（含避开定时行列的那几个缺口） */
    const fc = formatCoords(size);
    for (const [r, c] of fc.topLeft.concat(fc.topRight, fc.bottomLeft)) mark(r, c);
    if (ver >= 7) {
      for (let i = 0; i < 18; i++) {
        const a = Math.floor(i / 3), b = i % 3;
        mark(a, size - 11 + b);
        mark(size - 11 + b, a);
      }
    }
    mark(size - 8, 8);
    return res;
  })();

  /* 2. 去掩码 + 提取数据位（掩码 0），遍历顺序必须与编码时完全一致 */
  const bits = [];
  let upward = true;
  for (const pair of columnPairs(size)) {
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of pair) {
        if (reserved[row][c]) continue;
        let v = matrix[row][c];
        if ((row + c) % 2 === 0) v ^= 1;
        bits.push(v);
      }
    }
    upward = !upward;
  }

  const [perBlock, blocksA, blocksB] = BLOCK_TABLE[ecLevel][version];
  const totalBlocks = blocksA + blocksB;
  const ecPerBlock = EC_PER_BLOCK[ecLevel][version];
  const totalData = perBlock * totalBlocks;
  const totalCodewords = totalData + ecPerBlock * totalBlocks;

  const codewords = [];
  for (let i = 0; i < totalCodewords; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    codewords.push(v);
  }

  /* 3. 反交错 */
  const dataBlocks = Array.from({ length: totalBlocks }, () => []);
  const ecBlocks = Array.from({ length: totalBlocks }, () => []);
  let p = 0;
  for (let i = 0; i < perBlock; i++) for (let b = 0; b < totalBlocks; b++) dataBlocks[b].push(codewords[p++]);
  for (let i = 0; i < ecPerBlock; i++) for (let b = 0; b < totalBlocks; b++) ecBlocks[b].push(codewords[p++]);

  /* 4. 校验每块的里德-所罗门伴随式 */
  for (let b = 0; b < totalBlocks; b++) {
    const full = dataBlocks[b].concat(ecBlocks[b]);
    if (!rsSyndromesValid(full, ecPerBlock)) throw new Error("第 " + b + " 块的纠错校验失败");
  }

  /* 5. 解析位流 */
  const flat = [];
  for (const block of dataBlocks) for (const byte of block) for (let i = 7; i >= 0; i--) flat.push((byte >>> i) & 1);
  let idx = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | flat[idx++]; return v; };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error("不是字节模式，mode=" + mode);
  const len = take(version < 10 ? 8 : 16);
  const out = [];
  for (let i = 0; i < len; i++) out.push(take(8));
  return {
    text: Buffer.from(out).toString("utf8"),
    version, ecLevel, mask: best.mask, blocks: totalBlocks, ecPerBlock
  };
}

/* ---------------- 渲染成 SVG（viewBox 单位制，便于任意缩放） ---------------- */
function toSVG(text, opts = {}) {
  const qr = encode(text, opts.ecLevel || "M");
  const margin = opts.margin === undefined ? 2 : opts.margin;
  const dim = qr.size + margin * 2;
  const dark = opts.dark || "#2f2a26";
  const light = opts.light || "#ffffff";
  let path = "";
  for (let r = 0; r < qr.size; r++) {
    let c = 0;
    while (c < qr.size) {
      if (!qr.modules[r][c]) { c++; continue; }
      let run = 1;
      while (c + run < qr.size && qr.modules[r][c + run]) run++;
      path += "M" + (c + margin) + " " + (r + margin) + "h" + run + "v1h-" + run + "z";
      c += run;
    }
  }
  return {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + " " + dim + '" shape-rendering="crispEdges" role="img" aria-label="扫码访问">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>' +
      '<path d="' + path + '" fill="' + dark + '"/></svg>',
    qr
  };
}

/* 终端 ASCII 预览（调试用） */
function toText(text, opts = {}) {
  const qr = encode(text, opts.ecLevel || "M");
  const margin = 2;
  const lines = [];
  for (let r = -margin; r < qr.size + margin; r++) {
    let line = "";
    for (let c = -margin; c < qr.size + margin; c++) {
      const on = r >= 0 && c >= 0 && r < qr.size && c < qr.size && qr.modules[r][c];
      line += on ? "██" : "  ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

module.exports = { encode, decode, toSVG, toText, alignmentPositions, rsEncode, rsSyndromesValid, pickVersion, BLOCK_TABLE, EC_PER_BLOCK };
