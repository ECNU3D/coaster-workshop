// 轨道：由控制节点生成曲线、姿态，再生成钢轨、主梁、支架、站台等模型
import * as THREE from 'three';
import { clamp, lerp, catmull, wrapDeg, DEG, registerWet, unregisterWet, segmentMatrix, GeoBatch } from './util.js';
import { G, KIND, speedProfile, analyze, findStation } from './sim.js';
import { assets } from './assets.js';
import { SCENE_INDEX, SCENES } from './scenes.js';
import { propParts, propMat, boxUV } from './props.js';

export const TRACK_STYLES = [
  { id: 'box', name: '箱梁式', desc: '两根钢轨加一根方形主梁' },
  { id: 'truss', name: '桁架式', desc: '三根钢管加斜拉杆' },
  { id: 'wood', name: '木质', desc: '木头搭的轨道和支架' },
  { id: 'mono', name: '单轨', desc: '只有一根粗钢轨' },
];
export const TRACK_MATERIALS = [
  { id: 'paint', name: '烤漆' },
  { id: 'chrome', name: '镀铬' },
  { id: 'matte', name: '哑光' },
  { id: 'neon', name: '霓虹发光' },
];
export const KINDS = [
  { id: 'normal', name: '普通', color: '#ffffff' },
  { id: 'lift', name: '提升链', color: '#ffd23f' },
  { id: 'launch', name: '弹射', color: '#22d3ee' },
  { id: 'brake', name: '刹车', color: '#ef4444' },
  { id: 'station', name: '站台', color: '#4ade80' },
];

const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

class InstList {
  constructor() {
    this.data = new Float32Array(16 * 256);
    this.count = 0;
  }
  push(m) {
    if ((this.count + 1) * 16 > this.data.length) {
      const n = new Float32Array(this.data.length * 2);
      n.set(this.data);
      this.data = n;
    }
    this.data.set(m.elements, this.count * 16);
    this.count++;
  }
  mesh(geo, mat, shadow = true) {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(this.count, 1));
    mesh.count = this.count;
    mesh.instanceMatrix.array.set(this.data.subarray(0, this.count * 16));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }
}

function tubeProfile(cx, cy, r, m = 8) {
  const e = [];
  for (let i = 0; i < m; i++) {
    const a0 = (i / m) * Math.PI * 2, a1 = ((i + 1) / m) * Math.PI * 2;
    e.push({
      x0: cx + r * Math.cos(a0), y0: cy + r * Math.sin(a0), nx0: Math.cos(a0), ny0: Math.sin(a0),
      x1: cx + r * Math.cos(a1), y1: cy + r * Math.sin(a1), nx1: Math.cos(a1), ny1: Math.sin(a1),
    });
  }
  return e;
}
function boxProfile(cx, cy, w, h) {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  const edge = (ax, ay, bx, by, nx, ny) => ({ x0: ax, y0: ay, nx0: nx, ny0: ny, x1: bx, y1: by, nx1: nx, ny1: ny });
  return [edge(x1, y0, x1, y1, 1, 0), edge(x1, y1, x0, y1, 0, 1), edge(x0, y1, x0, y0, -1, 0), edge(x0, y0, x1, y0, 0, -1)];
}

function heatColor(g, out) {
  // 蓝（负 G）→ 绿（1G）→ 黄（3G）→ 红（5G 以上）
  if (g < 1) out.setRGB(0.1, lerp(0.35, 0.85, clamp(g, 0, 1)), lerp(1, 0.25, clamp(g + 0.5, 0, 1)));
  else if (g < 3) out.setRGB(lerp(0.1, 1, (g - 1) / 2), 0.85, lerp(0.25, 0.05, (g - 1) / 2));
  else out.setRGB(1, lerp(0.85, 0.05, clamp((g - 3) / 2, 0, 1)), 0.05);
  return out;
}

export class Track {
  constructor(world) {
    this.world = world;
    this.nodes = [];
    this.opts = {
      style: 'box', material: 'paint',
      railColor: '#e63946', spineColor: '#b3202c', supportColor: '#e8edf2',
      lights: 'night', lightColor: '#ffd27a',
      bank: 1, liftSpeed: 6, launchSpeed: 32,
      hang: false, halfWidth: 1.15,
    };
    this.group = new THREE.Group();
    this.group.name = 'track';
    this.N = 0;
    this.ds = 0.5;
    this.length = 0;
    this.showHeat = false;
    this.mats = [];
    this.analysis = null;
    this.hash = new Map();
    this.nodeS = [];
    this.stationLight = null;
  }

  addNode(x, y, z, roll = 0, kind = 'normal', auto = true, scene = '') {
    this.nodes.push({ p: new THREE.Vector3(x, y, z), roll, kind, auto, scene });
  }

  toJSON() {
    return {
      nodes: this.nodes.map((n) => [+n.p.x.toFixed(2), +n.p.y.toFixed(2), +n.p.z.toFixed(2), +n.roll.toFixed(1), n.kind, n.auto ? 1 : 0, n.scene || '']),
      opts: { ...this.opts },
    };
  }

  fromJSON(data) {
    this.nodes = data.nodes.map((a) => ({ p: new THREE.Vector3(a[0], a[1], a[2]), roll: a[3] || 0, kind: a[4] || 'normal', auto: a[5] !== 0, scene: a[6] || '' }));
    if (data.opts) Object.assign(this.opts, data.opts);
  }

  // ---------- 计算曲线和姿态 ----------
  compute() {
    const nodes = this.nodes;
    const n = nodes.length;
    if (n < 4) {
      this.N = 0;
      this.length = 0;
      this.analysis = null;
      return;
    }
    const curve = new THREE.CatmullRomCurve3(nodes.map((nd) => nd.p), true, 'centripetal');
    curve.arcLengthDivisions = n * 24;
    const L = curve.getLength();
    const N = Math.max(32, Math.round(L / 0.5));
    const ds = L / N;
    this.N = N;
    this.ds = ds;
    this.length = L;
    const P = (this.P = new Float32Array(N * 3));
    const T = (this.T = new Float32Array(N * 3));
    const U = (this.U = new Float32Array(N * 3));
    const R = (this.R = new Float32Array(N * 3));
    const K = (this.K = new Float32Array(N * 3));
    const kind = (this.kind = new Uint8Array(N));
    const scene = (this.scene = new Uint8Array(N));
    const manual = new Float32Array(N);
    const autoW = new Float32Array(N);
    this.nodeS = new Array(n).fill(0);
    let lastSeg = -1;
    const roll = (i) => nodes[((i % n) + n) % n].roll;
    for (let k = 0; k < N; k++) {
      const t = curve.getUtoTmapping(k / N);
      curve.getPoint(t, _p);
      curve.getTangent(t, _t);
      _p.toArray(P, k * 3);
      _t.toArray(T, k * 3);
      const sf = t * n;
      const seg = Math.min(n - 1, Math.floor(sf));
      const local = sf - seg;
      if (seg !== lastSeg) {
        for (let s = lastSeg + 1; s <= seg; s++) this.nodeS[s] = k * ds;
        lastSeg = seg;
      }
      kind[k] = KIND[nodes[seg].kind] || 0;
      scene[k] = SCENE_INDEX[nodes[seg].scene] || 0;
      const v1 = roll(seg);
      const v0 = v1 - wrapDeg(v1 - roll(seg - 1));
      const v2 = v1 + wrapDeg(roll(seg + 1) - v1);
      const v3 = v2 + wrapDeg(roll(seg + 2) - roll(seg + 1));
      manual[k] = catmull(v0, v1, v2, v3, local) * DEG;
      const w0 = nodes[seg].auto ? 1 : 0, w1 = nodes[(seg + 1) % n].auto ? 1 : 0;
      autoW[k] = lerp(w0, w1, local * local * (3 - 2 * local));
    }

    // 沿曲线平移法向量，得到不会乱翻的基准姿态
    _t.fromArray(T, 0);
    _u.copy(WORLD_UP).addScaledVector(_t, -_t.y);
    if (_u.lengthSq() < 1e-4) _u.set(1, 0, 0).addScaledVector(_t, -_t.x);
    _u.normalize();
    _u.toArray(U, 0);
    for (let k = 1; k < N; k++) {
      _a.fromArray(T, (k - 1) * 3);
      _b.fromArray(T, k * 3);
      _q.setFromUnitVectors(_a, _b);
      _u.applyQuaternion(_q);
      _u.addScaledVector(_b, -_u.dot(_b)).normalize();
      _u.toArray(U, k * 3);
    }
    // 首尾相接处的偏差平均分摊到整条轨道
    _a.fromArray(T, (N - 1) * 3);
    _b.fromArray(T, 0);
    _q.setFromUnitVectors(_a, _b);
    _c.copy(_u).applyQuaternion(_q);
    _d.fromArray(U, 0);
    const alpha = Math.atan2(_a.crossVectors(_d, _c).dot(_b), _d.dot(_c));
    for (let k = 0; k < N; k++) {
      _t.fromArray(T, k * 3);
      _u.fromArray(U, k * 3);
      const th = (-alpha * k) / N;
      _r.crossVectors(_t, _u);
      _u.multiplyScalar(Math.cos(th)).addScaledVector(_r, Math.sin(th));
      _u.toArray(U, k * 3);
    }
    // 曲率向量
    for (let k = 0; k < N; k++) {
      const kp = ((k + 1) % N) * 3, km = ((k + N - 1) % N) * 3;
      K[k * 3] = (T[kp] - T[km]) / (2 * ds);
      K[k * 3 + 1] = (T[kp + 1] - T[km + 1]) / (2 * ds);
      K[k * 3 + 2] = (T[kp + 2] - T[km + 2]) / (2 * ds);
    }

    // 根据估算的速度计算自动倾斜角
    const profile = speedProfile(this);
    const auto = new Float32Array(N);
    const bank = this.opts.bank;
    if (bank > 0.001) {
      for (let k = 0; k < N; k++) {
        const v2 = profile.v[k] * profile.v[k];
        const fx = v2 * K[k * 3], fy = v2 * K[k * 3 + 1] + G, fz = v2 * K[k * 3 + 2];
        _t.fromArray(T, k * 3);
        _u.fromArray(U, k * 3);
        _r.crossVectors(_t, _u);
        const fl = fx * _r.x + fy * _r.y + fz * _r.z;
        const fu = fx * _u.x + fy * _u.y + fz * _u.z;
        auto[k] = clamp(Math.atan2(fl, Math.max(fu, 0.4 * G)), -1.4, 1.4) * bank * autoW[k];
      }
      const tmp = new Float32Array(N);
      const rad = Math.max(2, Math.round(7 / ds));
      for (let pass = 0; pass < 2; pass++) {
        let sum = 0;
        for (let j = -rad; j <= rad; j++) sum += auto[(j + N) % N];
        for (let k = 0; k < N; k++) {
          tmp[k] = sum / (rad * 2 + 1);
          sum += auto[(k + rad + 1) % N] - auto[(k - rad + N) % N];
        }
        auto.set(tmp);
      }
    }
    for (let k = 0; k < N; k++) {
      _t.fromArray(T, k * 3);
      _u.fromArray(U, k * 3);
      _r.crossVectors(_t, _u);
      const th = manual[k] + auto[k];
      _u.multiplyScalar(Math.cos(th)).addScaledVector(_r, Math.sin(th)).normalize();
      _r.crossVectors(_t, _u).normalize();
      _u.toArray(U, k * 3);
      _r.toArray(R, k * 3);
    }

    // 空间索引，用来查某个位置附近有没有轨道
    this.hash.clear();
    for (let k = 0; k < N; k += 2) {
      const key = this.hashKey(P[k * 3], P[k * 3 + 2]);
      let list = this.hash.get(key);
      if (!list) this.hash.set(key, (list = []));
      list.push(k);
    }
    this.profile = profile;
    this.analysis = analyze(this, profile);
  }

  // 采样点 k 是否在室内场景里（室内场景自己负责支撑轨道，不需要支架）
  indoor(k) {
    const id = this.scene ? this.scene[k] : 0;
    return id > 0 && SCENES[id].indoor;
  }

  hashKey(x, z) {
    return (Math.floor(x / 6) + 2048) * 4096 + (Math.floor(z / 6) + 2048);
  }

  // 遍历 (x, z) 周围半径 r 内的采样点
  forNear(x, z, r, fn) {
    const c0 = Math.floor((x - r) / 6), c1 = Math.floor((x + r) / 6);
    const d0 = Math.floor((z - r) / 6), d1 = Math.floor((z + r) / 6);
    const P = this.P;
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = d0; cz <= d1; cz++) {
        const list = this.hash.get((cx + 2048) * 4096 + (cz + 2048));
        if (!list) continue;
        for (const k of list) {
          const dx = P[k * 3] - x, dz = P[k * 3 + 2] - z;
          if (dx * dx + dz * dz <= r * r && fn(k) === true) return true;
        }
      }
    }
    return false;
  }

  // 植被清理用：这个位置是否紧挨着轨道
  nearTrack(x, z, top) {
    if (!this.N) return false;
    const drop = this.opts.hang ? 6.5 : 3.5;
    return this.forNear(x, z, 5.5, (k) => this.P[k * 3 + 1] - drop < top);
  }

  // 找离某个点最近的采样点
  nearestSample(pos, maxDist = 30) {
    let best = -1, bd = maxDist * maxDist;
    const P = this.P;
    this.forNear(pos.x, pos.z, maxDist, (k) => {
      const dx = P[k * 3] - pos.x, dy = P[k * 3 + 1] - pos.y, dz = P[k * 3 + 2] - pos.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; best = k; }
    });
    return best;
  }

  // 取轨道上弧长 s 处的位置和姿态
  frame(s, out) {
    const N = this.N, ds = this.ds;
    let f = s / ds;
    f = ((f % N) + N) % N;
    const k = Math.floor(f), t = f - k, k1 = (k + 1) % N;
    const { P, T, U } = this;
    out.p.set(lerp(P[k * 3], P[k1 * 3], t), lerp(P[k * 3 + 1], P[k1 * 3 + 1], t), lerp(P[k * 3 + 2], P[k1 * 3 + 2], t));
    out.t.set(lerp(T[k * 3], T[k1 * 3], t), lerp(T[k * 3 + 1], T[k1 * 3 + 1], t), lerp(T[k * 3 + 2], T[k1 * 3 + 2], t)).normalize();
    out.u.set(lerp(U[k * 3], U[k1 * 3], t), lerp(U[k * 3 + 1], U[k1 * 3 + 1], t), lerp(U[k * 3 + 2], U[k1 * 3 + 2], t));
    out.r.crossVectors(out.t, out.u).normalize();
    out.u.crossVectors(out.r, out.t);
    return out;
  }

  // ---------- 生成模型 ----------
  clearMeshes() {
    for (const c of [...this.group.children]) {
      c.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.isInstancedMesh) o.dispose();
      });
      this.group.remove(c);
    }
    for (const m of this.mats) {
      unregisterWet(m);
      m.dispose();
    }
    this.mats = [];
    this.stationLight = null;
    this.bulbMat = null;
    this.lampMat = null;
    this.launchMat = null;
  }

  mat(params, wet = 0.4) {
    const m = new THREE.MeshStandardMaterial(params);
    if (wet) registerWet(m, wet);
    this.mats.push(m);
    return m;
  }

  finishMat(color, glow) {
    const kind = this.opts.material;
    if (glow && kind === 'neon') {
      const c = new THREE.Color(color);
      return this.mat({ color: c.clone().multiplyScalar(0.25), emissive: c, emissiveIntensity: 2.2, roughness: 0.4, metalness: 0.2 }, 0);
    }
    if (kind === 'chrome') return this.mat({ color, metalness: 1, roughness: 0.07 }, 0);
    if (kind === 'matte') return this.mat({ color, metalness: 0.1, roughness: 0.85 });
    return this.mat({ color, metalness: 0.55, roughness: 0.32 });
  }

  rebuild(fast = false) {
    this.compute();
    this.buildMeshes(fast);
  }

  sweep(step, edges) {
    const N = this.N, { P, U, R } = this;
    const rings = Math.ceil(N / step);
    const E = edges.length, vpr = E * 2;
    const pos = new Float32Array(rings * vpr * 3), nor = new Float32Array(rings * vpr * 3);
    let o = 0;
    for (let i = 0; i < rings; i++) {
      const k = i * step * 3;
      const px = P[k], py = P[k + 1], pz = P[k + 2];
      const rx = R[k], ry = R[k + 1], rz = R[k + 2];
      const ux = U[k], uy = U[k + 1], uz = U[k + 2];
      for (let e = 0; e < E; e++) {
        const ed = edges[e];
        pos[o] = px + rx * ed.x0 + ux * ed.y0; pos[o + 1] = py + ry * ed.x0 + uy * ed.y0; pos[o + 2] = pz + rz * ed.x0 + uz * ed.y0;
        nor[o] = rx * ed.nx0 + ux * ed.ny0; nor[o + 1] = ry * ed.nx0 + uy * ed.ny0; nor[o + 2] = rz * ed.nx0 + uz * ed.ny0;
        o += 3;
        pos[o] = px + rx * ed.x1 + ux * ed.y1; pos[o + 1] = py + ry * ed.x1 + uy * ed.y1; pos[o + 2] = pz + rz * ed.x1 + uz * ed.y1;
        nor[o] = rx * ed.nx1 + ux * ed.ny1; nor[o + 1] = ry * ed.nx1 + uy * ed.ny1; nor[o + 2] = rz * ed.nx1 + uz * ed.ny1;
        o += 3;
      }
    }
    const idx = new Uint32Array(rings * E * 6);
    let q = 0;
    for (let i = 0; i < rings; i++) {
      const j = (i + 1) % rings;
      for (let e = 0; e < E; e++) {
        const ed = edges[e];
        const ex = ed.x1 - ed.x0, ey = ed.y1 - ed.y0;
        const ok = ey * (ed.nx0 + ed.nx1) - ex * (ed.ny0 + ed.ny1) > 0;
        const a = i * vpr + e * 2, b = a + 1, c = j * vpr + e * 2, d = c + 1;
        if (ok) { idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d; }
        else { idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = b; idx[q++] = d; idx[q++] = c; }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    return geo;
  }

  addMesh(geo, mat, shadow = true) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  // 在采样点 k 的局部坐标系里放一个盒子：x 向右，y 向上，z 向前
  frameMatrix(k, x, y, z, sx, sy, sz) {
    const { P, T, U, R } = this;
    const i = k * 3;
    _r.set(R[i], R[i + 1], R[i + 2]);
    _u.set(U[i], U[i + 1], U[i + 2]);
    _t.set(T[i], T[i + 1], T[i + 2]);
    _p.set(P[i], P[i + 1], P[i + 2]).addScaledVector(_r, x).addScaledVector(_u, y).addScaledVector(_t, z);
    _a.copy(_r).multiplyScalar(sx);
    _b.copy(_u).multiplyScalar(sy);
    _c.copy(_t).multiplyScalar(-sz);
    _m.makeBasis(_a, _b, _c).setPosition(_p);
    return _m;
  }

  point(k, x, y, out) {
    const { P, U, R } = this;
    const i = k * 3;
    return out.set(P[i] + R[i] * x + U[i] * y, P[i + 1] + R[i + 1] * x + U[i + 1] * y, P[i + 2] + R[i + 2] * x + U[i + 2] * y);
  }

  buildMeshes(fast = false) {
    this.clearMeshes();
    const N = this.N;
    if (!N) return;
    const o = this.opts;
    const sgn = o.hang ? 1 : -1; // 主梁在钢轨的哪一侧：坐式在下方，悬挂式在上方
    const ds = this.ds;
    const stepM = Math.max(1, Math.round(1 / ds));
    const railMat = this.finishMat(o.railColor, true);
    const spineMat = o.material === 'neon' ? this.mat({ color: o.spineColor, metalness: 0.5, roughness: 0.4 }) : this.finishMat(o.spineColor, false);
    const supportMat = this.mat({ color: o.supportColor, metalness: 0.45, roughness: 0.45 });
    const woodMat = this.mat({ color: '#8a623c', metalness: 0, roughness: 0.9 }, 0.3);
    // 木梁和枕木用木板贴图，每根木料只取贴图里的一条木板
    const T = assets.tex;
    if (!Track.beamTex && T.planks) {
      Track.beamTex = T.planks.clone();
      Track.beamTex.repeat.set(1 / 6, 1);
      Track.beamTex.needsUpdate = true;
      Track.beamNormal = T.planks_n.clone();
      Track.beamNormal.repeat.set(1 / 6, 1);
      Track.beamNormal.needsUpdate = true;
    }
    const woodBeam = this.mat({ color: '#e8d9c6', map: Track.beamTex, normalMap: Track.beamNormal, metalness: 0, roughness: 0.88 }, 0.3);
    const woodDark = this.mat({ color: '#b39a80', map: Track.beamTex, normalMap: Track.beamNormal, metalness: 0, roughness: 0.9 }, 0.3);
    const concrete = this.mat({ color: '#c9cacb', map: T.concrete, normalMap: T.concrete_n, metalness: 0, roughness: 0.9 }, 0.5);
    const concretePlain = this.mat({ color: '#9a9c9e', metalness: 0, roughness: 0.9 }, 0.5);
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 10);
    const every = (meters) => Math.max(1, Math.round(meters / ds));

    // 钢轨和主梁
    if (o.style === 'box') {
      this.addMesh(this.sweep(stepM, [...tubeProfile(-0.6, 0, 0.09), ...tubeProfile(0.6, 0, 0.09)]), railMat);
      this.addMesh(this.sweep(stepM, boxProfile(0, sgn * 0.62, 0.46, 0.5)), spineMat);
      const ties = new InstList();
      for (let k = 0; k < N; k += every(1.25)) {
        ties.push(this.frameMatrix(k, 0, sgn * 0.1, 0, 1.24, 0.08, 0.16));
        ties.push(this.frameMatrix(k, 0, sgn * 0.25, 0, 0.16, 0.3, 0.16));
      }
      this.group.add(ties.mesh(unitBox, spineMat));
    } else if (o.style === 'truss') {
      this.addMesh(this.sweep(stepM, [...tubeProfile(-0.55, 0, 0.085), ...tubeProfile(0.55, 0, 0.085)]), railMat);
      this.addMesh(this.sweep(stepM, tubeProfile(0, sgn * 0.78, 0.12)), spineMat);
      const bars = new InstList();
      const st = every(0.9);
      let flip = false;
      for (let k = 0; k + st <= N; k += st) {
        const k2 = (k + st) % N;
        for (const side of [-1, 1]) {
          if (flip) {
            this.point(k, 0, sgn * 0.78, _a);
            this.point(k2, side * 0.55, 0, _b);
          } else {
            this.point(k, side * 0.55, 0, _a);
            this.point(k2, 0, sgn * 0.78, _b);
          }
          bars.push(segmentMatrix(_m, _a, _b, 0.035));
        }
        this.point(k, -0.55, 0, _a);
        this.point(k, 0.55, 0, _b);
        bars.push(segmentMatrix(_m, _a, _b, 0.035));
        flip = !flip;
      }
      this.group.add(bars.mesh(unitCyl, spineMat));
    } else if (o.style === 'wood') {
      this.addMesh(this.sweep(stepM, [...boxProfile(-0.6, -0.12, 0.16, 0.2), ...boxProfile(0.6, -0.12, 0.16, 0.2), ...boxProfile(-0.98, -0.42, 0.1, 0.26), ...boxProfile(0.98, -0.42, 0.1, 0.26)]), woodMat);
      this.addMesh(this.sweep(stepM, [...boxProfile(-0.6, 0, 0.13, 0.04), ...boxProfile(0.6, 0, 0.13, 0.04)]), railMat);
      const ties = new InstList();
      for (let k = 0; k < N; k += every(0.8)) ties.push(this.frameMatrix(k, 0, -0.29, 0, 2.1, 0.12, 0.24));
      this.group.add(ties.mesh(unitBox, woodDark));
    } else {
      this.addMesh(this.sweep(stepM, boxProfile(0, sgn * 0.2, 0.34, 0.4)), railMat);
      this.addMesh(this.sweep(stepM, [...boxProfile(-0.24, sgn * 0.05, 0.14, 0.05), ...boxProfile(0.24, sgn * 0.05, 0.14, 0.05)]), spineMat);
    }

    // 提升链、刹车片、弹射定子
    const chain = new InstList(), brake = new InstList(), launch = new InstList();
    const yIn = -sgn * 0.02;
    for (let k = 0; k < N; k += every(1.1)) {
      const kd = this.kind[k];
      if (kd === KIND.lift) chain.push(this.frameMatrix(k, 0, sgn * 0.03, 0, 0.16, 0.07, 0.75));
      else if (kd === KIND.brake) {
        brake.push(this.frameMatrix(k, -0.28, yIn, 0, 0.04, 0.2, 0.85));
        brake.push(this.frameMatrix(k, 0.28, yIn, 0, 0.04, 0.2, 0.85));
      } else if (kd === KIND.launch) {
        launch.push(this.frameMatrix(k, -0.3, yIn, 0, 0.06, 0.18, 0.9));
        launch.push(this.frameMatrix(k, 0.3, yIn, 0, 0.06, 0.18, 0.9));
      }
    }
    if (chain.count) this.group.add(chain.mesh(unitBox, this.mat({ color: '#2b2f36', metalness: 0.8, roughness: 0.4 }), false));
    if (brake.count) this.group.add(brake.mesh(unitBox, this.mat({ color: '#c2562a', metalness: 0.7, roughness: 0.35 }), false));
    if (launch.count) {
      this.launchMat = this.mat({ color: '#0a2a33', emissive: '#22d3ee', emissiveIntensity: 2.4, roughness: 0.3 }, 0);
      this.group.add(launch.mesh(unitBox, this.launchMat, false));
    }

    // G 力热力图
    if (this.showHeat && this.analysis) {
      const st = 2, rings = Math.ceil(N / st);
      const pos = new Float32Array((rings + 1) * 6), col = new Float32Array((rings + 1) * 6);
      const c = new THREE.Color();
      for (let i = 0; i <= rings; i++) {
        const k = (i * st) % N;
        this.point(k, -0.5, -sgn * 0.06, _a).toArray(pos, i * 6);
        this.point(k, 0.5, -sgn * 0.06, _b).toArray(pos, i * 6 + 3);
        heatColor(this.analysis.gv[k], c);
        c.toArray(col, i * 6);
        c.toArray(col, i * 6 + 3);
      }
      const idx = [];
      for (let i = 0; i < rings; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(idx);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }

    if (fast) return;

    // 支架
    if (o.style === 'wood') this.buildTrestle(unitBox, woodBeam, woodDark);
    else this.buildSupports(unitCyl, supportMat, concrete, sgn);

    // 轨道灯带
    if (o.lights !== 'off') {
      const bulbs = new InstList();
      const geo = new THREE.SphereGeometry(0.085, 8, 6);
      for (let k = 0; k < N; k += every(4)) {
        for (const side of [-1, 1]) {
          this.point(k, side * 0.82, sgn * 0.25, _a);
          _m.makeTranslation(_a.x, _a.y, _a.z);
          bulbs.push(_m);
        }
      }
      this.bulbMat = new THREE.MeshBasicMaterial({ color: o.lightColor });
      this.mats.push(this.bulbMat);
      this.bulbMesh = bulbs.mesh(geo, this.bulbMat, false);
      this.bulbMesh.receiveShadow = false;
      this.group.add(this.bulbMesh);
    }

    this.buildStation(concretePlain, supportMat);
  }

  blocked(x, z, topY, k, radius = 1.7) {
    const N = this.N, P = this.P;
    return this.forNear(x, z, radius, (j) => {
      let d = Math.abs(j - k);
      d = Math.min(d, N - d);
      return d > 16 && P[j * 3 + 1] < topY - 2.2;
    });
  }

  buildSupports(unitCyl, supportMat, concrete, sgn) {
    const N = this.N, ds = this.ds, { T, U } = this;
    const world = this.world;
    const cols = new InstList(), feet = new InstList();
    const step = Math.max(4, Math.round(13 / ds));
    const lat = new THREE.Vector3(), top = new THREE.Vector3(), base = new THREE.Vector3(), tmp = new THREE.Matrix4();
    const foot = (p) => {
      tmp.makeScale(0.75, 0.5, 0.75).setPosition(p.x, p.y + 0.2, p.z);
      feet.push(tmp);
    };
    for (let k = Math.floor(step / 2); k < N; k += step) {
      const uy = U[k * 3 + 1];
      if (uy < 0.2 || this.indoor(k)) continue;
      lat.set(-T[k * 3 + 2], 0, T[k * 3]);
      if (lat.lengthSq() < 0.01) continue;
      lat.normalize();
      this.point(k, 0, sgn * 0.88, top);
      if (sgn < 0) {
        const ground = world.heightAt(top.x, top.z);
        const h = top.y - ground;
        if (h < 1.3) continue;
        if (this.blocked(top.x, top.z, top.y, k)) continue;
        const rad = 0.2 + Math.min(h, 60) * 0.0055;
        if (h > 24) {
          for (const side of [-1, 1]) {
            base.copy(top).addScaledVector(lat, side * h * 0.16);
            base.y = world.heightAt(base.x, base.z) - 0.3;
            cols.push(segmentMatrix(_m, base, top, rad * 0.85));
            foot(base);
          }
          // 高支架中间加一根横撑
          _a.copy(top).addScaledVector(lat, -h * 0.08).setY(top.y - h * 0.5);
          _b.copy(top).addScaledVector(lat, h * 0.08).setY(top.y - h * 0.5);
          cols.push(segmentMatrix(_m, _a, _b, rad * 0.5));
        } else {
          base.set(top.x, ground - 0.3, top.z);
          cols.push(segmentMatrix(_m, base, top, rad));
          foot(base);
        }
      } else {
        if (uy < 0.45) continue;
        const side = U[k * 3] * lat.x + U[k * 3 + 2] * lat.z >= 0 ? 1 : -1;
        base.copy(top).addScaledVector(lat, side * 3.1);
        const ground = world.heightAt(base.x, base.z);
        const colTop = _c.set(base.x, top.y + 0.5, base.z);
        if (colTop.y - ground < 2) continue;
        if (this.blocked(base.x, base.z, colTop.y, k, 2.1)) continue;
        base.y = ground - 0.3;
        const rad = 0.24 + Math.min(colTop.y - ground, 60) * 0.0055;
        cols.push(segmentMatrix(_m, base, colTop, rad));
        cols.push(segmentMatrix(_m, colTop, top, rad * 0.8));
        foot(base);
      }
    }
    if (cols.count) this.group.add(cols.mesh(unitCyl, supportMat));
    if (feet.count) this.group.add(feet.mesh(unitCyl, concrete, false));
  }

  buildTrestle(unitBox, woodMat, woodDark) {
    const N = this.N, ds = this.ds, { T, U } = this;
    const world = this.world;
    const beams = new InstList(), posts = new InstList();
    const step = Math.max(2, Math.round(4.2 / ds));
    const lat = new THREE.Vector3(), top = new THREE.Vector3();
    const LV = 3.6;
    let prev = null;
    for (let k = 0; k < N; k += step) {
      if (U[k * 3 + 1] < 0.4 || this.indoor(k)) { prev = null; continue; }
      lat.set(-T[k * 3 + 2], 0, T[k * 3]);
      if (lat.lengthSq() < 0.01) { prev = null; continue; }
      lat.normalize();
      this.point(k, 0, -0.5, top);
      const bent = { l: new THREE.Vector3(), r: new THREE.Vector3(), top: top.y, gl: 0, gr: 0 };
      bent.l.copy(top).addScaledVector(lat, -1.35);
      bent.r.copy(top).addScaledVector(lat, 1.35);
      bent.gl = world.heightAt(bent.l.x, bent.l.z) - 0.3;
      bent.gr = world.heightAt(bent.r.x, bent.r.z) - 0.3;
      const h = top.y - Math.min(bent.gl, bent.gr);
      if (h < 0.8) { prev = null; continue; }
      // 两根立柱
      _a.set(bent.l.x, bent.gl, bent.l.z); _b.set(bent.l.x, top.y, bent.l.z);
      posts.push(segmentMatrix(_m, _a, _b, 0.2));
      _a.set(bent.r.x, bent.gr, bent.r.z); _b.set(bent.r.x, top.y, bent.r.z);
      posts.push(segmentMatrix(_m, _a, _b, 0.2));
      // 顶部横梁
      _a.set(bent.l.x, top.y, bent.l.z).addScaledVector(lat, -0.25);
      _b.set(bent.r.x, top.y, bent.r.z).addScaledVector(lat, 0.25);
      beams.push(segmentMatrix(_m, _a, _b, 0.16));
      // 每隔一层加横梁和斜撑
      const base = Math.max(bent.gl, bent.gr);
      let lv = Math.ceil((base + 0.5) / LV) * LV;
      let flip = false;
      for (; lv < top.y - 0.8; lv += LV) {
        _a.set(bent.l.x, lv, bent.l.z);
        _b.set(bent.r.x, lv, bent.r.z);
        beams.push(segmentMatrix(_m, _a, _b, 0.13));
        const next = Math.min(lv + LV, top.y);
        if (flip) { _a.set(bent.l.x, lv, bent.l.z); _b.set(bent.r.x, next, bent.r.z); }
        else { _a.set(bent.r.x, lv, bent.r.z); _b.set(bent.l.x, next, bent.l.z); }
        beams.push(segmentMatrix(_m, _a, _b, 0.1));
        flip = !flip;
        // 和上一榀之间的纵向连杆
        if (prev && lv < prev.top - 0.8) {
          _a.set(prev.l.x, lv, prev.l.z); _b.set(bent.l.x, lv, bent.l.z);
          beams.push(segmentMatrix(_m, _a, _b, 0.1));
          _a.set(prev.r.x, lv, prev.r.z); _b.set(bent.r.x, lv, bent.r.z);
          beams.push(segmentMatrix(_m, _a, _b, 0.1));
        }
      }
      // 高的地方加外侧斜柱
      if (h > 12) {
        for (const side of [-1, 1]) {
          const p = side < 0 ? bent.l : bent.r;
          _a.copy(p).addScaledVector(lat, side * h * 0.2);
          _a.y = world.heightAt(_a.x, _a.z) - 0.3;
          _b.set(p.x, top.y - 1.5, p.z);
          posts.push(segmentMatrix(_m, _a, _b, 0.18));
        }
      }
      prev = bent;
    }
    if (posts.count) this.group.add(posts.mesh(unitBox, woodMat));
    if (beams.count) this.group.add(beams.mesh(unitBox, woodDark));
  }

  buildStation(concrete, postMat) {
    const st = findStation(this);
    if (!st || st.len < 6) return;
    const { P } = this;
    const o = this.opts;
    const a = new THREE.Vector3().fromArray(P, st.ks * 3), b = new THREE.Vector3().fromArray(P, st.ke * 3);
    const dir = b.clone().sub(a);
    const Ls = Math.hypot(dir.x, dir.z);
    if (Ls < 3) return;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const yaw = Math.atan2(dir.x, dir.z);
    let ground = 1e9;
    for (const [dx, dz] of [[0, 0], [5, 0], [-5, 0], [0, Ls / 2], [0, -Ls / 2]]) {
      const wx = mid.x + dx * Math.cos(yaw) + dz * Math.sin(yaw), wz = mid.z - dx * Math.sin(yaw) + dz * Math.cos(yaw);
      ground = Math.min(ground, this.world.heightAt(wx, wz));
    }
    const batch = new GeoBatch();
    const box = (key, w, h, d, x, y, z) => batch.put(key, new THREE.BoxGeometry(w, h, d), x, y, z);
    const half = o.halfWidth;
    const len = Ls + 4;
    const top = o.hang ? -2.95 : 0.42; // 站台面相对轨道的高度
    const hSlab = Math.max(0.5, mid.y - ground + top + 1);
    const decks = [];
    if (!o.hang) {
      for (const s of [-1, 1]) {
        box('concrete', 3.4, hSlab, len, s * (half + 1.7), top - hSlab / 2, 0);
        box('trim', 0.3, 0.03, len, s * (half + 0.16), top + 0.075, 0);
        decks.push([3.1, s * (half + 1.85)]);
      }
      if (hSlab > 1.4) box('dark', half * 2, hSlab - 1.3, len, 0, top - hSlab / 2 - 0.65, 0);
    } else {
      box('concrete', 9.2, hSlab, len, 0, top - hSlab / 2, 0);
      for (const s of [-1, 1]) box('trim', 0.3, 0.03, len, s * (half + 0.2), top + 0.075, 0);
      decks.push([9.2, 0]);
    }
    this.lampMat = new THREE.MeshBasicMaterial({ color: '#fff1d0' });
    this.mats.push(this.lampMat);
    const roofMat = this.mat({ color: o.spineColor, metalness: 0.3, roughness: 0.5, side: THREE.DoubleSide });
    const mats = {
      concrete,
      dark: this.mat({ color: '#3b3d42', roughness: 0.95 }, 0),
      trim: this.mat({ color: '#f4c20d', roughness: 0.6 }),
    };
    const g = batch.build(mats);
    g.position.copy(mid);
    g.rotation.y = yaw;
    this.group.add(g);
    // 木地板
    for (const [w, x] of decks) {
      const deck = new THREE.Mesh(boxUV(new THREE.BoxGeometry(w, 0.06, len), 0.3), propMat('wood'));
      deck.position.set(x, top + 0.03, 0);
      deck.receiveShadow = true;
      g.add(deck);
    }
    // 屋顶、立柱、栏杆和控制室用 Blender 做的模型，按站台的长度一跨一跨排开
    const override = { spine: roofMat, lamp: this.lampMat, metal: postMat };
    const wScale = o.hang ? 0.98 : (half + 3.55) / 4.7;
    const nb = Math.max(1, Math.round(len / 4));
    const bay = len / nb, zs = bay / 4;
    const place = (name, list) => {
      for (const part of propParts(name, override)) {
        const mesh = new THREE.InstancedMesh(part.geo, part.mat, list.length);
        list.forEach((m, i) => mesh.setMatrixAt(i, m));
        mesh.castShadow = !part.mat.isMeshBasicMaterial;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        g.add(mesh);
      }
    };
    const mk = (x, z, sx, sz, ry = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, top, z), new THREE.Quaternion().setFromAxisAngle(WORLD_UP, ry), new THREE.Vector3(sx, 1, sz));
    const roofs = [], pillars = [], rails = [];
    for (let i = 0; i < nb; i++) {
      const z = -len / 2 + (i + 0.5) * bay;
      roofs.push(mk(0, z, wScale, zs));
      for (const s of [-1, 1]) rails.push(mk(s * 4.55 * wScale, z, 1, zs));
    }
    for (let i = 0; i <= nb; i++) {
      for (const s of [-1, 1]) pillars.push(mk(s * 4.2 * wScale, -len / 2 + i * bay, 1, 1));
    }
    place('st_roof', roofs);
    place('st_pillar', pillars);
    place('st_rail', rails);
    if (!o.hang) place('st_booth', [mk(half + 2.1, len / 2 - 1.7, 1, 1)]);
    this.stationLight = new THREE.PointLight('#ffe2b0', 0, 60, 1.6);
    this.stationLight.position.set(0, top + 3.6, 0);
    g.add(this.stationLight);
    this.stationInfo = { mid, yaw, Ls };
  }

  // 每帧调用：灯光随天色变化
  update(lightsOn, time) {
    if (this.bulbMat) {
      const k = this.opts.lights === 'on' ? 1 : lightsOn;
      this.bulbMesh.visible = k > 0.05;
      this.bulbMat.color.set(this.opts.lightColor).multiplyScalar(0.3 + k * 3.5);
    }
    if (this.lampMat) this.lampMat.color.set('#fff1d0').multiplyScalar(0.35 + lightsOn * 4);
    if (this.stationLight) this.stationLight.intensity = lightsOn * 45;
    if (this.launchMat) this.launchMat.emissiveIntensity = 1.8 + Math.sin(time * 8) * 0.8;
  }
}
