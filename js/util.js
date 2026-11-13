// 通用工具：随机数、噪声、插值、材质登记等
import * as THREE from 'three';

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const saturate = (x) => clamp(x, 0, 1);
export const smoothstep = (a, b, x) => {
  const t = saturate((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
// 与帧率无关的指数平滑
export const damp = (cur, target, lambda, dt) => lerp(cur, target, 1 - Math.exp(-lambda * dt));
export const wrapDeg = (d) => {
  d = ((d + 180) % 360 + 360) % 360 - 180;
  return d;
};
export const DEG = Math.PI / 180;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// 二维值噪声，返回 0~1
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

export function fbm(x, y, oct = 5, seed = 0) {
  let amp = 0.5, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * noise2(x * f, y * f, seed + i * 17);
    n += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / n;
}

// 山脊状噪声，返回 0~1
export function ridged(x, y, oct = 5, seed = 0) {
  let amp = 0.5, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    const v = 1 - Math.abs(noise2(x * f, y * f, seed + i * 31) * 2 - 1);
    s += amp * v * v;
    n += amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return s / n;
}

// Catmull-Rom 标量插值
export function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

// 下雨时地面和金属会变得更光滑。需要跟着变化的材质在这里登记。
const wetMaterials = new Set();
let currentWet = 0;
export function registerWet(mat, amount = 0.5) {
  mat.userData.baseRough = mat.roughness;
  mat.userData.wetAmount = amount;
  mat.roughness = mat.userData.baseRough * (1 - amount * currentWet);
  wetMaterials.add(mat);
  return mat;
}
export function unregisterWet(mat) {
  wetMaterials.delete(mat);
}
export function applyWetness(w) {
  if (Math.abs(w - currentWet) < 0.005) return;
  currentWet = w;
  for (const m of wetMaterials) m.roughness = m.userData.baseRough * (1 - m.userData.wetAmount * w);
}

// 把一组几何体按材质合并，减少绘制次数
export class GeoBatch {
  constructor() {
    this.parts = new Map();
  }
  add(matKey, geo, matrix) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    }
    if (!this.parts.has(matKey)) this.parts.set(matKey, []);
    this.parts.get(matKey).push(g);
    return this;
  }
  // 便捷方法：位置 + 欧拉角 + 缩放
  put(matKey, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    _m.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
    return this.add(matKey, geo, _m);
  }
  build(materials, opts = {}) {
    const group = new THREE.Group();
    for (const [key, list] of this.parts) {
      const merged = mergeSimple(list);
      const mesh = new THREE.Mesh(merged, materials[key]);
      mesh.castShadow = opts.castShadow !== false;
      mesh.receiveShadow = opts.receiveShadow !== false;
      mesh.name = key;
      group.add(mesh);
    }
    return group;
  }
  geometries() {
    const out = {};
    for (const [key, list] of this.parts) out[key] = mergeSimple(list);
    return out;
  }
}
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _v = new THREE.Vector3(), _s = new THREE.Vector3();

export function mergeSimple(list) {
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

// 给合并后的几何体整体上色（顶点色），用于树木等实例化物体
export function paintGeometry(geo, color) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
  }
  return g;
}

export function mergeColored(list) {
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

export function transformed(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  const g = geo.clone();
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _m.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
  g.applyMatrix4(_m);
  return g;
}

// 计算把一根沿 Y 轴的单位圆柱放到 a、b 两点之间所需的矩阵
const _up = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3();
export function segmentMatrix(out, a, b, radius) {
  _d.subVectors(b, a);
  const len = _d.length();
  if (len < 1e-6) return out.makeScale(0, 0, 0);
  _q.setFromUnitVectors(_up, _d.multiplyScalar(1 / len));
  _v.addVectors(a, b).multiplyScalar(0.5);
  _s.set(radius, len, radius);
  return out.compose(_v, _q, _s);
}

export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.isInstancedMesh) o.dispose();
  });
  if (obj.parent) obj.parent.remove(obj);
}

export function fmt(n, d = 0) {
  return Number(n).toFixed(d);
}
