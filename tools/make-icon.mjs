/* 生成 Slowly 的应用图标：SVG + ICO（用内置 zlib 手写 PNG，零依赖） */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ASSETS = path.join(ROOT, "assets");
fs.mkdirSync(ASSETS, { recursive: true });

/* ---------- 图标造型：一枚慢慢转的螺旋 + 地平线 ---------- */
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Slowly">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fdf6ec"/>
      <stop offset="100%" stop-color="#f6e3d3"/>
    </linearGradient>
    <linearGradient id="spiral" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#e8a17c"/>
      <stop offset="55%" stop-color="#c96a49"/>
      <stop offset="100%" stop-color="#8fa98c"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="58" fill="url(#bg)"/>
  <circle cx="128" cy="128" r="104" fill="none" stroke="#eadfd4" stroke-width="2"/>
  <!-- 螺旋：从中心慢慢向外，象征一天天累积 -->
  <path d="M128 128
           m0 -8
           a8 8 0 0 1 8 8
           a16 16 0 0 1 -16 16
           a26 26 0 0 1 -26 -26
           a38 38 0 0 1 38 -38
           a52 52 0 0 1 52 52
           a66 66 0 0 1 -66 66"
        fill="none" stroke="url(#spiral)" stroke-width="11"
        stroke-linecap="round" stroke-linejoin="round"/>
  <!-- 一天中的一小步：一个小圆点 -->
  <circle cx="128" cy="46" r="9" fill="#8fa98c"/>
</svg>
`;
fs.writeFileSync(path.join(ASSETS, "slowly-icon.svg"), ICON_SVG, "utf8");

/* ---------- 手写 PNG 编码（RGBA，8 位） ---------- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* 用超采样 + 距离场把图标"画"成像素，无需 Canvas */
function renderIcon(size) {
  const SS = 3;                       // 超采样倍数
  const N = size * SS;
  const px = Buffer.alloc(size * size * 4);
  const GRAD = [[232, 161, 124], [201, 106, 73], [143, 169, 140]];
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const gradAt = (t) => {
    t = Math.max(0, Math.min(1, t));
    return t < 0.55 ? mix(GRAD[0], GRAD[1], t / 0.55) : mix(GRAD[1], GRAD[2], (t - 0.55) / 0.45);
  };
  /* 螺旋参数：x = c + r(t)cos(t), y = c + r(t)sin(t) */
  const R0 = 0.031, R1 = 0.258, TURNS = 2.0;
  const spiralPoint = (t) => {
    const r = R0 + (R1 - R0) * t;
    const a = t * TURNS * Math.PI * 2 - Math.PI / 2;
    return [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)];
  };
  const distToSpiral = (x, y) => {
    let best = 1;
    const STEPS = 900;
    for (let i = 0; i <= STEPS; i++) {
      const [sx, sy] = spiralPoint(i / STEPS);
      const d = Math.hypot(x - sx, y - sy);
      if (d < best) best = d;
    }
    return best;
  };

  const acc = new Float64Array(size * size * 4);
  for (let sy = 0; sy < N; sy++) {
    for (let sx = 0; sx < N; sx++) {
      const x = (sx + 0.5) / N, y = (sy + 0.5) / N;
      let r = 253, g = 246, b = 236, a = 255;         // 背景
      /* 圆角矩形裁切 */
      const rad = 0.226;
      const dx = Math.max(rad - x, x - (1 - rad), 0);
      const dy = Math.max(rad - y, y - (1 - rad), 0);
      const inside = Math.hypot(dx, dy) <= rad;
      if (!inside) { a = 0; }

      /* 外圈细线 */
      const dCenter = Math.hypot(x - 0.5, y - 0.5);
      if (inside && Math.abs(dCenter - 0.406) < 0.004) { r = 234; g = 223; b = 212; }

      /* 螺旋主线 */
      const ds = distToSpiral(x, y);
      const halfWidth = 0.0215;
      if (inside && ds < halfWidth) {
        const t = Math.max(0, Math.min(1, (Math.hypot(x - 0.5, y - 0.5) - R0) / (R1 - R0)));
        const col = gradAt(t);
        const edge = Math.min(1, (halfWidth - ds) / (0.004 + 1e-6));
        r = r + (col[0] - r) * edge;
        g = g + (col[1] - g) * edge;
        b = b + (col[2] - b) * edge;
      }

      /* 顶部小点 */
      const dDot = Math.hypot(x - 0.5, y - 0.18);
      if (inside && dDot < 0.035) { r = 143; g = 169; b = 140; }

      const o = (Math.floor(sy / SS) * size + Math.floor(sx / SS)) * 4;
      acc[o] += r; acc[o + 1] += g; acc[o + 2] += b; acc[o + 3] += a;
    }
  }
  const n = SS * SS;
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = Math.round(acc[i * 4] / n);
    px[i * 4 + 1] = Math.round(acc[i * 4 + 1] / n);
    px[i * 4 + 2] = Math.round(acc[i * 4 + 2] / n);
    px[i * 4 + 3] = Math.round(acc[i * 4 + 3] / n);
  }
  return px;
}

/* ---------- ICO 容器（内含多尺寸 PNG，Vista 以后都支持） ---------- */
function buildICO(sizes) {
  const images = sizes.map((s) => encodePNG(s, renderIcon(s)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);       // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  images.forEach((img, i) => {
    const e = Buffer.alloc(16);
    const s = sizes[i];
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.length;
    entries.push(e);
  });
  return Buffer.concat([header, ...entries, ...images]);
}

const ico = buildICO([16, 32, 48, 64, 128, 256]);
fs.writeFileSync(path.join(ASSETS, "slowly.ico"), ico);
fs.writeFileSync(path.join(ASSETS, "slowly-256.png"), encodePNG(256, renderIcon(256)));
fs.writeFileSync(path.join(ASSETS, "slowly-32.png"), encodePNG(32, renderIcon(32)));
console.log("icon.svg  " + fs.statSync(path.join(ASSETS, "slowly-icon.svg")).size + " 字节");
console.log("slowly.ico " + ico.length + " 字节（含 16/32/48/64/128/256）");
console.log("png 256   " + fs.statSync(path.join(ASSETS, "slowly-256.png")).size + " 字节");
