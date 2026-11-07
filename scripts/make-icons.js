'use strict';

// 零依赖图标生成器。
// 图形为原创矢量剪影，取基辅「祖国母亲像」（Батьківщина-Мати）的识别特征：
// 右手高举长剑、左手持盾、飘带与长袍。盾上的苏联国徽已于 2023 年换成三叉戟，
// 这里用简化的三叉戟镂空表示现状，不使用任何照片或第三方素材。
// 同一套形状同时输出 SVG、PWA 图标、Android launcher/adaptive/round 图标与启动屏。
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BG = '#1B3A63';
const FIG = '#F3E4BC';
const CUT = 'bg';
const BG_RGB = [0x1B, 0x3A, 0x63];
const FIG_RGB = [0xF3, 0xE4, 0xBC];
const TRANSPARENT = [0, 0, 0, 0];
const OPAQUE_BG = [...BG_RGB, 255];
const OPAQUE_FIG = [...FIG_RGB, 255];

// 512 × 512 虚拟坐标下的剪影，按绘制顺序排列；后绘制的覆盖先绘制的。
const SHAPES = [
  // 高举的长剑：剑身、护手、剑柄
  { t: 'p', c: FIG, p: [[153, 12], [161, 34], [168, 196], [150, 196], [143, 34]] },
  { t: 'p', c: FIG, p: [[126, 190], [198, 182], [200, 200], [128, 208]] },
  { t: 'p', c: FIG, p: [[154, 198], [168, 198], [170, 228], [156, 228]] },
  // 举剑的手臂
  { t: 'p', c: FIG, p: [[238, 152], [214, 164], [150, 200], [158, 226], [224, 194], [254, 178]] },
  // 向后飘的头巾
  { t: 'p', c: FIG, p: [[282, 98], [336, 82], [302, 116], [286, 134]] },
  // 头部
  { t: 'e', c: FIG, cx: 266, cy: 116, rx: 25, ry: 29 },
  // 颈肩
  { t: 'p', c: FIG, p: [[250, 138], [284, 138], [304, 164], [228, 164]] },
  // 长袍主体
  { t: 'p', c: FIG, p: [[230, 158], [300, 158], [318, 248], [336, 342], [354, 436], [304, 452], [256, 440], [208, 452], [170, 436], [190, 330], [206, 244]] },
  // 持盾的手臂
  { t: 'p', c: FIG, p: [[296, 156], [318, 168], [360, 238], [342, 256], [300, 196]] },
  // 盾
  { t: 'p', c: FIG, p: [[318, 214], [396, 214], [396, 282], [378, 310], [357, 332], [336, 310], [318, 282]] },
  // 盾上的三叉戟（镂空）
  { t: 'p', c: CUT, p: [[352, 238], [362, 238], [362, 292], [352, 292]] },
  { t: 'p', c: CUT, p: [[334, 242], [344, 242], [344, 278], [334, 278]] },
  { t: 'p', c: CUT, p: [[370, 242], [380, 242], [380, 278], [370, 278]] },
  { t: 'p', c: CUT, p: [[334, 286], [380, 286], [380, 296], [334, 296]] },
  // 长袍褶皱（镂空）
  { t: 'p', c: CUT, p: [[240, 206], [234, 420], [226, 420], [232, 206]] },
  { t: 'p', c: CUT, p: [[278, 202], [290, 424], [282, 424], [270, 202]] },
];

// 预计算包围盒，避免对每个像素都做完整多边形测试。
for (const s of SHAPES) {
  if (s.t === 'e') s.box = [s.cx - s.rx, s.cy - s.ry, s.cx + s.rx, s.cy + s.ry];
  else {
    const xs = s.p.map((p) => p[0]);
    const ys = s.p.map((p) => p[1]);
    s.box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
}
const FIG_BOX = [
  Math.min(...SHAPES.map((s) => s.box[0])) - 2,
  Math.min(...SHAPES.map((s) => s.box[1])) - 2,
  Math.max(...SHAPES.map((s) => s.box[2])) + 2,
  Math.max(...SHAPES.map((s) => s.box[3])) + 2,
];

function inPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function hit(s, x, y) {
  const b = s.box;
  if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return false;
  if (s.t === 'e') {
    const dx = (x - s.cx) / s.rx;
    const dy = (y - s.cy) / s.ry;
    return dx * dx + dy * dy <= 1;
  }
  return inPolygon(x, y, s.p);
}

// ------------------------------------------------------------------ PNG 编码
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(w, h, pixel) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (stride + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = row + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ 光栅化
// mode: rounded | round | maskable | foreground | splash
function background(px, py, w, h, mode) {
  if (mode === 'foreground') return TRANSPARENT;
  if (mode === 'round') {
    const r = Math.min(w, h) / 2;
    const dx = px - w / 2;
    const dy = py - h / 2;
    return dx * dx + dy * dy > r * r ? TRANSPARENT : OPAQUE_BG;
  }
  if (mode === 'rounded') {
    const r = Math.min(w, h) * (112 / 512);
    const cx = Math.min(Math.max(px, r), w - r);
    const cy = Math.min(Math.max(py, r), h - r);
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy > r * r ? TRANSPARENT : OPAQUE_BG;
  }
  return OPAQUE_BG; // maskable / splash 铺满
}

function figure(vx, vy, bgPix) {
  if (vx < FIG_BOX[0] || vx > FIG_BOX[2] || vy < FIG_BOX[1] || vy > FIG_BOX[3]) return bgPix;
  for (let i = SHAPES.length - 1; i >= 0; i--) {
    const s = SHAPES[i];
    if (hit(s, vx, vy)) return s.c === CUT ? bgPix : OPAQUE_FIG;
  }
  return bgPix;
}

function raster(w, h, mode, scale, supersample) {
  const side = Math.min(w, h) * scale; // 图形在物理画布上占据的边长
  const samples = supersample ? [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] : [[0.5, 0.5]];
  return encodePng(w, h, (x, y) => {
    const acc = [0, 0, 0, 0];
    for (const [ox, oy] of samples) {
      const px = x + ox;
      const py = y + oy;
      const bgPix = background(px, py, w, h, mode);
      const vx = (px - w / 2) / side * 512 + 256;
      const vy = (py - h / 2) / side * 512 + 256;
      const c = figure(vx, vy, bgPix);
      for (let k = 0; k < 4; k++) acc[k] += c[k];
    }
    return acc.map((v) => Math.round(v / samples.length));
  });
}

function write(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return `${path.relative(ROOT, file)} (${buf.length}B)`;
}

// ------------------------------------------------------------------ 矢量输出
function polyToPath(pts) {
  return `M${pts.map((p) => p.join(',')).join('L')}Z`;
}
function ellipseToPoly(s) {
  const pts = [];
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    pts.push([+(s.cx + s.rx * Math.cos(a)).toFixed(2), +(s.cy + s.ry * Math.sin(a)).toFixed(2)]);
  }
  return pts;
}

function buildSvg() {
  const body = SHAPES.map((s) => {
    const color = s.c === CUT ? BG : s.c;
    return s.t === 'e'
      ? `  <ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}" fill="${color}"/>`
      : `  <path d="${polyToPath(s.p)}" fill="${color}"/>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="基辅祖国母亲像剪影">\n`
    + `  <rect width="512" height="512" rx="112" fill="${BG}"/>\n${body}\n</svg>\n`;
}

function buildVectorXml() {
  const paths = SHAPES.map((s) => {
    const color = s.c === CUT ? BG : s.c;
    const d = polyToPath(s.t === 'e' ? ellipseToPoly(s) : s.p);
    return `    <path android:fillColor="${color}" android:pathData="${d}"/>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n`
    + `<vector xmlns:android="http://schemas.android.com/apk/res/android"\n`
    + `    android:width="108dp" android:height="108dp"\n`
    + `    android:viewportWidth="512" android:viewportHeight="512">\n`
    + `${paths}\n</vector>\n`;
}

// ------------------------------------------------------------------ 生成
const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const made = [];

made.push(write(path.join(WWW, 'icon.svg'), Buffer.from(buildSvg(), 'utf8')));
for (const size of [192, 512]) {
  made.push(write(path.join(WWW, `icon-${size}.png`), raster(size, size, 'rounded', 1, true)));
}
made.push(write(path.join(WWW, 'icon-maskable-512.png'), raster(512, 512, 'maskable', 0.72, true)));

// Android launcher：PNG 用于 API < 26 与圆形图标；foreground 用于 adaptive icon。
const DENS = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, size] of Object.entries(DENS)) {
  const dir = path.join(RES, `mipmap-${d}`);
  made.push(write(path.join(dir, 'ic_launcher.png'), raster(size, size, 'rounded', 1, true)));
  made.push(write(path.join(dir, 'ic_launcher_round.png'), raster(size, size, 'round', 1, true)));
  const fg = Math.round(size * 2.25); // 108dp 对应 2.25 × launcher 尺寸
  made.push(write(path.join(dir, 'ic_launcher_foreground.png'), raster(fg, fg, 'foreground', 0.58, true)));
}

// 启动屏：沿用 Capacitor 原有各密度尺寸，深蓝底 + 居中剪影。
const SPLASH = [
  ['drawable', 480, 320],
  ['drawable-land-mdpi', 480, 320], ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720], ['drawable-land-xxhdpi', 1600, 960],
  ['drawable-land-xxxhdpi', 1920, 1280],
  ['drawable-port-mdpi', 320, 480], ['drawable-port-hdpi', 480, 800],
  ['drawable-port-xhdpi', 720, 1280], ['drawable-port-xxhdpi', 960, 1600],
  ['drawable-port-xxxhdpi', 1280, 1920],
];
for (const [d, w, h] of SPLASH) {
  made.push(write(path.join(RES, d, 'splash.png'), raster(w, h, 'splash', 0.5, false)));
}

made.push(write(path.join(RES, 'drawable-v24', 'ic_launcher_foreground.xml'), Buffer.from(buildVectorXml(), 'utf8')));
made.push(write(path.join(RES, 'drawable', 'ic_launcher_background.xml'), Buffer.from(
  `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android"\n`
  + `    android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">\n`
  + `    <path android:fillColor="${BG}" android:pathData="M0,0h108v108h-108z"/>\n</vector>\n`, 'utf8')));
made.push(write(path.join(RES, 'values', 'ic_launcher_background.xml'), Buffer.from(
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG}</color>\n</resources>\n`, 'utf8')));

console.log(`生成 ${made.length} 个图标资源（祖国母亲像剪影）`);
for (const m of made) console.log('  ' + m);
