// 运行模式：列车模拟、四种镜头、速度感效果、录制和截图
import * as THREE from 'three';
import { TrainSim, KIND } from './sim.js';
import { Precip } from './world.js';
import { clamp, damp, smoothstep, mulberry32 } from './util.js';

export const CAMERAS = [
  { id: 'first', name: '第一人称', key: '1' },
  { id: 'follow', name: '跟随', key: '2' },
  { id: 'orbit', name: '环绕', key: '3' },
  { id: 'side', name: '路边机位', key: '4' },
];

const F = { p: new THREE.Vector3(), t: new THREE.Vector3(), u: new THREE.Vector3(), r: new THREE.Vector3() };
const F2 = { p: new THREE.Vector3(), t: new THREE.Vector3(), u: new THREE.Vector3(), r: new THREE.Vector3() };
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(), _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

const wobble = (t, s) => Math.sin(t * 37 + s) * 0.5 + Math.sin(t * 61.7 + s * 2.3) * 0.3 + Math.sin(t * 97.3 + s * 3.1) * 0.2;

export class Ride {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.cam = 'first';
    this.sim = null;
    this.paused = false;
    this.slow = false;
    this.time = 0;
    this.dust = new Precip({ count: 1600, box: [46, 28, 46], lines: true });
    this.dust.uniforms.uColor.value.set(0.9, 0.93, 1);
    app.scene.add(this.dust.object);
    this.camVel = new THREE.Vector3();
    this.prevCam = new THREE.Vector3();
    this.skipVel = true;
    this.look = { yaw: 0, pitch: 0, idle: 9 };
    this.follow = { az: 0, el: 0.3, dist: 16 };
    this.off = new THREE.Vector3();
    this.lean = 0;
    this.pitchG = 0;
    this.yawA = 0;
    this.pitchA = 0;
    this.heading = new THREE.Vector3(1, 0, 0);
    this.camPos = new THREE.Vector3();
    this.lookTarget = new THREE.Vector3();
    this.sideCams = [];
    this.sideIndex = -1;
    this.sideHold = 0;
    this.hudTimer = 0;
    this.recorder = null;
    this.recTime = 0;
    this.drag = null;
    this.screamCd = 0;
    this.indoorK = 0; // 镜头是不是在室内场景里
    this.fogK = 0;
    this.bindPointer();
  }

  bindPointer() {
    const el = this.app.canvas;
    el.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      this.drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.active || !this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      if (this.cam === 'first') {
        this.look.yaw = clamp(this.look.yaw + dx * 0.004, -2.4, 2.4);
        this.look.pitch = clamp(this.look.pitch - dy * 0.004, -1.2, 1.2);
        this.look.idle = 0;
      } else {
        this.follow.az -= dx * 0.006;
        this.follow.el = clamp(this.follow.el + dy * 0.005, -0.3, 1.4);
      }
    });
    const end = () => (this.drag = null);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      if (!this.active) return;
      this.follow.dist = clamp(this.follow.dist * (e.deltaY > 0 ? 1.1 : 0.9), 6, 80);
    }, { passive: true });
  }

  start(cam = 'first') {
    const { track, train } = this.app;
    this.sim = new TrainSim(track, train.cars.length, train.pitch);
    this.sim.onEvent = (name) => this.onSimEvent(name);
    this.active = true;
    this.paused = false;
    this.slow = false;
    this.time = 0;
    this.look.yaw = this.look.pitch = 0;
    this.follow.az = 0; this.follow.el = 0.3; this.follow.dist = 16;
    this.off.set(0, 0, 0);
    this.lean = this.pitchG = this.yawA = this.pitchA = 0;
    this.screamCd = 1;
    this.buildSideCams();
    this.setCamera(cam);
    this.app.ui.showStalled(false);
  }

  stop() {
    if (this.recorder) this.stopRecording();
    this.active = false;
    this.dust.object.visible = false;
    this.app.post.setEffects({});
    this.app.audio.setRide(0, { active: false });
    const cam = this.app.camera;
    cam.up.set(0, 1, 0);
    cam.near = 0.5;
    cam.fov = 50;
    cam.updateProjectionMatrix();
  }

  setCamera(id) {
    this.cam = id;
    this.skipVel = true;
    this.snap = true;
    this.sideIndex = -1;
    const cam = this.app.camera;
    cam.near = id === 'first' ? 0.08 : 0.5;
    cam.up.set(0, 1, 0);
    this.app.ui.setCameraButton(id);
  }

  cycleCamera() {
    const i = CAMERAS.findIndex((c) => c.id === this.cam);
    this.setCamera(CAMERAS[(i + 1) % CAMERAS.length].id);
  }

  onSimEvent(name) {
    const { ui, toast } = this.app;
    if (name === 'arrive') {
      const s = this.sim;
      toast(`第 ${s.lap} 圈跑完了，用时 ${s.lastLapTime.toFixed(1)} 秒，最高时速 ${Math.round(s.topSpeed * 3.6)} 公里。`);
      s.topSpeed = 0;
    } else if (name === 'stalled') {
      ui.showStalled(true);
    }
  }

  buildSideCams() {
    const { track, world } = this.app;
    const rng = mulberry32(7);
    this.sideCams = [];
    if (!track.N) return;
    for (let s = 20; s < track.length; s += 55) {
      track.frame(s, F);
      _v.set(-F.t.z, 0, F.t.x);
      if (_v.lengthSq() < 0.01) continue;
      _v.normalize();
      const side = rng() < 0.5 ? -1 : 1;
      if (this.app.scenes.indoorAt(s) > 0.5) {
        // 室内场景里的机位贴着内壁放在隧道里面
        const pos = F.p.clone().addScaledVector(_v, side * 3.1);
        pos.y += track.opts.hang ? -2.7 : 0.5;
        this.sideCams.push(pos);
        continue;
      }
      const dist = 13 + rng() * 16;
      const pos = F.p.clone().addScaledVector(_v, side * dist);
      pos.y = Math.max(world.surfaceAt(pos.x, pos.z) + 1.7, F.p.y - 7 + rng() * 9);
      this.sideCams.push(pos);
    }
  }

  key(e) {
    const k = e.key.toLowerCase();
    const cam = CAMERAS.find((c) => c.key === k);
    if (cam) this.setCamera(cam.id);
    else if (k === 'c') this.cycleCamera();
    else if (k === ' ') { this.paused = !this.paused; this.app.ui.setPaused(this.paused); }
    else if (k === 'r') this.toggleRecording();
    else if (k === 'p') this.screenshot();
    else if (k === 't') { this.slow = !this.slow; this.app.ui.setSlow(this.slow); }
    else if (k === 'h') this.app.ui.toggleHud();
    else if (k === 'enter') this.sim.dispatch();
    else if (k === 'b') { this.sim.push(); this.app.ui.showStalled(false); }
    else if (k === 'escape') this.app.stopRide();
    else return false;
    e.preventDefault();
    return true;
  }

  update(dt) {
    const { track, train, world, camera, post, audio, decor } = this.app;
    const sim = this.sim;
    const sdt = this.paused ? 0 : dt * (this.slow ? 0.25 : 1);
    this.time += sdt;
    if (sdt > 0) sim.step(sdt);
    train.place(track, sim.s);
    train.update(sdt, this.time, track, sim.s, sim.v, world.lightsOn);
    train.group.updateMatrixWorld(true);
    track.frame(sim.s, F);
    const v = Math.abs(sim.v);
    const hangSign = track.opts.hang ? -1 : 1;
    const center = _v2.copy(F.p);
    track.frame(sim.s - train.length * 0.35, F2);
    center.copy(F2.p).addScaledVector(F2.u, 0.9 * hangSign);
    track.frame(sim.s, F);

    let targetFov = 55, blurK = 0;
    const speedK = smoothstep(12, 46, v);
    if (this.cam === 'first') {
      const eye = train.eye;
      _m.copy(eye.matrixWorld);
      _q.setFromRotationMatrix(_m);
      const pos = _v.setFromMatrixPosition(_m);
      // G 力让身体和视线产生滞后
      this.off.x = damp(this.off.x, clamp(-sim.gl * 0.05, -0.15, 0.15), 6, dt);
      this.off.y = damp(this.off.y, clamp(-(sim.gv - 1) * 0.03, -0.12, 0.1), 6, dt);
      this.off.z = damp(this.off.z, clamp(sim.gf * 0.05, -0.12, 0.15), 6, dt);
      this.lean = damp(this.lean, clamp(sim.gl * 0.035, -0.12, 0.12), 5, dt);
      this.pitchG = damp(this.pitchG, clamp(sim.gf * 0.03, -0.06, 0.08), 5, dt);
      // 视线提前看向轨道前方
      const la = clamp(v * 0.5, 4, 24);
      track.frame(sim.s + la, F2);
      const ahead = F2.p.addScaledVector(F2.u, train.info.eye[1]).sub(pos);
      const lx = ahead.dot(F.r), ly = ahead.dot(F.u), lf = Math.max(ahead.dot(F.t), 0.5);
      this.yawA = damp(this.yawA, clamp(Math.atan2(lx, lf) * 0.5, -0.5, 0.5), 5, dt);
      this.pitchA = damp(this.pitchA, clamp(Math.atan2(ly, lf) * 0.35, -0.3, 0.3), 5, dt);
      this.look.idle += dt;
      if (this.look.idle > 2 && !this.drag) {
        this.look.yaw = damp(this.look.yaw, 0, 2.5, dt);
        this.look.pitch = damp(this.look.pitch, 0, 2.5, dt);
      }
      const rough = track.opts.style === 'wood' ? 1.9 : 1;
      const A = Math.min(1.6, (v / 35) * (v / 35)) * rough + (sim.kind === KIND.lift ? 0.12 : 0);
      const t = this.time;
      const basePitch = train.def.id === 'fly' ? -0.1 : 0;
      _e.set(
        basePitch + this.pitchA + this.pitchG + this.look.pitch + wobble(t, 1) * 0.004 * A,
        -(this.yawA + this.look.yaw) + wobble(t, 5) * 0.003 * A,
        this.lean + wobble(t, 9) * 0.004 * A,
        'YXZ',
      );
      _q2.setFromEuler(_e);
      camera.quaternion.copy(_q).multiply(_q2);
      camera.position.copy(pos);
      _v.set(this.off.x + wobble(t, 13) * 0.012 * A, this.off.y + wobble(t, 17) * 0.014 * A, this.off.z).applyQuaternion(_q);
      camera.position.add(_v);
      targetFov = 74 + 20 * speedK + (sim.kind === KIND.launch ? 5 : 0);
      blurK = 0.8;
    } else if (this.cam === 'follow' || this.cam === 'orbit') {
      _v.set(F.t.x, 0, F.t.z);
      if (_v.lengthSq() > 0.09) {
        _v.normalize();
        this.heading.lerp(_v, 1 - Math.exp(-3 * dt)).normalize();
      }
      if (this.cam === 'orbit') this.follow.az += dt * 0.22;
      const az = this.follow.az, el = this.follow.el, dist = this.follow.dist;
      const back = _v.copy(this.heading).negate().applyAxisAngle(UP, az);
      const desired = back.multiplyScalar(dist * Math.cos(el)).add(center);
      desired.y += dist * Math.sin(el);
      desired.y = Math.max(desired.y, world.surfaceAt(desired.x, desired.z) + 1.5);
      // 列车在室内场景里时，镜头不能跑到山体或墙外面去，改成贴着轨道跟在车后面
      if (this.app.scenes.indoorAt(sim.s - 9) > 0.25 || this.app.scenes.indoorAt(sim.s) > 0.25) {
        track.frame(sim.s - train.length - 7, F2);
        desired.copy(F2.p).addScaledVector(F2.u, hangSign > 0 ? 2.3 : -0.8);
      }
      if (this.snap) this.camPos.copy(desired);
      else this.camPos.lerp(desired, 1 - Math.exp(-5 * dt));
      camera.position.copy(this.camPos);
      camera.up.set(0, 1, 0);
      camera.lookAt(center.x, center.y + 0.6, center.z);
      targetFov = 56 + 10 * speedK;
      blurK = 0.3;
    } else {
      // 路边机位：选离列车最近的一台，用长焦跟拍
      this.sideHold += dt;
      track.frame(sim.s + v * 1.0, F2);
      let best = -1, bd = 1e9;
      for (let i = 0; i < this.sideCams.length; i++) {
        const d = this.sideCams[i].distanceToSquared(F2.p);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) {
        const cur = this.sideIndex >= 0 ? this.sideCams[this.sideIndex].distanceToSquared(F2.p) : 1e9;
        if (this.sideIndex < 0 || (best !== this.sideIndex && this.sideHold > 2.2 && (bd < cur * 0.55 || cur > 80 * 80))) {
          this.sideIndex = best;
          this.sideHold = 0;
          this.snap = true;
          this.skipVel = true;
        }
        const pos = this.sideCams[this.sideIndex];
        camera.position.copy(pos);
        if (this.snap) this.lookTarget.copy(center);
        else this.lookTarget.lerp(center, 1 - Math.exp(-9 * dt));
        camera.up.set(0, 1, 0);
        camera.lookAt(this.lookTarget);
        const d = pos.distanceTo(center);
        targetFov = clamp((2 * Math.atan(11 / Math.max(d, 4)) * 180) / Math.PI, 12, 52);
        if (this.snap) camera.fov = targetFov;
      }
    }
    this.snap = false;
    camera.fov = damp(camera.fov, targetFov, 6, dt);
    camera.updateProjectionMatrix();

    // 相机速度：用来拉出雨丝和速度线的拖尾
    if (this.skipVel || dt <= 0) {
      this.camVel.set(0, 0, 0);
      this.skipVel = false;
    } else {
      _v.copy(camera.position).sub(this.prevCam).divideScalar(dt);
      if (_v.length() > 90) _v.setLength(90);
      this.camVel.lerp(_v, 0.5);
    }
    this.prevCam.copy(camera.position);
    const cv = this.camVel.length();
    this.dust.vel.set(0, 0, 0);
    this.dust.uniforms.uColor.value.setScalar(0.45 + world.ambient * 0.55);
    this.dust.update(dt, camera.position, this.camVel, (this.cam === 'first' ? 0.5 : 0.28) * smoothstep(9, 38, cv), 0.022);

    // 画面效果跟着速度和 G 力变化
    const gv = sim.gv;
    post.setEffects({
      blur: blurK * speedK * (this.paused ? 0 : 1),
      aberr: this.cam === 'first' ? 0.006 * speedK : 0,
      vignette: 0.24 + (this.cam === 'first' ? 0.5 * smoothstep(3.6, 6, gv) : 0),
      desat: this.cam === 'first' ? 0.55 * smoothstep(4.2, 6.5, gv) : 0,
      tint: this.cam === 'first' && gv < -0.6 ? [0.22 * smoothstep(-0.6, -2, gv), 0, 0] : null,
    });

    // 刹车时轮子下面冒火花
    if (sim.kind === KIND.brake && v > 7 && sdt > 0) {
      for (let i = 0; i < 3; i++) {
        const side = Math.random() < 0.5 ? -0.6 : 0.6;
        _v.copy(F.p).addScaledVector(F.r, side).addScaledVector(F.t, -Math.random() * 2);
        decor.particles.spawn(_v.x, _v.y, _v.z,
          -F.t.x * v * 0.3 + (Math.random() - 0.5) * 3, 1 + Math.random() * 3, -F.t.z * v * 0.3 + (Math.random() - 0.5) * 3,
          4, 2, 0.5, 0.22, 0.25 + Math.random() * 0.2, 1);
      }
    }

    // 乘客的尖叫：俯冲、倒挂、大过载、弹射时尖叫，失重时欢呼
    this.screamCd -= sdt;
    if (sdt > 0 && sim.state === 'run' && this.screamCd <= 0) {
      let k = 0, woo = false;
      if (F.t.y < -0.42 && v > 9 && sim.a > 2) k = clamp(-F.t.y * 0.9 + v / 60, 0.4, 1);
      else if (F.u.y < -0.2 && v > 8) k = 0.8;
      else if (gv > 3.6) k = 0.6;
      else if (sim.kind === KIND.launch && sim.a > 8) k = 0.9;
      else if (gv < 0.15 && v > 10) { k = 0.5; woo = true; }
      if (k > 0) {
        audio.scream(k, woo, this.cam === 'first');
        this.screamCd = (woo ? 2.2 : 2.8) + Math.random() * 2;
      }
    }
    audio.setIntensity(sim.kind === KIND.lift || sim.state !== 'run' ? 0.15 : 1);

    audio.setRide(dt, {
      active: !this.paused, speed: sim.v, g: gv, firstPerson: this.cam === 'first',
      onLift: sim.kind === KIND.lift, braking: sim.kind === KIND.brake && v > 5.5,
      launching: sim.kind === KIND.launch && v < track.opts.launchSpeed - 0.5 && sim.state === 'run',
      wood: track.opts.style === 'wood',
    });

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.08;
      this.app.ui.setHud({
        speed: v * 3.6,
        height: F.p.y - world.surfaceAt(F.p.x, F.p.z),
        gv, gl: sim.gl,
        state: sim.state, timer: sim.timer, lap: sim.lap, lapTime: sim.lapTime,
      });
    }
    if (this.recorder) {
      this.recTime += dt;
      this.app.ui.setRecording(true, this.recTime);
    }
    // 镜头附近的轨道如果在室内场景里，就按室内来处理光线
    const scenes = this.app.scenes;
    if (this.cam === 'first') {
      this.indoorK = scenes.indoorAt(sim.s);
      this.fogK = scenes.fogAt(sim.s);
    } else {
      const k = track.nearestSample(camera.position, 14);
      this.indoorK = k >= 0 ? scenes.indoorK[k] || 0 : 0;
      this.fogK = k >= 0 ? scenes.fogK[k] || 0 : 0;
    }
    return center;
  }

  // ---------- 录制和截图 ----------
  toggleRecording() {
    if (this.recorder) this.stopRecording();
    else this.startRecording();
  }

  startRecording() {
    const { canvas, audio, toast } = this.app;
    if (!canvas.captureStream || !window.MediaRecorder) {
      toast('这个浏览器不支持录制视频，建议换用新版的 Chrome 或 Edge。');
      return;
    }
    const stream = canvas.captureStream(60);
    if (audio.streamDest) {
      const at = audio.streamDest.stream.getAudioTracks()[0];
      if (at) stream.addTrack(at);
    }
    const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    let rec;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 16e6 });
    } catch (err) {
      toast('录制没有启动成功：' + err.message);
      return;
    }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const type = rec.mimeType || mime || 'video/webm';
      const blob = new Blob(chunks, { type });
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const name = `过山车_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
      this.app.ui.showVideo(URL.createObjectURL(blob), name, blob.size);
    };
    rec.start(500);
    this.recorder = rec;
    this.recTime = 0;
    this.app.ui.setRecording(true, 0);
  }

  stopRecording() {
    if (!this.recorder) return;
    this.recorder.stop();
    this.recorder = null;
    this.app.ui.setRecording(false, 0);
  }

  screenshot() {
    const { post, canvas, toast } = this.app;
    post.render();
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `过山车截图_${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('截图已经保存到下载文件夹。');
    }, 'image/png');
  }
}
