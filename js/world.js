// 环境系统：地形、天空、光照、天气、水面、植被
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  clamp, lerp, smoothstep, fbm, ridged, noise2, mulberry32, damp,
  registerWet, applyWetness, paintGeometry, mergeColored, transformed,
} from './util.js';
import { assets } from './assets.js';

export const ENVIRONMENTS = [
  { id: 'meadow', name: '草原山谷', desc: '绿色的丘陵和湖泊，适合第一次设计' },
  { id: 'island', name: '热带海岛', desc: '四面环海，有沙滩和棕榈树' },
  { id: 'desert', name: '沙漠峡谷', desc: '沙丘和红色的平顶山' },
  { id: 'snow', name: '雪山', desc: '被雪山包围的高原' },
  { id: 'city', name: '未来都市', desc: '高楼中间的广场，夜景最好看' },
  { id: 'volcano', name: '火山', desc: '黑色的熔岩地和流动的岩浆' },
];

export const WEATHERS = [
  { id: 'clear', name: '晴天' },
  { id: 'cloudy', name: '多云' },
  { id: 'rain', name: '下雨' },
  { id: 'storm', name: '雷暴' },
  { id: 'snow', name: '下雪' },
  { id: 'fog', name: '大雾' },
];

const WEATHER_PARAMS = {
  clear:  { cover: 0.22, sun: 1.0,  gray: 0.0,  fog: 0.00042, rain: 0, snow: 0, wind: 0.3, wet: 0, storm: 0 },
  cloudy: { cover: 0.68, sun: 0.6,  gray: 0.35, fog: 0.0007,  rain: 0, snow: 0, wind: 0.5, wet: 0, storm: 0 },
  rain:   { cover: 0.95, sun: 0.22, gray: 0.75, fog: 0.0017,  rain: 1, snow: 0, wind: 0.8, wet: 1, storm: 0 },
  storm:  { cover: 1.0,  sun: 0.12, gray: 0.9,  fog: 0.0022,  rain: 1.5, snow: 0, wind: 1.6, wet: 1, storm: 1 },
  snow:   { cover: 0.9,  sun: 0.35, gray: 0.65, fog: 0.0024,  rain: 0, snow: 1, wind: 0.5, wet: 0.2, storm: 0 },
  fog:    { cover: 0.6,  sun: 0.3,  gray: 0.8,  fog: 0.0095,  rain: 0, snow: 0, wind: 0.1, wet: 0.3, storm: 0 },
};

const SIZE = 1800;
const SEG = 240;
const CELL = SIZE / SEG;

const C = (hex) => new THREE.Color(hex);

// ---------- 各环境的地形高度 ----------
const HEIGHT_FN = {
  meadow(x, z) {
    const d = Math.hypot(x, z);
    const f = smoothstep(190, 520, d);
    let h = (fbm(x / 260, z / 260, 5, 11) - 0.42) * 150 * f;
    h += (fbm(x / 60, z / 60, 3, 5) - 0.5) * 3;
    h += smoothstep(560, 880, d) * ridged(x / 300, z / 300, 4, 3) * 110;
    const dl = Math.hypot(x - 215, z + 165);
    h -= 9 * (1 - smoothstep(38, 98, dl));
    return h;
  },
  island(x, z) {
    const d = Math.hypot(x, z);
    const shape = 1 - smoothstep(205, 335, d + (fbm(x / 90, z / 90, 3, 3) - 0.5) * 90);
    let h = -12 + shape * 17 + (fbm(x / 50, z / 50, 3, 9) - 0.5) * 2.5 * shape;
    const far = smoothstep(450, 620, d);
    h += far * Math.max(0, fbm(x / 220, z / 220, 4, 21) - 0.56) * 520;
    return h;
  },
  desert(x, z) {
    const d = Math.hypot(x, z);
    const f = smoothstep(200, 480, d);
    let h = (Math.sin(x / 38 + fbm(x / 120, z / 120, 2, 4) * 6) * 0.5 + 0.5) * (1.5 + 12 * f);
    h += (fbm(x / 45, z / 45, 3, 7) - 0.5) * 3;
    const m = fbm(x / 300, z / 300, 4, 33);
    h += (smoothstep(0.5, 0.55, m) * 70 + smoothstep(0.61, 0.65, m) * 55) * f;
    return h;
  },
  snow(x, z) {
    const d = Math.hypot(x, z);
    const f = smoothstep(200, 560, d);
    return ridged(x / 420, z / 420, 5, 13) * 340 * f * f + (fbm(x / 70, z / 70, 3, 2) - 0.5) * 4;
  },
  city() {
    return 0;
  },
  volcano(x, z) {
    const d = Math.hypot(x, z);
    const f = smoothstep(180, 460, d);
    let h = (ridged(x / 200, z / 200, 4, 8) - 0.35) * 60 * f + (fbm(x / 40, z / 40, 3, 6) - 0.5) * 3 + 1.5;
    const dc = Math.hypot(x, z + 620);
    const cone = dc < 70 ? 247.5 - (70 - dc) * 1.5 : Math.max(0, 300 - 0.75 * dc);
    return h + cone;
  },
};

// ---------- 各环境的地面颜色 ----------
const PAL = {
  meadow: { a: C('#5d8f3a'), b: C('#7aa847'), rock: C('#7d7a72'), sand: C('#b8a676'), bed: C('#4a6b5a') },
  island: { a: C('#5fa04a'), b: C('#77b356'), rock: C('#8b8478'), sand: C('#e2d2a0'), bed: C('#3d8f96') },
  desert: { a: C('#d9a760'), b: C('#c98a4b'), m1: C('#b5562f'), m2: C('#d07a45'), m3: C('#8e3f26') },
  snow: { a: C('#f2f6fb'), b: C('#dbe7f3'), rock: C('#5f6470') },
  city: { a: C('#3a3f4a'), b: C('#434956') },
  volcano: { a: C('#2a2625'), b: C('#3d3836'), hot: C('#6a2a12'), rock: C('#1d1a1a') },
};
// 每种环境的地面由 4 层贴图混合而成。tile 是一张贴图在地面上铺多大（米）
const TERRAIN_LAYERS = {
  meadow: { tex: ['grass', 'rock', 'dirt', 'sand'], rough: [1.0, 0.9, 1.0, 0.95], tile: 5 },
  island: { tex: ['grass', 'rock', 'sand', 'dirt'], rough: [1.0, 0.9, 0.95, 1.0], tile: 5 },
  desert: { tex: ['sand', 'redrock', 'rock', 'dirt'], rough: [0.95, 0.92, 0.9, 1.0], tile: 6 },
  snow: { tex: ['snow', 'rock', 'dirt', 'snow'], rough: [0.72, 0.9, 1.0, 0.72], tile: 6 },
  city: { tex: ['pavement', 'concrete', 'pavement', 'concrete'], rough: [0.72, 0.85, 0.72, 0.85], tile: 8 },
  volcano: { tex: ['basalt', 'rock', 'dirt', 'basalt'], rough: [0.85, 0.9, 1.0, 0.85], tile: 6 },
};

const _col = new THREE.Color();
const _w = [0, 0, 0, 0];
// 把第 i 层的权重设为 k，其余各层按比例让出
function layer(i, k) {
  for (let j = 0; j < 4; j++) _w[j] *= 1 - k;
  _w[i] += k;
}
// 计算地面上一个点的 4 层贴图权重（写进 _w）和整体色调（返回 _col，会乘到贴图颜色上）
function terrainLayers(env, h, slope, x, z, water) {
  _w[0] = 1; _w[1] = 0; _w[2] = 0; _w[3] = 0;
  _col.setRGB(1, 1, 1);
  const patch = fbm(x / 28, z / 28, 3, 19);
  switch (env) {
    case 'meadow':
      layer(2, smoothstep(0.66, 0.82, patch) * 0.55);
      layer(3, smoothstep(water + 1.3, water + 0.2, h));
      layer(1, smoothstep(0.5, 0.85, slope));
      if (h < water) _col.setRGB(0.5, 0.68, 0.66);
      break;
    case 'island':
      layer(3, smoothstep(0.62, 0.76, patch) * 0.5);
      layer(2, smoothstep(3.8, 2.3, h));
      layer(1, smoothstep(0.6, 0.9, slope));
      if (h < water) _col.lerp(_tint.setRGB(0.45, 0.8, 0.85), smoothstep(0, -6, h));
      break;
    case 'desert': {
      layer(3, smoothstep(0.64, 0.8, patch) * 0.35);
      const mesa = smoothstep(20, 38, h);
      layer(1, Math.max(mesa, smoothstep(0.45, 0.8, slope)));
      const band = Math.sin(h / 5.5) * 0.5 + 0.5;
      _col.lerp(_tint.setRGB(0.72, 0.62, 0.6), mesa * (band > 0.5 ? 0.7 : 0));
      break;
    }
    case 'snow':
      layer(1, smoothstep(0.55, 0.9, slope));
      break;
    case 'city':
      _col.setScalar(0.8);
      break;
    case 'volcano':
      layer(2, smoothstep(0.55, 0.75, patch) * 0.45);
      layer(1, smoothstep(0.5, 0.9, slope) * 0.6);
      _col.setScalar(0.9).lerp(_tint.setRGB(2.4, 0.6, 0.25), smoothstep(-1, -4.5, h));
      break;
  }
  const v = 0.84 + noise2(x / 9, z / 9, 5) * 0.2 + fbm(x / 90, z / 90, 3, 41) * 0.16;
  _col.multiplyScalar(v);
  return _col;
}
const _tint = new THREE.Color();

// 给地形材质加上多层贴图混合的着色代码
function makeTerrainMaterial(U) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 splat;\nvarying vec4 vSplat;\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = splat;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uT0, uT1, uT2, uT3, uN0, uN1, uN2, uN3;
        uniform float uTile, uWet;
        uniform vec4 uRoughK;
        varying vec4 vSplat;
        varying vec3 vWPos;
        vec3 gDetailN;
        vec4 gSplat;`)
      .replace('#include <map_fragment>', `
        {
          vec2 tuv = vWPos.xz / uTile;
          vec2 fuv = vWPos.xz / (uTile * 7.3) + 0.37;
          float tdist = distance(cameraPosition, vWPos);
          float tfar = smoothstep(25.0, 190.0, tdist);
          gSplat = vSplat / max(vSplat.x + vSplat.y + vSplat.z + vSplat.w, 0.001);
          vec3 tcol = gSplat.x * mix(texture2D(uT0, tuv).rgb, texture2D(uT0, fuv).rgb, tfar);
          tcol += gSplat.y * mix(texture2D(uT1, tuv).rgb, texture2D(uT1, fuv).rgb, tfar);
          tcol += gSplat.z * mix(texture2D(uT2, tuv).rgb, texture2D(uT2, fuv).rgb, tfar);
          tcol += gSplat.w * mix(texture2D(uT3, tuv).rgb, texture2D(uT3, fuv).rgb, tfar);
          // 远处再叠一层更大尺度的明暗变化，从高处看不会有明显的重复格子
          float macro = texture2D(uT0, vWPos.xz / (uTile * 31.0)).g;
          tcol *= mix(1.0, 0.72 + macro * 0.75, 0.55);
          diffuseColor.rgb *= tcol * mix(1.0, 0.7, uWet);
          vec3 tn = gSplat.x * texture2D(uN0, tuv).xyz + gSplat.y * texture2D(uN1, tuv).xyz + gSplat.z * texture2D(uN2, tuv).xyz + gSplat.w * texture2D(uN3, tuv).xyz;
          gDetailN = (tn * 2.0 - 1.0) * (1.0 - tfar * 0.85);
        }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= dot(gSplat, uRoughK);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(normal + (viewMatrix * vec4(gDetailN.x, 0.0, gDetailN.y, 0.0)).xyz * 0.85);');
  };
  return mat;
}

// ---------- 植被：用 Blender 做的模型和贴图 ----------
const SWAY = { uSwayTime: { value: 0 }, uSwayWind: { value: 0.3 } };
function addSway(mat, leafy) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, SWAY);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uSwayTime, uSwayWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
            float swPh = instanceMatrix[3].x * 0.31 + instanceMatrix[3].z * 0.17;
          #else
            float swPh = 0.0;
          #endif
          float swAmp = uSwayWind * 0.016 * max(transformed.y, 0.0);
          transformed.x += sin(uSwayTime * 1.4 + swPh) * swAmp;
          transformed.z += cos(uSwayTime * 1.1 + swPh * 1.3) * swAmp * 0.7;
          ${leafy ? 'transformed.xyz += sin(uSwayTime * 3.7 + position.zxy * 2.3 + swPh) * 0.035 * uSwayWind;' : ''}
        }`);
    if (leafy) {
      // 树叶是双面的面片，法线已经改成从树冠中心向外，背面不要再翻转
      shader.fragmentShader = shader.fragmentShader.replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;');
    }
  };
  mat.customProgramCacheKey = () => 'sway' + (leafy ? 'leaf' : 'trunk');
  return mat;
}
const VEG_MATS = {};
export function vegMat(key, env) {
  const T = assets.tex;
  let id = key;
  if (key === 'rock') id = 'rock_' + (env === 'desert' ? 'redrock' : env === 'volcano' ? 'basalt' : 'rock');
  if (VEG_MATS[id]) return VEG_MATS[id];
  let m;
  if (key === 'bark') {
    m = addSway(new THREE.MeshStandardMaterial({ map: T.bark, normalMap: T.bark_n, roughness: 0.95 }), false);
  } else if (key.startsWith('leaf')) {
    const snowy = key.endsWith('_snow');
    const tex = T[snowy ? key.slice(0, -5) : key];
    m = addSway(new THREE.MeshStandardMaterial({
      map: tex, alphaTest: 0.36, side: THREE.DoubleSide, roughness: 0.78, metalness: 0,
      color: snowy ? new THREE.Color(1.5, 1.75, 2.0) : key === 'leaf_broad' ? new THREE.Color(0.7, 0.86, 0.58) : new THREE.Color(0.92, 1, 0.88),
    }), true);
    m.alphaToCoverage = true;
  } else if (key === 'rock') {
    const name = id.slice(5);
    m = new THREE.MeshStandardMaterial({ map: T[name], normalMap: T[name + '_n'], roughness: 0.92 });
  } else {
    m = new THREE.MeshStandardMaterial({ color: '#4f8a48', roughness: 0.8 });
  }
  VEG_MATS[id] = m;
  return m;
}
const VEG_MODELS = {
  broadleaf: { model: 'tree_broad', height: 9.6, scale: 1 },
  pine: { model: 'tree_pine', height: 13.4, scale: 0.78 },
  snowpine: { model: 'tree_pine', height: 13.4, scale: 0.78, snow: true },
  palm: { model: 'tree_palm', height: 9.8, scale: 1 },
  deadtree: { model: 'deadtree', height: 5.4, scale: 1 },
  cactus: { model: 'cactus', height: 3.6, scale: 1 },
  bush: { model: 'bush', height: 1.5, scale: 1 },
  rock1: { model: 'rock1', height: 1.2, scale: 1 },
  rock2: { model: 'rock2', height: 1.2, scale: 1 },
};
// 取一种植被的各个部分（树干、树叶）的几何体和材质
export function vegParts(type, env) {
  const def = VEG_MODELS[type] || VEG_MODELS.broadleaf;
  const parts = (assets.nature[def.model] || []).map((p) => ({
    geo: p.geo,
    mat: vegMat(def.snow && p.key.startsWith('leaf') ? p.key + '_snow' : p.key, env),
  }));
  return { parts, height: def.height * def.scale, scale: def.scale };
}
// 单独摆放的一棵植被（装饰道具用）
export function makeVegObject(type, env) {
  const { parts, scale } = vegParts(type, env);
  const g = new THREE.Group();
  for (const p of parts) {
    const m = new THREE.Mesh(p.geo, p.mat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.scale.setScalar(scale);
    g.add(m);
  }
  return g;
}

const ENV_CONF = {
  meadow: { water: -2.5, waterKind: 'water', ground: '#5d7a3c', veg: [['broadleaf', 900], ['pine', 500], ['rock', 160], ['bush', 600]] },
  island: { water: 0, waterKind: 'water', ground: '#b5a878', veg: [['palm', 520], ['bush', 320], ['rock', 110]] },
  desert: { water: -999, waterKind: null, ground: '#b98850', veg: [['cactus', 380], ['rock', 420], ['deadtree', 60]] },
  snow: { water: -999, waterKind: null, ground: '#cfd8e2', veg: [['snowpine', 1150], ['rock', 260]] },
  city: { water: -999, waterKind: null, ground: '#3a3f4a', veg: [['broadleaf', 140], ['bush', 120]] },
  volcano: { water: -4, waterKind: 'lava', ground: '#2a2020', veg: [['deadtree', 320], ['rock', 520]] },
};

const GLSL_NOISE = /* glsl */ `
float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash21(i), hash21(i+vec2(1,0)), u.x), mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), u.x), u.y);
}
float fbm2(vec2 p){
  float s = 0.0, a = 0.5;
  for(int i=0;i<5;i++){ s += a*vnoise(p); p = p*2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s;
}
`;

function makeSkyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uGround: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uCloudLit: { value: new THREE.Color() },
      uCloudDark: { value: new THREE.Color() },
      uSunGlow: { value: 1 },
      uStars: { value: 0 },
      uMoon: { value: 0 },
      uCover: { value: 0.3 },
      uTime: { value: 0 },
      uFlash: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop, uHorizon, uGround, uSunDir, uSunColor, uMoonDir, uCloudLit, uCloudDark;
      uniform float uSunGlow, uStars, uMoon, uCover, uTime, uFlash;
      varying vec3 vDir;
      ${GLSL_NOISE}
      float hash31(vec3 p){ p = fract(p*0.3183099+0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.5));
        col = mix(col, uGround, smoothstep(0.0, -0.22, h));
        float sd = max(dot(d, uSunDir), 0.0);
        col += uSunColor * (pow(sd, 6.0)*0.22 + pow(sd, 80.0)*0.7) * uSunGlow;
        col += uSunColor * smoothstep(0.99935, 0.9998, sd) * 30.0 * uSunGlow;
        float md = max(dot(d, uMoonDir), 0.0);
        col += vec3(0.85,0.9,1.0) * smoothstep(0.9992, 0.9996, md) * 3.0 * uMoon;
        col += vec3(0.25,0.33,0.5) * pow(md, 180.0) * 0.5 * uMoon;
        if (uStars > 0.001 && h > 0.0) {
          vec3 sp = d * 190.0;
          vec3 cell = floor(sp);
          float r = hash31(cell);
          float star = step(0.9962, r) * smoothstep(0.45, 0.05, length(fract(sp) - 0.5));
          float tw = 0.7 + 0.3*sin(uTime*3.0 + r*600.0);
          col += vec3(1.0, 0.95, 0.9) * star * tw * uStars * 2.2 * smoothstep(0.0, 0.25, h);
        }
        if (h > -0.02) {
          vec2 uv = d.xz / (h + 0.16) * 0.85 + uTime * vec2(0.007, 0.0025);
          float n = fbm2(uv * 1.3);
          float thr = mix(0.86, 0.12, uCover);
          float c = smoothstep(thr, thr + 0.3, n);
          float shade = fbm2(uv * 3.3 + 4.0);
          vec3 cc = mix(uCloudLit, uCloudDark, clamp(c*0.55 + shade*0.55 - 0.1, 0.0, 1.0));
          cc += uSunColor * pow(sd, 12.0) * 0.55 * uSunGlow * (1.0 - c*0.75);
          cc += vec3(0.8, 0.85, 1.0) * uFlash * (0.4 + shade);
          float fade = smoothstep(-0.02, 0.14, h);
          col = mix(col, cc, c * fade);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

function makeWaterMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uDeep: { value: new THREE.Color() },
        uSky: { value: new THREE.Color() },
        uRough: { value: 1 },
      },
    ]),
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uRough;
      uniform vec3 uSunDir, uSunColor, uDeep, uSky;
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      ${GLSL_NOISE}
      float waveH(vec2 p){
        float t = uTime;
        float h = sin(dot(p, vec2(0.12, 0.05)) + t*1.1) * 0.5;
        h += sin(dot(p, vec2(-0.07, 0.16)) + t*1.4) * 0.35;
        h += sin(dot(p, vec2(0.31, -0.22)) + t*2.1) * 0.12;
        h += (vnoise(p*0.45 + t*0.25) - 0.5) * 0.5;
        h += (vnoise(p*1.7 - t*0.4) - 0.5) * 0.12;
        return h * uRough;
      }
      void main(){
        vec2 p = vWorld.xz;
        float e = 0.4;
        float h0 = waveH(p), hx = waveH(p + vec2(e, 0.0)), hz = waveH(p + vec2(0.0, e));
        vec3 n = normalize(vec3(-(hx-h0)/e, 1.0, -(hz-h0)/e));
        float dist = distance(cameraPosition, vWorld);
        n = normalize(mix(n, vec3(0.0,1.0,0.0), smoothstep(120.0, 900.0, dist)));
        vec3 V = normalize(cameraPosition - vWorld);
        float fres = 0.03 + 0.97 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
        vec3 R = reflect(-V, n);
        float spec = pow(max(dot(R, uSunDir), 0.0), 220.0);
        vec3 col = mix(uDeep, uSky, fres) + uSunColor * spec * 6.0;
        gl_FragColor = vec4(col, mix(0.8, 1.0, fres));
        #include <fog_fragment>
      }`,
  });
}

function makeLavaMaterial() {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      ${GLSL_NOISE}
      void main(){
        vec2 p = vWorld.xz;
        float n = fbm2(p*0.03 + vec2(uTime*0.02, uTime*0.013));
        float cr = fbm2(p*0.11 - uTime*0.012);
        float heat = smoothstep(0.3, 0.75, n*0.75 + cr*0.5);
        vec3 col = mix(vec3(0.03,0.012,0.01), vec3(3.2,0.7,0.08), heat*heat);
        col += vec3(5.0,2.6,0.5) * pow(heat, 7.0);
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }`,
  });
}

// 降水、雪、火星、速度线共用的粒子系统。粒子固定在以相机为中心的一个盒子里循环出现。
export class Precip {
  constructor({ count, box, lines, size = 0.1, additive = false }) {
    this.box = new THREE.Vector3(...box);
    this.lines = lines;
    const n = lines ? count * 2 : count;
    const seed = new Float32Array(n * 3);
    const end = new Float32Array(n);
    for (let i = 0; i < count; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random();
      if (lines) {
        seed.set([x, y, z, x, y, z], i * 6);
        end[i * 2 + 1] = 1;
      } else {
        seed.set([x, y, z], i * 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(seed, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    this.uniforms = {
      uCam: { value: new THREE.Vector3() },
      uBox: { value: this.box },
      uOffset: { value: new THREE.Vector3() },
      uStreak: { value: new THREE.Vector3() },
      uColor: { value: new THREE.Color(1, 1, 1) },
      uOpacity: { value: 0 },
      uSize: { value: size },
      uScale: { value: 600 },
      uTime: { value: 0 },
      uSway: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute float aEnd;
        uniform vec3 uCam, uBox, uOffset, uStreak;
        uniform float uSize, uScale, uTime, uSway;
        varying float vEnd;
        varying float vFade;
        void main(){
          vec3 p = mod(position * uBox + uOffset - uCam, uBox) - uBox * 0.5;
          p.x += sin(uTime * 1.3 + position.y * 40.0) * uSway;
          p.z += cos(uTime * 1.1 + position.x * 40.0) * uSway;
          vec3 edge = abs(p) / (uBox * 0.5);
          vFade = 1.0 - smoothstep(0.75, 1.0, max(edge.x, max(edge.y, edge.z)));
          p += uCam + aEnd * uStreak;
          vEnd = aEnd;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * uScale / max(-mv.z, 0.5);
        }`,
      fragmentShader: lines
        ? /* glsl */ `
        uniform vec3 uColor; uniform float uOpacity;
        varying float vEnd; varying float vFade;
        void main(){ gl_FragColor = vec4(uColor, uOpacity * vFade * (1.0 - vEnd * 0.85)); }`
        : /* glsl */ `
        uniform vec3 uColor; uniform float uOpacity;
        varying float vFade;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.15, d);
          gl_FragColor = vec4(uColor, a * uOpacity * vFade);
        }`,
    });
    this.object = lines ? new THREE.LineSegments(geo, mat) : new THREE.Points(geo, mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
    this.object.visible = false;
    this.vel = new THREE.Vector3();
  }
  // vel：粒子自身的速度；camVel：相机速度（用来拉出运动拖尾）；exposure：拖尾对应的曝光时间
  update(dt, camPos, camVel, opacity, exposure = 0.03) {
    this.object.visible = opacity > 0.004;
    if (!this.object.visible) return;
    const u = this.uniforms;
    u.uOffset.value.addScaledVector(this.vel, dt);
    u.uOffset.value.set(u.uOffset.value.x % this.box.x, u.uOffset.value.y % this.box.y, u.uOffset.value.z % this.box.z);
    u.uCam.value.copy(camPos);
    u.uOpacity.value = opacity;
    u.uTime.value += dt;
    if (this.lines) u.uStreak.value.copy(this.vel).sub(camVel).multiplyScalar(exposure);
  }
}

function makeWindowTextures() {
  const size = 256;
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  };
  const base = mk(), emis = mk();
  const gb = base.getContext('2d'), ge = emis.getContext('2d');
  gb.fillStyle = '#5a6272';
  gb.fillRect(0, 0, size, size);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, size, size);
  const rng = mulberry32(42);
  const n = 8, cell = size / n;
  const warm = ['#ffd9a0', '#ffe9c4', '#fff4dd', '#bfe4ff', '#ffc27a'];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = x * cell + 5, py = y * cell + 7, w = cell - 10, h = cell - 14;
      gb.fillStyle = '#1c2533';
      gb.fillRect(px, py, w, h);
      if (rng() < 0.55) {
        ge.fillStyle = warm[Math.floor(rng() * warm.length)];
        ge.globalAlpha = 0.45 + rng() * 0.55;
        ge.fillRect(px, py, w, h);
        ge.globalAlpha = 1;
      }
    }
  }
  const tb = new THREE.CanvasTexture(base), te = new THREE.CanvasTexture(emis);
  for (const t of [tb, te]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
  }
  return { base: tb, emis: te };
}

const KEY_E = [-0.28, -0.08, 0.02, 0.14, 0.45];
const KEY_TOP = ['#01030a', '#0c1433', '#2b4a8c', '#2f66b8', '#2a6bd2'].map(C);
const KEY_HOR = ['#060b16', '#5a3350', '#f08a4a', '#e9b98a', '#a9cdf2'].map(C);
const KEY_SUN = ['#ff5a2a', '#ff5a2a', '#ff7a35', '#ffc27a', '#fff3e0'].map(C);
const KEY_SUNI = [0, 0, 1.3, 2.7, 3.4];
const KEY_AMB = [0.2, 0.3, 0.5, 0.82, 1.0];
const KEY_STAR = [1, 0.5, 0.04, 0, 0];

function keyIndex(e) {
  if (e <= KEY_E[0]) return [0, 0, 0];
  for (let i = 0; i < KEY_E.length - 1; i++) {
    if (e <= KEY_E[i + 1]) return [i, i + 1, (e - KEY_E[i]) / (KEY_E[i + 1] - KEY_E[i])];
  }
  const l = KEY_E.length - 1;
  return [l, l, 0];
}

export class World {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.env = 'meadow';
    this.weather = 'clear';
    this.time = 10;
    this.autoTime = false;
    this.clock = 0;
    this.wx = { ...WEATHER_PARAMS.clear };
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.moonDir = new THREE.Vector3(0, 1, 0);
    this.lightDir = new THREE.Vector3(0, 1, 0);
    this.lightsOn = 0;
    this.indoor = 0;   // 镜头在室内场景里的程度，0 到 1
    this.fogBoost = 0; // 丛林场景里加浓的雾
    this.waterLevel = -999;
    this.shadowExtent = 150;
    this.shadowMapSize = 4096;
    this.flash = 0;
    this.nextLightning = 6;
    this.onThunder = null;
    this.heights = new Float32Array((SEG + 1) * (SEG + 1));
    this.vegetation = [];

    // 天空
    this.skyMat = makeSkyMaterial();
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.skyMat);
    this.sky.scale.setScalar(4500);
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    scene.add(this.sky);
    this.envScene = new THREE.Scene();
    const skyCopy = new THREE.Mesh(this.sky.geometry, this.skyMat);
    skyCopy.scale.setScalar(100);
    this.envScene.add(skyCopy);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;
    this.envDirty = true;
    this.envTimer = 0;

    // 灯光
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.shadowMapSize, this.shadowMapSize);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.25;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.flashLight = new THREE.DirectionalLight(0xcfd8ff, 0);
    this.flashLight.position.set(0.3, 1, 0.2);
    scene.add(this.flashLight);
    scene.fog = new THREE.FogExp2(0xaaccee, 0.0005);

    // 地形
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));
    geo.setAttribute('splat', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 4), 4));
    this.tU = {
      uT0: { value: null }, uT1: { value: null }, uT2: { value: null }, uT3: { value: null },
      uN0: { value: null }, uN1: { value: null }, uN2: { value: null }, uN3: { value: null },
      uTile: { value: 5 }, uWet: { value: 0 }, uRoughK: { value: new THREE.Vector4(1, 1, 1, 1) },
    };
    this.terrainMat = registerWet(makeTerrainMaterial(this.tU), 0.5);
    this.terrain = new THREE.Mesh(geo, this.terrainMat);
    this.terrain.receiveShadow = true;
    this.terrain.name = 'terrain';
    scene.add(this.terrain);

    // 水面和岩浆
    this.waterMat = makeWaterMaterial();
    this.lavaMat = makeLavaMaterial();
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000, 1, 1).rotateX(-Math.PI / 2), this.waterMat);
    this.water.renderOrder = 2;
    scene.add(this.water);
    this.crater = new THREE.Mesh(new THREE.CircleGeometry(72, 24).rotateX(-Math.PI / 2), this.lavaMat);
    this.crater.position.set(0, 148, -620);
    scene.add(this.crater);
    this.lavaLight = new THREE.PointLight(0xff5a1e, 0, 0, 1.2);
    this.lavaLight.position.set(0, 190, -620);
    scene.add(this.lavaLight);

    this.vegGroup = new THREE.Group();
    scene.add(this.vegGroup);
    this.cityGroup = new THREE.Group();
    scene.add(this.cityGroup);

    // 天气粒子
    this.rain = new Precip({ count: 7000, box: [70, 44, 70], lines: true });
    this.rain.uniforms.uColor.value.set(0.72, 0.8, 0.95);
    this.snow = new Precip({ count: 6000, box: [70, 44, 70], lines: false, size: 0.11 });
    this.snow.uniforms.uSway.value = 0.5;
    this.embers = new Precip({ count: 900, box: [90, 50, 90], lines: false, size: 0.16, additive: true });
    this.embers.uniforms.uColor.value.set(4, 1.2, 0.2);
    this.embers.uniforms.uSway.value = 1.2;
    scene.add(this.rain.object, this.snow.object, this.embers.object);

    // 闪电
    this.boltMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 9, 12), fog: false });
    this.bolt = new THREE.Mesh(new THREE.BufferGeometry(), this.boltMat);
    this.bolt.visible = false;
    this.boltTimer = 0;
    scene.add(this.bolt);

    this._top = new THREE.Color();
    this._hor = new THREE.Color();
    this._sunC = new THREE.Color();
    this._tmp = new THREE.Color();
    this._lastKey = '';
    this.setEnvironment('meadow');
  }

  // ---------- 环境 ----------
  setEnvironment(id) {
    if (!HEIGHT_FN[id]) id = 'meadow';
    this.env = id;
    const conf = ENV_CONF[id];
    const fn = HEIGHT_FN[id];
    const N = SEG + 1;
    const H = this.heights;
    for (let r = 0; r < N; r++) {
      const z = -SIZE / 2 + r * CELL;
      for (let c = 0; c < N; c++) {
        const x = -SIZE / 2 + c * CELL;
        H[r * N + c] = fn(x, z);
      }
    }
    this.waterLevel = conf.water;
    const pos = this.terrain.geometry.attributes.position;
    const col = this.terrain.geometry.attributes.color;
    const splat = this.terrain.geometry.attributes.splat;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const i = r * N + c;
        const h = H[i];
        pos.setY(i, h);
        const hx = H[r * N + Math.min(c + 1, SEG)] - H[r * N + Math.max(c - 1, 0)];
        const hz = H[Math.min(r + 1, SEG) * N + c] - H[Math.max(r - 1, 0) * N + c];
        const slope = Math.hypot(hx, hz) / (2 * CELL);
        const k = terrainLayers(id, h, slope, pos.getX(i), pos.getZ(i), conf.water);
        col.setXYZ(i, k.r, k.g, k.b);
        splat.setXYZW(i, _w[0], _w[1], _w[2], _w[3]);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    splat.needsUpdate = true;
    this.terrain.geometry.computeVertexNormals();
    this.terrain.geometry.computeBoundingSphere();
    const L = TERRAIN_LAYERS[id];
    for (let i = 0; i < 4; i++) {
      this.tU['uT' + i].value = assets.tex[L.tex[i]];
      this.tU['uN' + i].value = assets.tex[L.tex[i] + '_n'];
    }
    this.tU.uTile.value = L.tile;
    this.tU.uRoughK.value.set(L.rough[0], L.rough[1], L.rough[2], L.rough[3]);
    this.terrainMat.userData.wetAmount = id === 'city' ? 0.7 : 0.45;

    this.water.visible = !!conf.waterKind;
    this.water.material = conf.waterKind === 'lava' ? this.lavaMat : this.waterMat;
    this.water.position.y = conf.water;
    this.crater.visible = id === 'volcano';
    this.lavaLight.visible = id === 'volcano';
    this.groundColor = C(conf.ground);

    this.buildVegetation(conf.veg);
    this.buildCity(id === 'city');
    this._lastKey = '';
    this.envDirty = true;
  }

  heightAt(x, z) {
    const fx = clamp((x + SIZE / 2) / CELL, 0, SEG - 0.001);
    const fz = clamp((z + SIZE / 2) / CELL, 0, SEG - 0.001);
    const c = Math.floor(fx), r = Math.floor(fz);
    const tx = fx - c, tz = fz - r;
    const N = SEG + 1, H = this.heights;
    const a = H[r * N + c], b = H[r * N + c + 1], d = H[(r + 1) * N + c], e = H[(r + 1) * N + c + 1];
    return lerp(lerp(a, b, tx), lerp(d, e, tx), tz);
  }

  // 地面或水面的高度，取较高的那个
  surfaceAt(x, z) {
    return Math.max(this.heightAt(x, z), this.waterLevel);
  }

  buildVegetation(list) {
    for (const v of this.vegetation) {
      for (const mesh of v.meshes) {
        this.vegGroup.remove(mesh);
        mesh.dispose();
      }
    }
    this.vegetation = [];
    const rng = mulberry32(1234 + this.env.length * 97);
    // 岩石有两种模型，各放一半
    const expanded = [];
    for (const [type, count] of list) {
      if (type === 'rock') expanded.push(['rock1', Math.ceil(count / 2)], ['rock2', Math.floor(count / 2)]);
      else expanded.push([type, count]);
    }
    for (const [type, count] of expanded) {
      const isRock = type.startsWith('rock');
      const { parts, height, scale } = vegParts(type, this.env);
      const items = [];
      let tries = 0;
      while (items.length < count && tries < count * 30) {
        tries++;
        const r = Math.sqrt(rng()) * 760, a = rng() * Math.PI * 2;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (Math.abs(x) > SIZE / 2 - 20 || Math.abs(z) > SIZE / 2 - 20) continue;
        const h = this.heightAt(x, z);
        if (h < this.waterLevel + 0.7) continue;
        const slope = Math.hypot(this.heightAt(x + 3, z) - h, this.heightAt(x, z + 3) - h) / 3;
        if (slope > (isRock ? 1.2 : 0.6)) continue;
        if (this.env === 'city') {
          if (r > 235 || r < 30) continue;
        } else {
          const dens = fbm(x / 140, z / 140, 3, 55);
          if (!isRock && dens < 0.42) continue;
          if (r < 210 && rng() > 0.4) continue;
          if (this.env === 'island' && type === 'palm' && h < 2.4 && rng() > 0.3) continue;
          if (this.env === 'snow' && h > 150) continue;
          if (this.env === 'volcano' && Math.hypot(x, z + 620) < 330) continue;
        }
        const k = isRock ? 0.6 + rng() * rng() * 3.2 : 0.75 + rng() * 0.7;
        items.push({ x, y: h - 0.1, z, s: k * scale, rot: rng() * Math.PI * 2, h: height * k });
      }
      const meshes = parts.map((p) => {
        const mesh = new THREE.InstancedMesh(p.geo, p.mat, Math.max(items.length, 1));
        mesh.count = items.length;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.vegGroup.add(mesh);
        return mesh;
      });
      this.vegetation.push({ meshes, items });
    }
    this.applyVegetation(null);
  }

  // 把离轨道太近的树木隐藏掉。near(x, z, top) 返回 true 表示这里要清空
  applyVegetation(near) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const v of this.vegetation) {
      v.items.forEach((it, i) => {
        const hide = near && near(it.x, it.z, it.y + it.h);
        q.setFromAxisAngle(up, it.rot);
        p.set(it.x, it.y, it.z);
        s.setScalar(hide ? 0 : it.s);
        m.compose(p, q, s);
        for (const mesh of v.meshes) mesh.setMatrixAt(i, m);
      });
      for (const mesh of v.meshes) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
    }
  }

  buildCity(on) {
    while (this.cityGroup.children.length) {
      const c = this.cityGroup.children.pop();
      c.geometry.dispose();
    }
    this.cityMat = null;
    this.neonMat = null;
    if (!on) return;
    if (!this.windowTex) this.windowTex = makeWindowTextures();
    const rng = mulberry32(2077);
    const geos = [], neon = [];
    const tints = ['#8f9bb3', '#a7b0c0', '#7c8aa6', '#b5a99a', '#6f7f9a'].map(C);
    for (let gx = -13; gx <= 13; gx++) {
      for (let gz = -13; gz <= 13; gz++) {
        const cx = gx * 64 + (rng() - 0.5) * 8, cz = gz * 64 + (rng() - 0.5) * 8;
        const d = Math.hypot(cx, cz);
        if (d < 262 || d > 860 || rng() < 0.12) continue;
        const w = 30 + rng() * 18, dp = 30 + rng() * 18;
        const tall = rng();
        const h = 28 + tall * tall * 230 * smoothstep(240, 420, d) + rng() * 30;
        const g = new THREE.BoxGeometry(w, h, dp);
        const uv = g.attributes.uv;
        for (let f = 0; f < 6; f++) {
          const width = f < 2 ? dp : w;
          for (let k = 0; k < 4; k++) {
            const i = f * 4 + k;
            if (f === 2 || f === 3) uv.setXY(i, 0.005, 0.005);
            else uv.setXY(i, uv.getX(i) * Math.round(width / 3.6) / 8, uv.getY(i) * Math.round(h / 3.6) / 8);
          }
        }
        g.translate(cx, h / 2 - 1, cz);
        const tint = tints[Math.floor(rng() * tints.length)];
        const col = new Float32Array(g.attributes.position.count * 3);
        for (let i = 0; i < col.length; i += 3) { col[i] = tint.r; col[i + 1] = tint.g; col[i + 2] = tint.b; }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        geos.push(g);
        if (rng() < 0.45) {
          const strip = new THREE.BoxGeometry(w + 0.6, 1.2, dp + 0.6);
          strip.translate(cx, h - 2 - rng() * h * 0.3, cz);
          const nc = [C('#00e5ff'), C('#ff2bd6'), C('#ffd23f'), C('#7c4dff')][Math.floor(rng() * 4)];
          const ncol = new Float32Array(strip.attributes.position.count * 3);
          for (let i = 0; i < ncol.length; i += 3) { ncol[i] = nc.r; ncol[i + 1] = nc.g; ncol[i + 2] = nc.b; }
          strip.setAttribute('color', new THREE.BufferAttribute(ncol, 3));
          strip.deleteAttribute('uv');
          neon.push(strip);
        }
      }
    }
    this.cityMat = registerWet(new THREE.MeshStandardMaterial({
      map: this.windowTex.base, emissiveMap: this.windowTex.emis, emissive: 0xffffff, emissiveIntensity: 0,
      vertexColors: true, roughness: 0.3, metalness: 0.65,
    }), 0.3);
    const mesh = new THREE.Mesh(mergeGeometries(geos), this.cityMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.cityGroup.add(mesh);
    this.neonMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.cityGroup.add(new THREE.Mesh(mergeGeometries(neon), this.neonMat));
    geos.forEach((g) => g.dispose());
    neon.forEach((g) => g.dispose());
  }

  // ---------- 天气和时间 ----------
  setWeather(id) {
    if (!WEATHER_PARAMS[id]) id = 'clear';
    this.weather = id;
  }

  setTime(h) {
    this.time = ((h % 24) + 24) % 24;
  }

  updateSky(dt) {
    const target = WEATHER_PARAMS[this.weather];
    const wx = this.wx;
    for (const k of Object.keys(target)) wx[k] = damp(wx[k], target[k], 1.4, dt);

    const ang = ((this.time - 6) / 24) * Math.PI * 2;
    this.sunDir.set(Math.cos(ang), Math.sin(ang) * 0.92, 0.38 * Math.sin(ang) + 0.18).normalize();
    this.moonDir.set(-this.sunDir.x * 0.8 + 0.2, Math.max(0.28, -this.sunDir.y * 0.9), -this.sunDir.z + 0.35).normalize();
    const e = this.sunDir.y;
    const [i0, i1, t] = keyIndex(e);
    const top = this._top.copy(KEY_TOP[i0]).lerp(KEY_TOP[i1], t);
    const hor = this._hor.copy(KEY_HOR[i0]).lerp(KEY_HOR[i1], t);
    const sunC = this._sunC.copy(KEY_SUN[i0]).lerp(KEY_SUN[i1], t);
    let sunI = lerp(KEY_SUNI[i0], KEY_SUNI[i1], t);
    let amb = lerp(KEY_AMB[i0], KEY_AMB[i1], t);
    const stars = lerp(KEY_STAR[i0], KEY_STAR[i1], t);
    const moonK = smoothstep(-0.08, -0.25, e);

    // 环境自身的色调
    if (this.env === 'volcano') {
      hor.lerp(this._tmp.set('#a8401a'), 0.3 + 0.25 * moonK);
      top.lerp(this._tmp.set('#2a1410'), 0.3);
    } else if (this.env === 'city') {
      hor.lerp(this._tmp.set('#4a3a78'), 0.35 * moonK);
      top.lerp(this._tmp.set('#141033'), 0.3 * moonK);
    } else if (this.env === 'snow') {
      amb *= 1.12;
    } else if (this.env === 'desert') {
      hor.lerp(this._tmp.set('#e8c79a'), 0.25 * (1 - moonK));
    }

    // 天气让天空变灰、阳光变弱
    const lumaT = top.r * 0.3 + top.g * 0.5 + top.b * 0.2, lumaH = hor.r * 0.3 + hor.g * 0.5 + hor.b * 0.2;
    const g = wx.gray;
    const gv = (lumaT + lumaH) * 0.5;
    top.lerp(this._tmp.setRGB(gv * 0.62, gv * 0.66, gv * 0.72), g);
    hor.lerp(this._tmp.setRGB(gv * 0.95, gv * 0.98, gv * 1.03), g);
    sunI *= wx.sun;
    amb *= 1 - 0.3 * g;

    const u = this.skyMat.uniforms;
    u.uTop.value.copy(top);
    u.uHorizon.value.copy(hor);
    u.uGround.value.copy(this.groundColor).multiplyScalar(0.25 * amb + 0.02).lerp(hor, 0.35);
    u.uSunDir.value.copy(this.sunDir);
    u.uMoonDir.value.copy(this.moonDir);
    u.uSunColor.value.copy(sunC);
    u.uSunGlow.value = (1 - g * 0.9) * smoothstep(-0.12, 0.02, e);
    u.uStars.value = stars * (1 - wx.cover * 0.9);
    u.uMoon.value = moonK * (1 - g * 0.8);
    u.uCover.value = wx.cover;
    u.uTime.value = this.clock * (0.6 + wx.wind);
    u.uFlash.value = this.flash;
    const lit = u.uCloudLit.value.copy(sunC).multiplyScalar(0.5 * sunI / 3.4 / Math.max(wx.sun, 0.35)).add(this._tmp.copy(top).multiplyScalar(0.55));
    lit.addScalar(0.015 + 0.05 * moonK * (1 - g)).multiplyScalar(1 - 0.5 * g);
    u.uCloudDark.value.copy(lit).multiplyScalar(0.42 - 0.2 * g).add(this._tmp.copy(top).multiplyScalar(0.12));

    // 主光源：白天用太阳，晚上用月亮
    if (e > -0.08) {
      this.lightDir.copy(this.sunDir);
      this.sun.color.copy(sunC);
      this.sun.intensity = sunI;
    } else {
      this.lightDir.copy(this.moonDir);
      this.sun.color.set('#8fa8ff');
      this.sun.intensity = 0.9 * moonK * (0.3 + 0.7 * wx.sun);
    }
    this.hemi.color.copy(top).lerp(hor, 0.45);
    const hl = Math.max(this.hemi.color.r, this.hemi.color.g, this.hemi.color.b, 0.001);
    this.hemi.color.multiplyScalar(Math.min(1 / hl, 6)).lerp(this._tmp.set(1, 1, 1), 0.25);
    this.hemi.groundColor.copy(this.groundColor).multiplyScalar(0.6);
    this.hemi.intensity = amb * 0.55 + this.flash * 2.5;
    if (this.env === 'volcano') {
      this.hemi.groundColor.lerp(this._tmp.set('#ff4a10'), 0.5);
      this.lavaLight.intensity = 1500 * (0.4 + 0.6 * moonK);
    }

    // 雾的颜色跟着地平线走
    const fog = this.scene.fog;
    fog.color.copy(hor).lerp(top, 0.3);
    let dens = wx.fog;
    if (this.env === 'volcano') dens *= 1.5;
    if (this.env === 'city') dens *= 1.25;
    // 进了室内场景：天光基本照不进来，雾也看不到了，眼睛适应以后画面整体提亮一点
    const ik = this.indoor;
    fog.density = dens * (1 - 0.85 * ik) * (1 + 1.8 * this.fogBoost);
    fog.color.multiplyScalar(1 - 0.92 * ik);
    this.hemi.intensity *= 1 - 0.9 * ik;
    this.waterMat.uniforms.uSky.value.copy(hor).lerp(top, 0.45);
    this.waterMat.uniforms.uDeep.value.set(this.env === 'island' ? '#0b5f6e' : '#17423d').multiplyScalar(0.12 + amb * 0.75);
    this.waterMat.uniforms.uSunDir.value.copy(this.lightDir);
    this.waterMat.uniforms.uSunColor.value.copy(this.sun.color).multiplyScalar(this.sun.intensity / 3.4 * (1 - g));
    this.waterMat.uniforms.uRough.value = 0.7 + wx.wind * 0.6;

    this.lightsOn = clamp(Math.max(smoothstep(0.1, -0.06, e), g > 0.6 ? (g - 0.6) * 1.6 : 0), 0, 1);
    this.ambient = amb;
    this.nightK = moonK;
    this.renderer.toneMappingExposure = lerp(1.0, 1.5, moonK) * (1 + 0.45 * ik);
    if (this.cityMat) this.cityMat.emissiveIntensity = this.lightsOn * 2.4;
    if (this.neonMat) this.neonMat.color.setScalar(0.25 + this.lightsOn * 3.2);
    applyWetness(wx.wet);
    this.tU.uWet.value = wx.wet;

    // 天空变化到一定程度后，重新烘焙环境反射
    const key = `${top.r.toFixed(2)},${top.g.toFixed(2)},${hor.r.toFixed(2)},${hor.b.toFixed(2)},${sunI.toFixed(1)},${wx.cover.toFixed(1)},${this.sunDir.x.toFixed(1)}`;
    if (key !== this._lastKey) {
      this._lastKey = key;
      this.envDirty = true;
    }
    this.envTimer -= dt;
    if (this.envDirty && this.envTimer <= 0) {
      this.envDirty = false;
      this.envTimer = 0.35;
      const flash = u.uFlash.value;
      u.uFlash.value = 0;
      const rt = this.pmrem.fromScene(this.envScene, 0, 1, 500);
      u.uFlash.value = flash;
      if (this.envRT) this.envRT.dispose();
      this.envRT = rt;
      this.scene.environment = rt.texture;
    }
  }

  strikeLightning(camPos) {
    this.flash = 1;
    const a = Math.random() * Math.PI * 2, d = 500 + Math.random() * 700;
    const x = camPos.x + Math.cos(a) * d, z = camPos.z + Math.sin(a) * d;
    const pts = [];
    let px = x, pz = z;
    const ground = this.heightAt(clamp(x, -SIZE / 2, SIZE / 2), clamp(z, -SIZE / 2, SIZE / 2));
    for (let y = 620; y > ground; y -= 45) {
      pts.push(new THREE.Vector3(px, y, pz));
      px += (Math.random() - 0.5) * 60;
      pz += (Math.random() - 0.5) * 60;
    }
    pts.push(new THREE.Vector3(px, ground, pz));
    this.bolt.geometry.dispose();
    this.bolt.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 1.6, 4, false);
    this.bolt.visible = true;
    this.boltTimer = 0.22;
    if (this.onThunder) this.onThunder(d);
  }

  // focus：阴影要覆盖的中心点；camVel：相机速度
  update(dt, camera, focus, camVel) {
    this.clock += dt;
    if (this.autoTime) this.setTime(this.time + dt / 12);
    this.sky.position.copy(camera.position);

    if (this.wx.storm > 0.5) {
      this.nextLightning -= dt;
      if (this.nextLightning <= 0) {
        this.nextLightning = 4 + Math.random() * 9;
        this.strikeLightning(camera.position);
      }
    }
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * (2.2 + Math.random() * 4));
      this.flashLight.intensity = this.flash * 2.5;
    } else this.flashLight.intensity = 0;
    if (this.boltTimer > 0) {
      this.boltTimer -= dt;
      this.bolt.visible = this.boltTimer > 0 && Math.random() > 0.25;
    }

    this.updateSky(dt);

    // 阴影跟着关注点移动
    const ext = this.shadowExtent;
    const cam = this.sun.shadow.camera;
    if (Math.abs(cam.right - ext) > 1) {
      cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
      cam.near = 10; cam.far = 900;
      cam.updateProjectionMatrix();
    }
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.lightDir, 450);

    const t = this.clock;
    SWAY.uSwayTime.value = t;
    SWAY.uSwayWind.value = 0.25 + this.wx.wind * 0.9;
    this.waterMat.uniforms.uTime.value = t;
    this.lavaMat.uniforms.uTime.value = t;

    const wx = this.wx;
    const wind = wx.wind;
    this.rain.vel.set(wind * 5, -30, wind * 2);
    const open = 1 - this.indoor;
    this.rain.update(dt, camera.position, camVel, Math.min(1, wx.rain) * 0.5 * open, 0.03);
    this.snow.vel.set(wind * 2.5, -2.4, wind);
    this.snow.uniforms.uColor.value.setScalar(0.5 + this.ambient * 0.7);
    this.snow.update(dt, camera.position, camVel, wx.snow * 0.9 * open);
    this.embers.vel.set(0.8, 2.2, 0.4);
    this.embers.update(dt, camera.position, camVel, this.env === 'volcano' ? 0.9 : 0);
  }

  setQuality(level) {
    const size = level === 'low' ? 1024 : level === 'mid' ? 2048 : 4096;
    if (size !== this.shadowMapSize) {
      this.shadowMapSize = size;
      this.sun.shadow.mapSize.set(size, size);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
  }
}
