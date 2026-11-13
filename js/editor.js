// 编辑器：镜头控制、专业模式的节点编辑、快速模式的手绘路线、装饰道具的摆放
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { KINDS } from './track.js';
import { insertElement, trackFromPlan } from './generator.js';
import { clamp, wrapDeg } from './util.js';

const ORTHO_SCALE = 2.64; // 窄视角镜头要拉远这么多倍，画面里的物体才和普通视角一样大

export class Editor {
  constructor(app) {
    this.app = app;
    this.enabled = true;
    this.mode = 'quick';
    this.tool = 'select';
    this.selected = -1;
    this.decorSel = null;
    this.decorId = null;
    this.snap = false;
    this.view = 'persp';
    this.fastPending = false;
    const { camera, canvas, scene } = app;

    camera.position.set(190, 120, 210);
    this.orbit = new OrbitControls(camera, canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.09;
    this.orbit.maxPolarAngle = Math.PI / 2 - 0.02;
    this.orbit.minDistance = 4;
    this.orbit.maxDistance = 1400;
    this.orbit.target.set(0, 14, 0);

    this.proxy = new THREE.Object3D();
    scene.add(this.proxy);
    this.tc = new TransformControls(camera, canvas);
    this.tc.setSize(0.85);
    this.tc.visible = false;
    this.tc.enabled = false;
    scene.add(this.tc);
    this.tc.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      if (e.value) app.pushUndo();
      else app.rebuildTrack(false);
    });
    this.tc.addEventListener('objectChange', () => {
      const node = app.track.nodes[this.selected];
      if (!node) return;
      node.p.copy(this.proxy.position);
      this.fastPending = true;
      app.ui.showNode(node, this.selected, app.track.nodes.length);
    });

    // 节点手柄
    this.handles = new THREE.Group();
    this.handles.visible = false;
    scene.add(this.handles);
    this.handleGeo = new THREE.SphereGeometry(1, 14, 10);
    this.handleMats = {};
    for (const k of KINDS) {
      this.handleMats[k.id] = new THREE.MeshBasicMaterial({ color: k.color, depthTest: false, transparent: true, opacity: 0.95 });
    }
    this.selMat = new THREE.MeshBasicMaterial({ color: '#ff8a00', depthTest: false, transparent: true });
    this.polyLine = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.3, depthTest: false }));
    this.polyLine.renderOrder = 19;
    this.polyLine.frustumCulled = false;
    this.handles.add(this.polyLine);

    // 手绘路线用的线和起点标记
    this.strokeMax = 6000;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.strokeMax * 3), 3));
    sg.setDrawRange(0, 0);
    this.strokeLine = new THREE.Line(sg, new THREE.LineBasicMaterial({ color: '#ffd23f', depthTest: false }));
    this.strokeLine.renderOrder = 30;
    this.strokeLine.frustumCulled = false;
    this.strokeLine.visible = false;
    scene.add(this.strokeLine);
    this.startMark = new THREE.Mesh(new THREE.RingGeometry(5, 7, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#4ade80', depthTest: false, transparent: true, opacity: 0.9 }));
    this.startMark.renderOrder = 30;
    this.startMark.visible = false;
    scene.add(this.startMark);
    this.stroke = [];
    this.drawing = false;

    this.selBox = new THREE.BoxHelper(new THREE.Object3D(), '#ffd23f');
    this.selBox.visible = false;
    scene.add(this.selBox);

    this.ray = new THREE.Raycaster();
    this.box3 = new THREE.Box3();
    this.ndc = new THREE.Vector2();
    this.down = null;
    this.dragDecor = null;
    this.bind();
  }

  bind() {
    const el = this.app.canvas;
    el.addEventListener('pointerdown', (e) => this.onDown(e), true);
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('dblclick', (e) => this.onDouble(e));
  }

  setRay(e) {
    const r = this.app.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.app.camera);
  }

  groundPoint(e) {
    this.setRay(e);
    const world = this.app.world;
    const hit = this.ray.intersectObject(world.terrain, false)[0];
    if (!hit) return null;
    const p = hit.point;
    if (p.y < world.waterLevel) {
      const o = this.ray.ray.origin, d = this.ray.ray.direction;
      const t = (world.waterLevel - o.y) / d.y;
      if (t > 0) p.copy(o).addScaledVector(d, t);
    }
    return p;
  }

  planePoint(e, y) {
    this.setRay(e);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    if (Math.abs(d.y) < 1e-5) return null;
    const t = (y - o.y) / d.y;
    return t > 0 ? new THREE.Vector3().copy(o).addScaledVector(d, t) : null;
  }

  onDown(e) {
    if (!this.enabled || e.button !== 0) return;
    this.down = { x: e.clientX, y: e.clientY, gizmo: this.tc.visible && this.tc.axis !== null };
    if (this.tool === 'draw') {
      this.drawing = true;
      this.stroke = [];
      this.strokeLine.geometry.setDrawRange(0, 0);
      this.addStrokePoint(e);
      return;
    }
    if (this.tool === 'select' && this.decorSel && !this.down.gizmo) {
      // 只要点在选中物体的黄色框里面，就可以拖动它
      this.setRay(e);
      this.box3.setFromObject(this.decorSel.obj);
      if (this.ray.ray.intersectsBox(this.box3)) {
        this.dragDecor = this.decorSel;
        this.orbit.enabled = false;
        this.app.pushUndo();
      }
    }
  }

  onMove(e) {
    if (!this.enabled) return;
    if (this.drawing) {
      this.addStrokePoint(e);
      return;
    }
    if (this.dragDecor) {
      const p = this.groundPoint(e);
      if (p) {
        const it = this.dragDecor;
        it.x = p.x;
        it.z = p.z;
        it.snapY = undefined;
        this.app.decor.place(it);
        this.selBox.setFromObject(it.obj);
      }
    }
  }

  onUp(e) {
    if (!this.enabled) return;
    if (this.drawing) {
      this.drawing = false;
      this.finishDraw();
      this.down = null;
      return;
    }
    if (this.dragDecor) {
      this.dragDecor = null;
      this.orbit.enabled = true;
      this.down = null;
      return;
    }
    const d = this.down;
    this.down = null;
    if (!d || d.gizmo) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    this.onClick(e);
  }

  onClick(e) {
    const { decor, track } = this.app;
    if (this.tool === 'decor' && this.decorId) {
      const p = this.groundPoint(e);
      if (!p) return;
      this.app.pushUndo();
      const item = decor.add(this.decorId, p.x, p.z, Math.random() * Math.PI * 2, 1);
      if (item && item.def.snap && item.snapY === undefined) this.app.toast('附近没有轨道，这个道具需要放在轨道旁边才会套上去。');
      this.selectDecor(item);
      this.app.audio.ui();
      return;
    }
    this.setRay(e);
    if (this.mode === 'pro' && track.nodes.length) {
      const hits = this.ray.intersectObjects(this.handles.children.filter((c) => c.isMesh), false);
      if (hits.length) {
        this.selectNode(hits[0].object.userData.index);
        return;
      }
    }
    const item = decor.pick(this.ray);
    if (item) {
      this.selectNode(-1);
      this.selectDecor(item);
      return;
    }
    this.selectDecor(null);
    this.selectNode(-1);
  }

  onDouble(e) {
    if (!this.enabled || this.mode !== 'pro' || this.tool !== 'select') return;
    const track = this.app.track;
    if (!track.N) return;
    this.setRay(e);
    const hit = this.ray.intersectObjects(track.group.children, true)[0];
    if (!hit) return;
    const k = track.nearestSample(hit.point, 8);
    if (k < 0) return;
    const s = k * track.ds;
    let seg = 0;
    for (let i = 0; i < track.nodes.length; i++) if (track.nodeS[i] <= s) seg = i;
    this.app.pushUndo();
    const src = track.nodes[seg];
    track.nodes.splice(seg + 1, 0, { p: new THREE.Vector3().fromArray(track.P, k * 3), roll: src.roll, kind: src.kind, auto: src.auto, scene: src.scene || '' });
    this.app.rebuildTrack(false);
    this.selectNode(seg + 1);
  }

  // ---------- 模式和工具 ----------
  setMode(mode) {
    this.mode = mode;
    if (this.tool === 'draw') this.cancelDraw();
    this.handles.visible = mode === 'pro' && this.enabled;
    if (mode !== 'pro') this.selectNode(-1);
    if (mode !== 'pro' && this.view !== 'persp') this.setView('persp');
    this.refreshHandles();
  }

  setEnabled(on) {
    this.enabled = on;
    this.orbit.enabled = on;
    this.handles.visible = on && this.mode === 'pro';
    if (!on) {
      this.tc.detach();
      this.tc.visible = false;
      this.tc.enabled = false;
      this.selBox.visible = false;
      if (this.tool === 'draw') this.cancelDraw();
    } else {
      this.selectNode(this.selected);
      if (this.decorSel) this.selBox.visible = true;
    }
  }

  armDecor(id) {
    if (this.tool === 'draw') this.cancelDraw();
    this.decorId = id;
    this.tool = id ? 'decor' : 'select';
    this.app.canvas.style.cursor = id ? 'crosshair' : '';
  }

  // ---------- 节点 ----------
  refreshHandles() {
    const nodes = this.app.track.nodes;
    const meshes = this.handles.children.filter((c) => c.isMesh);
    while (meshes.length > nodes.length) {
      const m = meshes.pop();
      this.handles.remove(m);
    }
    while (meshes.length < nodes.length) {
      const m = new THREE.Mesh(this.handleGeo, this.handleMats.normal);
      m.renderOrder = 20;
      this.handles.add(m);
      meshes.push(m);
    }
    const pos = new Float32Array(nodes.length * 3);
    nodes.forEach((n, i) => {
      const m = meshes[i];
      m.position.copy(n.p);
      m.userData.index = i;
      m.material = i === this.selected ? this.selMat : this.handleMats[n.kind] || this.handleMats.normal;
      n.p.toArray(pos, i * 3);
    });
    this.polyLine.geometry.dispose();
    this.polyLine.geometry = new THREE.BufferGeometry();
    this.polyLine.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.handleMeshes = meshes;
    if (this.selected >= nodes.length) this.selectNode(-1);
    else if (this.selected >= 0) this.proxy.position.copy(nodes[this.selected].p);
  }

  selectNode(i) {
    const nodes = this.app.track.nodes;
    if (i >= nodes.length) i = -1;
    this.selected = i;
    if (i >= 0 && this.mode === 'pro' && this.enabled) {
      this.selectDecor(null);
      this.proxy.position.copy(nodes[i].p);
      this.tc.attach(this.proxy);
      this.tc.visible = true;
      this.tc.enabled = true;
      this.tc.setTranslationSnap(this.snap ? 1 : null);
      this.app.ui.showNode(nodes[i], i, nodes.length);
    } else {
      this.tc.detach();
      this.tc.visible = false;
      this.tc.enabled = false;
      this.app.ui.showNode(null, -1, nodes.length);
    }
    if (this.handleMeshes) {
      this.handleMeshes.forEach((m, j) => {
        const n = nodes[j];
        if (n) m.material = j === this.selected ? this.selMat : this.handleMats[n.kind] || this.handleMats.normal;
      });
    }
  }

  setSnap(on) {
    this.snap = on;
    this.tc.setTranslationSnap(on ? 1 : null);
  }

  setNodeProp(prop, value) {
    const node = this.app.track.nodes[this.selected];
    if (!node) return;
    this.app.pushUndo();
    if (prop === 'x' || prop === 'y' || prop === 'z') node.p[prop] = value;
    else if (prop === 'roll') node.roll = wrapDeg(value);
    else if (prop === 'kind') node.kind = value;
    else if (prop === 'auto') node.auto = value;
    else if (prop === 'scene') node.scene = value;
    this.app.rebuildTrack(false);
    this.selectNode(this.selected);
  }

  insertNode() {
    const track = this.app.track;
    const i = this.selected;
    const n = track.nodes.length;
    if (i < 0 || !track.N) return;
    const s0 = track.nodeS[i];
    let s1 = i + 1 < n ? track.nodeS[i + 1] : track.length;
    if (s1 < s0) s1 += track.length;
    const k = Math.round(((s0 + s1) / 2) / track.ds) % track.N;
    this.app.pushUndo();
    const a = track.nodes[i], b = track.nodes[(i + 1) % n];
    track.nodes.splice(i + 1, 0, {
      p: new THREE.Vector3().fromArray(track.P, k * 3),
      roll: a.roll + wrapDeg(b.roll - a.roll) / 2, kind: a.kind, auto: a.auto, scene: a.scene || '',
    });
    this.app.rebuildTrack(false);
    this.selectNode(i + 1);
  }

  deleteNode() {
    const track = this.app.track;
    if (this.selected < 0) return;
    if (track.nodes.length <= 4) {
      this.app.toast('轨道至少需要保留 4 个节点。');
      return;
    }
    this.app.pushUndo();
    track.nodes.splice(this.selected, 1);
    const next = Math.min(this.selected, track.nodes.length - 1);
    this.app.rebuildTrack(false);
    this.selectNode(next);
  }

  stepNode(dir) {
    const n = this.app.track.nodes.length;
    if (!n) return;
    this.selectNode(((this.selected < 0 ? 0 : this.selected + dir) + n) % n);
  }

  addElement(type) {
    const track = this.app.track;
    if (this.selected < 0) {
      this.app.toast('请先选中一个节点，元素会插在它和下一个节点之间。');
      return;
    }
    this.app.pushUndo();
    const res = insertElement(track, this.selected, type);
    if (!res) {
      this.app.toast('这两个节点离得太近，放不下这个元素。');
      return;
    }
    this.app.rebuildTrack(false);
    this.selectNode(res.to);
  }

  shiftAll(dy) {
    const track = this.app.track;
    this.app.pushUndo();
    for (const n of track.nodes) n.p.y += dy;
    this.app.rebuildTrack(false);
    this.selectNode(this.selected);
  }

  focusSelection() {
    const node = this.app.track.nodes[this.selected];
    const target = node ? node.p : this.decorSel ? this.decorSel.obj.position : null;
    if (!target) return;
    const cam = this.app.camera;
    const offset = cam.position.clone().sub(this.orbit.target);
    offset.setLength(clamp(offset.length(), 20, 70) * (this.view === 'persp' ? 1 : ORTHO_SCALE));
    this.orbit.target.copy(target);
    cam.position.copy(target).add(offset);
  }

  // 透视图、顶视图、前视图、侧视图
  setView(name) {
    const cam = this.app.camera;
    const t = this.orbit.target;
    let d = cam.position.distanceTo(t);
    if (this.view !== 'persp') d /= ORTHO_SCALE;
    d = clamp(d, 30, 520);
    this.view = name;
    if (name === 'persp') {
      cam.fov = 50;
      cam.position.set(t.x + d * 0.55, t.y + d * 0.42, t.z + d * 0.72);
    } else {
      cam.fov = 20;
      const D = d * ORTHO_SCALE;
      if (name === 'top') cam.position.set(t.x, t.y + D, t.z + 0.01);
      else if (name === 'front') cam.position.set(t.x, t.y + D * 0.02, t.z + D);
      else cam.position.set(t.x + D, t.y + D * 0.02, t.z);
    }
    cam.updateProjectionMatrix();
    this.orbit.update();
    this.app.ui.setViewButton(name);
  }

  // ---------- 装饰道具 ----------
  selectDecor(item) {
    this.decorSel = item;
    if (item) {
      this.selBox.setFromObject(item.obj);
      this.selBox.visible = true;
    } else this.selBox.visible = false;
    this.app.ui.showDecor(item);
  }

  rotateDecor(delta) {
    const it = this.decorSel;
    if (!it) return;
    it.rot += delta;
    this.app.decor.place(it);
    this.selBox.setFromObject(it.obj);
  }

  scaleDecor(f) {
    const it = this.decorSel;
    if (!it) return;
    it.scale = clamp(it.scale * f, 0.3, 5);
    this.app.decor.place(it);
    this.selBox.setFromObject(it.obj);
    this.app.ui.showDecor(it);
  }

  deleteDecor() {
    if (!this.decorSel) return;
    this.app.pushUndo();
    this.app.decor.remove(this.decorSel);
    this.selectDecor(null);
  }

  // ---------- 手绘路线 ----------
  startDraw() {
    const cam = this.app.camera;
    this.armDecor(null);
    this.selectNode(-1);
    this.tool = 'draw';
    this.saved = { pos: cam.position.clone(), target: this.orbit.target.clone(), fov: cam.fov, view: this.view };
    this.orbit.enabled = false;
    this.drawY = this.app.world.surfaceAt(0, 0) + 1;
    cam.fov = 50;
    cam.position.set(0, this.drawY + 560, 0.5);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, this.drawY, 0);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    this.strokeLine.visible = true;
    this.strokeLine.geometry.setDrawRange(0, 0);
    this.stroke = [];
    this.app.canvas.style.cursor = 'crosshair';
    this.app.ui.setDrawing(true);
  }

  addStrokePoint(e) {
    const p = this.planePoint(e, this.drawY);
    if (!p) return;
    p.x = clamp(p.x, -420, 420);
    p.z = clamp(p.z, -420, 420);
    const last = this.stroke[this.stroke.length - 1];
    if (last && Math.hypot(p.x - last.x, p.z - last.z) < 2) return;
    if (this.stroke.length >= this.strokeMax) return;
    this.stroke.push({ x: p.x, z: p.z });
    const attr = this.strokeLine.geometry.attributes.position;
    attr.setXYZ(this.stroke.length - 1, p.x, this.drawY, p.z);
    attr.needsUpdate = true;
    this.strokeLine.geometry.setDrawRange(0, this.stroke.length);
    if (this.stroke.length === 1) {
      this.startMark.position.set(p.x, this.drawY, p.z);
      this.startMark.visible = true;
    }
  }

  finishDraw() {
    const app = this.app;
    if (this.stroke.length < 10) {
      this.strokeLine.geometry.setDrawRange(0, 0);
      this.startMark.visible = false;
      return;
    }
    app.pushUndo();
    const res = trackFromPlan(app.track, this.stroke);
    if (!res.ok) {
      app.undo(true);
      app.toast(res.reason);
      this.strokeLine.geometry.setDrawRange(0, 0);
      this.startMark.visible = false;
      return;
    }
    this.endDraw();
    app.rebuildTrack(false);
    app.frameTrack();
    const a = app.track.analysis;
    app.toast(`轨道已经生成，全长 ${Math.round(app.track.length)} 米，最高点 ${Math.round(a.maxHeight)} 米。`);
  }

  endDraw() {
    const cam = this.app.camera;
    this.tool = 'select';
    this.drawing = false;
    this.strokeLine.visible = false;
    this.startMark.visible = false;
    this.orbit.enabled = this.enabled;
    if (this.saved) {
      cam.position.copy(this.saved.pos);
      this.orbit.target.copy(this.saved.target);
      cam.fov = this.saved.fov;
      cam.updateProjectionMatrix();
      this.saved = null;
    }
    this.app.canvas.style.cursor = '';
    this.app.ui.setDrawing(false);
  }

  cancelDraw() {
    this.endDraw();
  }

  key(e) {
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && k === 'z') { e.shiftKey ? this.app.redo() : this.app.undo(); return true; }
    if (ctrl && k === 'y') { this.app.redo(); return true; }
    if (ctrl && k === 's') { this.app.save(); return true; }
    if (k === 'escape') {
      if (this.tool === 'draw') this.cancelDraw();
      else if (this.decorId) { this.armDecor(null); this.app.ui.setDecorArmed(null); }
      else { this.selectNode(-1); this.selectDecor(null); }
      return true;
    }
    if (this.decorSel) {
      if (k === 'delete' || k === 'backspace') { this.deleteDecor(); return true; }
      if (k === 'r') { this.rotateDecor(e.shiftKey ? -Math.PI / 12 : Math.PI / 12); return true; }
      if (k === '=' || k === '+') { this.scaleDecor(1.1); return true; }
      if (k === '-') { this.scaleDecor(1 / 1.1); return true; }
    }
    if (k === 'f') { this.focusSelection(); return true; }
    if (this.mode !== 'pro') return false;
    if (e.code === 'Numpad7') { this.setView('top'); return true; }
    if (e.code === 'Numpad1') { this.setView('front'); return true; }
    if (e.code === 'Numpad3') { this.setView('side'); return true; }
    if (e.code === 'Numpad5') { this.setView('persp'); return true; }
    if (k === 'tab') { this.stepNode(e.shiftKey ? -1 : 1); return true; }
    if (this.selected < 0) return false;
    const node = this.app.track.nodes[this.selected];
    if (k === 'delete' || k === 'backspace') { this.deleteNode(); return true; }
    if (k === 'i') { this.insertNode(); return true; }
    if (k === 'q') { this.setNodeProp('roll', node.roll - 5); return true; }
    if (k === 'e') { this.setNodeProp('roll', node.roll + 5); return true; }
    if (k === 'pageup') { this.setNodeProp('y', node.p.y + 1); return true; }
    if (k === 'pagedown') { this.setNodeProp('y', node.p.y - 1); return true; }
    return false;
  }

  update() {
    if (!this.enabled) return;
    if (this.tool !== 'draw') this.orbit.update();
    if (this.fastPending) {
      this.fastPending = false;
      this.app.rebuildTrack(true);
    }
    const cam = this.app.camera;
    if (this.handles.visible && this.handleMeshes) {
      const k = this.view === 'persp' ? 0.006 : 0.006 / ORTHO_SCALE;
      for (let i = 0; i < this.handleMeshes.length; i++) {
        const m = this.handleMeshes[i];
        const s = clamp(cam.position.distanceTo(m.position) * k, 0.2, 5) * (i === this.selected ? 1.7 : 1);
        m.scale.setScalar(s);
      }
    }
    if (this.decorSel && this.decorSel.obj.userData.tick) this.selBox.setFromObject(this.decorSel.obj);
  }
}
