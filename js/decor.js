// 装饰和道具：可以摆放在场景里的物体，以及烟花、喷泉等用到的粒子
import * as THREE from 'three';
import { GeoBatch, clamp } from './util.js';
import { makeVegObject } from './world.js';
import { makeProp, makeMountain, makeWaterfall } from './props.js';
import { makeTrex, makeBronto, makeRaptor } from './scenes.js';

// 简单的粒子池：烟花、喷泉、火焰、刹车火花都用它
export class Particles {
  constructor(max = 4000) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.base = new Float32Array(max * 4);
    this.cursor = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute float aSize; attribute vec3 color; uniform float uScale;
        varying vec3 vColor;
        void main(){
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / max(-mv.z, 0.5);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vColor * a, a);
        }`,
    });
    this.material = mat;
    this.object = new THREE.Points(geo, mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 11;
  }
  spawn(x, y, z, vx, vy, vz, r, g, b, size, life, gravity = 1) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.base[i * 4] = r; this.base[i * 4 + 1] = g; this.base[i * 4 + 2] = b; this.base[i * 4 + 3] = size;
    this.life[i] = life; this.maxLife[i] = life; this.grav[i] = gravity;
  }
  update(dt) {
    const { pos, vel, col, size, life, maxLife, grav, base } = this;
    const dragK = Math.exp(-0.9 * dt);
    for (let i = 0; i < this.max; i++) {
      if (life[i] <= 0) {
        if (size[i] !== 0) size[i] = 0;
        continue;
      }
      life[i] -= dt;
      vel[i * 3] *= dragK; vel[i * 3 + 2] *= dragK;
      vel[i * 3 + 1] = vel[i * 3 + 1] * dragK - 9.8 * grav[i] * dt;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      const k = clamp(life[i] / maxLife[i], 0, 1);
      const f = k * k;
      col[i * 3] = base[i * 4] * f; col[i * 3 + 1] = base[i * 4 + 1] * f; col[i * 3 + 2] = base[i * 4 + 2] * f;
      size[i] = base[i * 4 + 3] * (0.4 + 0.6 * k);
    }
    const g = this.object.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }
}

const std = (p) => new THREE.MeshStandardMaterial(p);
// 路灯照在地上的光斑：中间亮、边缘逐渐变暗
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const M = {
  wood: std({ color: '#8a623c', roughness: 0.9 }),
  stone: std({ color: '#9a9b9d', roughness: 0.92 }),
  metal: std({ color: '#c9ced6', metalness: 0.8, roughness: 0.35 }),
  dark: std({ color: '#2a2d33', metalness: 0.6, roughness: 0.5 }),
  white: std({ color: '#f4f4f0', roughness: 0.7 }),
  red: std({ color: '#d7263d', roughness: 0.6 }),
  blue: std({ color: '#2176ae', roughness: 0.6 }),
  yellow: std({ color: '#fbb13c', roughness: 0.6 }),
  green: std({ color: '#3f8f4f', roughness: 0.8 }),
  purple: std({ color: '#8a4fff', roughness: 0.6 }),
  water: std({ color: '#3fa7d6', roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.8 }),
  rock: std({ color: '#4a4744', roughness: 0.95, side: THREE.DoubleSide }),
  lamp: new THREE.MeshBasicMaterial({ color: '#fff1d0' }),
  neonA: new THREE.MeshBasicMaterial({ color: '#00e5ff' }),
  neonB: new THREE.MeshBasicMaterial({ color: '#ff2bd6' }),
  flower1: std({ color: '#ff6b9d', roughness: 0.7 }),
  flower2: std({ color: '#ffd166', roughness: 0.7 }),
  pool: new THREE.MeshBasicMaterial({ color: '#ffd9a0', map: glowTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
  beam: new THREE.MeshBasicMaterial({ color: '#cfe8ff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
};
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, seg = 12) => new THREE.CylinderGeometry(rt, rb, h, seg);
const cone = (r, h, seg = 12) => new THREE.ConeGeometry(r, h, seg);
const sph = (r, a = 12, b = 8) => new THREE.SphereGeometry(r, a, b);
const HALF = Math.PI / 2;
const COLORS = [[4, 0.6, 0.4], [0.5, 2.5, 4], [4, 3, 0.5], [0.8, 4, 1], [3.5, 0.6, 4], [4, 4, 4]];

function veg(type) {
  const g = makeVegObject(type, '');
  g.traverse((o) => { if (o.isMesh) o.userData.shared = true; });
  return g;
}
const PAINTS = {};
function paint(color) {
  if (!PAINTS[color]) PAINTS[color] = new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.4 });
  return PAINTS[color];
}
const CABIN_COLORS = ['#d7263d', '#fbb13c', '#2176ae', '#3f8f4f', '#8a4fff', '#f4f4f0'];

export const DECOR_ITEMS = [
  // ---------- 静态装饰 ----------
  { id: 'tree_broad', name: '阔叶树', cat: 'decor', build: () => veg('broadleaf') },
  { id: 'tree_pine', name: '松树', cat: 'decor', build: () => veg('pine') },
  { id: 'tree_palm', name: '棕榈树', cat: 'decor', build: () => veg('palm') },
  { id: 'rock', name: '岩石', cat: 'decor', build: () => { const g = veg('rock1'); g.scale.setScalar(1.8); return g; } },
  {
    id: 'lamp', name: '路灯', cat: 'decor',
    build() {
      const g = makeProp('lamp_post');
      const pool = new THREE.Mesh(new THREE.CircleGeometry(5.5, 24).rotateX(-HALF), M.pool);
      pool.position.set(0.9, 0.12, 0);
      pool.renderOrder = 3;
      g.add(pool);
      return g;
    },
  },
  { id: 'bench', name: '长椅', cat: 'decor', build: () => makeProp('bench') },
  {
    id: 'flower', name: '花坛', cat: 'decor',
    build() {
      const b = new GeoBatch();
      b.put('stone', cyl(1.6, 1.7, 0.45, 16), 0, 0.22, 0);
      b.put('green', cyl(1.45, 1.45, 0.1, 16), 0, 0.47, 0);
      for (let i = 0; i < 14; i++) {
        const a = i * 2.4, r = 0.3 + (i % 5) * 0.25;
        b.put(i % 2 ? 'flower1' : 'flower2', sph(0.17, 8, 6), Math.cos(a) * r, 0.62, Math.sin(a) * r);
      }
      return b.build(M);
    },
  },
  { id: 'tent', name: '小吃摊', cat: 'decor', build: () => makeProp('kiosk') },
  { id: 'fern', name: '蕨丛', cat: 'decor', build: () => makeProp('fern') },
  { id: 'tropic', name: '热带植物', cat: 'decor', build: () => makeProp('tropic') },
  { id: 'barrel', name: '木桶', cat: 'decor', build: () => makeProp('barrel') },
  { id: 'minecart', name: '矿车', cat: 'decor', build: () => makeProp('minecart') },
  { id: 'crystal', name: '水晶簇', cat: 'decor', build: () => { const g = makeProp('crystal'); g.scale.setScalar(1.6); return g; } },
  {
    id: 'flags', name: '彩旗杆', cat: 'decor',
    build() {
      const b = new GeoBatch();
      b.put('metal', cyl(0.06, 0.08, 9, 8), 0, 4.5, 0);
      b.put('yellow', sph(0.14), 0, 9.05, 0);
      const keys = ['red', 'yellow', 'blue', 'green', 'purple'];
      for (let i = 0; i < 5; i++) b.put(keys[i], box(1.3 - i * 0.12, 0.6, 0.03), 0.7 - i * 0.06, 8.5 - i * 0.75, 0);
      return b.build(M);
    },
  },
  // ---------- 大型布景 ----------
  { id: 'mountain', name: '石山', cat: 'scene', desc: '用放大和缩小可以调整山的大小', build: (ctx) => makeMountain(ctx.world.env, 1 + Math.floor(Math.random() * 50)) },
  { id: 'waterfall', name: '瀑布', cat: 'scene', build: (ctx) => makeWaterfall(ctx.world.env, ctx) },
  { id: 'castle_keep', name: '城堡', cat: 'scene', build: () => makeProp('castle_keep') },
  { id: 'tower', name: '城堡塔楼', cat: 'scene', build: () => makeProp('castle_tower') },
  { id: 'castle_wall', name: '城墙', cat: 'scene', build: () => makeProp('castle_wall') },
  { id: 'castle_gate', name: '城门', cat: 'scene', snap: 'ground', desc: '会自动跨在最近的一段轨道上，列车从门洞里穿过', build: () => makeProp('castle_gate') },
  { id: 'trex', name: '霸王龙', cat: 'scene', desc: '会盯着列车看，列车靠近时张嘴吼叫', build: (ctx) => makeTrex(ctx.onRoar) },
  { id: 'bronto', name: '长颈龙', cat: 'scene', build: () => makeBronto() },
  { id: 'raptor', name: '迅猛龙', cat: 'scene', build: () => makeRaptor() },
  {
    id: 'lighthouse', name: '灯塔', cat: 'scene', desc: '天黑以后光柱会转起来',
    build() {
      const g = makeProp('lighthouse');
      const head = new THREE.Group();
      head.position.y = 21.3;
      for (const s of [-1, 1]) {
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(9, 0.8, 150, 14, 1, true).rotateZ(-s * HALF).translate(s * 76, 0, 0), M.beam);
        beam.renderOrder = 4;
        head.add(beam);
      }
      g.add(head);
      g.userData.tick = (dt) => { head.rotation.y += dt * 0.5; };
      return g;
    },
  },
  {
    id: 'ship', name: '帆船', cat: 'scene', desc: '放在水面上会随着波浪起伏',
    build() {
      const g = new THREE.Group();
      const hull = makeProp('ship');
      g.add(hull);
      const ph = Math.random() * 6;
      g.userData.tick = (dt, t) => {
        hull.position.y = Math.sin(t * 0.6 + ph) * 0.25 - 0.2;
        hull.rotation.set(Math.sin(t * 0.45 + ph) * 0.025, 0, Math.sin(t * 0.55 + ph * 2) * 0.04);
      };
      return g;
    },
  },
  {
    id: 'dolphins', name: '海豚', cat: 'scene', desc: '三只海豚绕着圈跃出水面',
    build() {
      const g = new THREE.Group();
      const list = [];
      for (let i = 0; i < 3; i++) {
        const d = makeProp('dolphin');
        g.add(d);
        list.push({ d, ph: i * 2.1 + Math.random(), r: 5 + i * 1.6 });
      }
      g.userData.tick = (dt, t) => {
        for (const it of list) {
          // 沿着圆圈前进，同时一上一下地跃出水面
          const a = t * 0.45 + it.ph, j = t * 1.7 + it.ph * 3;
          it.d.position.set(Math.cos(a) * it.r, Math.sin(j) * 1.9 - 0.7, Math.sin(a) * it.r);
          it.d.rotation.set(Math.cos(j) * 0.75, -a + Math.PI, 0, 'YXZ');
        }
      };
      return g;
    },
  },
  // ---------- 会动的道具 ----------
  {
    id: 'ferris', name: '摩天轮', cat: 'prop',
    build() {
      const g = new THREE.Group();
      g.add(makeProp('ferris_base'));
      const wheel = makeProp('ferris_wheel');
      wheel.position.set(0, 17.5, 0);
      g.add(wheel);
      const cabins = [];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const cabin = makeProp('ferris_cabin', { paint: paint(CABIN_COLORS[i % 6]) });
        cabin.position.set(Math.cos(a) * 14, Math.sin(a) * 14, 0);
        wheel.add(cabin);
        cabins.push(cabin);
      }
      g.userData.tick = (dt) => {
        wheel.rotation.z += dt * 0.12;
        for (const c of cabins) c.rotation.z = -wheel.rotation.z;
      };
      return g;
    },
  },
  {
    id: 'carousel', name: '旋转木马', cat: 'prop',
    build() {
      const g = new THREE.Group();
      g.add(makeProp('carousel_base'));
      const spin = makeProp('carousel_top');
      g.add(spin);
      const horses = [];
      const colors = ['#f4f4f0', '#f6d9b0', '#d9e6f6', '#f3c7d3'];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const horse = makeProp('carousel_horse', { white: paint(colors[i % 4]) });
        horse.position.set(Math.cos(a) * 3.7, 0.5, Math.sin(a) * 3.7);
        horse.rotation.y = -a;
        spin.add(horse);
        horses.push(horse);
      }
      let t = 0;
      g.userData.tick = (dt) => {
        t += dt;
        spin.rotation.y -= dt * 0.5;
        horses.forEach((h, i) => (h.position.y = 0.5 + Math.sin(t * 2 + i * 1.6) * 0.3));
      };
      return g;
    },
  },
  {
    id: 'balloon', name: '热气球', cat: 'prop',
    build() {
      const g = new THREE.Group();
      const inner = makeProp('balloon');
      g.add(inner);
      let t = Math.random() * 10;
      g.userData.tick = (dt) => {
        t += dt;
        inner.position.set(Math.sin(t * 0.07) * 14, 30 + Math.sin(t * 0.3) * 3, Math.cos(t * 0.05) * 14);
        inner.rotation.y = t * 0.05;
      };
      inner.position.y = 30;
      return g;
    },
  },
  {
    id: 'fountain', name: '喷泉', cat: 'prop',
    build(ctx) {
      const g = makeProp('fountain');
      const wp = new THREE.Vector3();
      let acc = 0;
      g.userData.tick = (dt, t, env) => {
        acc += dt * 90;
        g.getWorldPosition(wp);
        const k = 0.5 + env.ambient * 0.9;
        while (acc > 1) {
          acc -= 1;
          const a = Math.random() * Math.PI * 2, sp = 1.2 + Math.random() * 1.8;
          const up = Math.random() < 0.35 ? 10 : 6;
          ctx.particles.spawn(wp.x, wp.y + 3.9 * g.scale.y, wp.z, Math.cos(a) * sp, up + Math.random() * 1.5, Math.sin(a) * sp, 0.35 * k, 0.6 * k, 0.9 * k, 0.22, 1.5, 1);
        }
      };
      return g;
    },
  },
  {
    id: 'fireworks', name: '烟花', cat: 'prop',
    build(ctx) {
      const b = new GeoBatch();
      b.put('dark', box(1.2, 0.5, 1.2), 0, 0.25, 0);
      for (const [x, z] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) b.put('red', cyl(0.12, 0.12, 0.9, 8), x, 0.8, z);
      const g = b.build(M);
      const wp = new THREE.Vector3();
      let next = 1 + Math.random() * 2;
      const shells = [];
      g.userData.tick = (dt, t, env) => {
        g.getWorldPosition(wp);
        next -= dt;
        if (next <= 0) {
          next = 1.2 + Math.random() * 3.2;
          shells.push({ x: wp.x, y: wp.y + 1, z: wp.z, vx: (Math.random() - 0.5) * 9, vy: 34 + Math.random() * 12, vz: (Math.random() - 0.5) * 9, life: 1.5 + Math.random() * 0.5, c: COLORS[Math.floor(Math.random() * COLORS.length)] });
        }
        for (let i = shells.length - 1; i >= 0; i--) {
          const s = shells[i];
          s.life -= dt;
          s.vy -= 9.8 * dt;
          s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
          ctx.particles.spawn(s.x, s.y, s.z, 0, 0, 0, 3, 2, 1, 0.5, 0.35, 0.1);
          if (s.life <= 0) {
            shells.splice(i, 1);
            const n = 130, sp = 16 + Math.random() * 10;
            const c2 = COLORS[Math.floor(Math.random() * COLORS.length)];
            for (let j = 0; j < n; j++) {
              const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
              const v = sp * (0.85 + Math.random() * 0.3);
              const c = j % 3 === 0 ? c2 : s.c;
              ctx.particles.spawn(s.x, s.y, s.z, r * Math.cos(a) * v, u * v, r * Math.sin(a) * v, c[0], c[1], c[2], 1.3, 1.6 + Math.random() * 0.8, 0.35);
            }
            if (env.onBoom) env.onBoom(s.x, s.y, s.z);
          }
        }
      };
      return g;
    },
  },
  {
    id: 'ring', name: '光环门', cat: 'prop', snap: true, desc: '会自动套在最近的一段轨道上',
    build() {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: '#00e5ff' });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(4.8, 0.22, 10, 48), mat);
      const outer = new THREE.Mesh(new THREE.TorusGeometry(5.3, 0.1, 8, 48), M.dark);
      outer.castShadow = true;
      g.add(ring, outer);
      const col = new THREE.Color();
      const wp = new THREE.Vector3();
      let flash = 0;
      const hue = Math.random();
      g.userData.tick = (dt, t, env) => {
        g.getWorldPosition(wp);
        if (env.trainPos && wp.distanceToSquared(env.trainPos) < 100) flash = 1;
        flash = Math.max(0, flash - dt * 1.5);
        col.setHSL((hue + t * 0.05) % 1, 1, 0.5).multiplyScalar(1.2 + env.lightsOn * 1.6 + flash * 6);
        mat.color.copy(col);
      };
      return g;
    },
  },
  {
    id: 'tunnel', name: '隧道', cat: 'prop', snap: true, desc: '会自动套在最近的一段轨道上',
    build() {
      const g = new THREE.Group();
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(5.4, 5.4, 22, 20, 1, true).rotateX(HALF), M.rock);
      tube.castShadow = true;
      tube.receiveShadow = true;
      g.add(tube);
      const b = new GeoBatch();
      for (const z of [-11, 11]) b.put('stone', new THREE.TorusGeometry(5.6, 0.5, 8, 24), 0, 0, z);
      for (let i = 0; i < 5; i++) {
        b.put(i % 2 ? 'neonA' : 'neonB', new THREE.TorusGeometry(5.25, 0.07, 6, 32), 0, 0, -8.8 + i * 4.4);
      }
      g.add(b.build(M));
      return g;
    },
  },
  {
    id: 'flame', name: '喷火柱', cat: 'prop', desc: '列车经过时会喷火',
    build(ctx) {
      const b = new GeoBatch();
      b.put('dark', cyl(0.35, 0.5, 3.4, 10), 0, 1.7, 0);
      b.put('metal', cyl(0.5, 0.35, 0.3, 10), 0, 3.5, 0);
      const g = b.build(M);
      const wp = new THREE.Vector3();
      let burst = 0, idle = 3 + Math.random() * 4;
      g.userData.tick = (dt, t, env) => {
        g.getWorldPosition(wp);
        idle -= dt;
        const near = env.trainPos && wp.distanceToSquared(env.trainPos) < 45 * 45;
        if ((near || idle <= 0) && burst <= 0) {
          burst = 1.1;
          idle = 5 + Math.random() * 5;
        }
        if (burst > 0) {
          burst -= dt;
          for (let i = 0; i < 5; i++) {
            ctx.particles.spawn(wp.x + (Math.random() - 0.5) * 0.4, wp.y + 3.6 * g.scale.y, wp.z + (Math.random() - 0.5) * 0.4,
              (Math.random() - 0.5) * 2.5, 13 + Math.random() * 7, (Math.random() - 0.5) * 2.5, 5, 1.6 + Math.random(), 0.25, 2.2, 0.55 + Math.random() * 0.3, -0.15);
          }
        }
      };
      return g;
    },
  },
  {
    id: 'searchlight', name: '探照灯', cat: 'prop', desc: '天黑以后会亮起光柱',
    build() {
      const g = new THREE.Group();
      const b = new GeoBatch();
      b.put('dark', cyl(0.8, 1, 0.6, 12), 0, 0.3, 0);
      g.add(b.build(M));
      const head = new THREE.Group();
      head.position.y = 1.1;
      const hb = new GeoBatch();
      hb.put('metal', cyl(0.6, 0.45, 1, 12), 0, 0.3, 0);
      hb.put('lamp', cyl(0.55, 0.55, 0.05, 12), 0, 0.82, 0);
      head.add(hb.build(M));
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(7, 0.5, 160, 16, 1, true).translate(0, 80.8, 0), M.beam);
      beam.renderOrder = 4;
      head.add(beam);
      g.add(head);
      const ph = Math.random() * 6;
      g.userData.tick = (dt, t) => {
        head.rotation.z = 0.5 + Math.sin(t * 0.35 + ph) * 0.3;
        g.children[1].rotation.y = t * 0.25 + ph;
      };
      return g;
    },
  },
  {
    id: 'windmill', name: '风车', cat: 'prop',
    build() {
      const g = new THREE.Group();
      g.add(makeProp('windmill_body'));
      const blades = makeProp('windmill_blades');
      blades.position.set(0, 9.2, -2.6);
      g.add(blades);
      g.userData.tick = (dt, t, env) => {
        blades.rotation.z += dt * (0.4 + env.wind * 1.2);
      };
      return g;
    },
  },
];

const _f = { p: new THREE.Vector3(), t: new THREE.Vector3(), u: new THREE.Vector3(), r: new THREE.Vector3() };
const _mat = new THREE.Matrix4(), _z = new THREE.Vector3();

export class DecorManager {
  constructor(scene, world, track) {
    this.scene = scene;
    this.world = world;
    this.track = track;
    this.items = [];
    this.group = new THREE.Group();
    this.group.name = 'decor';
    scene.add(this.group);
    this.particles = new Particles(5000);
    scene.add(this.particles.object);
    this.env = { lightsOn: 0, ambient: 1, wind: 0.3, trainPos: null, onBoom: null };
    this.onRoar = null;
    this.time = 0;
  }

  def(id) {
    return DECOR_ITEMS.find((d) => d.id === id);
  }

  add(id, x, z, rot = 0, scale = 1) {
    const def = this.def(id);
    if (!def) return null;
    const obj = def.build({ particles: this.particles, world: this.world, onRoar: (d) => this.onRoar && this.onRoar(d) });
    obj.traverse((o) => {
      if (o.isMesh && !o.material.transparent && !o.material.isShaderMaterial && !o.material.isMeshBasicMaterial) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    const item = { id, def, obj, x, z, rot, scale };
    obj.userData.item = item;
    this.group.add(obj);
    this.items.push(item);
    this.place(item);
    return item;
  }

  // 根据物体的位置、朝向、大小更新它在场景里的摆放
  place(item) {
    const { obj, def } = item;
    const tr = this.track;
    obj.scale.setScalar(item.scale);
    if (def.snap === 'ground' && tr.N) {
      // 跨在轨道上的建筑：立在地面上，门洞对着轨道的方向
      const y = this.world.surfaceAt(item.x, item.z);
      const k = tr.nearestSample(new THREE.Vector3(item.x, y + 3, item.z), 60);
      if (k >= 0) {
        item.x = tr.P[k * 3];
        item.z = tr.P[k * 3 + 2];
        obj.position.set(item.x, this.world.surfaceAt(item.x, item.z), item.z);
        obj.rotation.set(0, Math.atan2(tr.T[k * 3], tr.T[k * 3 + 2]), 0);
        item.snapY = 0;
        return;
      }
    } else if (def.snap && tr.N) {
      const y = this.world.surfaceAt(item.x, item.z);
      const k = tr.nearestSample(new THREE.Vector3(item.x, item.snapY ?? y, item.z), 60);
      if (k >= 0) {
        tr.frame(k * tr.ds, _f);
        _z.copy(_f.t).negate();
        _mat.makeBasis(_f.r, _f.u, _z);
        obj.quaternion.setFromRotationMatrix(_mat);
        obj.position.copy(_f.p).addScaledVector(_f.u, tr.opts.hang ? -1.4 : 0.7);
        item.snapY = _f.p.y;
        item.x = _f.p.x;
        item.z = _f.p.z;
        return;
      }
    }
    obj.position.set(item.x, this.world.surfaceAt(item.x, item.z), item.z);
    obj.rotation.set(0, item.rot, 0);
  }

  remove(item) {
    const i = this.items.indexOf(item);
    if (i < 0) return;
    this.items.splice(i, 1);
    this.group.remove(item.obj);
    // 模型的几何体是共用的，只释放这个物体自己生成的
    item.obj.traverse((o) => {
      if (o.geometry && !o.userData.shared) o.geometry.dispose();
    });
  }

  clear() {
    for (const it of [...this.items]) this.remove(it);
  }

  // 轨道或地形变化后，重新摆放所有物体
  replaceAll() {
    for (const it of this.items) this.place(it);
  }

  pick(raycaster) {
    const hits = raycaster.intersectObjects(this.group.children, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.item) o = o.parent;
      if (o) return o.userData.item;
    }
    return null;
  }

  update(dt, lightsOn, ambient, wind, trainPos) {
    this.time += dt;
    const env = this.env;
    env.lightsOn = lightsOn;
    env.ambient = ambient;
    env.wind = wind;
    env.trainPos = trainPos;
    M.lamp.color.set('#fff1d0').multiplyScalar(0.4 + lightsOn * 4.5);
    M.neonA.color.set('#00e5ff').multiplyScalar(1 + lightsOn * 2.5);
    M.neonB.color.set('#ff2bd6').multiplyScalar(1 + lightsOn * 2.5);
    M.pool.opacity = lightsOn * 0.5;
    M.beam.opacity = lightsOn * 0.1;
    for (const it of this.items) {
      const tick = it.obj.userData.tick;
      if (tick) tick(dt, this.time, env);
    }
    this.particles.update(dt);
  }

  toJSON() {
    return this.items.map((it) => [it.id, +it.x.toFixed(2), +it.z.toFixed(2), +it.rot.toFixed(3), +it.scale.toFixed(2), it.snapY !== undefined ? +it.snapY.toFixed(2) : null]);
  }

  fromJSON(list) {
    this.clear();
    for (const a of list || []) {
      const it = this.add(a[0], a[1], a[2], a[3] || 0, a[4] || 1);
      if (it && a[5] !== null && a[5] !== undefined) {
        it.snapY = a[5];
        this.place(it);
      }
    }
  }
}
