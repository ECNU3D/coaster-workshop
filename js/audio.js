// 音效和音乐：全部用 Web Audio 实时合成，不需要任何音频文件
import { clamp } from './util.js';

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// 运行时的音乐：A 小调，128 拍。每小节一个和弦：Am、F、C、G
const RIDE = {
  bpm: 128,
  chords: [
    { root: 45, notes: [57, 60, 64] },
    { root: 41, notes: [53, 57, 60] },
    { root: 48, notes: [55, 60, 64] },
    { root: 43, notes: [55, 59, 62] },
  ],
  arp: [0, 1, 2, 1, 3, 2, 1, 2, 0, 1, 2, 1, 3, 2, 4, 2],
  // 主旋律：[第几个十六分音符, 音高, 时值]
  melody: [[0, 76, 3], [4, 74, 2], [8, 72, 3], [12, 69, 4], [16, 72, 3], [20, 69, 2], [24, 65, 6], [32, 67, 3], [36, 72, 2], [40, 76, 3], [44, 79, 4], [48, 74, 6], [56, 71, 3], [60, 74, 3]],
};
// 设计时的音乐：舒缓，84 拍。Fmaj7、G6、Em7、Am7
const EDIT = {
  bpm: 84,
  chords: [
    { root: 41, notes: [57, 60, 64] },
    { root: 43, notes: [59, 62, 64] },
    { root: 40, notes: [55, 59, 62] },
    { root: 45, notes: [55, 60, 64] },
  ],
  pluck: [0, 3, 6, 10, 12],
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.chainAcc = 0;
    this.clatterAcc = 0;
    this.streamDest = null;
    this.musicVolume = 0.5;
    this.screamsOn = true;
    this.mood = 'edit';
    this.intensity = 1;
    this.step = 0;
    this.nextTime = 0;
    this.timer = null;
  }

  // 浏览器要求在用户点击之后才能开始播放声音
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.85;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp);
    comp.connect(ctx.destination);
    if (ctx.createMediaStreamDestination) {
      this.streamDest = ctx.createMediaStreamDestination();
      comp.connect(this.streamDest);
    }
    const len = ctx.sampleRate * 2;
    this.white = ctx.createBuffer(1, len, ctx.sampleRate);
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = this.white.getChannelData(0), b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const r = Math.random() * 2 - 1;
      w[i] = r;
      last = (last + 0.02 * r) / 1.02;
      b[i] = last * 3.5;
    }
    const loop = (buffer, filterType, freq, q = 0.7) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f);
      f.connect(g);
      g.connect(this.master);
      src.start();
      return { f, g };
    };
    this.wind = loop(this.white, 'bandpass', 600, 0.6);
    this.rumble = loop(this.brown, 'lowpass', 160);
    this.rain = loop(this.white, 'highpass', 1800);
    this.air = loop(this.brown, 'bandpass', 320, 0.4);
    this.hiss = loop(this.white, 'highpass', 4500);
    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = 80;
    const of = ctx.createBiquadFilter();
    of.type = 'lowpass';
    of.frequency.value = 900;
    this.oscGain = ctx.createGain();
    this.oscGain.gain.value = 0;
    this.osc.connect(of);
    of.connect(this.oscGain);
    this.oscGain.connect(this.master);
    this.osc.start();

    // 人声：带一点回声，听起来像在开阔的场地里
    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 0.9;
    this.voiceBus.connect(this.master);
    const vd = ctx.createDelay(0.5);
    vd.delayTime.value = 0.13;
    const vfb = ctx.createGain();
    vfb.gain.value = 0.28;
    const vlp = ctx.createBiquadFilter();
    vlp.type = 'lowpass';
    vlp.frequency.value = 2600;
    this.voiceBus.connect(vd);
    vd.connect(vlp);
    vlp.connect(vfb);
    vfb.connect(vd);
    vlp.connect(this.master);

    // 音乐：鼓、贝斯、铺底、琶音、主旋律各一路，方便按情况调整比例
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVolume;
    this.musicBus.connect(this.master);
    const bus = (v) => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(this.musicBus);
      return g;
    };
    this.drumBus = bus(0.9);
    this.bassBus = bus(0.7);
    this.padBus = bus(0.5);
    this.leadBus = bus(0.5);
    const md = ctx.createDelay(1);
    md.delayTime.value = 0.35;
    const mfb = ctx.createGain();
    mfb.gain.value = 0.32;
    const mlp = ctx.createBiquadFilter();
    mlp.type = 'lowpass';
    mlp.frequency.value = 3000;
    this.leadBus.connect(md);
    md.connect(mlp);
    mlp.connect(mfb);
    mfb.connect(md);
    mlp.connect(this.musicBus);
    this.musicDelay = md;
    this.startMusic();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.05);
  }

  setMusicVolume(v) {
    this.musicVolume = v;
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }

  set(param, value, tc = 0.08) {
    param.setTargetAtTime(value, this.ctx.currentTime, tc);
  }

  // 环境声：雨声和风声
  setAmbience(rain, wind) {
    if (!this.ctx) return;
    this.set(this.rain.g.gain, clamp(rain, 0, 1.5) * 0.11, 0.4);
    this.set(this.air.g.gain, 0.02 + wind * 0.06, 0.4);
  }

  // 运行时的声音。active 为 false 时全部静音
  setRide(dt, s) {
    if (!this.ctx) return;
    if (!s.active) {
      this.set(this.wind.g.gain, 0);
      this.set(this.rumble.g.gain, 0);
      this.set(this.hiss.g.gain, 0);
      this.set(this.oscGain.gain, 0);
      return;
    }
    const v = Math.abs(s.speed);
    const k = clamp(v / 42, 0, 1);
    const inside = s.firstPerson ? 1 : 0.55;
    this.set(this.wind.g.gain, k * k * 0.5 * inside);
    this.set(this.wind.f.frequency, 350 + k * 2300);
    this.set(this.rumble.g.gain, (0.05 + k * 0.5) * (s.wood ? 1.5 : 1) * inside * (v > 0.3 ? 1 : 0));
    this.set(this.rumble.f.frequency, 90 + k * 260 + clamp(s.g - 1, 0, 4) * 40);
    this.set(this.hiss.g.gain, s.braking ? 0.1 * clamp(v / 15, 0.2, 1) : 0, 0.05);
    this.set(this.oscGain.gain, s.launching ? 0.09 : 0, 0.1);
    this.set(this.osc.frequency, 70 + v * 9, 0.05);
    if (s.onLift && v > 0.5) {
      this.chainAcc += dt * v * 1.9;
      while (this.chainAcc > 1) {
        this.chainAcc -= 1;
        this.tick(2600 + Math.random() * 500, 0.1 * inside, 0.035);
      }
    }
    if (s.wood && v > 3) {
      this.clatterAcc += dt * v * 0.8;
      while (this.clatterAcc > 1) {
        this.clatterAcc -= 1;
        this.tick(300 + Math.random() * 200, 0.12 * inside * k, 0.05);
      }
    }
  }

  // 短促的敲击声：提升链、木轨接缝、界面点击
  tick(freq, gain, dur) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t, Math.random(), dur + 0.02);
  }

  // 低沉的轰鸣：雷声、烟花
  boom(delay, gain, decay, cutoff) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, cutoff * 0.3), t + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t, Math.random(), decay + 0.1);
  }

  thunder(distance) {
    this.boom(Math.min(3.5, distance / 340), clamp(1.4 - distance / 1400, 0.4, 1.2), 3.5 + Math.random() * 2, 260);
  }

  firework(distance) {
    this.boom(Math.min(2, distance / 340), clamp(0.7 - distance / 900, 0.08, 0.6), 0.9, 420);
  }

  ui() {
    this.tick(1800, 0.05, 0.03);
  }

  // ---------- 乘客的尖叫声 ----------
  // 一个人的叫声：锯齿波当声带，几个带通滤波器模拟口腔的共鸣，音高先冲上去再慢慢落下来
  voice(t, opt) {
    const ctx = this.ctx;
    const { f0, dur, gain, pan, woo } = opt;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const f = osc.frequency;
    f.setValueAtTime(f0 * 0.62, t);
    f.exponentialRampToValueAtTime(f0, t + 0.1 + Math.random() * 0.08);
    f.setValueAtTime(f0, t + dur * 0.35);
    f.exponentialRampToValueAtTime(f0 * (woo ? 0.6 : 0.78), t + dur);
    // 颤音
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.5 + Math.random() * 2;
    const vibGain = ctx.createGain();
    vibGain.gain.value = f0 * 0.022;
    vib.connect(vibGain);
    vibGain.connect(osc.frequency);
    // 嘶喊的粗糙感：几十赫兹的音量抖动
    const rough = ctx.createGain();
    rough.gain.value = 1;
    const am = ctx.createOscillator();
    am.frequency.value = 42 + Math.random() * 40;
    const amGain = ctx.createGain();
    amGain.gain.value = woo ? 0.08 : 0.3;
    am.connect(amGain);
    amGain.connect(rough.gain);
    osc.connect(rough);
    // 气声
    const noise = ctx.createBufferSource();
    noise.buffer = this.white;
    noise.loop = true;
    const ng = ctx.createGain();
    ng.gain.value = 0.16;
    noise.connect(ng);
    ng.connect(rough);
    // 共鸣峰。尖叫时嘴张得很大，第一共鸣峰会跟着音高走
    const out = ctx.createGain();
    const female = f0 > 520;
    const F = woo
      ? [[Math.max(430, f0), 1.0, 7], [900, 0.5, 8], [2700, 0.2, 9]]
      : [[Math.max(female ? 950 : 760, f0 * 1.02), 1.0, 6], [female ? 1650 : 1250, 0.7, 8], [female ? 3100 : 2700, 0.45, 9], [4100, 0.2, 10]];
    for (const [freq, g, q] of F) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = q;
      const bg = ctx.createGain();
      bg.gain.value = g;
      rough.connect(bp);
      bp.connect(bg);
      bg.connect(out);
      if (woo && freq < 500) {
        // “呜——呼”：口型从闭到开
        bp.frequency.setValueAtTime(freq, t);
        bp.frequency.linearRampToValueAtTime(freq * 1.5, t + dur * 0.6);
      }
    }
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(gain, t + 0.07);
    out.gain.setValueAtTime(gain, t + dur * 0.55);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let dest = this.voiceBus;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      p.connect(this.voiceBus);
      dest = p;
    }
    out.connect(dest);
    const end = t + dur + 0.05;
    osc.start(t); vib.start(t); am.start(t); noise.start(t, Math.random());
    osc.stop(end); vib.stop(end); am.stop(end); noise.stop(end);
  }

  // 一群乘客一起叫。intensity 0~1 决定人数和音量；woo 为 true 时是比较轻松的欢呼
  scream(intensity = 1, woo = false, near = true) {
    if (!this.ctx || !this.screamsOn) return;
    const t0 = this.ctx.currentTime + 0.02;
    const n = Math.round(2 + intensity * 4);
    for (let i = 0; i < n; i++) {
      const female = Math.random() < 0.62;
      const f0 = female ? 700 + Math.random() * 420 : 330 + Math.random() * 150;
      this.voice(t0 + Math.random() * 0.45, {
        f0: woo ? f0 * 0.72 : f0,
        dur: (woo ? 0.7 : 1.0) + Math.random() * (0.6 + intensity * 0.9),
        gain: (near ? 0.13 : 0.07) * (woo ? 1.8 : 1) * (0.6 + intensity * 0.6) * (0.7 + Math.random() * 0.5),
        pan: Math.random() * 1.4 - 0.7,
        woo,
      });
    }
  }

  // 恐龙的吼声：很低的锯齿波加噪声，音高往下掉，带粗糙的颤动
  roar(distance = 30) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.02, dur = 2.2;
    const gain = clamp(1.3 - distance / 70, 0.25, 1) * 0.5;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(gain, t + 0.18);
    out.gain.setValueAtTime(gain, t + dur * 0.5);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const rough = ctx.createGain();
    const am = ctx.createOscillator();
    am.frequency.setValueAtTime(34, t);
    am.frequency.linearRampToValueAtTime(19, t + dur);
    const amGain = ctx.createGain();
    amGain.gain.value = 0.55;
    am.connect(amGain);
    amGain.connect(rough.gain);
    for (const [f0, f1, type, g] of [[92, 48, 'sawtooth', 0.8], [138, 70, 'square', 0.3]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og);
      og.connect(rough);
      o.start(t);
      o.stop(t + dur + 0.1);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = this.brown;
    noise.loop = true;
    const ng = ctx.createGain();
    ng.gain.value = 1.4;
    noise.connect(ng);
    ng.connect(rough);
    for (const [freq, q, g] of [[260, 2.5, 1], [640, 3, 0.7], [1300, 4, 0.3]]) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(freq * 1.25, t);
      bp.frequency.exponentialRampToValueAtTime(freq * 0.75, t + dur);
      bp.Q.value = q;
      const bg = ctx.createGain();
      bg.gain.value = g;
      rough.connect(bp);
      bp.connect(bg);
      bg.connect(out);
    }
    out.connect(this.voiceBus);
    am.start(t); noise.start(t, Math.random());
    am.stop(t + dur + 0.1); noise.stop(t + dur + 0.1);
  }

  // ---------- 音乐 ----------
  startMusic() {
    if (this.timer || !this.ctx) return;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.step = 0;
    this.timer = setInterval(() => this.schedule(), 60);
  }

  // edit：设计时的舒缓音乐；ride：运行时的快节奏音乐
  setMood(mood) {
    if (mood === this.mood) return;
    this.mood = mood;
    this.step = 0;
    if (this.ctx) this.nextTime = Math.max(this.nextTime, this.ctx.currentTime + 0.05);
  }

  // 运行时音乐的强度：爬坡时只留铺底和心跳一样的底鼓，冲下去以后全部乐器进来
  setIntensity(x) {
    if (!this.ctx || Math.abs(x - this.intensity) < 0.02) return;
    this.intensity = x;
    this.set(this.drumBus.gain, 0.25 + 0.65 * x, 0.4);
    this.set(this.leadBus.gain, 0.2 + 0.3 * x, 0.4);
    this.set(this.bassBus.gain, 0.4 + 0.3 * x, 0.4);
  }

  schedule() {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    if (this.nextTime < ctx.currentTime - 0.3) this.nextTime = ctx.currentTime + 0.05;
    const song = this.mood === 'ride' ? RIDE : EDIT;
    const stepDur = 60 / song.bpm / 4;
    while (this.nextTime < ctx.currentTime + 0.3) {
      if (this.musicVolume > 0.001) {
        if (this.mood === 'ride') this.rideStep(this.step, this.nextTime, stepDur);
        else this.editStep(this.step, this.nextTime, stepDur);
      }
      this.step++;
      this.nextTime += stepDur;
    }
  }

  note(bus, type, midi, t, dur, gain, cutoff = 2400, attack = 0.005, detune = 0) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = mtof(midi);
    o.detune.value = detune;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(200, cutoff * 0.35), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f);
    f.connect(g);
    g.connect(bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  pad(notes, t, dur, gain, cutoff) {
    const ctx = this.ctx;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + dur * 0.25);
    g.gain.setValueAtTime(gain, t + dur * 0.75);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.25);
    f.connect(g);
    g.connect(this.padBus);
    for (const m of notes) {
      for (const d of [-9, 8]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(m);
        o.detune.value = d;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.3);
      }
    }
  }

  kick(t, gain = 0.9) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(g);
    g.connect(this.drumBus);
    o.start(t);
    o.stop(t + 0.26);
  }

  noiseHit(t, type, freq, gain, dur) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.drumBus);
    src.start(t, Math.random(), dur + 0.02);
  }

  rideStep(step, t, sd) {
    const s = step % 16, bar = Math.floor(step / 16);
    const ch = RIDE.chords[bar % 4];
    const full = this.intensity > 0.5;
    if (s === 0) this.pad(ch.notes, t, sd * 16, 0.05, full ? 1500 : 800);
    // 鼓
    if (s % 4 === 0) this.kick(t);
    if (full) {
      if (s === 4 || s === 12) {
        this.noiseHit(t, 'bandpass', 1900, 0.42, 0.14);
        this.note(this.drumBus, 'triangle', 55, t, 0.09, 0.25, 900);
      }
      if (s % 2 === 0) this.noiseHit(t, 'highpass', 7500, s % 4 === 2 ? 0.13 : 0.06, 0.04);
      if (bar % 4 === 3 && s >= 12) this.noiseHit(t, 'bandpass', 1500 + s * 120, 0.3, 0.09);
    }
    // 贝斯：八分音符，第四拍后半拍跳一个八度
    if (s % 2 === 0) {
      const up = s === 14 || s === 6 ? 12 : 0;
      this.note(this.bassBus, 'sawtooth', ch.root + up, t, sd * 1.8, 0.34, full ? 700 : 380);
      this.note(this.bassBus, 'square', ch.root - 12 + up, t, sd * 1.8, 0.16, 300);
    }
    // 琶音
    const idx = RIDE.arp[s];
    const tones = [ch.notes[0], ch.notes[1], ch.notes[2], ch.notes[0] + 12, ch.notes[1] + 12];
    this.note(this.leadBus, 'square', tones[idx] + 12, t, sd * 0.9, full ? 0.07 : 0.045, full ? 3200 : 1400);
    // 主旋律：每 8 小节里的后 4 小节出现
    if (full && bar % 8 >= 4) {
      const pos = (step - 0) % 64;
      for (const [at, midi, len] of RIDE.melody) {
        if (at === pos) {
          this.note(this.leadBus, 'sawtooth', midi, t, sd * len, 0.1, 3600, 0.02);
          this.note(this.leadBus, 'square', midi, t, sd * len, 0.05, 2600, 0.02, 7);
        }
      }
    }
  }

  editStep(step, t, sd) {
    const s = step % 16, bar = Math.floor(step / 16);
    const ch = EDIT.chords[bar % 4];
    if (s === 0) {
      this.pad(ch.notes, t, sd * 16, 0.06, 900);
      this.note(this.bassBus, 'triangle', ch.root, t, sd * 14, 0.3, 500, 0.05);
    }
    if (EDIT.pluck.includes(s) && (bar % 2 === 0 || s !== 3)) {
      const tones = [ch.notes[0] + 12, ch.notes[1] + 12, ch.notes[2] + 12, ch.notes[0] + 24];
      const m = tones[(s * 7 + bar * 3) % 4];
      this.note(this.leadBus, 'triangle', m, t, sd * 5, 0.11, 2600, 0.008);
    }
  }
}
