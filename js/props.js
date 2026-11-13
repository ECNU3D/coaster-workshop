// 布景模型：Blender 做的站台、游乐设施、城堡、恐龙等模型的材质和摆放，以及程序生成的山和瀑布
import * as THREE from 'three';
import { assets } from './assets.js';
import { vegMat } from './world.js';
import { fbm, ridged, clamp } from './util.js';

const std = (p) => new THREE.MeshStandardMaterial(p);
const PM = {};
const LIGHTS = { on: 0, ambient: 1, time: 0 };

// 模型里每种材质名字对应的材质
export function propMat(key) {
  if (PM[key]) return PM[key];
  const T = assets.tex;
  let m;
  switch (key) {
    case 'stone': m = std({ map: T.stonebrick, normalMap: T.stonebrick_n, roughness: 0.92 }); break;
    case 'roof': m = std({ map: T.rooftile, normalMap: T.rooftile_n, roughness: 0.7, color: '#aebbd0' }); break;
    case 'wood': m = std({ map: T.planks, normalMap: T.planks_n, roughness: 0.86, color: '#d9c4a8' }); break;
    case 'concrete': m = std({ map: T.concrete, normalMap: T.concrete_n, roughness: 0.9 }); break;
    case 'dino': m = std({ map: T.dinoskin, normalMap: T.dinoskin_n, roughness: 0.82 }); break;
    case 'rock': m = std({ map: T.rock, normalMap: T.rock_n, roughness: 0.92 }); break;
    case 'scifi': m = std({ map: T.scifi, normalMap: T.scifi_n, roughness: 0.4, metalness: 0.7, color: '#c5cfdd' }); break;
    case 'metal': m = std({ color: '#c9ced6', metalness: 0.85, roughness: 0.35 }); break;
    case 'dark': m = std({ color: '#24272c', metalness: 0.6, roughness: 0.5 }); break;
    case 'white': m = std({ color: '#f2f1ec', roughness: 0.6 }); break;
    case 'stripe': m = std({ color: '#f6f3e8', roughness: 0.7, side: THREE.DoubleSide }); break;
    case 'red': m = std({ color: '#c8202f', roughness: 0.6, side: THREE.DoubleSide }); break;
    case 'blue': m = std({ color: '#2176ae', roughness: 0.6, side: THREE.DoubleSide }); break;
    case 'yellow': m = std({ color: '#f2b233', roughness: 0.6, side: THREE.DoubleSide }); break;
    case 'gold': m = std({ color: '#d9a441', metalness: 1, roughness: 0.3 }); break;
    case 'paint': m = std({ color: '#2176ae', metalness: 0.3, roughness: 0.4 }); break;
    case 'spine': m = std({ color: '#b3202c', metalness: 0.3, roughness: 0.5, side: THREE.DoubleSide }); break;
    case 'bone': m = std({ color: '#efe9da', roughness: 0.6 }); break;
    case 'glass': m = std({ color: '#0c1620', metalness: 0.9, roughness: 0.08 }); break;
    case 'water': m = std({ color: '#3fa7d6', roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.8 }); break;
    case 'crystal': m = crystalMat('#3fd8ff'); break;
    // 海洋生物。鱼和珊瑚用白色做底，每一只的颜色在摆放时单独指定
    case 'fish': m = std({ color: '#ffffff', roughness: 0.45, emissive: '#16242c', envMapIntensity: 0.1 }); break;
    case 'coral': m = std({ color: '#ffffff', roughness: 0.8, emissive: '#20141a', envMapIntensity: 0.1 }); break;
    case 'sea': m = std({ color: '#557a96', roughness: 0.5, emissive: '#0a1620', envMapIntensity: 0.15 }); break;
    case 'jelly': m = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff8ad8').multiplyScalar(1.5), transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }); break;
    case 'hull': m = std({ map: T.planks, normalMap: T.planks_n, color: '#7a5636', roughness: 0.85 }); break;
    case 'sail': m = std({ color: '#efe8d6', roughness: 0.9, side: THREE.DoubleSide }); break;
    case 'glow': m = new THREE.MeshBasicMaterial({ color: '#ffb64a' }); break;
    case 'lamp': m = new THREE.MeshBasicMaterial({ color: '#fff1d0' }); break;
    case 'neon': m = new THREE.MeshBasicMaterial({ color: '#00e5ff' }); break;
    default:
      if (key.startsWith('leaf')) m = vegMat(key, '');
      else m = std({ color: '#888888', roughness: 0.7 });
  }
  PM[key] = m;
  return m;
}

const CRYSTALS = {};
export function crystalMat(color) {
  if (CRYSTALS[color]) return CRYSTALS[color];
  const c = new THREE.Color(color);
  const m = std({ color: c.clone().multiplyScalar(0.35), emissive: c, emissiveIntensity: 0.7, roughness: 0.15, metalness: 0.2, flatShading: true });
  CRYSTALS[color] = m;
  return m;
}

// 一个模型的各个部分：[{ geo, mat, key }]。override 可以替换某种材质
export function propParts(name, override = null) {
  const list = assets.props[name];
  if (!list) throw new Error('缺少布景模型：' + name);
  return list.map((p) => ({ key: p.key, geo: p.geo, mat: (override && override[p.key]) || propMat(p.key) }));
}

// 单独摆放的一个模型
export function makeProp(name, override = null) {
  const g = new THREE.Group();
  for (const p of propParts(name, override)) {
    const m = new THREE.Mesh(p.geo, p.mat);
    const flat = p.mat.isMeshBasicMaterial;
    m.castShadow = !flat;
    m.receiveShadow = !flat;
    m.userData.shared = true; // 几何体是共用的，删除物体时不能释放
    g.add(m);
  }
  return g;
}

// 每帧更新：窗户、灯、火把的亮度跟着天色变
export function updatePropMaterials(lightsOn, ambient, time) {
  LIGHTS.on = lightsOn;
  LIGHTS.ambient = ambient;
  LIGHTS.time = time;
  if (PM.glow) PM.glow.color.set('#ffb64a').multiplyScalar(0.7 + lightsOn * 3.2 + Math.sin(time * 9) * 0.08);
  if (PM.lamp) PM.lamp.color.set('#fff1d0').multiplyScalar(0.4 + lightsOn * 4.5);
  if (PM.neon) PM.neon.color.set('#00e5ff').multiplyScalar(1.2 + lightsOn * 2.5);
  for (const m of WATERFALLS) {
    m.uniforms.uTime.value = time;
    m.uniforms.uLight.value = 0.25 + ambient * 0.85;
  }
}

// 把几何体改成按面的朝向做盒式贴图坐标，保留平滑的法线
export function boxUV(geo, scale) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    n.subVectors(b, a).cross(c.clone().sub(a));
    const ax = Math.abs(n.x) > Math.abs(n.y) && Math.abs(n.x) > Math.abs(n.z) ? 0 : Math.abs(n.y) > Math.abs(n.z) ? 1 : 2;
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? a : k === 1 ? b : c;
      uv[(i + k) * 2] = (ax === 0 ? p.z : p.x) * scale;
      uv[(i + k) * 2 + 1] = (ax === 1 ? p.z : p.y) * scale;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// ---------- 山 ----------
// 一座独立的石山。底部半径约 45 米，高约 50 米，可以用缩放改变大小
export function makeMountain(env, seed = 1) {
  const rings = 26, segs = 44;
  const R = 46, H = 52;
  const geo = new THREE.BufferGeometry();
  const pos = [], idx = [];
  const ox = seed * 13.7, oz = seed * 7.3;
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const wob = 0.78 + fbm(Math.cos(a) * 1.2 + ox, Math.sin(a) * 1.2 + oz, 3, 5) * 0.5;
      const rad = R * t * wob;
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      const prof = Math.pow(1 - t, 1.25);
      const h = H * prof * (0.55 + ridged(x / 38 + ox, z / 38 + oz, 4, 9) * 0.9) + (fbm(x / 7 + ox, z / 7, 3, 2) - 0.5) * 5 * (1 - prof * 0.5) - t * t * 4;
      pos.push(x, h, z);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * segs + s, b = r * segs + ((s + 1) % segs), c = (r + 1) * segs + s, d = (r + 1) * segs + ((s + 1) % segs);
      idx.push(a, b, c, b, d, c);
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(boxUV(geo, 0.09), vegMat('rock', env));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const g = new THREE.Group();
  g.add(mesh);
  return g;
}

// ---------- 瀑布 ----------
const WATERFALLS = new Set();
const GLSL_N = /* glsl */ `
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), u.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), u.x), u.y); }
`;
export function waterfallMaterial() {
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uLight: { value: 1 } }]),
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      #include <fog_pars_vertex>
      void main(){
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uLight;
      varying vec2 vUv;
      #include <fog_pars_fragment>
      ${GLSL_N}
      void main(){
        // vUv.y 从上到下是 0 到 1。水越往下落得越快，条纹被拉长
        float fall = vUv.y * (1.0 + vUv.y * 0.8);
        float n = vn(vec2(vUv.x * 9.0, fall * 7.0 - uTime * 2.6));
        n = n * 0.6 + vn(vec2(vUv.x * 26.0, fall * 16.0 - uTime * 4.4)) * 0.4;
        float edge = smoothstep(0.0, 0.14, vUv.x) * smoothstep(1.0, 0.86, vUv.x);
        float a = (0.5 + n * 0.5) * edge * smoothstep(0.0, 0.03, vUv.y);
        vec3 col = mix(vec3(0.42, 0.68, 0.82), vec3(1.0), smoothstep(0.35, 0.8, n) * 0.85 + vUv.y * 0.25);
        gl_FragColor = vec4(col * uLight, a * 0.92);
        #include <fog_fragment>
      }`,
  });
  WATERFALLS.add(m);
  return m;
}

// 一面带瀑布的石崖：宽约 30 米，高约 24 米。ctx.particles 用来做水雾
export function makeWaterfall(env, ctx) {
  const g = new THREE.Group();
  const W = 30, Hc = 24, D = 16;
  const nx = 30, nz = 16;
  const pos = [], idx = [];
  const height = (x, z) => {
    // 正面（z 大的一侧）是陡崖，背面是缓坡
    const u = x / (W / 2), v = z / (D / 2);
    const side = Math.pow(Math.max(0, 1 - u * u), 0.55);
    const back = v > 0.55 ? Math.max(0, 1 - (v - 0.55) / 0.45) : Math.pow(Math.max(0, (v + 1) / 1.55), 0.7);
    const front = v > 0.55 ? Math.pow(back, 0.35) : back;
    return Hc * side * front * (0.82 + fbm(x / 6 + 3, z / 6, 3, 21) * 0.36) - 0.5;
  };
  for (let i = 0; i <= nz; i++) {
    for (let j = 0; j <= nx; j++) {
      const x = -W / 2 + (W * j) / nx, z = -D / 2 + (D * i) / nz;
      pos.push(x + (fbm(z / 4, x / 5, 2, 8) - 0.5) * 1.6, height(x, z), z + (fbm(x / 4, z / 3, 2, 4) - 0.5) * 1.4);
    }
  }
  for (let i = 0; i < nz; i++) {
    for (let j = 0; j < nx; j++) {
      const a = i * (nx + 1) + j, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const rock = new THREE.Mesh(boxUV(geo, 0.11), vegMat('rock', env));
  rock.castShadow = true;
  rock.receiveShadow = true;
  g.add(rock);
  // 水流：从崖顶的豁口沿着崖面落到水潭
  const topZ = D * 0.5 * 0.5, topY = height(0, topZ) + 0.2;
  const strip = new THREE.PlaneGeometry(5.5, 1, 1, 12);
  const sp = strip.attributes.position, suv = strip.attributes.uv;
  for (let i = 0; i < sp.count; i++) {
    const t = 1 - suv.getY(i);
    const y = topY * (1 - t * t * 0.4 - t * 0.6) + 0.15;
    const z = topZ + 0.6 + t * (D * 0.5 - topZ + 1.4) + Math.sin(t * Math.PI) * 0.9;
    sp.setXYZ(i, sp.getX(i) * (1 + t * 0.25), y, z);
    suv.setY(i, t);
  }
  const fall = new THREE.Mesh(strip, waterfallMaterial());
  fall.renderOrder = 5;
  g.add(fall);
  const pool = new THREE.Mesh(new THREE.CircleGeometry(9, 28).rotateX(-Math.PI / 2), propMat('water'));
  pool.position.set(0, 0.25, D / 2 + 5);
  pool.scale.set(1.25, 1, 0.8);
  g.add(pool);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(9, 0.8, 6, 28).rotateX(Math.PI / 2), vegMat('rock', env));
  rim.position.copy(pool.position).setY(0);
  rim.scale.copy(pool.scale).setY(0.6);
  rim.castShadow = true;
  g.add(rim);
  const wp = new THREE.Vector3();
  let acc = 0;
  g.userData.tick = (dt, t, e) => {
    if (!ctx || !ctx.particles) return;
    acc += dt * 50;
    g.getWorldPosition(wp);
    const s = g.scale.x, k = 0.35 + e.ambient * 0.6;
    const c = Math.cos(g.rotation.y), sn = Math.sin(g.rotation.y);
    while (acc > 1) {
      acc -= 1;
      const lx = (Math.random() - 0.5) * 6 * s, lz = (D / 2 + 1.5) * s;
      ctx.particles.spawn(wp.x + lx * c + lz * sn, wp.y + 0.6, wp.z - lx * sn + lz * c,
        (Math.random() - 0.5) * 3, 2 + Math.random() * 3.5, (Math.random() - 0.5) * 3, 0.22 * k, 0.26 * k, 0.3 * k, 2.6 * s, 1.6, 0.12);
    }
  };
  return g;
}

// 星空贴图：黑底上随机撒星星，给星际场景的内壁用
let starTex = null;
export function starTexture() {
  if (starTex) return starTex;
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 1500; i++) {
    const x = Math.random() * 1024, y = Math.random() * 1024, r = Math.random() < 0.06 ? 1.8 : Math.random() * 0.9 + 0.3;
    const b = 150 + Math.random() * 105;
    g.fillStyle = `rgb(${b},${b},${Math.min(255, b + 30)})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  starTex = new THREE.CanvasTexture(c);
  starTex.wrapS = starTex.wrapT = THREE.RepeatWrapping;
  starTex.colorSpace = THREE.SRGBColorSpace;
  return starTex;
}

// 行星贴图：一圈圈的条纹
export function planetTexture(hue) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  for (let y = 0; y < 128; y++) {
    const n = fbm(y / 14 + hue * 9, hue * 3, 3, 4);
    g.fillStyle = `hsl(${(hue * 360 + n * 50) % 360}, ${45 + n * 30}%, ${28 + n * 42}%)`;
    g.fillRect(0, y, 256, 1);
  }
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.12})`;
    g.fillRect(Math.random() * 256, Math.random() * 128, 20 + Math.random() * 60, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
export { clamp };
