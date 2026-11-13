// 列车模型：6 种乘坐方式，8 套主题车厢
import * as THREE from 'three';
import { GeoBatch, registerWet, unregisterWet, clamp } from './util.js';
import { G } from './sim.js';
import { assets } from './assets.js';

export const SEAT_TYPES = [
  { id: 'sit', name: '坐式', desc: '坐在轨道上方的车厢里', hang: false, half: 1.15, pitch: 3.0 },
  { id: 'invert', name: '悬挂式', desc: '座椅吊在轨道下面，双脚悬空', hang: true, half: 1.4, pitch: 2.0 },
  { id: 'fly', name: '飞行式', desc: '趴在轨道下面，面朝地面飞', hang: true, half: 1.4, pitch: 2.5 },
  { id: 'stand', name: '站立式', desc: '站在轨道上方的车厢里', hang: false, half: 1.15, pitch: 2.7 },
  { id: 'wing', name: '翼式', desc: '座椅伸在轨道两侧，脚下是空的', hang: false, half: 2.9, pitch: 2.7 },
  { id: 'swing', name: '摇摆吊舱', desc: '吊舱挂在轨道下面，转弯时会自己荡起来', hang: true, half: 1.5, pitch: 3.5 },
];

export const THEMES = [
  { id: 'classic', name: '经典', desc: '流线型车头', seat: 'sit', body: '#d62828', accent: '#f5f5f5', seatColor: '#1d1f24', material: 'paint' },
  { id: 'dragon', name: '巨龙', desc: '龙头、龙角和龙尾', seat: 'sit', body: '#2f9e44', accent: '#f2c230', seatColor: '#3b2a1a', material: 'paint' },
  { id: 'rocket', name: '火箭', desc: '尖头、尾翼和喷焰', seat: 'sit', body: '#f1f3f5', accent: '#e03131', seatColor: '#22262e', material: 'paint' },
  { id: 'mine', name: '矿车', desc: '木板车身和提灯', seat: 'sit', body: '#7a5230', accent: '#d4a017', seatColor: '#3a2a1c', material: 'wood' },
  { id: 'ghost', name: '幽灵', desc: '骷髅车头和绿色鬼火', seat: 'invert', body: '#17141f', accent: '#7cff6b', seatColor: '#2a2333', material: 'matte' },
  { id: 'candy', name: '糖果', desc: '棒棒糖和软糖装饰', seat: 'sit', body: '#ff8fb1', accent: '#fff3b0', seatColor: '#ffffff', material: 'paint' },
  { id: 'cyber', name: '赛博', desc: '黑色车身和发光灯条', seat: 'wing', body: '#12141c', accent: '#00e5ff', seatColor: '#1b1e28', material: 'matte' },
  { id: 'shark', name: '鲨鱼', desc: '鲨鱼头、胸鳍和尾鳍', seat: 'fly', body: '#5c7a8c', accent: '#f1f5f9', seatColor: '#26323a', material: 'paint' },
];

export const BODY_MATERIALS = [
  { id: 'paint', name: '车漆' },
  { id: 'chrome', name: '镀铬' },
  { id: 'matte', name: '哑光' },
  { id: 'carbon', name: '碳纤维' },
  { id: 'wood', name: '木质' },
  { id: 'neon', name: '霓虹发光' },
];

const GEO = { bar: new THREE.CapsuleGeometry(0.04, 0.5, 3, 8) };
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const HALF = Math.PI / 2;

// 把 Blender 里做好的部件放进车厢。keyMap 用来替换材质，比如给每个乘客换一种上衣颜色
function addPart(batch, name, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx, keyMap = null) {
  const list = assets.parts[name];
  if (!list) throw new Error('缺少模型部件：' + name);
  for (const p of list) batch.put((keyMap && keyMap[p.key]) || p.key, p.geo, x, y, z, rx, ry, rz, sx, sy, sz);
}

// 一个乘客。原点在臀部，面朝 -z。pose：sit 坐着，hang 双腿悬空，stand 站着；prone 表示趴着
function addRider(batch, hx, hy, hz, pose, shirt, prone = false) {
  addPart(batch, 'rider_' + pose, hx, hy, hz, prone ? -HALF : 0, 0, 0, 1, 1, 1, { shirt });
}

// 一个座椅，原点在臀部
function addSeat(batch, x, y, z, harness = true) {
  addPart(batch, 'seat', x, y, z);
  if (harness) addPart(batch, 'harness', x, y, z);
}

// 抱住钢轨的轮组。车厢挂在轨道下面时，把轮组上下翻过来
function addBogie(batch, z, hang = false) {
  addPart(batch, 'bogie', 0, 0, z, 0, 0, hang ? Math.PI : 0);
}

const SHIRTS = ['shirtA', 'shirtB', 'shirtC', 'shirtD'];

// 各种乘坐方式的车厢主体。返回装饰件用的定位信息和第一人称视点
const CAR_BUILDERS = {
  sit(b, riders, lead) {
    addBogie(b, -0.95);
    addBogie(b, 0.95);
    addPart(b, 'body_sit');
    let i = 0;
    for (const z of [-0.45, 0.66]) {
      for (const x of [-0.33, 0.33]) {
        addSeat(b, x, 0.64, z);
        if (!(lead && z < 0 && x < 0)) addRider(riders, x, 0.64, z, 'sit', SHIRTS[i % 4]);
        i++;
      }
    }
    return { anchor: { y: 0.66, front: -1.28, back: 1.3, top: true, w: 0.7 }, eye: [-0.33, 1.42, -0.52] };
  },
  stand(b, riders, lead) {
    addBogie(b, -0.9);
    addBogie(b, 0.9);
    addPart(b, 'body_sit', 0, 0, 0, 0, 0, 0, 1, 1, 0.94);
    let i = 0;
    for (const z of [-0.45, 0.6]) {
      for (const x of [-0.33, 0.33]) {
        b.put('dark', box(0.1, 0.88, 0.1), x, 0.88, z + 0.18);
        b.put('seat', box(0.4, 0.8, 0.08), x, 1.64, z + 0.2);
        b.put('seat', box(0.15, 0.08, 0.22), x, 1.3, z + 0.08);
        addPart(b, 'harness', x, 1.34, z + 0.02);
        if (!(lead && z < 0 && x < 0)) addRider(riders, x, 1.34, z, 'stand', SHIRTS[i % 4]);
        i++;
      }
    }
    return { anchor: { y: 0.66, front: -1.2, back: 1.22, top: true, w: 0.7 }, eye: [-0.33, 2.12, -0.5] };
  },
  wing(b, riders, lead) {
    addBogie(b, -0.9);
    addBogie(b, 0.9);
    b.put('dark', box(1.0, 0.16, 2.3), 0, 0.3, 0);
    addPart(b, 'pod', 0, 0.66, 0, 0, 0, 0, 0.98, 0.56, 2.5);
    b.put('dark', box(5.5, 0.16, 0.46), 0, 0.42, 0.3);
    let i = 0;
    for (const x of [-2.25, -1.6, 1.6, 2.25]) {
      addSeat(b, x, 0.6, 0);
      if (!(lead && x === -2.25)) addRider(riders, x, 0.6, 0, 'hang', SHIRTS[i % 4]);
      i++;
    }
    for (const s of [-1, 1]) {
      addPart(b, 'pod', s * 2.72, 0.9, 0.1, 0, 0, 0, 0.12, 1.0, 1.3);
    }
    return { anchor: { y: 0.66, front: -1.2, back: 1.2, top: true, w: 0.5 }, eye: [-2.25, 1.38, -0.07] };
  },
  invert(b, riders, lead) {
    addBogie(b, 0, true);
    addPart(b, 'pod', 0, -0.44, 0, 0, 0, 0, 1.3, 0.44, 1.75);
    b.put('dark', box(0.3, 0.7, 0.36), 0, -0.9, 0.18);
    b.put('dark', box(2.6, 0.18, 0.3), 0, -1.2, 0.22);
    let i = 0;
    for (const x of [-0.96, -0.32, 0.32, 0.96]) {
      addSeat(b, x, -2.0, 0);
      if (!(lead && x === -0.32)) addRider(riders, x, -2.0, 0, 'hang', SHIRTS[i % 4]);
      i++;
    }
    return { anchor: { y: -0.44, front: -0.8, back: 0.85, top: false, w: 0.66 }, eye: [-0.32, -1.24, -0.07] };
  },
  fly(b, riders, lead) {
    addBogie(b, -0.5, true);
    addBogie(b, 0.5, true);
    addPart(b, 'pod', 0, -0.44, 0, 0, 0, 0, 1.3, 0.44, 2.3);
    b.put('dark', box(0.3, 0.5, 0.4), 0, -0.8, 0.3);
    b.put('dark', box(2.6, 0.16, 0.3), 0, -1.0, 0.3);
    let i = 0;
    for (const x of [-0.96, -0.32, 0.32, 0.96]) {
      b.put('seat', box(0.46, 0.1, 1.25), x, -1.08, 0.05);
      b.put('accent', box(0.5, 0.3, 0.12), x, -1.28, 0.9);
      b.put('accent', GEO.bar, x - 0.2, -1.3, -0.25, HALF, 0, 0);
      b.put('accent', GEO.bar, x + 0.2, -1.3, -0.25, HALF, 0, 0);
      if (!(lead && x === -0.32)) addRider(riders, x, -1.34, 0.15, 'stand', SHIRTS[i % 4], true);
      i++;
    }
    return { anchor: { y: -0.44, front: -1.1, back: 1.1, top: false, w: 0.66 }, eye: [-0.32, -1.38, -0.68] };
  },
  swing(b, riders, lead, pivot) {
    addBogie(b, -0.8, true);
    addBogie(b, 0.8, true);
    addPart(b, 'pod', 0, -0.42, 0, 0, 0, 0, 1.2, 0.4, 2.4);
    b.put('dark', box(0.2, 0.2, 2.5), 0, -0.6, 0);
    // 吊舱挂在转轴上，坐标相对转轴（y = -0.6）
    const p = pivot;
    p.put('dark', box(0.12, 0.9, 0.12), 0, -0.45, -1.1);
    p.put('dark', box(0.12, 0.9, 0.12), 0, -0.45, 1.1);
    addPart(p, 'pod', 0, -0.9, 0, 0, 0, 0, 1.62, 0.2, 3.1);
    p.put('body', box(1.56, 0.12, 3.0), 0, -2.75, 0);
    for (const s of [-1, 1]) {
      p.put('body', box(0.08, 0.6, 3.0), s * 0.76, -2.4, 0);
      p.put('accent', box(0.03, 0.1, 2.9), s * 0.81, -2.3, 0);
      for (const z of [-1.46, 1.46]) p.put('dark', box(0.08, 1.9, 0.08), s * 0.74, -1.82, z);
    }
    p.put('body', box(1.56, 0.6, 0.08), 0, -2.4, -1.5);
    p.put('body', box(1.56, 0.6, 0.08), 0, -2.4, 1.5);
    let i = 0;
    for (const z of [-0.6, 0.65]) {
      for (const x of [-0.34, 0.34]) {
        addSeat(p, x, -2.5, z);
        if (!(lead && z < 0 && x < 0)) addRider(p.riders, x, -2.5, z, 'sit', SHIRTS[i % 4]);
        i++;
      }
    }
    return { anchor: { y: -0.42, front: -1.15, back: 1.15, top: false, w: 0.62 }, eye: [-0.34, -1.74, -0.66], eyeOnPivot: true };
  },
};

// 主题装饰件。role：lead 车头，mid 中间，tail 车尾
function addOrnaments(b, theme, role, A) {
  const y = A.y, f = A.front, k = A.back, w = A.w;
  const hs = A.top ? 1 : 0.74; // 挂在轨道下面的车厢比较窄，车头模型按比例缩小
  const cone = (r, h, seg = 12) => new THREE.ConeGeometry(r, h, seg);
  const sph = (r, a = 14, c = 10) => new THREE.SphereGeometry(r, a, c);
  switch (theme) {
    case 'classic':
      if (role === 'lead') addPart(b, 'nose', 0, y - 0.67 * hs, f + 1.28 * hs, 0, 0, 0, hs);
      if (role === 'tail') b.put('accent', box(1.2, 0.05, 0.3), 0, y + 0.42, k + 0.12);
      break;
    case 'dragon':
      if (role === 'lead') addPart(b, 'dragon_head', 0, y + 0.02, f + 0.04, 0, 0, 0, hs);
      for (const s of [-1, 1]) {
        for (const z of [-0.8, 0, 0.8]) b.put('accent', cone(0.1, 0.34, 6), s * (w + 0.1), y + 0.1, z, 0, 0, s * -1.2);
      }
      if (role === 'tail') {
        b.put('body', cone(0.42, 2.4, 10), 0, y - 0.05, k + 1.15, HALF, 0, 0);
        b.put('accent', new THREE.OctahedronGeometry(0.3), 0, y - 0.05, k + 2.4, 0, 0, 0, 0.25, 1.1, 1.5);
        for (let i = 0; i < 3; i++) b.put('accent', cone(0.07, 0.26, 6), 0, y + 0.3 - i * 0.09, k + 0.4 + i * 0.5, 0.35, 0, 0);
      }
      break;
    case 'rocket':
      if (role === 'lead') addPart(b, 'rocket_nose', 0, y + 0.04, f + 0.05, 0, 0, 0, hs * 0.98);
      b.put('accent', box(0.03, 0.2, 1.6), w + 0.02, y + 0.05, 0);
      b.put('accent', box(0.03, 0.2, 1.6), -w - 0.02, y + 0.05, 0);
      if (role === 'tail') {
        for (const s of [-1, 1]) {
          b.put('accent', box(0.06, 0.5, 1.0), s * (w + 0.3), y + 0.1, k - 0.1, 0, 0, s * -0.9);
          b.put('dark', new THREE.CylinderGeometry(0.2, 0.28, 0.5, 12), s * 0.36, y - 0.05, k + 0.25, HALF, 0, 0);
        }
        b.put('dark', new THREE.CylinderGeometry(0.2, 0.28, 0.5, 12), 0, y + (A.top ? 0.2 : -0.25), k + 0.25, HALF, 0, 0);
      }
      break;
    case 'mine':
      for (const s of [-1, 1]) {
        for (const z of [-0.9, -0.3, 0.3, 0.9]) b.put('dark', box(0.03, 0.46, 0.1), s * (w + 0.015), y + 0.02, z);
        b.put('dark', box(0.035, 0.06, f * -2), s * (w + 0.015), y + 0.2, 0);
      }
      if (role === 'lead') {
        b.put('dark', cone(0.75, 0.8, 4), 0, y - 0.15, f - 0.3, -HALF, Math.PI / 4, 0, 1, 1, 0.45);
        b.put('dark', box(0.05, 0.5, 0.05), 0.5, y + 0.2, f - 0.55);
        b.put('dark', box(0.2, 0.04, 0.2), 0.5, y + 0.46, f - 0.6);
        b.put('glow', box(0.13, 0.17, 0.13), 0.5, y + 0.34, f - 0.63);
        b.put('light', sph(0.08), -0.4, y, f - 0.1);
      }
      if (role === 'tail') {
        b.put('body', box(1.2, 0.5, 0.9), 0, y - 0.05, k + 0.5);
        b.put('dark', box(1.24, 0.06, 0.94), 0, y + 0.2, k + 0.5);
        const pos = [[0, 0.3, 0.5], [0.3, 0.25, 0.35], [-0.3, 0.26, 0.6], [0.15, 0.42, 0.62], [-0.15, 0.4, 0.38]];
        for (const [px, py, pz] of pos) b.put('accent', new THREE.IcosahedronGeometry(0.22, 0), px, y + py, k + pz, px * 3, py * 5, 0);
      }
      break;
    case 'ghost':
      if (role === 'lead') addPart(b, 'skull', 0, y + 0.06, f + 0.12, 0, 0, 0, hs * 0.95);
      for (const s of [-1, 1]) {
        b.put('glow', box(0.08, 0.14, 0.08), s * (w + 0.05), y - 0.05, 0.4);
        for (const z of [-0.5, 0, 0.5]) b.put('accentDark', cone(0.13, 0.55, 5), s * (w + 0.02), y - 0.4, z, Math.PI, 0, 0);
      }
      if (role === 'tail') {
        for (const [dx, dy, r] of [[0, 0, 0.36], [0.3, -0.15, 0.22], [-0.3, 0.1, 0.24]]) {
          b.put('accentDark', cone(r, 1.9, 8), dx, y + dy, k + 0.9, HALF, 0, 0);
        }
      }
      break;
    case 'candy':
      if (role === 'lead') {
        b.put('accent', new THREE.CylinderGeometry(0.72, 0.72, 0.14, 24), 0, y + 0.15, f - 0.2, HALF, 0, 0);
        b.put('body', new THREE.TorusGeometry(0.5, 0.06, 8, 24), 0, y + 0.15, f - 0.28);
        b.put('candyC', new THREE.TorusGeometry(0.28, 0.06, 8, 20), 0, y + 0.15, f - 0.28);
        b.put('candyA', sph(0.12), 0, y + 0.15, f - 0.3);
        b.put('light', sph(0.07), 0.5, y - 0.3, f - 0.15);
        b.put('light', sph(0.07), -0.5, y - 0.3, f - 0.15);
      }
      {
        const keys = ['candyA', 'accent', 'candyC'];
        let i = 0;
        for (const s of [-1, 1]) {
          for (const z of [-0.9, -0.3, 0.3, 0.9]) {
            b.put(keys[i % 3], sph(0.13, 10, 8), s * (w + (A.top ? -0.04 : 0.04)), y + (A.top ? 0.32 : 0.02), z, 0, 0, 0, 1, 0.8, 1);
            i++;
          }
        }
      }
      if (role === 'tail') {
        b.put('candyR', sph(0.36, 16, 12), 0, y + 0.05, k + 0.42);
        b.put('candyG', new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6), 0.06, y + 0.5, k + 0.42, 0, 0, -0.3);
      }
      break;
    case 'cyber':
      if (role === 'lead') {
        b.put('body', cone(0.8, 1.9, 4), 0, y, f - 0.9, -HALF, Math.PI / 4, 0, 1, 1, 0.42);
        b.put('glow', box(0.9, 0.05, 0.05), 0, y + 0.08, f - 0.55);
        b.put('glow', box(0.04, 0.04, 1.3), 0, y + 0.24, f - 0.7, 0.2, 0, 0);
        b.put('light', box(0.3, 0.05, 0.05), 0.3, y - 0.1, f - 0.9);
        b.put('light', box(0.3, 0.05, 0.05), -0.3, y - 0.1, f - 0.9);
      }
      for (const s of [-1, 1]) {
        b.put('glow', box(0.03, 0.05, k * 2 - 0.2), s * (w + 0.02), y + 0.12, 0);
        b.put('glow', box(0.03, 0.03, k * 2 - 0.6), s * (w + 0.02), y - 0.14, 0);
      }
      if (role === 'tail') {
        for (const s of [-1, 1]) b.put('glow', box(0.05, 0.5, 0.7), s * 0.4, y + (A.top ? 0.35 : -0.35), k + 0.25, A.top ? -0.5 : 0.5, 0, 0);
        b.put('glow', box(1.0, 0.05, 0.05), 0, y, k + 0.06);
      }
      break;
    case 'shark':
      if (role === 'lead') addPart(b, 'shark_head', 0, y, f + 0.04, 0, 0, 0, hs);
      for (const s of [-1, 1]) {
        const g = cone(0.32, 1.1, 4);
        g.scale(1, 1, 0.18);
        b.put('body', g, s * (w + 0.45), y - 0.12, 0.25, HALF * 0.25, 0, s * -1.25);
      }
      if (role === 'tail') {
        const up = cone(0.4, 1.3, 4);
        up.scale(0.16, 1, 1);
        b.put('body', cone(0.45, 1.5, 10), 0, y, k + 0.7, HALF, 0, 0, 1, 1, 0.8);
        if (A.top) b.put('body', up, 0, y + 0.55, k + 1.55, -0.6, 0, 0);
        b.put('body', up.clone(), 0, y - 0.5, k + 1.5, Math.PI + 0.6, 0, 0);
        if (!A.top) {
          const fl = cone(0.4, 1.2, 4);
          fl.scale(1, 1, 0.16);
          b.put('body', fl, 0.5, y, k + 1.5, HALF * 0.6, 0, -1.2);
          b.put('body', fl.clone(), -0.5, y, k + 1.5, HALF * 0.6, 0, 1.2);
        }
      } else if (A.top) {
        const fin = cone(0.3, 0.8, 4);
        fin.scale(0.16, 1, 1);
        b.put('body', fin, w - 0.02, y + 0.6, 0.9, -0.4, 0, 0);
        b.put('body', fin.clone(), -w + 0.02, y + 0.6, 0.9, -0.4, 0, 0);
      }
      break;
  }
}

function bodyMaterial(kind, color) {
  const c = new THREE.Color(color);
  switch (kind) {
    case 'chrome':
      return new THREE.MeshStandardMaterial({ color: c, metalness: 1, roughness: 0.06 });
    case 'matte':
      return registerWet(new THREE.MeshStandardMaterial({ color: c, metalness: 0.15, roughness: 0.8 }), 0.4);
    case 'carbon':
      return new THREE.MeshPhysicalMaterial({ color: c.clone().multiplyScalar(0.22), metalness: 0.5, roughness: 0.5, clearcoat: 1, clearcoatRoughness: 0.12 });
    case 'wood':
      return registerWet(new THREE.MeshStandardMaterial({ color: c, metalness: 0, roughness: 0.88 }), 0.3);
    case 'neon':
      return new THREE.MeshStandardMaterial({ color: c.clone().multiplyScalar(0.2), emissive: c, emissiveIntensity: 1.6, roughness: 0.4 });
    default:
      return new THREE.MeshPhysicalMaterial({ color: c, metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 });
  }
}

export class Train {
  constructor(cfg) {
    this.cfg = { ...cfg };
    this.def = SEAT_TYPES.find((s) => s.id === cfg.seat) || SEAT_TYPES[0];
    this.pitch = this.def.pitch;
    this.group = new THREE.Group();
    this.group.name = 'train';
    this.cars = [];
    this.pivots = [];
    this.swing = [];
    this.flames = [];
    this.frame = { p: new THREE.Vector3(), t: new THREE.Vector3(), u: new THREE.Vector3(), r: new THREE.Vector3() };
    this._z = new THREE.Vector3();

    const accent = new THREE.Color(cfg.accent);
    const std = (p) => new THREE.MeshStandardMaterial(p);
    this.glowColor = accent.clone();
    this.mats = {
      body: bodyMaterial(cfg.material, cfg.body),
      accent: std({ color: accent, metalness: 0.7, roughness: 0.25 }),
      accentDark: std({ color: accent.clone().multiplyScalar(0.35), emissive: accent, emissiveIntensity: 0.25, roughness: 0.7 }),
      seat: std({ color: cfg.seatColor, roughness: 0.7 }),
      dark: std({ color: '#23262b', metalness: 0.7, roughness: 0.45 }),
      wheel: std({ color: '#e0b030', roughness: 0.5 }),
      metal: std({ color: '#b9bec6', metalness: 0.9, roughness: 0.3 }),
      shoe: std({ color: '#f1f1f1', roughness: 0.7 }),
      skin: std({ color: '#e0b090', roughness: 0.8 }),
      hair: std({ color: '#2b1d14', roughness: 0.9 }),
      pants: std({ color: '#2c3e50', roughness: 0.85 }),
      shirtA: std({ color: '#e63946', roughness: 0.85 }),
      shirtB: std({ color: '#457b9d', roughness: 0.85 }),
      shirtC: std({ color: '#f4a261', roughness: 0.85 }),
      shirtD: std({ color: '#f1faee', roughness: 0.85 }),
      bone: std({ color: '#efe9da', roughness: 0.6 }),
      candyA: std({ color: '#7bdff2', roughness: 0.3 }),
      candyC: std({ color: '#b388eb', roughness: 0.3 }),
      candyR: new THREE.MeshPhysicalMaterial({ color: '#d00000', roughness: 0.15, clearcoat: 1 }),
      candyG: std({ color: '#386641', roughness: 0.6 }),
      glow: new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(3) }),
      light: new THREE.MeshBasicMaterial({ color: '#fff6d8' }),
    };

    const n = clamp(cfg.cars | 0, 1, 12);
    const builder = CAR_BUILDERS[this.def.id];
    // 车头、中间车厢、车尾各做一份几何体，中间车厢共用
    const variants = {};
    const makeVariant = (role, lead) => {
      const b = new GeoBatch(), riders = new GeoBatch(), pivot = new GeoBatch();
      pivot.riders = new GeoBatch();
      const info = builder(b, riders, lead, pivot);
      addOrnaments(b, cfg.theme, role, info.anchor);
      if (n === 1 && role === 'lead') addOrnaments(b, cfg.theme, 'tail', info.anchor);
      return { body: b.geometries(), riders: riders.geometries(), pivot: pivot.geometries(), pivotRiders: pivot.riders.geometries(), info };
    };
    for (let i = 0; i < n; i++) {
      const role = i === 0 ? 'lead' : i === n - 1 ? 'tail' : 'mid';
      if (!variants[role]) variants[role] = makeVariant(role, i === 0);
      const v = variants[role];
      const car = new THREE.Group();
      car.matrixAutoUpdate = false;
      this.addGeos(car, v.body);
      this.addGeos(car, v.riders);
      let pivot = null;
      if (this.def.id === 'swing') {
        pivot = new THREE.Group();
        pivot.position.set(0, -0.6, 0);
        this.addGeos(pivot, v.pivot);
        this.addGeos(pivot, v.pivotRiders);
        car.add(pivot);
        this.pivots.push(pivot);
        this.swing.push({ a: 0, w: 0 });
      }
      if (i === 0) {
        this.info = v.info;
        this.eye = new THREE.Object3D();
        const e = v.info.eye;
        if (v.info.eyeOnPivot) {
          this.eye.position.set(e[0], e[1], e[2]);
          pivot.add(this.eye);
        } else {
          this.eye.position.set(e[0], e[1], e[2]);
          car.add(this.eye);
        }
        const A = v.info.anchor;
        this.headlight = new THREE.SpotLight('#fff1d6', 0, 140, 0.5, 0.7, 1.4);
        this.headlight.position.set(0, A.y + 0.1, A.front - 0.6);
        this.headlight.target.position.set(0, A.y - 3, A.front - 40);
        car.add(this.headlight, this.headlight.target);
      }
      if (cfg.theme === 'rocket' && i === n - 1) {
        const A = v.info.anchor;
        const fm = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 2.2, 0.5), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
        const fg = new THREE.ConeGeometry(0.2, 1.8, 10).rotateX(Math.PI / 2).translate(0, 0, 0.9);
        for (const [x, y] of [[-0.36, -0.05], [0.36, -0.05], [0, A.top ? 0.2 : -0.25]]) {
          const flame = new THREE.Mesh(fg, fm);
          flame.position.set(x, A.y + y, A.back + 0.5);
          car.add(flame);
          this.flames.push(flame);
        }
        this.flameMat = fm;
      }
      this.cars.push(car);
      this.group.add(car);
    }
    this.length = (n - 1) * this.pitch;
  }

  addGeos(parent, geos) {
    for (const key of Object.keys(geos)) {
      const mesh = new THREE.Mesh(geos[key], this.mats[key] || this.mats.dark);
      mesh.castShadow = key !== 'glow' && key !== 'light';
      mesh.receiveShadow = true;
      parent.add(mesh);
    }
  }

  // 把各节车厢摆到轨道上。s 是第一节车厢中心的弧长位置
  place(track, s) {
    const f = this.frame;
    for (let i = 0; i < this.cars.length; i++) {
      track.frame(s - i * this.pitch, f);
      this._z.copy(f.t).negate();
      const car = this.cars[i];
      car.matrix.makeBasis(f.r, f.u, this._z).setPosition(f.p);
      car.matrixWorldNeedsUpdate = true;
    }
  }

  // 每帧更新：吊舱摆动、灯光、喷焰
  update(dt, time, track, s, v, lightsOn) {
    if (this.pivots.length && track.N) {
      const { K, U, R, ds, N } = track;
      for (let i = 0; i < this.pivots.length; i++) {
        let k = Math.floor((s - i * this.pitch) / ds) % N;
        if (k < 0) k += N;
        const v2 = v * v;
        const fx = v2 * K[k * 3], fy = v2 * K[k * 3 + 1] + G, fz = v2 * K[k * 3 + 2];
        const fl = fx * R[k * 3] + fy * R[k * 3 + 1] + fz * R[k * 3 + 2];
        const fu = fx * U[k * 3] + fy * U[k * 3 + 1] + fz * U[k * 3 + 2];
        const target = clamp(-Math.atan2(fl, Math.max(fu, 2)), -1.2, 1.2);
        const st = this.swing[i];
        const om = 2.4, zeta = 0.22;
        const steps = Math.max(1, Math.ceil(dt / 0.01));
        const h = dt / steps;
        for (let j = 0; j < steps; j++) {
          st.w += (om * om * (target - st.a) - 2 * zeta * om * st.w) * h;
          st.a += st.w * h;
        }
        st.a = clamp(st.a, -1.4, 1.4);
        this.pivots[i].rotation.z = st.a;
      }
    }
    const k = lightsOn;
    this.mats.light.color.set('#fff6d8').multiplyScalar(0.8 + k * 5);
    this.mats.glow.color.copy(this.glowColor).multiplyScalar(1.6 + k * 2.6);
    if (this.headlight) this.headlight.intensity = k * 80;
    if (this.flames.length) {
      const sp = clamp(Math.abs(v) / 30, 0, 1);
      for (let i = 0; i < this.flames.length; i++) {
        const fl = 0.35 + sp * 0.9 + Math.sin(time * 40 + i * 2) * 0.12;
        this.flames[i].scale.set(1, 1, fl);
      }
      this.flameMat.opacity = 0.35 + sp * 0.6;
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    for (const m of Object.values(this.mats)) {
      unregisterWet(m);
      m.dispose();
    }
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
