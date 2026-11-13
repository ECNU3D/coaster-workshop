// 主题场景段：轨道的某一段可以穿进矿洞、霓虹隧道、城堡、星空大厅，或者穿过恐龙丛林。
// 室内场景会沿着轨道生成外壳（山体或建筑）、内壁、内部的道具和灯光。
import * as THREE from 'three';
import { assets } from './assets.js';
import { propParts, propMat, crystalMat, makeProp, starTexture, planetTexture } from './props.js';
import { vegParts, vegMat } from './world.js';
import { fbm, clamp, smoothstep, mulberry32, lerp } from './util.js';

export const SCENES = [
  { id: '', name: '没有场景', indoor: false },
  { id: 'mine', name: '水晶矿洞', indoor: true, desc: '山体里的矿洞，有木架、提灯和发光的水晶' },
  { id: 'neon', name: '霓虹隧道', indoor: true, desc: '黑色的隧道，光环和灯带向后流动' },
  { id: 'castle', name: '魔法城堡', indoor: true, desc: '石头走廊，有尖拱、火把、蜡烛和彩色玻璃窗' },
  { id: 'space', name: '星空大厅', indoor: true, desc: '漆黑的大厅里有星星、行星和星云' },
  { id: 'jungle', name: '恐龙丛林', indoor: false, desc: '露天的丛林，两边是蕨类、棕榈树和恐龙' },
  { id: 'ocean', name: '海底世界', indoor: true, desc: '玻璃隧道外面是海水，有鱼群、鲨鱼、鲸鱼和珊瑚' },
];
export const SCENE_INDEX = {};
SCENES.forEach((s, i) => (SCENE_INDEX[s.id] = i));

const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _z = new THREE.Vector3();
const _c = new THREE.Color(), _x = new THREE.Vector3(), _y = new THREE.Vector3();
const CRYSTAL_COLORS = ['#3fd8ff', '#ff4fd8', '#8f6bff', '#5dff9a', '#ffb84a'];
const FISH_COLORS = ['#ff9f1a', '#ffd32a', '#3ae374', '#17c0eb', '#ff5252', '#f1f2f6', '#7d5fff'];
const CORAL_COLORS = ['#ff6b6b', '#ff9f43', '#f368e0', '#feca57', '#48dbfb', '#ff9ff3', '#e8e2cf'];
const GLSL_VN = /* glsl */ `
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), u.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), u.x), u.y); }
`;
// 海带：两片交叉的竖直面片，用蕨叶贴图（贴图里叶柄是横着的，这里把贴图坐标转 90 度）
let kelpGeo = null;
function kelpGeometry() {
  if (kelpGeo) return kelpGeo;
  const a = new THREE.PlaneGeometry(1.1, 4.8).translate(0, 2.4, 0);
  const b = a.clone().rotateY(Math.PI / 2);
  const pos = [], uv = [], nor = [], idx = [];
  for (const g of [a, b]) {
    const off = pos.length / 3;
    const p = g.attributes.position, u = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      uv.push(u.getY(i), u.getX(i));
      nor.push(0, 1, 0);
    }
    for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + off);
  }
  kelpGeo = new THREE.BufferGeometry();
  kelpGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  kelpGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  kelpGeo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  kelpGeo.setIndex(idx);
  return kelpGeo;
}

// 把同一种几何体和材质的摆放位置收集起来，最后做成实例化网格
class Instancer {
  constructor() {
    this.map = new Map();
  }
  add(parts, matrix, color = null) {
    for (const p of parts) {
      const id = p.geo.uuid + '|' + p.mat.uuid;
      let e = this.map.get(id);
      if (!e) this.map.set(id, (e = { geo: p.geo, mat: p.mat, list: [], colors: [] }));
      e.list.push(matrix.clone());
      e.colors.push(color);
    }
  }
  build(group) {
    const out = [];
    for (const e of this.map.values()) {
      const mesh = new THREE.InstancedMesh(e.geo, e.mat, e.list.length);
      e.list.forEach((m, i) => mesh.setMatrixAt(i, m));
      if (e.colors.some((c) => c)) e.colors.forEach((c, i) => mesh.setColorAt(i, _c.set(c || '#ffffff')));
      const flat = e.mat.isMeshBasicMaterial;
      mesh.castShadow = !flat;
      mesh.receiveShadow = !flat;
      mesh.frustumCulled = false;
      group.add(mesh);
      out.push(mesh);
    }
    return out;
  }
}

// ---------- 恐龙（场景段和装饰道具都会用到） ----------
// env.trainPos 是列车的位置；onRoar(距离) 在恐龙吼叫时调用
export function makeTrex(onRoar) {
  const g = new THREE.Group();
  g.add(makeProp('trex_body'));
  const head = makeProp('trex_head');
  head.position.set(0, 5.35, -2.9);
  const jaw = makeProp('trex_jaw');
  jaw.position.set(0, -0.35, -0.4);
  head.add(jaw);
  g.add(head);
  const wp = new THREE.Vector3(), local = new THREE.Vector3();
  let yaw = 0, open = 0.12, cool = 0;
  const ph = Math.random() * 6;
  g.userData.tick = (dt, t, env) => {
    g.getWorldPosition(wp);
    let target = Math.sin(t * 0.5 + ph) * 0.25, wantOpen = 0.1 + Math.max(0, Math.sin(t * 0.8 + ph)) * 0.1;
    cool -= dt;
    if (env.trainPos) {
      const d = wp.distanceTo(env.trainPos);
      if (d < 70) {
        local.copy(env.trainPos);
        g.worldToLocal(local);
        target = clamp(Math.atan2(-local.x, -local.z), -0.75, 0.75);
        if (d < 42) {
          wantOpen = 0.6;
          if (cool <= 0) {
            cool = 9;
            if (onRoar) onRoar(d);
          }
        }
      }
    }
    yaw += (target - yaw) * Math.min(1, dt * 2.5);
    open += (wantOpen - open) * Math.min(1, dt * 5);
    head.rotation.set(Math.sin(t * 1.3 + ph) * 0.04 + (open - 0.1) * 0.25, yaw, 0);
    jaw.rotation.x = -open;
  };
  return g;
}

export function makeBronto() {
  const g = new THREE.Group();
  g.add(makeProp('bronto_body'));
  const neck = makeProp('bronto_neck');
  neck.position.set(0, 4.8, -3.6);
  g.add(neck);
  const ph = Math.random() * 6;
  g.userData.tick = (dt, t) => {
    neck.rotation.set(Math.sin(t * 0.35 + ph) * 0.06, Math.sin(t * 0.25 + ph * 2) * 0.3, 0);
  };
  return g;
}

export function makeRaptor() {
  const g = new THREE.Group();
  const body = makeProp('raptor');
  g.add(body);
  const ph = Math.random() * 6;
  g.userData.tick = (dt, t) => {
    body.position.y = Math.abs(Math.sin(t * 3 + ph)) * 0.06;
    body.rotation.set(Math.sin(t * 3 + ph) * 0.03, Math.sin(t * 0.7 + ph) * 0.25, 0);
  };
  return g;
}

export class SceneManager {
  constructor(scene, world, track, particles) {
    this.scene = scene;
    this.world = world;
    this.track = track;
    this.particles = particles;
    this.group = new THREE.Group();
    this.group.name = 'scenes';
    scene.add(this.group);
    this.shells = [];
    this.shellVisible = true;
    this.lights = [];
    this.ticks = [];
    this.pool = [];
    for (let i = 0; i < 5; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 26, 1.7);
      scene.add(l);
      this.pool.push(l);
    }
    this.indoorK = new Float32Array(0);
    this.fogK = new Float32Array(0);
    this.env = { trainPos: null, lightsOn: 0, ambient: 1 };
    this.onRoar = null;
    this.mats = {};
    this.time = 0;
  }

  // ---------- 材质 ----------
  mat(id) {
    if (this.mats[id]) return this.mats[id];
    const T = assets.tex;
    const std = (p) => new THREE.MeshStandardMaterial(p);
    let m;
    switch (id) {
      case 'mineIn': m = std({ map: T.rock, normalMap: T.rock_n, color: '#7a6e64', roughness: 1, envMapIntensity: 0.04 }); break;
      case 'neonIn': m = std({ color: '#06080d', normalMap: T.scifi_n, metalness: 0.75, roughness: 0.3, envMapIntensity: 0.08 }); break;
      case 'castleIn': m = std({ map: T.stonebrick, normalMap: T.stonebrick_n, color: '#a69e94', roughness: 0.95, envMapIntensity: 0.04 }); break;
      case 'spaceIn': {
        const t = starTexture();
        m = new THREE.MeshBasicMaterial({ map: t, fog: false });
        break;
      }
      case 'spaceOut': m = std({ map: T.scifi, normalMap: T.scifi_n, color: '#6c7686', metalness: 0.7, roughness: 0.45 }); break;
      case 'neonStripA': m = new THREE.MeshBasicMaterial({ color: new THREE.Color('#00e5ff').multiplyScalar(2.6), side: THREE.DoubleSide }); break;
      case 'neonStripB': m = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff2bd6').multiplyScalar(2.6), side: THREE.DoubleSide }); break;
      case 'ring': m = new THREE.MeshBasicMaterial({ color: 0xffffff }); break;
      case 'warp': m = new THREE.MeshBasicMaterial({ color: new THREE.Color('#9fd0ff').multiplyScalar(2.4) }); break;
      case 'flame': m = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffb040').multiplyScalar(3.2) }); break;
      case 'candle': m = std({ color: '#efe6d2', roughness: 0.7 }); break;
      case 'glass': m = new THREE.MeshBasicMaterial({ map: T.stainedglass || null, color: T.stainedglass ? new THREE.Color(1.7, 1.7, 1.7) : new THREE.Color('#7a5cff') }); break;
      case 'oceanIn': m = std({ color: '#bfefff', transparent: true, opacity: 0.13, roughness: 0.05, metalness: 0, depthWrite: false, envMapIntensity: 0.25 }); break;
      case 'oceanOut': m = std({ normalMap: T.scifi_n, color: '#4fb3d9', metalness: 0.25, roughness: 0.28 }); break;
      case 'oceanSand': m = std({ map: T.sand, normalMap: T.sand_n, color: '#9fc4d6', roughness: 1, envMapIntensity: 0 }); break;
      case 'oceanWalk': m = std({ color: '#1c2a33', metalness: 0.6, roughness: 0.5, envMapIntensity: 0.1 }); break;
      case 'oceanGlow': m = new THREE.MeshBasicMaterial({ color: new THREE.Color('#5fe0ff').multiplyScalar(2.4) }); break;
      case 'oceanBeam': m = new THREE.MeshBasicMaterial({ color: '#9fe8ff', transparent: true, opacity: 0.055, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }); break;
      case 'oceanWater':
        // 隧道外面的海水：上面被水面的光照亮，越往下越暗，顶上有晃动的光纹
        m = new THREE.ShaderMaterial({
          fog: false,
          uniforms: { uTime: { value: 0 } },
          vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: `
            uniform float uTime; varying vec2 vUv;
            ${GLSL_VN}
            void main(){
              float h = sin(vUv.y * 6.2831853);
              vec3 deep = vec3(0.003, 0.022, 0.06), mid = vec3(0.008, 0.1, 0.2), top = vec3(0.06, 0.36, 0.48);
              vec3 col = mix(deep, mid, smoothstep(-0.7, 0.25, h));
              col = mix(col, top, pow(smoothstep(0.2, 1.0, h), 1.4));
              float n = vn(vec2(vUv.x * 46.0 + uTime * 0.2, vUv.y * 34.0 + uTime * 0.07)) * vn(vec2(vUv.x * 21.0 - uTime * 0.13, vUv.y * 60.0));
              col += top * pow(max(h, 0.0), 2.5) * n * 1.5;
              gl_FragColor = vec4(col, 1.0);
            }`,
        });
        break;
      case 'nebula': m = new THREE.SpriteMaterial({ map: T.nebula || null, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.85 }); break;
    }
    this.mats[id] = m;
    return m;
  }

  clear() {
    for (const c of [...this.group.children]) {
      c.traverse((o) => {
        if (o.isInstancedMesh) o.dispose();
        if (o.geometry && o.userData.own) o.geometry.dispose();
      });
      this.group.remove(c);
    }
    this.shells = [];
    this.lights = [];
    this.ticks = [];
    this.neonRings = [];
    this.candles = [];
    this.swimmers = [];
    this.jellies = [];
  }

  // 轨道变化后重新生成全部场景段
  build() {
    this.clear();
    const tr = this.track;
    const N = tr.N;
    this.indoorK = new Float32Array(N);
    this.fogK = new Float32Array(N);
    if (!N || !tr.scene) return;
    const sc = tr.scene;
    // 找出一段段连续的场景
    let start = -1;
    for (let k = 0; k < N; k++) {
      if (sc[k] !== sc[(k + N - 1) % N]) { start = k; break; }
    }
    const sections = [];
    if (start < 0) {
      if (sc[0]) sections.push({ id: sc[0], k0: 0, len: N, whole: true });
    } else {
      let k = start, guard = 0;
      while (guard < N) {
        const id = sc[k % N];
        let len = 1;
        while (len < N && sc[(k + len) % N] === id) len++;
        if (id) sections.push({ id, k0: k % N, len });
        k += len;
        guard += len;
      }
    }
    sections.forEach((sec, i) => {
      const def = SCENES[sec.id];
      if (sec.len * tr.ds < 12) return;
      const ramp = sec.whole ? 1e9 : 14;
      for (let j = 0; j < sec.len; j++) {
        const d = Math.min(j, sec.len - 1 - j) * tr.ds;
        const v = sec.whole ? 1 : smoothstep(0, ramp, d);
        const k = (sec.k0 + j) % N;
        if (def.indoor) this.indoorK[k] = v;
        else this.fogK[k] = v;
      }
      const g = new THREE.Group();
      this.group.add(g);
      this.buildSection(sec, def, g, 1000 + i * 77);
    });
    this.setShellVisible(this.shellVisible);
  }

  // 沿着这一段轨道取一圈圈截面的位置和朝向。截面始终是竖直的，不跟着轨道倾斜
  frames(sec) {
    const tr = this.track, N = tr.N;
    const step = Math.max(1, Math.round(2 / tr.ds));
    const off = tr.opts.hang ? -1.5 : 1.3;
    const out = [];
    const S = new THREE.Vector3(1, 0, 0);
    for (let j = 0; ; j += step) {
      const last = j >= sec.len - 1;
      const jj = last ? sec.len - 1 : j;
      const k = (sec.k0 + jj) % N;
      const P = new THREE.Vector3().fromArray(tr.P, k * 3), T = new THREE.Vector3().fromArray(tr.T, k * 3);
      _v.crossVectors(T, UP);
      if (_v.lengthSq() > 0.03) S.copy(_v).normalize();
      const Up = new THREE.Vector3().crossVectors(S, T).normalize();
      const C = P.clone().addScaledVector(Up, off);
      out.push({ k, P, T, S: S.clone(), Up, C, arc: jj * tr.ds, ground: this.world.heightAt(C.x, C.z) });
      if (last) break;
    }
    return out;
  }

  frameMatrix(f, x, y, z, yaw = 0, sx = 1, sy = sx, sz = sx) {
    _z.copy(f.T).negate();
    _m.makeBasis(f.S, f.Up, _z);
    _v.copy(f.C).addScaledVector(f.S, x).addScaledVector(f.Up, y).addScaledVector(f.T, z);
    _m.setPosition(_v);
    if (yaw) _m.multiply(_m2.makeRotationY(yaw));
    if (sx !== 1 || sy !== 1 || sz !== 1) _m.scale(_s.set(sx, sy, sz));
    return _m;
  }

  point(f, x, y, out) {
    return out.copy(f.C).addScaledVector(f.S, x).addScaledVector(f.Up, y);
  }

  light(pos, color, intensity, dist, flicker = 0) {
    this.lights.push({ pos: pos.clone(), color: new THREE.Color(color), intensity, dist, flicker, ph: Math.random() * 6 });
  }

  // 用一圈圈截面生成一个筒状的面。inward 为 true 时面朝里
  tube(rings, uvScaleU, uvScaleV, inward) {
    const n = rings[0].length, m = rings.length;
    const pos = new Float32Array(m * (n + 1) * 3), uv = new Float32Array(m * (n + 1) * 2);
    for (let r = 0; r < m; r++) {
      for (let i = 0; i <= n; i++) {
        const p = rings[r][i % n];
        const o = (r * (n + 1) + i) * 3;
        pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z;
        const q = (r * (n + 1) + i) * 2;
        uv[q] = rings[r].arc * uvScaleU;
        uv[q + 1] = (i / n) * uvScaleV;
      }
    }
    const idx = [];
    for (let r = 0; r < m - 1; r++) {
      for (let i = 0; i < n; i++) {
        const a = r * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        if (inward) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  // 两端的端面：内圈和外圈之间的一圈环形面，中间留出洞口
  cap(inner, outer, atStart) {
    const n = inner.length;
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= n; i++) {
      const a = inner[i % n], b = outer[i % n];
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      uv.push((i / n) * 10, 0, (i / n) * 10, a.distanceTo(b) / 5);
    }
    for (let i = 0; i < n; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      if (atStart) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  addShell(g, geo, mat, cast) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.userData.own = true;
    g.add(mesh);
    this.shells.push(mesh);
    return mesh;
  }

  buildSection(sec, def, g, seed) {
    const tr = this.track;
    const F = this.frames(sec);
    if (F.length < 4) return;
    const rng = mulberry32(seed);
    const id = def.id;
    const hang = tr.opts.hang;
    const R0 = Math.max(5.6, tr.opts.halfWidth + 2.7);
    const fd = hang ? 3.3 : 2.5; // 地面在截面中心以下多少米
    const L = F[F.length - 1].arc;
    const inst = new Instancer();
    if (id === 'jungle') {
      this.buildJungle(sec, F, g, rng, inst);
      inst.build(g);
      return;
    }

    // ---------- 内壁和外壳 ----------
    const n = 28;
    const inner = [], outer = [], water = [];
    for (const f of F) {
      const end = Math.min(f.arc, L - f.arc);
      const taper = sec.whole ? 1 : smoothstep(0, 22, end);
      const D = Math.max(3, f.C.y - f.ground + 2.5);
      const ri = [], ro = [];
      ri.arc = ro.arc = f.arc;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        let x, y, ox, oy;
        if (id === 'mine') {
          const nz = sa > -0.3 ? 1 + (fbm(a * 1.3 + 5, f.arc / 6, 3, seed) - 0.5) * 0.44 : 1;
          x = (R0 + 0.3) * ca * nz; y = (R0 + 0.3) * sa * nz;
          const Ht = (R0 + 3 + 15 * fbm(f.arc / 45, seed * 0.1, 3, 7)) * (0.55 + 0.45 * taper);
          const Wd = Math.min(40, R0 + 5 + 0.75 * D + 7 * fbm(f.arc / 30 + 9, seed * 0.1, 3, 3)) * (0.72 + 0.28 * taper);
          const on = sa > -0.2 ? 1 + (fbm(a * 2.2 + seed, f.arc / 14, 3, 11) - 0.5) * 0.56 : 1;
          ox = Wd * Math.sign(ca) * Math.pow(Math.abs(ca), 0.75) * on;
          oy = sa >= 0 ? Ht * Math.pow(sa, 0.85) * on : -D * Math.pow(-sa, 0.5);
        } else if (id === 'neon') {
          x = R0 * ca; y = R0 * sa;
          ox = (R0 + 3.2) * Math.sign(ca) * Math.pow(Math.abs(ca), 0.35);
          oy = sa >= 0 ? (R0 + 2.4) * Math.pow(sa, 0.55) : -D * Math.pow(-sa, 0.3);
        } else if (id === 'castle') {
          x = R0 * Math.sign(ca) * Math.pow(Math.abs(ca), 0.6);
          y = R0 * Math.sign(sa) * Math.pow(Math.abs(sa), 0.6) * (sa > 0 ? 1.15 : 1);
          ox = (R0 + 2.6) * Math.sign(ca) * Math.pow(Math.abs(ca), 0.18);
          oy = sa >= 0 ? (R0 * 1.15 + 3.2) * Math.pow(sa, 0.18) : -D * Math.pow(-sa, 0.18);
        } else if (id === 'ocean') {
          // 里面一层是玻璃隧道，外面一层是海水的边界（两头收窄成喇叭口），最外面是建筑的外壳
          const Rs = lerp(R0 + 0.8, 19, sec.whole ? 1 : smoothstep(0, 24, end));
          f.Rs = Rs;
          f.sb = Math.min(Rs * 0.92, 7.5);
          x = R0 * ca; y = R0 * sa;
          if (i === 0) water.push(Object.assign([], { arc: f.arc }));
          water[water.length - 1].push(this.point(f, Rs * ca, Math.max(Rs * sa * (sa > 0 ? 0.85 : 1), -f.sb), new THREE.Vector3()));
          const Ro = Rs + 1.6;
          ox = Ro * Math.sign(ca) * Math.pow(Math.abs(ca), 0.8);
          oy = sa >= 0 ? Ro * 0.9 * Math.pow(sa, 0.8) : -Math.max(D, f.sb + 1.5) * Math.pow(-sa, 0.4);
        } else {
          const Rs = lerp(R0 + 0.6, 11.5, sec.whole ? 1 : smoothstep(0, 20, end));
          x = Rs * ca; y = Rs * sa;
          const Ro = Rs + 3.5;
          ox = Ro * Math.sign(ca) * Math.pow(Math.abs(ca), 0.7);
          oy = sa >= 0 ? Ro * Math.pow(sa, 0.7) : -Math.max(D, Rs + 2) * Math.pow(-sa, 0.4);
        }
        if (id !== 'space' && y < -fd) y = -fd;
        ri.push(this.point(f, x, y, new THREE.Vector3()));
        ro.push(this.point(f, ox, oy, new THREE.Vector3()));
      }
      inner.push(ri);
      outer.push(ro);
    }
    const outMat = id === 'mine' ? vegMat('rock', this.world.env) : id === 'neon' ? propMat('scifi') : id === 'castle' ? propMat('stone') : id === 'ocean' ? this.mat('oceanOut') : this.mat('spaceOut');
    const inMat = this.mat(id + 'In');
    const innerMesh = this.addShell(g, this.tube(inner, id === 'space' ? 1 / 30 : 1 / 5, id === 'space' ? 2 : 8, true), inMat, false);
    if (id === 'ocean') {
      innerMesh.renderOrder = 6;
      innerMesh.receiveShadow = false;
      this.addShell(g, this.tube(water, 1 / 20, 1, true), this.mat('oceanWater'), false);
    }
    const outU = id === 'mine' ? 1 / 9 : 1 / 5;
    this.addShell(g, this.tube(outer, outU, id === 'mine' ? 7 : 10, false), outMat, true);
    if (!sec.whole) {
      this.addShell(g, this.cap(inner[0], outer[0], true), outMat, true);
      this.addShell(g, this.cap(inner[inner.length - 1], outer[outer.length - 1], false), outMat, true);
    }

    // ---------- 内部的布置 ----------
    const every = (meters, fn, offset = 0) => {
      let next = offset;
      F.forEach((f, i) => {
        if (f.arc >= next && f.arc > 3 && f.arc < L - 3) {
          fn(f, i);
          next = f.arc + meters;
        }
      });
    };
    if (id === 'mine') {
      const frame = propParts('mine_frame'), lantern = propParts('lantern');
      let side = 1;
      every(7, (f) => {
        inst.add(frame, this.frameMatrix(f, 0, -fd, 0));
        side = -side;
        inst.add(lantern, this.frameMatrix(f, side * 2.5, -fd + 6.66, 0));
        this.light(this.point(f, side * 2.5, -fd + 5.7, _v2), '#ffb060', 55, 24, 0.18);
      }, 3);
      every(8, (f) => {
        const s = rng() < 0.5 ? -1 : 1, sc = 0.7 + rng() * 1.1;
        const col = CRYSTAL_COLORS[Math.floor(rng() * CRYSTAL_COLORS.length)];
        inst.add(propParts('crystal', { crystal: crystalMat(col) }), this.frameMatrix(f, s * (3.4 + rng() * 0.9), -fd, (rng() - 0.5) * 3, rng() * 6, sc));
        if (sc > 1.05) this.light(this.point(f, s * 3.2, -fd + 1.2, _v2), col, 34, 15, 0.05);
        if (rng() < 0.4) {
          const col2 = CRYSTAL_COLORS[Math.floor(rng() * CRYSTAL_COLORS.length)];
          _m.copy(this.frameMatrix(f, -s * 2.2, R0 * 0.82, 1.5, rng() * 6, 0.8 + rng() * 0.6));
          _m.multiply(_m2.makeRotationX(Math.PI));
          inst.add(propParts('crystal', { crystal: crystalMat(col2) }), _m);
        }
      }, 6);
      every(34, (f) => {
        const s = rng() < 0.5 ? -1 : 1;
        if (rng() < 0.5) inst.add(propParts('minecart'), this.frameMatrix(f, s * 3.5, -fd, 0, rng() * 0.6));
        else {
          inst.add(propParts('barrel'), this.frameMatrix(f, s * 3.8, -fd, 0, 0, 1.1));
          inst.add(propParts('barrel'), this.frameMatrix(f, s * 3.5, -fd, 0.95, 1, 1.0));
        }
      }, 16);
      const cone = new THREE.ConeGeometry(0.3, 1, 6).translate(0, -0.5, 0);
      const rock = { geo: cone, mat: inMat };
      every(3, (f) => {
        const x = (rng() - 0.5) * 6;
        inst.add([rock], this.frameMatrix(f, x, Math.sqrt(Math.max(1, R0 * R0 - x * x)) * 0.92, (rng() - 0.5) * 2, 0, 0.7 + rng(), 0.8 + rng() * 1.6, 0.7 + rng()));
      }, 2);
    } else if (id === 'neon') {
      // 光环：每 5 米一个，颜色和亮度在 update 里做流动的效果
      const ringF = F.filter((f, i) => i % Math.max(1, Math.round(5 / (F[1].arc - F[0].arc || 2))) === 0 && f.arc > 2 && f.arc < L - 2);
      if (ringF.length) {
        const geo = new THREE.TorusGeometry(R0 - 0.35, 0.085, 6, 44);
        const mesh = new THREE.InstancedMesh(geo, this.mat('ring'), ringF.length);
        ringF.forEach((f, i) => {
          mesh.setMatrixAt(i, this.frameMatrix(f, 0, 0, 0));
          mesh.setColorAt(i, new THREE.Color(0, 1, 1));
        });
        mesh.frustumCulled = false;
        mesh.userData.own = true;
        g.add(mesh);
        this.neonRings.push(mesh);
      }
      // 沿着隧道的灯带
      const strip = (ang, y, width, matId, flat) => {
        const pos = [], idx = [];
        F.forEach((f, i) => {
          let a, b;
          if (flat) {
            a = this.point(f, ang - width / 2, y, new THREE.Vector3());
            b = this.point(f, ang + width / 2, y, new THREE.Vector3());
          } else {
            const r = R0 - 0.1, da = width / r / 2;
            a = this.point(f, Math.cos(ang - da) * r, Math.sin(ang - da) * r, new THREE.Vector3());
            b = this.point(f, Math.cos(ang + da) * r, Math.sin(ang + da) * r, new THREE.Vector3());
          }
          pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
          if (i < F.length - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setIndex(idx);
        const mesh = new THREE.Mesh(geo, this.mat(matId));
        mesh.frustumCulled = false;
        mesh.userData.own = true;
        g.add(mesh);
      };
      // 外壳上也拉两条灯带，晚上从外面能看出建筑的轮廓
      for (const [i, matId] of [[3, 'neonStripA'], [11, 'neonStripA'], [6, 'neonStripB'], [8, 'neonStripB']]) {
        const pos = [], idx = [];
        outer.forEach((ring, r) => {
          const a = ring[i], b = ring[i + 1];
          _v.copy(a).sub(F[r].C).normalize();
          pos.push(a.x + _v.x * 0.06, a.y + _v.y * 0.06, a.z + _v.z * 0.06);
          pos.push(a.x + (b.x - a.x) * 0.1 + _v.x * 0.06, a.y + (b.y - a.y) * 0.1 + _v.y * 0.06, a.z + (b.z - a.z) * 0.1 + _v.z * 0.06);
          if (r < outer.length - 1) idx.push(r * 2, r * 2 + 1, r * 2 + 2, r * 2 + 1, r * 2 + 3, r * 2 + 2);
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setIndex(idx);
        const mesh = new THREE.Mesh(geo, this.mat(matId));
        mesh.frustumCulled = false;
        mesh.userData.own = true;
        g.add(mesh);
        this.shells.push(mesh);
      }
      strip(0.62, 0, 0.14, 'neonStripA');
      strip(Math.PI - 0.62, 0, 0.14, 'neonStripA');
      strip(1.25, 0, 0.1, 'neonStripB');
      strip(Math.PI - 1.25, 0, 0.1, 'neonStripB');
      strip(-2.1, -fd + 0.04, 0.12, 'neonStripB', true);
      strip(2.1, -fd + 0.04, 0.12, 'neonStripB', true);
      let flip = false;
      every(18, (f) => {
        flip = !flip;
        this.light(this.point(f, 0, R0 * 0.55, _v2), flip ? '#19d8ff' : '#ff3bd0', 46, 22, 0.05);
      }, 5);
      const gs = (R0 + 0.3) / 5.75;
      inst.add(propParts('neon_gate'), this.frameMatrix(F[0], 0, 0, -0.3, 0, gs));
      inst.add(propParts('neon_gate'), this.frameMatrix(F[F.length - 1], 0, 0, 0.3, 0, gs));
    } else if (id === 'castle') {
      const arch = propParts('gothic_arch'), torch = propParts('torch');
      every(6, (f) => inst.add(arch, this.frameMatrix(f, 0, -fd, 0, 0, 1.08, 0.9, 1)), 3);
      every(12, (f) => {
        for (const s of [-1, 1]) {
          inst.add(torch, this.frameMatrix(f, s * 5.3, -fd + 3.0, 0, s * Math.PI / 2, 1.4));
          this.light(this.point(f, s * 4.6, -fd + 4.0, _v2), '#ff9a3c', 52, 20, 0.3);
        }
      }, 6);
      // 彩色玻璃窗
      const glassGeo = new THREE.PlaneGeometry(2.5, 4.6);
      const glass = { geo: glassGeo, mat: this.mat('glass') };
      every(12, (f) => {
        for (const s of [-1, 1]) inst.add([glass], this.frameMatrix(f, s * 5.42, -fd + 3.6, 0, -s * Math.PI / 2));
      }, 12);
      // 漂在空中的蜡烛
      const cGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.26, 6), fGeo = new THREE.SphereGeometry(0.05, 6, 5).translate(0, 0.2, 0);
      const list = [];
      every(1.6, (f) => {
        const x = (rng() - 0.5) * 7.6, y = -fd + 4.5 + rng() * 1.6;
        list.push({ m: this.frameMatrix(f, x, y, (rng() - 0.5) * 1.5).clone(), ph: rng() * 6, up: f.Up });
      }, 2);
      if (list.length) {
        const body = new THREE.InstancedMesh(cGeo, this.mat('candle'), list.length);
        const flame = new THREE.InstancedMesh(fGeo, this.mat('flame'), list.length);
        for (const mesh of [body, flame]) {
          mesh.frustumCulled = false;
          mesh.userData.own = true;
          g.add(mesh);
        }
        this.candles.push({ body, flame, list });
      }
      // 外墙顶上的垛口和塔楼
      const merlon = { geo: new THREE.BoxGeometry(0.6, 1.0, 1.0), mat: propMat('stone') };
      const Ht = R0 * 1.15 + 3.2, Wd = R0 + 2.6;
      every(2, (f) => {
        for (const s of [-1, 1]) inst.add([merlon], this.frameMatrix(f, s * (Wd - 0.35), Ht + 0.3, 0));
      }, 1);
      const tower = propParts('castle_tower');
      const towerAt = (f, s) => {
        const D = f.C.y - f.ground;
        const sc = clamp((Ht + D + 4) / 16, 0.7, 2.2);
        inst.add(tower, this.frameMatrix(f, s * (Wd + 1.6), -D - 0.5, 0, 0, sc));
      };
      if (!sec.whole) {
        for (const s of [-1, 1]) {
          towerAt(F[1], s);
          towerAt(F[F.length - 2], s);
        }
      }
      let ts = 1;
      every(46, (f) => { ts = -ts; towerAt(f, ts); }, 30);
    } else if (id === 'ocean') {
      this.buildOcean(F, g, rng, inst, R0, fd, L);
    } else if (id === 'space') {
      const sphere = new THREE.SphereGeometry(1, 24, 16);
      every(26, (f) => {
        const s = rng() < 0.5 ? -1 : 1, r = 0.9 + rng() * 1.5;
        const tex = planetTexture(rng());
        const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.2, roughness: 0.9, envMapIntensity: 0 });
        const p = new THREE.Mesh(sphere, mat);
        this.point(f, s * (6.6 + rng() * 2.2), -2 + rng() * 6, p.position);
        p.scale.setScalar(r);
        p.rotation.z = rng() * 0.6;
        g.add(p);
        if (rng() < 0.45) {
          const ring = new THREE.Mesh(new THREE.RingGeometry(1.4, 2.2, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(rng(), 0.4, 0.7), side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthWrite: false }));
          ring.rotation.x = Math.PI / 2 + 0.4;
          ring.userData.own = true;
          p.add(ring);
        }
        const speed = 0.1 + rng() * 0.2;
        this.ticks.push((dt) => (p.rotation.y += dt * speed));
      }, 12);
      if (assets.tex.nebula) {
        every(34, (f) => {
          const s = rng() < 0.5 ? -1 : 1;
          const sp = new THREE.Sprite(this.mat('nebula'));
          this.point(f, s * 8.6, 1 + rng() * 5, sp.position);
          sp.scale.setScalar(10 + rng() * 6);
          g.add(sp);
        }, 20);
      }
      const warp = { geo: new THREE.TorusGeometry(6.2, 0.1, 6, 48), mat: this.mat('warp') };
      every(24, (f) => inst.add([warp], this.frameMatrix(f, 0, 0, 0)), 8);
      const rockPart = vegParts('rock1', this.world.env).parts;
      every(5, (f) => {
        const a = rng() * 6.28, d = 4 + rng() * 5.5;
        inst.add(rockPart, this.frameMatrix(f, Math.cos(a) * d, Math.sin(a) * d, (rng() - 0.5) * 3, rng() * 6, 0.25 + rng() * 0.7));
      }, 4);
      let flip = false;
      every(24, (f) => {
        flip = !flip;
        this.light(this.point(f, 0, 3.5, _v2), flip ? '#8fb8ff' : '#c59bff', 40, 26, 0.03);
      }, 8);
      const gs = (R0 + 0.9) / 5.75;
      inst.add(propParts('neon_gate'), this.frameMatrix(F[0], 0, 0, -0.3, 0, gs));
      inst.add(propParts('neon_gate'), this.frameMatrix(F[F.length - 1], 0, 0, 0.3, 0, gs));
    }
    // 每隔几米在轨道下面立一根短柱，撑在场景的地面上
    if (id !== 'space') {
      const post = { geo: new THREE.CylinderGeometry(0.13, 0.16, 1, 8), mat: propMat('dark') };
      const top = hang ? 1.5 + 0.9 : -1.3 - 0.85;
      every(7, (f) => {
        if (hang) {
          inst.add([post], this.frameMatrix(f, 2.9, (top - fd) / 2, 0, 0, 1, top + fd, 1));
          _m.copy(this.frameMatrix(f, 1.45, top, 0, 0, 1, 2.9, 1)).multiply(_m2.makeRotationZ(Math.PI / 2));
          inst.add([post], _m);
        } else {
          inst.add([post], this.frameMatrix(f, 0, (top - fd) / 2, 0, 0, 1, Math.max(0.2, top + fd), 1));
        }
      }, 3.5);
    }
    inst.build(g);
  }

  // 海底世界：玻璃隧道外面的海床、珊瑚、海带、鱼群、鲨鱼、鲸鱼、蝠鲼和水母
  buildOcean(F, g, rng, inst, R0, fd, L) {
    const every = (meters, fn, offset = 0) => {
      let next = offset;
      F.forEach((f, i) => {
        if (f.arc >= next && f.arc > 3 && f.arc < L - 3) {
          fn(f, i);
          next = f.arc + meters;
        }
      });
    };
    const ribbon = (xa, xb, y, matId, uvScale) => {
      const pos = [], uv = [], idx = [];
      F.forEach((f, i) => {
        const a = typeof xa === 'function' ? xa(f) : xa, b = typeof xb === 'function' ? xb(f) : xb, yy = typeof y === 'function' ? y(f) : y;
        this.point(f, a, yy, _v); pos.push(_v.x, _v.y, _v.z);
        this.point(f, b, yy, _v); pos.push(_v.x, _v.y, _v.z);
        uv.push(f.arc * uvScale, a * uvScale, f.arc * uvScale, b * uvScale);
        if (i < F.length - 1) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, this.mat(matId));
      mesh.frustumCulled = false;
      mesh.userData.own = true;
      mesh.material.side = THREE.DoubleSide;
      g.add(mesh);
    };
    const half = (f) => Math.sqrt(Math.max(1, f.Rs * f.Rs - f.sb * f.sb)) * 0.98;
    ribbon(-2.1, 2.1, -fd + 0.03, 'oceanWalk', 1 / 3);
    ribbon((f) => -half(f), half, (f) => -f.sb + 0.06, 'oceanSand', 1 / 6);
    // 玻璃隧道的金属肋
    const rib = { geo: new THREE.TorusGeometry(R0 + 0.05, 0.1, 6, 40), mat: propMat('dark') };
    every(4, (f) => inst.add([rib], this.frameMatrix(f, 0, 0, 0)), 2);
    // 水面透下来的光：真正发光的灯在隧道上方，另外画几道光柱
    every(14, (f) => this.light(this.point(f, 0, R0 + 3.2, _v2), '#8fdcff', 95, 38, 0.06), 4);
    every(22, (f) => {
      const s = rng() < 0.5 ? -1 : 1;
      this.light(this.point(f, s * 8, -f.sb + 2.5, _v2), '#39c0ff', 45, 24, 0.05);
    }, 11);
    const beam = { geo: new THREE.ConeGeometry(2.6, 16, 10, 1, true).translate(0, -8, 0), mat: this.mat('oceanBeam') };
    every(9, (f) => {
      if (f.Rs < 15) return;
      const s = rng() < 0.5 ? -1 : 1;
      _m.copy(this.frameMatrix(f, s * (6.5 + rng() * 5), 12, (rng() - 0.5) * 4)).multiply(_m2.makeRotationZ((rng() - 0.5) * 0.5));
      inst.add([beam], _m);
    }, 5);
    // 海床上的珊瑚、海带、石头和宝箱
    const corals = ['coral_branch', 'coral_brain', 'coral_tube'].map((nm) => propParts(nm));
    const kelp = { geo: kelpGeometry(), mat: vegMat('leaf_fern', '') };
    const rock = vegParts('rock1', this.world.env).parts;
    const spot = (f) => {
      const h = half(f);
      if (h < 8) return null;
      return (rng() < 0.5 ? -1 : 1) * (6.6 + rng() * (h - 7.4));
    };
    every(1.8, (f) => {
      const x = spot(f);
      if (x === null) return;
      const col = CORAL_COLORS[Math.floor(rng() * CORAL_COLORS.length)];
      inst.add(corals[Math.floor(rng() * 3)], this.frameMatrix(f, x, -f.sb, (rng() - 0.5) * 2, rng() * 6, 0.9 + rng() * 1.6), col);
    }, 3);
    every(2.6, (f) => {
      const x = spot(f);
      if (x !== null) inst.add([kelp], this.frameMatrix(f, x, -f.sb, (rng() - 0.5) * 2, rng() * 6, 0.8 + rng() * 0.9));
    }, 4);
    every(7, (f) => {
      const x = spot(f);
      if (x !== null) inst.add(rock, this.frameMatrix(f, x, -f.sb - 0.2, 0, rng() * 6, 0.6 + rng() * 1.6));
    }, 6);
    every(70, (f) => {
      const x = spot(f);
      if (x !== null) inst.add(propParts('chest'), this.frameMatrix(f, x, -f.sb, 0, rng() * 6, 1.3));
    }, 30);
    const gs = (R0 + 0.3) / 5.75;
    const gate = propParts('neon_gate', { neon: this.mat('oceanGlow') });
    inst.add(gate, this.frameMatrix(F[0], 0, 0, -0.3, 0, gs));
    inst.add(gate, this.frameMatrix(F[F.length - 1], 0, 0, 0.3, 0, gs));

    // 会游的动物：沿着隧道的方向来回游，各有各的位置和速度
    const a0 = 26, a1 = L - 26;
    if (a1 - a0 < 20) return;
    const span = a1 - a0;
    const swim = (name, items, wag, wagF, colors) => {
      const meshes = propParts(name).map((p) => {
        const mesh = new THREE.InstancedMesh(p.geo, p.mat, items.length);
        mesh.frustumCulled = false;
        if (colors && p.key === 'fish') items.forEach((it, i) => mesh.setColorAt(i, _c.set(it.color)));
        g.add(mesh);
        return mesh;
      });
      this.swimmers.push({ meshes, items, F, a0, a1, wag, wagF });
    };
    const lane = (rMin, rMax) => ({ r: rMin + rng() * (rMax - rMin), phi: -0.25 + rng() * (Math.PI + 0.5) });
    // 鱼群：每群十来条，挨在一起游
    const fish = [];
    const schools = Math.max(2, Math.round(span / 14));
    for (let sI = 0; sI < schools; sI++) {
      const base = lane(6.8, 11.5), arc = a0 + rng() * span, speed = (rng() < 0.5 ? -1 : 1) * (1.4 + rng() * 2.6);
      const color = FISH_COLORS[Math.floor(rng() * FISH_COLORS.length)];
      const count = 8 + Math.floor(rng() * 10);
      for (let i = 0; i < count; i++) {
        fish.push({ arc: arc + (rng() - 0.5) * 5, r: base.r + (rng() - 0.5) * 1.6, phi: base.phi + (rng() - 0.5) * 0.22, speed: speed * (0.9 + rng() * 0.2), scale: 0.8 + rng() * 0.9, ph: rng() * 6, color });
      }
    }
    swim('fish', fish, 0.25, 9, true);
    const sharks = [];
    for (let i = 0; i < Math.max(1, Math.round(span / 45)); i++) sharks.push({ arc: a0 + rng() * span, ...lane(8, 12.5), speed: (rng() < 0.5 ? -1 : 1) * (1.6 + rng()), scale: 0.8 + rng() * 0.5, ph: rng() * 6 });
    swim('shark', sharks, 0.12, 2.2);
    const mantas = [];
    for (let i = 0; i < Math.max(1, Math.round(span / 70)); i++) mantas.push({ arc: a0 + rng() * span, r: 7.6 + rng() * 2, phi: 1.1 + rng() * 0.9, speed: (rng() < 0.5 ? -1 : 1) * (1.2 + rng() * 0.8), scale: 0.9 + rng() * 0.5, ph: rng() * 6 });
    swim('manta', mantas, 0.05, 1.2);
    if (span > 80) swim('whale', [{ arc: a0 + rng() * span, r: 13.2, phi: 1.15 + rng() * 0.8, speed: (rng() < 0.5 ? -1 : 1) * 1.1, scale: 0.85, ph: rng() * 6 }], 0.04, 0.6);
    // 水母：原地上下漂
    const jl = [];
    every(9, (f) => {
      if (f.Rs < 12) return;
      const ln = lane(7, 11);
      jl.push({ m: this.frameMatrix(f, Math.cos(ln.phi) * ln.r, Math.max(-f.sb + 2, Math.sin(ln.phi) * ln.r), (rng() - 0.5) * 3, rng() * 6, 0.7 + rng() * 0.9).clone(), up: f.Up, ph: rng() * 6 });
    }, 7);
    if (jl.length) {
      const meshes = propParts('jellyfish').map((p) => {
        const mesh = new THREE.InstancedMesh(p.geo, p.mat, jl.length);
        mesh.frustumCulled = false;
        mesh.renderOrder = 5;
        g.add(mesh);
        return mesh;
      });
      this.jellies.push({ meshes, list: jl });
    }
  }

  // 露天的丛林场景
  buildJungle(sec, F, g, rng, inst) {
    const tr = this.track, world = this.world;
    const L = F[F.length - 1].arc;
    const fern = propParts('fern'), tropic = propParts('tropic');
    const palm = vegParts('palm', world.env), broad = vegParts('broadleaf', world.env);
    const pos = new THREE.Vector3();
    const side = new THREE.Vector3();
    const spot = (f, lat) => {
      side.set(f.S.x, 0, f.S.z).normalize();
      pos.copy(f.P).addScaledVector(side, lat);
      pos.y = world.heightAt(pos.x, pos.z);
      if (pos.y < world.waterLevel + 0.3) return false;
      // 不要种在别的轨道下面太近的地方
      return !tr.forNear(pos.x, pos.z, 2.2, (k) => Math.abs(tr.P[k * 3 + 1] - pos.y) < 4.5);
    };
    const put = (parts, sc, lift = 0) => {
      _q.setFromAxisAngle(UP, rng() * Math.PI * 2);
      _m.compose(_v.copy(pos).setY(pos.y - 0.05 + lift), _q, _s.setScalar(sc));
      inst.add(parts, _m);
    };
    F.forEach((f, i) => {
      for (let n = 0; n < 2; n++) {
        const lat = (rng() < 0.5 ? -1 : 1) * (2.6 + rng() * 5.5);
        if (spot(f, lat)) put(fern, 0.8 + rng() * 0.8);
      }
      if (i % 2 === 0) {
        const lat = (rng() < 0.5 ? -1 : 1) * (4 + rng() * 7);
        if (spot(f, lat)) put(tropic, 1.0 + rng() * 1.0);
      }
      if (i % 3 === 1) {
        const lat = (rng() < 0.5 ? -1 : 1) * (5.5 + rng() * 9);
        if (spot(f, lat)) {
          const v = rng() < 0.7 ? palm : broad;
          put(v.parts, v.scale * (0.8 + rng() * 0.6));
        }
      }
    });
    // 恐龙：面朝轨道站在两边
    const dino = (frac, lat, make, sc = 1, turn = 0) => {
      const f = F[Math.min(F.length - 1, Math.floor(frac * F.length))];
      if (!f || !spot(f, lat)) return;
      const d = make();
      d.position.copy(pos);
      const dir = _v.copy(f.P).sub(pos).setY(0).normalize();
      d.rotation.y = Math.atan2(-dir.x, -dir.z) + turn;
      d.scale.setScalar(sc);
      g.add(d);
      if (d.userData.tick) this.ticks.push((dt, t, env) => d.userData.tick(dt, t, env));
    };
    const count = Math.max(1, Math.round(L / 110));
    for (let i = 0; i < count; i++) {
      const base = (i + 0.2) / count, span = 1 / count;
      dino(base + span * 0.15, (i % 2 ? -1 : 1) * 11, () => makeTrex((dist) => this.onRoar && this.onRoar(dist)));
      dino(base + span * 0.55, (i % 2 ? 1 : -1) * 19, makeBronto, 1.1);
      for (let r = 0; r < 3; r++) dino(base + span * 0.8 + r * 0.012, (i % 2 ? 1 : -1) * (5 + r * 1.6), makeRaptor, 0.9 + rng() * 0.2, 1.2);
    }
    // 两端各立一道木门架和火把
    for (const f of [F[0], F[F.length - 1]]) {
      const h = f.P.y - world.heightAt(f.P.x, f.P.z);
      if (h > 5 || tr.opts.hang) continue;
      side.set(f.S.x, 0, f.S.z).normalize();
      _z.set(f.T.x, 0, f.T.z).normalize().negate();
      _m.makeBasis(side, UP, _z).setPosition(_v.copy(f.P).setY(f.P.y - h));
      _m.scale(_s.set(1.15, 1.15 + h * 0.12, 1.15));
      inst.add(propParts('mine_frame'), _m);
      for (const s of [-1, 1]) {
        _v.copy(f.P).addScaledVector(side, s * 5.2).setY(f.P.y - h + 3.4);
        _m.makeBasis(side, UP, _z).setPosition(_v);
        _m.multiply(_m2.makeRotationY(s > 0 ? Math.PI : 0)).scale(_s.setScalar(1.6));
        inst.add(propParts('torch'), _m);
        this.light(_v2.copy(_v).setY(_v.y + 1.2), '#ff9a3c', 60, 24, 0.3);
      }
    }
  }

  setShellVisible(on) {
    this.shellVisible = on;
    for (const m of this.shells) m.visible = on;
  }

  // 列车在弧长 s 处时，是否在室内（0 到 1）
  indoorAt(s) {
    const tr = this.track;
    if (!tr.N || !this.indoorK.length) return 0;
    let k = Math.floor(s / tr.ds) % tr.N;
    if (k < 0) k += tr.N;
    return this.indoorK[k] || 0;
  }

  fogAt(s) {
    const tr = this.track;
    if (!tr.N || !this.fogK.length) return 0;
    let k = Math.floor(s / tr.ds) % tr.N;
    if (k < 0) k += tr.N;
    return this.fogK[k] || 0;
  }

  // 植被清理用：这个位置是否被室内场景的外壳盖住
  covers(x, z) {
    const tr = this.track;
    if (!tr.N || !tr.scene) return false;
    return tr.forNear(x, z, 24, (k) => {
      const id = tr.scene[k];
      if (!id || !SCENES[id].indoor) return false;
      const r = id === 1 || id === SCENE_INDEX.ocean ? 24 : 13;
      const dx = tr.P[k * 3] - x, dz = tr.P[k * 3 + 2] - z;
      return dx * dx + dz * dz < r * r;
    });
  }

  update(dt, camPos, trainPos, lightsOn, ambient) {
    this.time += dt;
    const t = this.time;
    this.env.trainPos = trainPos;
    this.env.lightsOn = lightsOn;
    this.env.ambient = ambient;
    for (const fn of this.ticks) fn(dt, t, this.env);
    // 海底世界：海水的光纹、游动的动物、水母和气泡
    if (this.mats.oceanWater) this.mats.oceanWater.uniforms.uTime.value = t;
    for (const sw of this.swimmers || []) {
      const F = sw.F, stepLen = F[1].arc - F[0].arc;
      sw.items.forEach((it, i) => {
        it.arc += it.speed * dt;
        if (it.arc > sw.a1) it.arc = sw.a0;
        else if (it.arc < sw.a0) it.arc = sw.a1;
        const fi = Math.min(F.length - 2, Math.max(0, Math.floor(it.arc / stepLen)));
        const fa = F[fi], fb = F[fi + 1];
        const u = clamp((it.arc - fa.arc) / Math.max(0.01, fb.arc - fa.arc), 0, 1);
        const dir = Math.sign(it.speed) || 1;
        _x.copy(fa.S).lerp(fb.S, u).normalize();
        _y.copy(fa.Up).lerp(fb.Up, u).normalize();
        _z.copy(fa.T).lerp(fb.T, u).normalize();
        _v.copy(fa.C).lerp(fb.C, u)
          .addScaledVector(_x, Math.cos(it.phi) * it.r)
          .addScaledVector(_y, Math.sin(it.phi) * it.r + Math.sin(t * 0.6 + it.ph) * 0.4);
        // 游到两头的喇叭口附近时缩小消失，再从另一头出来
        const fade = smoothstep(0, 7, Math.min(it.arc - sw.a0, sw.a1 - it.arc));
        _x.multiplyScalar(dir);
        _z.multiplyScalar(-dir);
        _m.makeBasis(_x, _y, _z).setPosition(_v);
        _m.multiply(_m2.makeRotationY(Math.sin(t * sw.wagF + it.ph) * sw.wag));
        _m.scale(_s.setScalar(it.scale * fade));
        for (const mesh of sw.meshes) mesh.setMatrixAt(i, _m);
      });
      for (const mesh of sw.meshes) mesh.instanceMatrix.needsUpdate = true;
    }
    for (const jg of this.jellies || []) {
      jg.list.forEach((it, i) => {
        _m.copy(it.m);
        const bob = Math.sin(t * 0.7 + it.ph) * 0.6;
        _m.elements[12] += it.up.x * bob; _m.elements[13] += it.up.y * bob; _m.elements[14] += it.up.z * bob;
        const pulse = 1 + Math.sin(t * 2.2 + it.ph) * 0.12;
        _m.scale(_s.set(pulse, 2 - pulse, pulse));
        for (const mesh of jg.meshes) mesh.setMatrixAt(i, _m);
      });
      for (const mesh of jg.meshes) mesh.instanceMatrix.needsUpdate = true;
    }
    if (trainPos && this.particles && this.swimmers && this.swimmers.length) {
      const k = this.track.nearestSample(trainPos, 6);
      if (k >= 0 && this.track.scene[k] === SCENE_INDEX.ocean && this.indoorK[k] > 0.6) {
        for (let i = 0; i < 2; i++) {
          const a = Math.random() * 6.28, d = 6.5 + Math.random() * 6;
          this.particles.spawn(trainPos.x + Math.cos(a) * d, trainPos.y - 4 + Math.random() * 6, trainPos.z + Math.sin(a) * d,
            (Math.random() - 0.5) * 0.4, 1.2 + Math.random() * 1.5, (Math.random() - 0.5) * 0.4, 0.25, 0.42, 0.5, 0.16, 2.6, -0.08);
        }
      }
    }
    // 霓虹光环：颜色沿着隧道向后流动
    const c = new THREE.Color();
    for (const mesh of this.neonRings || []) {
      for (let i = 0; i < mesh.count; i++) {
        const p = ((i * 0.16 + t * 1.7) % 1 + 1) % 1;
        const b = 0.35 + 3.2 * Math.pow(Math.max(0, 1 - Math.abs(p - 0.5) * 4), 2);
        c.setHSL(0.5 + 0.35 * Math.sin(i * 0.21 + t * 0.4) ** 2, 1, 0.5).multiplyScalar(b);
        mesh.setColorAt(i, c);
      }
      mesh.instanceColor.needsUpdate = true;
    }
    // 蜡烛上下浮动
    for (const cd of this.candles || []) {
      cd.list.forEach((it, i) => {
        _m.copy(it.m);
        _m.elements[12] += it.up.x * Math.sin(t * 1.2 + it.ph) * 0.12;
        _m.elements[13] += it.up.y * Math.sin(t * 1.2 + it.ph) * 0.12;
        _m.elements[14] += it.up.z * Math.sin(t * 1.2 + it.ph) * 0.12;
        cd.body.setMatrixAt(i, _m);
        cd.flame.setMatrixAt(i, _m);
      });
      cd.body.instanceMatrix.needsUpdate = true;
      cd.flame.instanceMatrix.needsUpdate = true;
    }
    // 场景里的灯很多，真正发光的只有离镜头最近的几盏
    const near = [];
    for (const l of this.lights) {
      const d = l.pos.distanceToSquared(camPos);
      if (d < 70 * 70) near.push([d, l]);
    }
    near.sort((a, b) => a[0] - b[0]);
    this.pool.forEach((pl, i) => {
      const e = near[i];
      if (!e) {
        pl.intensity = 0;
        return;
      }
      const l = e[1];
      pl.position.copy(l.pos);
      pl.color.copy(l.color);
      pl.distance = l.dist;
      const fade = 1 - smoothstep(45, 68, Math.sqrt(e[0]));
      pl.intensity = l.intensity * fade * (1 + Math.sin(t * 11 + l.ph) * l.flicker * 0.5 + Math.sin(t * 23 + l.ph * 2) * l.flicker * 0.5);
    });
  }
}
