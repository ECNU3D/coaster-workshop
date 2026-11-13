// 轨道生成：一键生成整条轨道、把手绘的路线变成轨道、在专业模式里插入回环等元素
import * as THREE from 'three';
import { clamp, lerp, mulberry32, DEG, wrapDeg } from './util.js';
import { G } from './sim.js';

export const GEN_STYLES = [
  { id: 'family', name: '家庭型', desc: '坡度平缓，没有翻转，适合所有人', H: [14, 19], rows: 2, d: [38, 44], rowMin: 80, elements: [[], []] },
  { id: 'thrill', name: '惊险型', desc: '35 米左右的落差，带一个垂直回环', H: [30, 40], rows: 4, rowsOpt: [4, 4, 2], d: [42, 50], rowMin: 110, elements: [[], ['loop'], [], []], helix: true },
  { id: 'extreme', name: '极限型', desc: '60 米左右的落差，两个回环加一个翻滚', H: [55, 68], rows: 4, rowsOpt: [4, 4, 2], d: [48, 56], rowMin: 150, elements: [[], ['loop'], ['roll', 'loop'], []], helix: true },
  // 下面这种只给“水晶矿山”主题用，不在一键生成里单独列出
  { id: 'minetrain', name: '矿山列车', hidden: true, H: [22, 28], rows: 4, rowsOpt: [4, 4, 2], d: [40, 46], rowMin: 110, elements: [[], [], [], []], helix: true },
  { id: 'launch', name: '弹射型', desc: '不用爬坡，从站台直接加速到 120 公里以上', launch: true, v: [33, 38], rows: 4, rowsOpt: [4, 4, 2], d: [48, 56], rowMin: 150, elements: [[], ['loop'], ['roll'], []], helix: true },
];

// 坡度先逐渐变陡、保持一段、再逐渐放平的过渡曲线。a 是起始过渡段的比例，b 是结束过渡段的比例
export function sCurve(t, a, b) {
  if (a <= 0 && b <= 0) return t;
  const m = 1 / (1 - a / 2 - b / 2);
  if (t < a) return (m * t * t) / (2 * a);
  if (t <= 1 - b) return m * (t - a / 2);
  const u = 1 - t;
  return 1 - (m * u * u) / (2 * b);
}

// 在低处和高处之间过渡需要多长的水平距离，以及两端的圆弧各占多少。
// E 是列车的能量高度（相对站台），车速越快，圆弧就要越大，这样谷底不超过 3.5G，坡顶不低于 -0.3G
export function transition(hLow, hHigh, E) {
  const dh = Math.max(0.01, hHigh - hLow);
  const kLow = Math.max(E - hLow, dh * 0.6 + 2, 3), kHigh = Math.max(E - hHigh, 4);
  let sm = Math.sqrt(dh / (0.4 * kLow + 0.77 * kHigh));
  let extra = 0;
  if (sm > 1.45) {
    sm = 1.45;
    extra = Math.max(0, dh / sm - (sm * (kLow * 0.8 + kHigh * 1.54)) / 2);
  }
  const Lv = sm * kLow * 0.8, Lc = sm * kHigh * 1.54;
  const total = Lv + Lc + extra;
  return { len: Math.max(6, total), low: Lv / total, high: Lc / total };
}

// 水滴形回环的形状：底部半径大、顶部半径小，这样进出回环时 G 力不会太高
function loopShape(E) {
  const rb = Math.max(9, 0.6 * E), rt = Math.max(4.5, 0.3 * rb);
  const pts = [];
  let x = 0, y = 0;
  const steps = 360;
  for (let i = 1; i <= steps; i++) {
    const ph = ((i - 0.5) / steps) * Math.PI * 2;
    const u = (1 + Math.cos(ph)) / 2;
    // 进出回环的头 30 度，弯曲程度从四成逐渐加到十成，避免 G 力突然跳上去
    const edge = Math.min(ph, Math.PI * 2 - ph) / 0.52;
    const w = 0.4 + 0.6 * Math.min(1, edge) * Math.min(1, edge) * (3 - 2 * Math.min(1, edge));
    const rho = (rt + (rb - rt) * Math.pow(u, 1.2)) / w;
    const dphi = (Math.PI * 2) / steps;
    x += rho * Math.cos(ph) * dphi;
    y += rho * Math.sin(ph) * dphi;
    if (i % 18 === 0) pts.push({ x, y: i === steps ? 0 : y, t: i / steps });
  }
  return { pts, advance: x };
}
const loopAdvance = (E) => loopShape(E).advance;

class Turtle {
  constructor(x, z, yaw, h) {
    this.x = x; this.z = z; this.yaw = yaw; this.h = h;
    this.nodes = [{ x, y: h, z, roll: 0, kind: 'normal', auto: true }];
  }
  get last() {
    return this.nodes[this.nodes.length - 1];
  }
  push(x, y, z, kind, roll = 0, auto = true) {
    this.nodes.push({ x, y, z, roll, kind, auto });
  }
  shape(endH, opt) {
    if (opt.a !== undefined) return opt;
    return { a: 0, b: 0 };
  }
  // 按车速自动选择合适的长度和弧度，过渡到新的高度
  go(endH, E, stretch = 1) {
    if (Math.abs(endH - this.h) < 0.05) return 0;
    const up = endH > this.h;
    const tr = up ? transition(this.h, endH, E) : transition(endH, this.h, E);
    const len = tr.len * stretch;
    this.straight(len, endH, { a: up ? tr.low : tr.high, b: up ? tr.high : tr.low, step: 9 });
    return len;
  }
  straight(len, endH = this.h, opt = {}) {
    const kind = opt.kind || 'normal';
    const { a, b } = this.shape(endH, opt);
    this.last.kind = kind;
    const n = Math.max(a > 0 || b > 0 ? 5 : 1, Math.round(len / (opt.step || 10)));
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const x0 = this.x, z0 = this.z, h0 = this.h;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      this.push(x0 + c * len * t, lerp(h0, endH, sCurve(t, a, b)), z0 + s * len * t, kind);
    }
    this.x = x0 + c * len; this.z = z0 + s * len; this.h = endH;
  }
  turn(angleDeg, r, endH = this.h, opt = {}) {
    const { a, b } = this.shape(endH, opt);
    this.last.kind = 'normal';
    const ang = angleDeg * DEG, sg = Math.sign(ang);
    const n = Math.max(2, Math.ceil(Math.abs(angleDeg) / 30), Math.ceil((Math.abs(ang) * r) / 13));
    const cx = this.x - Math.sin(this.yaw) * sg * r, cz = this.z + Math.cos(this.yaw) * sg * r;
    const px = this.x - cx, pz = this.z - cz, h0 = this.h;
    for (let i = 1; i <= n; i++) {
      const t = i / n, q = ang * t;
      this.push(cx + px * Math.cos(q) - pz * Math.sin(q), lerp(h0, endH, sCurve(t, a, b)), cz + px * Math.sin(q) + pz * Math.cos(q), 'normal');
    }
    this.x = this.last.x; this.z = this.last.z; this.yaw += ang; this.h = endH;
  }
  hill(peak, endH, E, stretch = 1) {
    this.go(peak, E, stretch);
    this.go(endH, E, stretch);
  }
  loop(E, side, shift) {
    const shp = loopShape(E);
    this.last.kind = 'normal';
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const lx = -s * side, lz = c * side;
    for (const p of shp.pts) {
      const lat = shift * p.t * p.t * (3 - 2 * p.t);
      this.push(this.x + c * p.x + lx * lat, this.h + p.y, this.z + s * p.x + lz * lat, 'normal');
    }
    this.x += c * shp.advance + lx * shift;
    this.z += s * shp.advance + lz * shift;
    this.last.x = this.x; this.last.z = this.z; this.last.y = this.h;
  }
  roll(len, side) {
    this.last.kind = 'normal';
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const x0 = this.x, z0 = this.z;
    for (let i = 1; i <= 5; i++) {
      const t = i / 5;
      this.push(x0 + c * len * t, this.h + (1 - Math.cos(Math.PI * 2 * t)) * 0.4, z0 + s * len * t, 'normal', i < 5 ? side * 72 * i : 0, i === 5);
    }
    this.x = x0 + c * len; this.z = z0 + s * len;
  }
}

function buildLayout(st, seed, hf, hang, half) {
  const R = mulberry32(seed);
  const rand = (a, b) => a + (b - a) * R();
  const vy = hang ? 1.0 : 1.5;
  let H, v0 = 0;
  if (st.launch) {
    v0 = rand(st.v[0], st.v[1]);
    H = ((v0 * v0 - 100) / (2 * G)) * 0.86;
  } else {
    H = rand(st.H[0], st.H[1]);
  }
  const d = rand(st.d[0], st.d[1]) + Math.max(0, half - 1.2) * 2;
  const mirror = R() < 0.5 ? -1 : 1;
  const rot = R() * Math.PI * 2;
  const shift = Math.max(3.6, 2 * half + 1.4);
  // 这条轨道的配置：排几排、回环和翻滚放在哪一排、螺旋放在哪个弯、驼峰和掉头弯有多高
  const rows = st.rowsOpt ? st.rowsOpt[Math.floor(R() * st.rowsOpt.length)] : st.rows;
  const elements = Array.from({ length: rows }, () => []);
  const pool = (st.elements || []).flat();
  for (const el of pool) {
    if (pool.length > 1 && R() < 0.18) continue;
    const k = Math.min(rows - 1, 1 + Math.floor(R() * R() * (rows - 1)));
    if (R() < 0.5) elements[k].push(el);
    else elements[k].unshift(el);
  }
  const helixAt = st.helix && rows > 2 ? Math.floor(R() * 3) : 0;
  const hillK = rand(0.3, 0.45), turnK = rand(0.38, 0.5);
  const rowMin = st.rowMin * (rows === 2 && st.rows > 2 ? rand(1.6, 2.0) : rand(1.0, 1.25));
  const brakeLen = st.launch ? 36 : H > 45 ? 40 : H > 25 ? 30 : 22;

  const hillLen = (peak, low, e) => transition(low, peak, e).len + transition(low + 0.5, peak, e).len;

  // 先估算每一排需要多长
  const plan = [];
  // 提升段顶上的掉头弯一路略微下坡，列车不会在上面越走越慢
  let E = H * 0.95, hs = H - 3;
  for (let k = 1; k < rows; k++) {
    const els = elements[k] || [];
    const last = k === rows - 1;
    let useHelix = false;
    const ht = last ? 0.5 : hf * turnK * E + vy;
    if (!last && k === helixAt && ht - 12 >= vy + 3) useHelix = true;
    const Ein = Math.max(E, hs);
    let need = transition(vy, hs, Ein).len;
    let eE = E;
    const items = [];
    for (const el of els) {
      if (el === 'loop') {
        const le = eE * Math.min(1, 0.7 + 0.3 * hf) * 0.93;
        items.push({ type: 'loop', E: le });
        need += loopAdvance(le) + 14;
        eE *= 0.95;
      } else if (el === 'roll') {
        items.push({ type: 'roll', len: 38 });
        need += 38 + 12;
      }
    }
    const climb = last ? 14 : transition(vy, ht, eE).len;
    need += climb;
    plan.push({ k, hs, ht, Ein, E: eE, items, need, climb, last, useHelix });
    hs = useHelix ? ht - 12 : ht;
    E = eE * 0.9;
  }
  let row0;
  if (st.launch) {
    const Ll = (v0 * v0) / (2 * 13) + 10;
    const Lc = transition(0, H, (v0 * v0) / (2 * G)).len;
    row0 = { Ll, need: brakeLen + 24 + 8 + Ll + Lc + 8 };
  } else {
    const liftL = (1.136 * H) / Math.tan(38 * DEG);
    row0 = { liftL, need: brakeLen + 24 + 8 + liftL + 8 };
  }
  let Lrow = Math.max(rowMin, row0.need);
  for (const p of plan) Lrow = Math.max(Lrow, p.need + 6);
  Lrow = Math.ceil(Lrow);

  // 第 0 排：刹车、站台、提升或弹射
  const t = new Turtle(0, 0, 0, 0);
  t.straight(brakeLen, 0, { kind: 'brake', step: 12 });
  t.straight(24, 0, { kind: 'station', step: 12 });
  t.straight(8, 0);
  if (st.launch) {
    t.straight(row0.Ll, 0, { kind: 'launch', step: 14 });
    t.go(H, (v0 * v0) / (2 * G));
  } else {
    t.straight(row0.liftL, H, { kind: 'lift', a: 0.12, b: 0.12, step: 10 });
  }
  t.straight(Math.max(4, Lrow - t.x), H, st.launch ? {} : { kind: 'lift', step: 12 });

  for (const p of plan) {
    const k = p.k;
    // 掉头弯
    const targetZ = -mirror * k * d;
    const sign = k % 2 === 1 ? -mirror : mirror;
    const r = Math.abs(targetZ - t.z) / 2;
    const prev = plan[k - 2];
    if (prev && prev.useHelix) t.turn(sign * 540, r, t.h - 12, { a: 0.3, b: 0.3 });
    else t.turn(sign * 180, r, k === 1 ? t.h - 3 : t.h, { a: 0.3, b: 0.3 });
    // 这一排：俯冲、各种元素、驼峰、再爬升到下一个弯的高度
    let extra = Lrow - p.need;
    const hills = [];
    let hillE = p.E * 0.94;
    while (true) {
      const peak = vy + hf * (p.last ? hillK * 0.9 : hillK) * hillE;
      const L = hillLen(peak, vy, hillE);
      if (extra < L + 4 || peak - vy < 2.5) break;
      hills.push({ peak, E: hillE });
      extra -= L;
      hillE *= 0.9;
    }
    const dropL = transition(vy, t.h, p.Ein).len;
    const flexTotal = dropL + p.climb + hills.reduce((sum, h) => sum + hillLen(h.peak, vy, h.E), 0);
    const stretch = 1 + Math.max(0, extra) / flexTotal;
    t.go(vy, p.Ein, stretch);
    const side = k % 2 === 1 ? -mirror : mirror;
    for (const it of p.items) {
      if (it.type === 'loop') {
        t.straight(6, vy);
        t.loop(it.E, side, shift);
        t.straight(8, vy);
      } else if (it.type === 'roll') {
        t.straight(6, vy);
        t.roll(it.len, side);
        t.straight(6, vy);
      }
    }
    for (const h of hills) t.hill(h.peak, vy + 0.5, h.E, stretch);
    if (p.last) t.straight(p.climb * stretch, 0.5, { a: 0.3, b: 0.3 });
    else t.go(p.ht, p.E, stretch);
    // 因为元素的长度估算有误差，这里把这一排补齐到统一的长度
    const endX = k % 2 === 1 ? 0 : Lrow;
    const gap = k % 2 === 1 ? t.x - endX : endX - t.x;
    if (gap > 7) t.straight(gap, t.h);
    else {
      // 差得不多就直接挪动最后一个节点，避免出现两个挨得很近的节点
      t.last.x = endX;
      t.x = endX;
    }
  }
  // 最后一个大弯回到刹车段
  const rBig = Math.abs(t.z) / 2;
  const signBig = rows % 2 === 0 ? -mirror : mirror;
  if (rows > 1) t.turn(signBig * 180, rBig, 0, { a: 0.3, b: 0.3 });
  const nodes = t.nodes;
  const first = nodes[0], end = nodes[nodes.length - 1];
  if (Math.hypot(end.x - first.x, end.z - first.z) < 3) nodes.pop();

  // 居中并旋转一个随机角度
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  for (const n of nodes) {
    const x = n.x - cx, z = n.z - cz;
    n.x = x * cr - z * sr;
    n.z = x * sr + z * cr;
  }
  return { nodes, launchSpeed: v0, H };
}

function applyNodes(track, nodes, clear) {
  const world = track.world;
  let base = -1e9;
  for (const n of nodes) base = Math.max(base, world.surfaceAt(n.x, n.z) - Math.max(0, n.y - 6) * 0.5);
  base += clear;
  track.nodes = nodes.map((n) => ({ p: new THREE.Vector3(n.x, n.y + base, n.z), roll: n.roll || 0, kind: n.kind || 'normal', auto: n.auto !== false, scene: '' }));
}

// 给一条生成好的轨道打分：0 分表示 G 力都在合适的范围里，分数越高越不舒服
function badness(a) {
  if (!a) return 1000;
  if (a.stalledAt >= 0) return 500;
  return Math.max(0, a.maxG - 5.2) + Math.max(0, -a.minG - 1.6) + Math.max(0, a.maxLat - 1.7);
}

// 一键生成整条轨道。同一种类型每次的布局都不一样：有时是来回折返的几排，有时是一条形状不规则的环线。
// 每次会试几个候选，留下 G 力最合适的那条
export function generateTrack(track, styleId, seed, opts = {}) {
  const st = GEN_STYLES.find((s) => s.id === styleId) || GEN_STYLES[1];
  let best = null;
  for (let c = 0; c < 5; c++) {
    generateOnce(track, st, (seed + c * 104729) >>> 0, opts);
    const score = badness(track.analysis);
    if (!best || score < best.score) best = { score, nodes: track.toJSON().nodes, launch: track.opts.launchSpeed };
    if (score <= 0) break;
  }
  if (best.score > 0) {
    track.fromJSON({ nodes: best.nodes });
    track.opts.launchSpeed = best.launch;
    track.compute();
  }
  return st;
}

function generateOnce(track, st, seed, opts) {
  const hang = track.opts.hang, half = track.opts.halfWidth;
  const clear = hang ? 5.2 : 2.2;
  const pick = mulberry32((seed ^ 0x5bd1e995) >>> 0);
  const chance = st.launch || st.id === 'extreme' ? 0.3 : 0.45;
  const organic = opts.layout === 'organic' || (opts.layout !== 'rows' && pick() < chance);
  if (organic && generateOrganic(track, st, seed)) return;
  let hf = 1, result = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    result = buildLayout(st, seed, hf, hang, half);
    if (result.launchSpeed) track.opts.launchSpeed = Math.round(result.launchSpeed);
    applyNodes(track, result.nodes, clear);
    track.compute();
    if (track.analysis && track.analysis.stalledAt < 0) break;
    hf *= 0.88;
  }
}

// 自由形状的环线：先随机画一个不规则的闭合圈，再沿着它安排爬升、俯冲和驼峰
function generateOrganic(track, st, seed) {
  const R = mulberry32((seed + 9173) >>> 0);
  const rand = (a, b) => a + (b - a) * R();
  let H, v0 = 0;
  if (st.launch) {
    v0 = rand(st.v[0], st.v[1]);
    H = ((v0 * v0 - 100) / (2 * G)) * 0.86;
  } else {
    H = rand(st.H[0], st.H[1]);
  }
  const Lp = (13 * H + 300) * rand(0.9, 1.35);
  // 圆圈上叠加几个不同周期的起伏，再压扁一点、转一个角度
  const harm = [];
  const wavy = st.launch || st.id === 'extreme' ? 0.26 : 0.42;
  for (let k = 2; k <= 5; k++) harm.push([k, rand(0, wavy / k), rand(0, Math.PI * 2)]);
  const sx = rand(0.68, 1), rot = rand(0, Math.PI * 2), dir = R() < 0.5 ? -1 : 1;
  const raw = [];
  const M = 200;
  for (let i = 0; i < M; i++) {
    const th = (i / M) * Math.PI * 2 * dir;
    let r = 1;
    for (const [k, a, ph] of harm) r += a * Math.cos(k * th + ph);
    const x = Math.cos(th) * r * sx, z = Math.sin(th) * r;
    raw.push({ x: x * Math.cos(rot) - z * Math.sin(rot), z: x * Math.sin(rot) + z * Math.cos(rot) });
  }
  let per = 0;
  for (let i = 0; i < M; i++) per += Math.hypot(raw[(i + 1) % M].x - raw[i].x, raw[(i + 1) % M].z - raw[i].z);
  const k = Lp / per;
  let cx = 0, cz = 0;
  for (const p of raw) { cx += p.x; cz += p.z; }
  cx /= M; cz /= M;
  const pts = raw.map((p) => ({ x: (p.x - cx) * k, z: (p.z - cz) * k }));
  const hasRoll = (st.elements || []).flat().includes('roll') || (st.elements || []).flat().includes('loop');
  const res = planToTrack(track, pts, { H, launchV: v0, rng: R, rolls: hasRoll ? 1 + Math.floor(R() * 2) : 0, minLen: 0, gentle: 1.35 });
  if (!res.ok || !track.analysis || track.analysis.stalledAt >= 0) return false;
  if (v0) track.opts.launchSpeed = Math.round(v0);
  return true;
}

// 把手绘的闭合路线变成轨道。points 是地面上的一串点 [{x, z}]
export function trackFromPlan(track, points) {
  const hang = track.opts.hang;
  const clear = hang ? 5.2 : 2.2;
  // 重新采样成间隔 4 米的点，再做几遍平滑
  const resample = (pts, step) => {
    const out = [];
    let acc = 0;
    const n = pts.length;
    out.push({ x: pts[0].x, z: pts[0].z });
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      if (seg < 1e-6) continue;
      let dpos = step - acc;
      while (dpos <= seg) {
        const t = dpos / seg;
        out.push({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) });
        dpos += step;
      }
      acc = seg - (dpos - step);
    }
    return out;
  };
  let pts = resample(points, 4);
  if (pts.length < 20) return { ok: false, reason: '画的圈太小了，请画一个更大的闭合路线。' };
  for (let pass = 0; pass < 4; pass++) {
    const n = pts.length;
    const next = [];
    for (let i = 0; i < n; i++) {
      let sx = 0, sz = 0;
      for (let j = -3; j <= 3; j++) {
        const p = pts[(i + j + n) % n];
        sx += p.x; sz += p.z;
      }
      next.push({ x: sx / 7, z: sz / 7 });
    }
    pts = next;
  }
  pts = resample(pts, 4);
  return planToTrack(track, pts, {});
}

// 沿着一条闭合的平面路线生成轨道。opts：H 提升高度，launchV 弹射速度（有就用弹射代替提升），rng 随机数，rolls 翻滚的个数
function planToTrack(track, pts, opts) {
  const hang = track.opts.hang;
  const clear = hang ? 5.2 : 2.2;
  const rnd = opts.rng || null;
  const n = pts.length;
  const cum = [0];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const Lp = cum[n];
  if (Lp < (opts.minLen ?? 240)) return { ok: false, reason: '路线太短了，至少需要 240 米左右，请画大一些。' };
  const ratios = rnd ? Array.from({ length: 6 }, () => 0.34 + rnd() * 0.26) : [0.55, 0.42, 0.5, 0.38];
  const rollAt = rnd ? Array.from({ length: opts.rolls || 0 }, () => Math.floor(rnd() * 4)) : [];
  const at = (s) => {
    s = clamp(s, 0, Lp - 0.001);
    let lo = 0, hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid; else hi = mid;
    }
    const a = pts[lo], b = pts[(lo + 1) % n];
    const t = (s - cum[lo]) / Math.max(1e-6, cum[lo + 1] - cum[lo]);
    return { x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) };
  };

  const build = (hf) => {
    const vy = hang ? 1.0 : 1.5;
    const brakeLen = clamp(Lp * 0.04, 18, 36);
    const gentle = opts.gentle || 1;
    const tr = (lo, hi, e) => transition(lo, hi, e * gentle);
    let H = (opts.H || clamp(Lp * 0.07, 10, 60)) * (opts.launchV ? Math.sqrt(hf) : 1);
    const launchV = opts.launchV || 0;
    const fixed = 22 + 8;
    const liftOf = (hh) => (1.136 * hh) / Math.tan(36 * DEG);
    // 沿路线的高度分段：[长度, 结束高度, 过渡形状, 段类型]
    const segs = [];
    segs.push([22, 0, null, 'station']);
    segs.push([8, 0, null, 'normal']);
    let used;
    if (launchV) {
      const Ll = (launchV * launchV) / (2 * 13) + 10;
      const E0 = (launchV * launchV) / (2 * G);
      while (H > 10 && fixed + Ll + tr(0, H, E0).len + 8 + tr(vy, H, H).len + brakeLen + 40 > Lp) H -= 1;
      const climb = tr(0, H, E0);
      segs.push([Ll, 0, null, 'launch']);
      segs.push([climb.len, H, { a: climb.low, b: climb.high }, 'normal']);
      segs.push([8, H, null, 'normal']);
      used = fixed + Ll + climb.len + 8;
    } else {
      while (H > 8 && fixed + liftOf(H) + 8 + tr(vy, H, H).len + brakeLen + 40 > Lp) H -= 1;
      const liftL = liftOf(H);
      segs.push([liftL, H, { a: 0.12, b: 0.12 }, 'lift']);
      segs.push([8, H, null, 'normal']);
      used = fixed + liftL + 8;
    }
    const crests = [];
    const endReserve = brakeLen + 14;
    let E = H * 0.95;
    // 列车每跑一米损失的能量高度：滚动阻力是固定的，空气阻力随速度增加
    const loss = (len) => len * (0.012 + 0.00045 * Math.max(E, 0));
    const d0 = tr(vy, H, H);
    segs.push([d0.len, vy, { a: d0.high, b: d0.low }, 'normal']);
    used += d0.len;
    E -= loss(d0.len);
    for (let i = 0; ; i++) {
      // 驼峰的高度按列车剩余的能量来定
      const peak = vy + hf * ratios[i % ratios.length] * E;
      const up = tr(vy, peak, E);
      if (used + up.len * 2 + endReserve > Lp || peak - vy < 2.5) break;
      segs.push([up.len, peak, { a: up.low, b: up.high }, 'normal']);
      segs.push([up.len, vy, { a: up.high, b: up.low }, 'normal']);
      crests.push(used + up.len);
      used += up.len * 2;
      E -= loss(up.len * 2);
    }
    const rest = Math.max(5, Lp - used - brakeLen);
    segs.push([rest, 0, { a: 0.3, b: 0.3 }, 'normal']);
    segs.push([brakeLen, 0, null, 'brake']);
    const nodes = [];
    let s0 = 0, h0 = 0;
    for (const [len, h1, shp, kind] of segs) {
      const cnt = Math.max(shp ? 4 : 1, Math.round(len / 9));
      for (let i = 0; i < cnt; i++) {
        const t = i / cnt;
        const p = at(s0 + len * t);
        const e = shp ? sCurve(t, shp.a, shp.b) : t;
        nodes.push({ x: p.x, y: lerp(h0, h1, e), z: p.z, roll: 0, kind, auto: true, s: s0 + len * t });
      }
      s0 += len;
      h0 = h1;
    }
    // 在几个坡顶做一圈翻滚
    for (const ci of rollAt) {
      const sc = crests[ci];
      if (sc === undefined) continue;
      for (const nd of nodes) {
        const f = (nd.s - (sc - 18)) / 36;
        if (f > 0.02 && f < 0.98) {
          nd.roll = wrapDeg(360 * f);
          nd.auto = false;
        }
      }
    }
    return nodes;
  };

  let hf = 1;
  for (let attempt = 0; attempt < 8; attempt++) {
    applyNodes(track, build(hf), clear);
    track.compute();
    if (track.analysis && track.analysis.stalledAt < 0) break;
    hf *= 0.85;
  }
  return { ok: true, length: Lp };
}

// 专业模式：在第 i 个节点和下一个节点之间插入一个元素。返回新插入节点的下标范围
export function insertElement(track, i, type) {
  const nodes = track.nodes;
  const n = nodes.length;
  if (n < 4) return null;
  const A = nodes[i], B = nodes[(i + 1) % n];
  const dir = new THREE.Vector3(B.p.x - A.p.x, 0, B.p.z - A.p.z);
  const dist = dir.length();
  if (dist < 1) return null;
  dir.normalize();
  const lat = new THREE.Vector3(-dir.z, 0, dir.x);
  const mk = (p, roll = 0, auto = true) => ({ p, roll, kind: A.kind === 'station' ? 'normal' : A.kind, auto });
  const added = [];
  const P = (f, up, side = 0) => new THREE.Vector3(
    A.p.x + dir.x * f + lat.x * side,
    lerp(A.p.y, B.p.y, clamp(f / dist, 0, 1)) + up,
    A.p.z + dir.z * f + lat.z * side,
  );
  // 用测试数据估算列车开到这里的速度
  let v = 15;
  if (track.profile && track.nodeS[i] !== undefined) {
    const k = Math.min(track.N - 1, Math.round(track.nodeS[i] / track.ds));
    v = track.profile.v[k] || 15;
  }
  const E = clamp((v * v) / (2 * G), 10, 70);
  if (type === 'hill') {
    const h = clamp(dist * 0.22, 3, 16);
    added.push(mk(P(dist * 0.25, h * 0.5)), mk(P(dist * 0.5, h)), mk(P(dist * 0.75, h * 0.5)));
  } else if (type === 'loop') {
    const shp = loopShape(E * 0.9);
    const shift = Math.max(3.6, 2 * track.opts.halfWidth + 1.4);
    const start = (dist - shp.advance) / 2;
    added.push(mk(P(start, 0, -shift / 2)));
    const baseY = added[0].p.y;
    for (const p of shp.pts) {
      const q = P(start + p.x, 0, -shift / 2 + shift * p.t * p.t * (3 - 2 * p.t));
      q.y = baseY + p.y;
      added.push(mk(q));
    }
  } else if (type === 'roll') {
    for (let k = 1; k <= 4; k++) {
      added.push(mk(P((dist * k) / 5, Math.sin((Math.PI * k) / 5) * 2), 72 * k, false));
    }
  } else if (type === 'helix') {
    const r = clamp(v * v / (2.5 * G), 9, 22);
    const mid = dist / 2;
    const rise = 8;
    for (let k = 0; k <= 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      const q = P(mid + Math.sin(ang) * r, (rise * k) / 8, r * (1 - Math.cos(ang)));
      added.push(mk(q));
    }
  } else return null;
  nodes.splice(i + 1, 0, ...added);
  return { from: i + 1, to: i + added.length };
}

// 默认轨道：第一次打开游戏时看到的那条
export function defaultTrack(track) {
  return generateTrack(track, 'thrill', 20241);
}

// 一键生成的主题过山车。每一项都给出几种可选的搭配，生成时随机挑一种，所以每次的结果都不一样。
// gens 布局类型，envs 环境，time 时间范围，weathers 天气，trains 列车，tracks 轨道外观，
// scene 主要的场景，extra 有时会混进来的第二种场景，cover 场景段占全长的比例范围
export const THEME_PRESETS = [
  {
    id: 'mine', name: '水晶矿山', desc: '木质矿车钻进山洞，洞里有提灯和发光的水晶', scene: 'mine', extra: ['jungle'], cover: [0.3, 0.55],
    gens: ['minetrain', 'minetrain', 'family', 'thrill'], envs: ['meadow', 'meadow', 'desert', 'snow'], time: [9, 18.2], weathers: ['clear', 'clear', 'cloudy', 'fog'],
    trains: [
      { theme: 'mine', seat: 'sit', body: '#7a5230', accent: '#d4a017', seatColor: '#3a2a1c', material: 'wood' },
      { theme: 'mine', seat: 'sit', body: '#5d4630', accent: '#c0c6cc', seatColor: '#2b2622', material: 'wood' },
      { theme: 'mine', seat: 'sit', body: '#8a3324', accent: '#e2b93b', seatColor: '#2a1d16', material: 'matte' },
    ],
    tracks: [
      { style: 'wood', material: 'paint', railColor: '#c0c6cc', spineColor: '#7a4a2a', supportColor: '#8a623c', lights: 'night', lightColor: '#ffb060' },
      { style: 'truss', material: 'matte', railColor: '#6b3f24', spineColor: '#4a2c1a', supportColor: '#7c6a58', lights: 'night', lightColor: '#ffb060' },
      { style: 'wood', material: 'paint', railColor: '#3a3f47', spineColor: '#5d4630', supportColor: '#6f4d2e', lights: 'night', lightColor: '#ffd27a' },
    ],
  },
  {
    id: 'neon', name: '霓虹赛道', desc: '弹射起步冲进黑色隧道，光环和灯带向后流动', scene: 'neon', extra: ['space'], cover: [0.3, 0.5],
    gens: ['launch', 'launch', 'extreme', 'thrill'], envs: ['city', 'city', 'volcano'], time: [19.6, 23.5], weathers: ['clear', 'clear', 'rain', 'cloudy'],
    trains: [
      { theme: 'cyber', seat: 'sit', body: '#12141c', accent: '#00e5ff', seatColor: '#1b1e28', material: 'matte' },
      { theme: 'cyber', seat: 'sit', body: '#14101f', accent: '#ff2bd6', seatColor: '#1f1830', material: 'matte' },
      { theme: 'cyber', seat: 'wing', body: '#0e1512', accent: '#5dff9a', seatColor: '#18221c', material: 'carbon' },
      { theme: 'cyber', seat: 'invert', body: '#101622', accent: '#ffd23f', seatColor: '#1a2030', material: 'matte' },
    ],
    tracks: [
      { style: 'box', material: 'neon', railColor: '#00e5ff', spineColor: '#161a24', supportColor: '#2b303b', lights: 'on', lightColor: '#00e5ff' },
      { style: 'mono', material: 'neon', railColor: '#ff2bd6', spineColor: '#1a1424', supportColor: '#2d2838', lights: 'on', lightColor: '#ff2bd6' },
      { style: 'truss', material: 'neon', railColor: '#5dff9a', spineColor: '#121a16', supportColor: '#27302b', lights: 'on', lightColor: '#5dff9a' },
    ],
  },
  {
    id: 'castle', name: '魔法城堡', desc: '穿过城堡的石头走廊，有火把、蜡烛和彩色玻璃窗', scene: 'castle', extra: ['mine', 'jungle'], cover: [0.28, 0.5],
    gens: ['thrill', 'thrill', 'extreme', 'minetrain'], envs: ['meadow', 'meadow', 'snow'], time: [16.5, 22], weathers: ['clear', 'clear', 'cloudy', 'fog', 'storm'],
    trains: [
      { theme: 'classic', seat: 'sit', body: '#4b2a7a', accent: '#e2b93b', seatColor: '#1d1626', material: 'paint' },
      { theme: 'dragon', seat: 'sit', body: '#7a1f1f', accent: '#e2b93b', seatColor: '#2a1612', material: 'paint' },
      { theme: 'ghost', seat: 'invert', body: '#17141f', accent: '#7cff6b', seatColor: '#2a2333', material: 'matte' },
      { theme: 'dragon', seat: 'invert', body: '#1f4a3a', accent: '#c0c6cc', seatColor: '#16261f', material: 'paint' },
    ],
    tracks: [
      { style: 'box', material: 'paint', railColor: '#3d2b5c', spineColor: '#2a1f3d', supportColor: '#77717f', lights: 'night', lightColor: '#ffcf7a' },
      { style: 'truss', material: 'matte', railColor: '#2b2f36', spineColor: '#1d2026', supportColor: '#6a6f78', lights: 'night', lightColor: '#ffcf7a' },
      { style: 'box', material: 'paint', railColor: '#6a1f1f', spineColor: '#3d1414', supportColor: '#8a8580', lights: 'night', lightColor: '#ffb060' },
    ],
  },
  {
    id: 'jungle', name: '恐龙丛林', desc: '在丛林里穿行，两边站着霸王龙、长颈龙和迅猛龙', scene: 'jungle', extra: ['mine'], cover: [0.45, 0.75],
    gens: ['thrill', 'thrill', 'minetrain', 'extreme'], envs: ['island', 'island', 'meadow', 'volcano'], time: [7.5, 17.5], weathers: ['cloudy', 'clear', 'fog', 'rain'],
    trains: [
      { theme: 'classic', seat: 'sit', body: '#c8a22a', accent: '#2f3b1f', seatColor: '#2b2a22', material: 'matte' },
      { theme: 'classic', seat: 'invert', body: '#b5432a', accent: '#e8e2cf', seatColor: '#2b2a22', material: 'matte' },
      { theme: 'dragon', seat: 'sit', body: '#4f6b2a', accent: '#d9c27a', seatColor: '#2b2a22', material: 'matte' },
      { theme: 'mine', seat: 'sit', body: '#6a5a3a', accent: '#c8a22a', seatColor: '#2b2a22', material: 'wood' },
    ],
    tracks: [
      { style: 'truss', material: 'matte', railColor: '#3f6b3a', spineColor: '#2f4f2c', supportColor: '#6b6f5a', lights: 'night', lightColor: '#ffd27a' },
      { style: 'wood', material: 'paint', railColor: '#8a8f7a', spineColor: '#5d4630', supportColor: '#6f4d2e', lights: 'night', lightColor: '#ffb060' },
      { style: 'box', material: 'matte', railColor: '#7a3b22', spineColor: '#4a2c1a', supportColor: '#5f6652', lights: 'night', lightColor: '#ffd27a' },
    ],
  },
  {
    id: 'space', name: '星际穿梭', desc: '火箭列车飞进漆黑的大厅，身边是行星和星云', scene: 'space', extra: ['neon'], cover: [0.3, 0.5],
    gens: ['launch', 'launch', 'extreme'], envs: ['desert', 'snow', 'volcano', 'city'], time: [20, 24], weathers: ['clear', 'clear', 'cloudy'],
    trains: [
      { theme: 'rocket', seat: 'sit', body: '#f1f3f5', accent: '#e03131', seatColor: '#22262e', material: 'paint' },
      { theme: 'rocket', seat: 'fly', body: '#dfe6ee', accent: '#1c7ed6', seatColor: '#22262e', material: 'chrome' },
      { theme: 'rocket', seat: 'invert', body: '#2b2f36', accent: '#ffd23f', seatColor: '#16181d', material: 'carbon' },
    ],
    tracks: [
      { style: 'box', material: 'chrome', railColor: '#dfe6ee', spineColor: '#8892a0', supportColor: '#aab2bd', lights: 'on', lightColor: '#9fd0ff' },
      { style: 'mono', material: 'paint', railColor: '#f1f3f5', spineColor: '#1c7ed6', supportColor: '#8892a0', lights: 'on', lightColor: '#c59bff' },
      { style: 'truss', material: 'chrome', railColor: '#aab2bd', spineColor: '#5c6570', supportColor: '#8892a0', lights: 'on', lightColor: '#9fd0ff' },
    ],
  },
  {
    id: 'ocean', name: '海底世界', desc: '钻进海底的玻璃隧道，外面有鱼群、鲨鱼、鲸鱼和珊瑚', scene: 'ocean', extra: ['jungle'], cover: [0.3, 0.52],
    gens: ['thrill', 'thrill', 'extreme', 'launch', 'minetrain'], envs: ['island'], time: [8.5, 17.8], weathers: ['clear', 'clear', 'cloudy'],
    trains: [
      { theme: 'shark', seat: 'sit', body: '#5c7a8c', accent: '#f1f5f9', seatColor: '#26323a', material: 'paint' },
      { theme: 'shark', seat: 'fly', body: '#3f6f8f', accent: '#f1f5f9', seatColor: '#1f2c35', material: 'paint' },
      { theme: 'classic', seat: 'sit', body: '#1c7ed6', accent: '#fff3b0', seatColor: '#16324a', material: 'paint' },
      { theme: 'classic', seat: 'invert', body: '#12b5b0', accent: '#f1f5f9', seatColor: '#123a3a', material: 'paint' },
    ],
    tracks: [
      { style: 'box', material: 'paint', railColor: '#22b8cf', spineColor: '#1864ab', supportColor: '#e8edf2', lights: 'night', lightColor: '#7fd4ff' },
      { style: 'truss', material: 'paint', railColor: '#f1f5f9', spineColor: '#22b8cf', supportColor: '#c9d6e0', lights: 'night', lightColor: '#7fd4ff' },
      { style: 'box', material: 'chrome', railColor: '#9fd8e8', spineColor: '#3f8fb0', supportColor: '#dfe6ee', lights: 'night', lightColor: '#9fe8ff' },
    ],
  },
];

// 在现有轨道上自动挑几段布置场景。cover 是希望场景段占轨道总长的比例。返回布置了多少米
export function autoScenes(track, sceneId, cover = 0.4, rng = null, keep = false) {
  const nodes = track.nodes, n = nodes.length;
  if (!keep) for (const nd of nodes) nd.scene = '';
  const N = track.N, ds = track.ds;
  if (!sceneId || !N) return 0;
  const indoor = sceneId !== 'jungle';
  const { T, U, P, kind } = track;
  // 室内场景避开提升段、站台、刹车段，也避开回环和翻滚（外壳没法包住竖着的圈）
  const ok = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const kd = kind[k];
    const kindOk = kd === 0 || (kd === 2 && (sceneId === 'neon' || sceneId === 'space'));
    if (!kindOk) continue;
    if (keep && track.scene && track.scene[k]) continue;
    if (Math.abs(T[k * 3 + 1]) > (indoor ? 0.62 : 0.8)) continue;
    if (U[k * 3 + 1] < 0.25) continue;
    // 室内场景不放在离地太高的地方（外壳会变得非常大）；丛林场景只放在贴近地面的路段，这样才看得清两边的植物和恐龙
    const clearance = track.world ? P[k * 3 + 1] - track.world.surfaceAt(P[k * 3], P[k * 3 + 2]) : 0;
    if (clearance > (indoor ? 36 : 15)) continue;
    ok[k] = 1;
  }
  // 找出一段段连续可用的轨道
  let start = -1;
  for (let k = 0; k < N; k++) if (!ok[k]) { start = k; break; }
  if (start < 0) start = 0;
  const runs = [];
  for (let i = 0; i < N;) {
    const k = (start + i) % N;
    if (!ok[k]) { i++; continue; }
    let len = 0;
    while (i + len < N && ok[(start + i + len) % N]) len++;
    runs.push({ k0: k, len });
    i += len;
  }
  const minLen = indoor ? 55 : 30, maxLen = indoor ? 190 : 320, gap = indoor ? 45 : 8;
  const chunks = [];
  for (const r of runs) {
    const m = r.len * ds;
    if (m < minLen + 12) continue;
    // 两头各留 6 米，长的可用段拆成几段，中间留出露天的间隔
    const edge = keep ? 30 : 6;
    let pos = edge + (rng ? rng() * 25 : 0);
    while (m - pos - edge >= minLen) {
      const cap = rng ? lerp(Math.min(maxLen, minLen + 40), maxLen, rng()) : maxLen;
      const len = Math.min(cap, m - pos - edge);
      chunks.push({ k0: (r.k0 + Math.round(pos / ds)) % N, len: Math.round(len / ds), m: len });
      pos += len + gap;
    }
  }
  // 不指定随机数时优先选长的；指定了就打乱顺序，每次选中的路段都不一样
  if (rng) chunks.sort(() => rng() - 0.5);
  else chunks.sort((a, b) => b.m - a.m);
  const sel = new Uint8Array(N);
  let total = 0;
  const want = cover * track.length;
  for (const c of chunks) {
    if (total >= want) break;
    for (let j = 0; j < c.len; j++) sel[(c.k0 + j) % N] = 1;
    total += c.m;
  }
  // 落到节点上：一个节点到下一个节点之间大部分被选中，这一段就算场景段
  let placed = 0;
  for (let i = 0; i < n; i++) {
    const s0 = track.nodeS[i];
    let s1 = i + 1 < n ? track.nodeS[i + 1] : track.length;
    if (s1 <= s0) s1 += track.length;
    let cnt = 0, hit = 0;
    for (let s = s0; s < s1; s += ds) {
      cnt++;
      if (sel[Math.floor(s / ds) % N]) hit++;
    }
    if (cnt && hit / cnt >= 0.6) {
      nodes[i].scene = sceneId;
      placed += s1 - s0;
    }
  }
  return placed;
}
