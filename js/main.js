// 入口：创建渲染器和各个系统，把界面操作和它们接起来
import * as THREE from 'three';
import { World } from './world.js';
import { Track } from './track.js';
import { Train, SEAT_TYPES, THEMES } from './train.js';
import { DecorManager } from './decor.js';
import { Editor } from './editor.js';
import { Ride } from './ride.js';
import { Post } from './post.js';
import { AudioEngine } from './audio.js';
import { UI } from './ui.js';
import { generateTrack, GEN_STYLES, THEME_PRESETS, autoScenes } from './generator.js';
import { SceneManager, SCENES } from './scenes.js';
import { updatePropMaterials } from './props.js';
import { findStation } from './sim.js';
import { clamp, damp, mulberry32 } from './util.js';
import { loadAssets } from './assets.js';

const SAVE_KEY = 'coaster-workshop-v1';

class App {
  constructor(renderer) {
    this.canvas = renderer.domElement;
    this.renderer = renderer;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 6000);

    this.state = {
      mode: 'quick',
      train: { theme: 'classic', seat: 'sit', cars: 6, body: '#d62828', accent: '#f5f5f5', seatColor: '#1d1f24', material: 'paint' },
      scene: { env: 'meadow', weather: 'clear', time: 10, autoTime: false, quality: 'high' },
    };
    this.undoStack = [];
    this.redoStack = [];
    this.time = 0;
    this.last = performance.now();
    this.focus = new THREE.Vector3();
    this.zeroVel = new THREE.Vector3();
    this.trainPos = new THREE.Vector3();
    this.started = false;

    this.toast = (msg) => this.ui.toast(msg);

    this.applyPixelRatio();
    this.world = new World(this.scene, this.renderer);
    this.track = new Track(this.world);
    this.scene.add(this.track.group);
    this.decor = new DecorManager(this.scene, this.world, this.track);
    this.scenes = new SceneManager(this.scene, this.world, this.track, this.decor.particles);
    this.envK = 1;
    this.post = new Post(this.renderer, this.scene, this.camera);
    this.audio = new AudioEngine();
    this.world.onThunder = (d) => this.audio.thunder(d);
    this.scenes.onRoar = (d) => this.audio.roar(d);
    this.decor.onRoar = (d) => this.audio.roar(d);
    this.decor.env.onBoom = (x, y, z) => this.audio.firework(this.camera.position.distanceTo(new THREE.Vector3(x, y, z)));
    this.ui = new UI(this);
    this.editor = new Editor(this);
    this.ride = new Ride(this);

    this.train = null;
    this.buildTrain(false);
    generateTrack(this.track, 'thrill', 20241);
    this.rebuildTrack(false);
    this.decorateDefault();
    this.frameTrack();
    this.editor.orbit.autoRotate = true;
    this.editor.orbit.autoRotateSpeed = 0.5;

    this.ui.syncAll();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ---------- 画质和尺寸 ----------
  applyPixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    const q = this.state.scene.quality;
    const pr = q === 'low' ? Math.min(dpr, 1) * 0.8 : q === 'mid' ? Math.min(dpr, 1.25) : Math.min(dpr, 1.5);
    this.renderer.setPixelRatio(pr);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.applyViewOffset();
    this.post.setSize();
  }

  // 设计界面左边有一块面板，把画面中心向右挪一点，轨道就不会被面板挡住
  applyViewOffset() {
    const w = window.innerWidth, h = window.innerHeight;
    const riding = this.ride && this.ride.active;
    if (!riding && this.started && w > 900) this.camera.setViewOffset(w, h, -165, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  setQuality(q) {
    this.state.scene.quality = q;
    this.applyPixelRatio();
    this.world.setQuality(q);
    this.post.setQuality(q);
    this.resize();
  }

  // ---------- 撤销和重做 ----------
  snapshot() {
    return JSON.stringify({ nodes: this.track.toJSON().nodes, decor: this.decor.toJSON() });
  }

  restore(json) {
    const data = JSON.parse(json);
    this.track.fromJSON({ nodes: data.nodes });
    this.decor.fromJSON(data.decor);
    this.editor.selectDecor(null);
    this.rebuildTrack(false);
    this.editor.selectNode(-1);
  }

  pushUndo() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(silent = false) {
    if (!this.undoStack.length) {
      if (!silent) this.toast('没有可以撤销的操作了。');
      return;
    }
    if (!silent) this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack.length) {
      this.toast('没有可以重做的操作了。');
      return;
    }
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
  }

  // ---------- 轨道 ----------
  rebuildTrack(fast = false) {
    this.track.rebuild(fast);
    this.editor.refreshHandles();
    if (fast) return;
    const tr = this.track;
    this.scenes.build();
    this.world.applyVegetation(tr.N ? (x, z, top) => tr.nearTrack(x, z, top) || this.scenes.covers(x, z) : null);
    this.decor.replaceAll();
    this.ui.updateStats(tr);
    this.placeTrainAtStation();
  }

  placeTrainAtStation() {
    const tr = this.track;
    if (!tr.N || !this.train) return;
    const st = findStation(tr);
    this.restS = st ? (st.ks + st.len) * tr.ds - 1.5 : 0;
    this.train.place(tr, this.restS);
  }

  minClearance() {
    let min = 1e9;
    for (const n of this.track.nodes) min = Math.min(min, n.p.y - this.world.surfaceAt(n.p.x, n.p.z));
    return min;
  }

  generate(styleId) {
    this.pushUndo();
    const st = generateTrack(this.track, styleId, Math.floor(Math.random() * 1e9));
    this.rebuildTrack(false);
    this.editor.selectNode(-1);
    this.frameTrack();
    this.ui.syncTrack();
    const a = this.track.analysis;
    this.toast(`已经生成一条${st.name}轨道，全长 ${Math.round(this.track.length)} 米，最高点 ${Math.round(a.maxHeight)} 米，最高时速 ${Math.round(a.maxSpeed * 3.6)} 公里。`);
  }

  // 一键生成主题过山车：环境、时间、天气、列车、轨道外观、布局、场景段和布景都在主题允许的范围里随机搭配
  generateThemed(id) {
    const preset = THEME_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    this.pushUndo();
    const rnd = Math.random;
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const train = pick(preset.trains), look = { ...pick(preset.tracks) };
    const env = pick(preset.envs);
    let weather = pick(preset.weathers);
    if (env === 'snow' && (weather === 'rain' || weather === 'storm')) weather = 'snow';
    const time = preset.time[0] + rnd() * (preset.time[1] - preset.time[0]);
    const hang = (SEAT_TYPES.find((t) => t.id === train.seat) || {}).hang;
    if (hang && look.style === 'wood') look.style = 'truss';
    Object.assign(this.state.train, train, { cars: 4 + Math.floor(rnd() * 4) });
    Object.assign(this.track.opts, look);
    Object.assign(this.state.scene, { env, weather, time });
    this.world.setEnvironment(env);
    this.world.setWeather(weather);
    this.world.setTime(time);
    this.buildTrain(false);
    generateTrack(this.track, pick(preset.gens), Math.floor(rnd() * 1e9));
    // 场景段：位置和长度每次都不一样，有时还会混进第二种场景
    const rng = mulberry32(Math.floor(rnd() * 1e9));
    const cover = preset.cover[0] + rnd() * (preset.cover[1] - preset.cover[0]);
    const meters = autoScenes(this.track, preset.scene, cover, rng);
    let extra = '';
    if (preset.extra && rnd() < 0.4) {
      const ex = pick(preset.extra);
      const fits = ex !== 'jungle' || env === 'island' || env === 'meadow' || env === 'volcano';
      if (fits) {
        this.track.compute();
        if (autoScenes(this.track, ex, 0.14 + rnd() * 0.16, rng, true) > 1) extra = SCENES.find((sc) => sc.id === ex).name;
      }
    }
    this.decor.clear();
    this.editor.selectDecor(null);
    this.rebuildTrack(false);
    this.decorateTheme(preset.id);
    this.editor.selectNode(-1);
    this.frameTrack();
    this.ui.syncAll();
    const name = SCENES.find((sc) => sc.id === preset.scene).name;
    this.toast(`已经生成“${preset.name}”主题过山车，全长 ${Math.round(this.track.length)} 米，其中 ${Math.round(meters)} 米是${name}场景${extra ? '，另外还有一段' + extra : ''}。再点一次会换一种布局和搭配。`);
  }

  // 给现有的轨道自动布置一种场景；sceneId 为空时清除全部场景段
  autoScene(sceneId) {
    if (!this.track.N) return;
    this.pushUndo();
    const meters = autoScenes(this.track, sceneId, 0.4);
    this.rebuildTrack(false);
    this.editor.selectNode(this.editor.selected);
    if (!sceneId) this.toast('场景段已经全部清除。');
    else if (meters < 1) this.toast('这条轨道上没有找到适合布置场景的路段。室内场景需要一段至少 60 米、没有回环、也不是提升段的轨道。');
    else this.toast(`已经在轨道上布置了 ${Math.round(meters)} 米的${SCENES.find((s) => s.id === sceneId).name}。在专业模式里可以逐个节点调整。`);
  }

  // 主题过山车周围的布景：每次摆的东西、数量、方位和大小都不一样
  decorateTheme(id) {
    const tr = this.track;
    if (!tr.N) return;
    const world = this.world;
    const rnd = Math.random;
    const box = new THREE.Box3();
    for (const n of tr.nodes) box.expandByPoint(n.p);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const R = Math.max(size.x, size.z) * 0.5;
    const base = rnd() * Math.PI * 2;
    const free = (x, z, r) => !tr.forNear(x, z, r, () => true) && !this.scenes.covers(x, z) && Math.hypot(x, z) < 400 && world.heightAt(x, z) > world.waterLevel + 0.5;
    // 在轨道外圈找一块空地放下；ang 是大致的方位，r 是需要的空地半径
    const put = (pid, ang, dist, r, scale = 1, face = true) => {
      for (let i = 0; i < 16; i++) {
        const a = base + ang + i * 0.19, d = dist + i * 7;
        const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
        if (free(x, z, r)) return this.decor.add(pid, x, z, face ? -a - Math.PI / 2 : rnd() * 6, scale);
      }
      return null;
    };
    const some = (min, max) => min + Math.floor(rnd() * (max - min + 1));
    const spread = (pid, count, dist, r, scaleMin = 1, scaleMax = 1, face = false) => {
      for (let i = 0; i < count; i++) put(pid, rnd() * Math.PI * 2, dist + rnd() * 14, r, scaleMin + rnd() * (scaleMax - scaleMin), face);
    };
    // 在海里或海边找位置（只有带水面的环境才找得到）
    const atSea = (pid, rMin, rMax, depth, scale = 1) => {
      for (let i = 0; i < 40; i++) {
        const a = rnd() * Math.PI * 2, d = rMin + rnd() * (rMax - rMin);
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        if (world.heightAt(x, z) < world.waterLevel - depth) return this.decor.add(pid, x, z, rnd() * 6, scale);
      }
      return null;
    };
    const onCoast = (pid, scale = 1) => {
      for (let i = 0; i < 30; i++) {
        const a = rnd() * Math.PI * 2;
        for (let d = 360; d > 150; d -= 6) {
          const x = Math.cos(a) * d, z = Math.sin(a) * d;
          const h = world.heightAt(x, z);
          if (h > world.waterLevel + 1.2) {
            if (h < world.waterLevel + 6 && free(x, z, 12)) return this.decor.add(pid, x, z, a, scale);
            break;
          }
        }
      }
      return null;
    };
    const mountains = (count) => {
      for (let i = 0; i < count; i++) {
        const sc = 0.9 + rnd() * 1.1;
        put('mountain', rnd() * Math.PI * 2, R + 46 * sc + 30, 46 * sc + 12, sc, false);
      }
    };
    if (id === 'mine') {
      spread('waterfall', some(0, 2), R + 34, 26, 0.9, 1.5, true);
      mountains(some(1, 3));
      spread('minecart', some(2, 6), R + 10, 5);
      spread('crystal', some(3, 8), R + 12, 4, 1.2, 2.6);
      spread('barrel', some(0, 5), R + 9, 3);
      spread('lamp', some(3, 7), R + 8, 4, 1, 1, true);
      if (rnd() < 0.4) put('windmill', rnd() * 6, R + 26, 12);
    } else if (id === 'castle') {
      if (rnd() < 0.8) put('castle_keep', rnd() * 6, R + 45, 30, 1 + rnd() * 0.5);
      spread('tower', some(1, 4), R + 22, 10, 0.8, 1.3);
      spread('castle_wall', some(0, 3), R + 30, 9, 1, 1, true);
      if (rnd() < 0.6) put('fountain', rnd() * 6, R + 18, 10);
      spread('lamp', some(4, 9), R + 9, 4, 1, 1, true);
      if (rnd() < 0.5) spread('waterfall', 1, R + 40, 26, 0.9, 1.3, true);
      if (rnd() < 0.5) mountains(some(1, 2));
      if (rnd() < 0.3) put('balloon', rnd() * 6, R + 30, 8);
    } else if (id === 'jungle') {
      spread('waterfall', some(0, 2), R + 30, 26, 1, 1.5, true);
      mountains(some(0, 2));
      spread('bronto', some(0, 2), R + 22, 14, 0.9, 1.4, true);
      spread('trex', some(0, 2), R + 16, 12, 0.9, 1.2, true);
      spread('raptor', some(0, 4), R + 9, 4, 0.9, 1.1);
      spread('tropic', some(5, 14), R + 8, 3, 1, 1.8);
      spread('fern', some(4, 12), R + 6, 2, 1, 1.6);
    } else if (id === 'space') {
      spread('searchlight', some(2, 6), R + 14, 6);
      mountains(some(0, 2));
      if (rnd() < 0.5) spread('fireworks', some(1, 3), R + 20, 8);
    } else if (id === 'neon') {
      spread('searchlight', some(3, 8), R + 14, 6);
      spread('fireworks', some(0, 3), R + 20, 8);
      if (rnd() < 0.5) put('ferris', rnd() * 6, R + 38, 26);
    } else if (id === 'ocean') {
      onCoast('lighthouse', 0.9 + rnd() * 0.4);
      const ships = some(1, 3);
      for (let i = 0; i < ships; i++) atSea('ship', 330, 520, 5, 0.9 + rnd() * 0.5);
      const pods = some(2, 5);
      for (let i = 0; i < pods; i++) atSea('dolphins', 250, 380, 2.5, 1);
      spread('tree_palm', some(4, 10), R + 10, 4, 0.9, 1.4);
      spread('tropic', some(3, 8), R + 8, 3, 1, 1.6);
      if (rnd() < 0.5) spread('waterfall', 1, R + 32, 26, 1, 1.3, true);
      spread('lamp', some(2, 6), R + 8, 4, 1, 1, true);
      if (rnd() < 0.4) put('fountain', rnd() * 6, R + 18, 10);
    }
    // 在最快的露天路段套一个光环
    const v = tr.profile.v;
    let best = -1;
    for (let k = 0; k < tr.N; k++) {
      if (tr.scene[k] || tr.U[k * 3 + 1] < 0.8) continue;
      if (best < 0 || v[k] > v[best]) best = k;
    }
    if (best >= 0 && (id === 'neon' || id === 'space') && rnd() < 0.7) {
      const it = this.decor.add('ring', tr.P[best * 3], tr.P[best * 3 + 2]);
      if (it) { it.snapY = tr.P[best * 3 + 1]; this.decor.place(it); }
    }
  }

  setShellVisible(on) {
    this.scenes.setShellVisible(on);
  }

  // 把镜头对准整条轨道
  frameTrack() {
    const nodes = this.track.nodes;
    if (!nodes.length) return;
    const box = new THREE.Box3();
    for (const n of nodes) box.expandByPoint(n.p);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const d = clamp(Math.max(size.x, size.z) * 0.95 + size.y, 90, 600);
    const orbit = this.editor.orbit;
    orbit.target.set(c.x, box.min.y + size.y * 0.3, c.z);
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
    this.editor.view = 'persp';
    this.camera.position.set(c.x + d * 0.6, box.min.y + d * 0.42, c.z + d * 0.72);
  }

  setTrackOpt(key, value) {
    const o = this.track.opts;
    if (key === 'style' && value === 'wood' && o.hang) {
      this.toast('木质轨道只能配坐在轨道上方的车厢。请先在“列车”里换一种乘坐方式。');
      this.ui.syncTrack();
      return;
    }
    o[key] = value;
    this.rebuildTrack(false);
  }

  setHeat(on) {
    this.track.showHeat = on;
    this.track.buildMeshes(false);
  }

  // ---------- 列车 ----------
  buildTrain(rebuild = true) {
    if (this.train) this.train.dispose();
    this.train = new Train(this.state.train);
    this.scene.add(this.train.group);
    const def = this.train.def;
    const o = this.track.opts;
    const wasHang = o.hang;
    o.hang = def.hang;
    o.halfWidth = def.half;
    if (!rebuild) return;
    if (def.hang && o.style === 'wood') {
      o.style = 'box';
      this.toast('挂在轨道下面的车厢不能用木质轨道，轨道样式已经改成箱梁式。');
      this.ui.syncTrack();
    }
    if (this.track.nodes.length && wasHang !== def.hang) {
      const min = this.minClearance();
      const need = def.hang ? 5.2 : 2.2;
      let dy = 0;
      if (min < need) dy = need - min;
      else if (!def.hang && min > need + 0.5) dy = -Math.min(3, min - need);
      if (dy) for (const n of this.track.nodes) n.p.y += dy;
    }
    this.rebuildTrack(false);
  }

  setTrainOpt(key, value) {
    this.state.train[key] = value;
    this.buildTrain();
  }

  applyTheme(id) {
    const t = THEMES.find((x) => x.id === id);
    if (!t) return;
    Object.assign(this.state.train, { theme: t.id, seat: t.seat, body: t.body, accent: t.accent, seatColor: t.seatColor, material: t.material });
    this.buildTrain();
    this.ui.syncTrain();
  }

  // ---------- 场景 ----------
  setEnv(id) {
    const before = this.track.nodes.length ? this.minClearance() : 3;
    this.state.scene.env = id;
    this.world.setEnvironment(id);
    if (this.track.nodes.length) {
      const need = this.track.opts.hang ? 5.2 : 2.2;
      const dy = Math.max(before, need) - this.minClearance();
      for (const n of this.track.nodes) n.p.y += dy;
    }
    this.rebuildTrack(false);
    this.editor.orbit.target.y = this.world.surfaceAt(this.editor.orbit.target.x, this.editor.orbit.target.z) + 14;
  }

  setWeather(id) {
    this.state.scene.weather = id;
    this.world.setWeather(id);
  }

  setTime(h) {
    this.state.scene.time = h;
    this.world.setTime(h);
  }

  setAutoTime(on) {
    this.state.scene.autoTime = on;
    this.world.autoTime = on;
  }

  // 第一次打开时，在轨道周围摆一些装饰
  decorateDefault() {
    const tr = this.track;
    if (!tr.N) return;
    const box = new THREE.Box3();
    for (const n of tr.nodes) box.expandByPoint(n.p);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const R = Math.max(size.x, size.z) * 0.5;
    const free = (x, z, r) => !tr.forNear(x, z, r, () => true) && Math.hypot(x, z) < 330 && this.world.heightAt(x, z) > this.world.waterLevel + 0.5;
    const tryPlace = (id, ang, dist, r, scale = 1) => {
      for (let i = 0; i < 14; i++) {
        const a = ang + i * 0.21, d = dist + i * 6;
        const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
        if (free(x, z, r)) return this.decor.add(id, x, z, -a + Math.PI / 2, scale);
      }
      return null;
    };
    tryPlace('ferris', 0.6, R + 38, 26);
    tryPlace('carousel', 2.2, R + 24, 14);
    tryPlace('fireworks', 3.6, R + 30, 8);
    tryPlace('fireworks', 4.6, R + 34, 8);
    tryPlace('balloon', 5.3, R + 46, 8);
    tryPlace('tent', 1.5, R + 18, 9);
    tryPlace('flags', 2.9, R + 16, 6);
    tryPlace('fountain', 1.1, R + 20, 10);
    for (let i = 0; i < 6; i++) tryPlace('lamp', i * 1.05 + 0.3, R + 12, 5);
    // 在速度最快的地方套两个光环
    const v = tr.profile.v;
    let best = 0;
    for (let k = 0; k < tr.N; k++) if (v[k] > v[best] && tr.U[k * 3 + 1] > 0.8) best = k;
    for (const off of [0, 18]) {
      const k = (best + Math.round(off / tr.ds)) % tr.N;
      const it = this.decor.add('ring', tr.P[k * 3], tr.P[k * 3 + 2]);
      if (it) {
        it.snapY = tr.P[k * 3 + 1];
        this.decor.place(it);
      }
    }
  }

  clearDecor() {
    if (!this.decor.items.length) return;
    this.pushUndo();
    this.decor.clear();
    this.editor.selectDecor(null);
  }

  // ---------- 保存和读取 ----------
  serialize() {
    return {
      v: 1,
      mode: this.state.mode,
      track: this.track.toJSON(),
      train: { ...this.state.train },
      scene: { ...this.state.scene },
      decor: this.decor.toJSON(),
    };
  }

  applyData(data) {
    if (!data || !data.track || !Array.isArray(data.track.nodes) || data.track.nodes.length < 4) throw new Error('文件里没有有效的轨道数据');
    Object.assign(this.state.train, data.train || {});
    Object.assign(this.state.scene, data.scene || {});
    const sc = this.state.scene;
    this.world.setEnvironment(sc.env);
    this.world.setWeather(sc.weather);
    this.world.setTime(sc.time);
    this.world.autoTime = !!sc.autoTime;
    this.track.fromJSON(data.track);
    this.buildTrain(false);
    this.decor.fromJSON(data.decor);
    this.rebuildTrack(false);
    this.setQuality(sc.quality || 'high');
    this.editor.selectNode(-1);
    this.editor.selectDecor(null);
    this.undoStack = [];
    this.redoStack = [];
    this.frameTrack();
    this.ui.syncAll();
  }

  hasSave() {
    try {
      return !!localStorage.getItem(SAVE_KEY);
    } catch {
      return false;
    }
  }

  save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.serialize()));
      this.toast('设计已经保存在这个浏览器里，下次打开可以继续。');
    } catch (err) {
      this.toast('保存失败：' + err.message);
    }
  }

  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) {
        this.toast('这个浏览器里还没有保存过设计。');
        return false;
      }
      this.applyData(JSON.parse(raw));
      this.toast('已经读取上次保存的设计。');
      return true;
    } catch (err) {
      this.toast('读取失败：' + err.message);
      return false;
    }
  }

  exportFile() {
    const blob = new Blob([JSON.stringify(this.serialize())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '过山车设计.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  importFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        this.applyData(JSON.parse(reader.result));
        this.toast('设计文件已经导入。');
      } catch (err) {
        this.toast('这个文件读不出来：' + err.message);
      }
    };
    reader.readAsText(file);
  }

  // ---------- 模式切换 ----------
  begin(loadSaved) {
    this.started = true;
    this.editor.orbit.autoRotate = false;
    this.audio.init();
    if (loadSaved) this.load();
    this.ui.showStart(false);
    this.applyViewOffset();
  }

  setMode(mode) {
    this.state.mode = mode;
    this.editor.setMode(mode);
    this.ui.syncMode();
  }

  startRide(cam = 'first') {
    const a = this.track.analysis;
    if (!this.track.N || !a) {
      this.toast('还没有轨道，请先生成或画一条。');
      return;
    }
    this.audio.init();
    this.audio.setMood('ride');
    this.editor.armDecor(null);
    this.ui.setDecorArmed(null);
    this.editor.setEnabled(false);
    this.ride.start(cam);
    this.applyViewOffset();
    this.ui.setRiding(true);
    if (a.stalledAt >= 0) this.toast('按测试结果，这条轨道列车跑不完一圈。运行时如果停在半路，可以按 B 推一把。');
  }

  stopRide() {
    if (!this.ride.active) return;
    this.ride.stop();
    this.audio.setMood('edit');
    this.applyViewOffset();
    this.editor.setEnabled(true);
    this.ui.setRiding(false);
    this.placeTrainAtStation();
    this.frameTrack();
  }

  onKey(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (e.key === 'Escape') e.target.blur();
      if (e.target.type !== 'range' && e.target.type !== 'checkbox' && e.target.type !== 'color') return;
    }
    if (!this.started) return;
    if (e.key.toLowerCase() === 'm' && !e.ctrlKey) {
      this.audio.setMuted(!this.audio.muted);
      this.ui.syncSound();
      return;
    }
    if (this.ride.active) {
      this.ride.key(e);
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      this.startRide();
      return;
    }
    if (this.editor.key(e)) e.preventDefault();
  }

  tick() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    const world = this.world;
    let camVel = this.zeroVel, trainPos = null;
    if (this.ride.active) {
      const c = this.ride.update(dt);
      this.focus.copy(c);
      this.trainPos.copy(c);
      trainPos = this.trainPos;
      camVel = this.ride.camVel;
      world.shadowExtent = this.ride.cam === 'first' ? 120 : 160;
    } else {
      this.editor.update();
      this.focus.copy(this.editor.orbit.target);
      const d = this.camera.position.distanceTo(this.focus) / (this.editor.view === 'persp' ? 1 : 2.64);
      world.shadowExtent = clamp(d * 0.9, 90, 460);
      this.post.setEffects({});
      if (this.train && this.track.N) this.train.update(dt, this.time, this.track, this.restS || 0, 0, world.lightsOn);
    }
    // 镜头进了室内场景，天光和环境反射要跟着变暗
    const riding = this.ride.active;
    world.indoor = damp(world.indoor, riding ? this.ride.indoorK : 0, 5, dt);
    world.fogBoost = damp(world.fogBoost, riding ? this.ride.fogK : 0, 2, dt);
    const envK = 1 - 0.93 * world.indoor;
    if (Math.abs(envK - this.envK) > 0.01) {
      this.envK = envK;
      for (const m of Object.values(this.train.mats)) if (m.envMapIntensity !== undefined) m.envMapIntensity = envK;
      for (const m of this.track.mats) if (m.envMapIntensity !== undefined) m.envMapIntensity = envK;
    }
    world.update(dt, this.camera, this.focus, camVel);
    this.scenes.update(dt, this.camera.position, trainPos, world.lightsOn, world.ambient);
    updatePropMaterials(world.lightsOn, world.ambient, this.time);
    this.track.update(world.lightsOn, this.time);
    this.decor.update(dt, world.lightsOn, world.ambient, world.wx.wind, trainPos);
    this.audio.setAmbience(world.wx.rain, world.wx.wind);
    if (world.autoTime) this.ui.syncTime(world.time);
    this.post.render();
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  const bar = document.getElementById('load-bar'), text = document.getElementById('load-text');
  try {
    const canvas = document.getElementById('view');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    await loadAssets(renderer, (p) => {
      bar.style.width = Math.round(p * 100) + '%';
      text.textContent = `正在加载贴图和模型 ${Math.round(p * 100)}%`;
    });
    text.textContent = '正在搭建场景';
    await new Promise((r) => setTimeout(r, 30));
    window.app = new App(renderer);
    document.getElementById('loading').hidden = true;
    document.getElementById('start-actions').hidden = false;
  } catch (err) {
    console.error(err);
    const el = document.getElementById('fatal');
    el.hidden = false;
    el.textContent = '游戏没有启动成功：' + err.message + '。请用新版的 Chrome 或 Edge 打开，并确认显卡驱动支持 WebGL 2。';
  }
});

export { GEN_STYLES, SEAT_TYPES };
