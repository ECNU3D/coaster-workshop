// 物理模拟：列车在轨道上的运动、G 力计算，以及整条轨道的测试分析
import { clamp } from './util.js';

export const G = 9.81;
export const KIND = { normal: 0, lift: 1, launch: 2, brake: 3, station: 4 };
export const KIND_NAMES = ['normal', 'lift', 'launch', 'brake', 'station'];

const LAUNCH_ACC = 13;
const BRAKE_ACC = 9;
const BRAKE_SPEED = 5;
const STATION_SPEED = 4.5;

function friction(track) {
  return track.opts.style === 'wood' ? { mu: 0.013, drag: 0.00029 } : { mu: 0.011, drag: 0.00027 };
}

// 找到第一段站台的起止采样点，没有站台时返回 null
export function findStation(track) {
  const { N, kind } = track;
  if (!N) return null;
  let start = -1;
  for (let i = 0; i < N; i++) {
    if (kind[i] !== KIND.station) { start = i; break; }
  }
  if (start < 0) return null;
  let ks = -1;
  for (let i = 0; i < N; i++) {
    const k = (start + i) % N;
    if (kind[k] === KIND.station) { ks = k; break; }
  }
  if (ks < 0) return null;
  let len = 0;
  while (len < N && kind[(ks + len) % N] === KIND.station) len++;
  return { ks, ke: (ks + len - 1) % N, len };
}

// 按质点估算列车在每个采样点的速度，用来计算倾斜角和做测试分析
export function speedProfile(track) {
  const { N, ds, T, kind, opts } = track;
  const out = new Float32Array(N);
  if (!N) return { v: out, stalledAt: -1 };
  const { mu, drag } = friction(track);
  const st = findStation(track);
  const k0 = st ? (st.ke + 1) % N : 0;
  const lift2 = opts.liftSpeed * opts.liftSpeed;
  const launch2 = opts.launchSpeed * opts.launchSpeed;
  let v2 = STATION_SPEED * STATION_SPEED;
  let stalledAt = -1;
  for (let i = 0; i < N; i++) {
    const k = (k0 + i) % N;
    const ty = T[k * 3 + 1];
    const a = -G * ty - mu * G * Math.sqrt(Math.max(0, 1 - ty * ty)) - drag * v2;
    let n2 = v2 + 2 * a * ds;
    switch (kind[k]) {
      case KIND.lift:
        if (n2 < lift2) n2 = lift2;
        break;
      case KIND.launch:
        if (v2 < launch2) n2 = Math.min(launch2, v2 + 2 * (a + LAUNCH_ACC) * ds);
        break;
      case KIND.brake:
        if (v2 > BRAKE_SPEED * BRAKE_SPEED) n2 = Math.max(BRAKE_SPEED * BRAKE_SPEED, v2 + 2 * (a - BRAKE_ACC) * ds);
        else if (n2 < BRAKE_SPEED * BRAKE_SPEED) n2 = BRAKE_SPEED * BRAKE_SPEED;
        break;
      case KIND.station:
        n2 = STATION_SPEED * STATION_SPEED;
        break;
    }
    if (n2 < 0.3) {
      if (stalledAt < 0) stalledAt = k;
      n2 = 9;
    }
    v2 = n2;
    out[k] = Math.sqrt(v2);
  }
  return { v: out, stalledAt };
}

// 对整条轨道做一次测试，得到统计数据、评分和需要注意的问题
export function analyze(track, profile) {
  const { N, ds, P, T, U, R, K, kind } = track;
  const v = profile.v;
  const res = {
    length: N * ds, maxSpeed: 0, maxHeight: 0, maxDrop: 0, maxG: 1, minG: 1, maxLat: 0,
    inversions: 0, airtime: 0, duration: 0, stalledAt: profile.stalledAt,
    gv: new Float32Array(N), gl: new Float32Array(N),
    ratings: { excitement: 0, intensity: 0, nausea: 0 }, warnings: [],
    hasStation: false, hasPower: false,
  };
  if (!N) return res;
  let inverted = false;
  let minClear = 1e9;
  let turnSum = 0;
  for (let k = 0; k < N; k++) {
    const kp = (k + 1) % N, km = (k + N - 1) % N;
    const vk = v[k];
    const at = (v[kp] * v[kp] - v[km] * v[km]) / (4 * ds);
    const v2 = vk * vk;
    const fx = v2 * K[k * 3] + at * T[k * 3];
    const fy = v2 * K[k * 3 + 1] + at * T[k * 3 + 1] + G;
    const fz = v2 * K[k * 3 + 2] + at * T[k * 3 + 2];
    const gv = (fx * U[k * 3] + fy * U[k * 3 + 1] + fz * U[k * 3 + 2]) / G;
    const gl = (fx * R[k * 3] + fy * R[k * 3 + 1] + fz * R[k * 3 + 2]) / G;
    res.gv[k] = gv;
    res.gl[k] = gl;
    const dt = ds / Math.max(vk, 0.5);
    res.duration += dt;
    if (kind[k] === KIND.station) res.hasStation = true;
    if (kind[k] === KIND.lift || kind[k] === KIND.launch) res.hasPower = true;
    if (kind[k] !== KIND.station) {
      if (vk > res.maxSpeed) res.maxSpeed = vk;
      if (gv < 0.1) res.airtime += dt;
    }
    const uy = U[k * 3 + 1];
    if (!inverted && uy < -0.25) { inverted = true; res.inversions++; }
    else if (inverted && uy > 0.25) inverted = false;
    turnSum += Math.hypot(K[k * 3], K[k * 3 + 2]) * ds;
    if (k % 6 === 0 && track.world) {
      const clear = P[k * 3 + 1] - track.world.surfaceAt(P[k * 3], P[k * 3 + 2]);
      if (clear > res.maxHeight) res.maxHeight = clear;
      if (clear < minClear) minClear = clear;
    }
  }
  // 取 1 米范围内的平均值作为 G 力的极值，避免个别采样点的毛刺
  const win = 2;
  for (let k = 0; k < N; k++) {
    let sv = 0, sl = 0;
    for (let j = -win; j <= win; j++) {
      const i = (k + j + N) % N;
      sv += res.gv[i];
      sl += res.gl[i];
    }
    sv /= win * 2 + 1;
    sl /= win * 2 + 1;
    if (sv > res.maxG) res.maxG = sv;
    if (sv < res.minG) res.minG = sv;
    if (Math.abs(sl) > res.maxLat) res.maxLat = Math.abs(sl);
  }
  // 最大落差：从一个高点连续下降到低点的最大高度差
  let peak = P[1];
  for (let i = 0; i < N * 2; i++) {
    const y = P[(i % N) * 3 + 1];
    const yn = P[((i + 1) % N) * 3 + 1];
    if (y > peak) peak = y;
    if (yn > y + 0.001) {
      if (peak - y > res.maxDrop) res.maxDrop = peak - y;
      peak = yn;
    }
  }

  const kmh = res.maxSpeed * 3.6;
  let ex = 0.5 + kmh / 40 + res.maxDrop / 25 + res.inversions * 0.5 + Math.min(res.airtime, 12) * 0.15 + Math.min(res.length, 1800) / 1200;
  const inten = (res.maxG - 1) * 1.0 + res.maxLat * 1.0 + Math.max(0, -res.minG) * 0.8 + kmh / 50;
  const nausea = res.inversions * 0.85 + res.maxLat * 1.5 + turnSum / (Math.PI * 6);
  if (inten > 9) ex -= (inten - 9) * 0.8;
  if (res.stalledAt >= 0) ex *= 0.3;
  res.ratings.excitement = clamp(ex, 0, 10);
  res.ratings.intensity = clamp(inten, 0, 10);
  res.ratings.nausea = clamp(nausea, 0, 10);

  const w = res.warnings;
  if (!res.hasStation) w.push('轨道上没有站台段，列车不会停站。');
  if (!res.hasPower) w.push('轨道上没有提升段或弹射段，列车没有动力来源。');
  if (res.stalledAt >= 0) {
    w.push(`列车开到第 ${Math.round(res.stalledAt * ds)} 米附近会停下来，前面的坡太高，或者提升段不够高。`);
  }
  if (res.maxG > 5.5) w.push(`最大正向 G 力达到 ${res.maxG.toFixed(1)}，真实的过山车一般不超过 5。可以把谷底或回环的弯做得更缓。`);
  if (res.minG < -1.8) w.push(`最大负向 G 力达到 ${res.minG.toFixed(1)}，乘客会被明显往上抛。可以把坡顶做得更圆。`);
  if (res.maxLat > 1.8) w.push(`最大横向 G 力达到 ${res.maxLat.toFixed(1)}，建议加大转弯处的倾斜角，或者打开自动倾斜。`);
  if (minClear < 0.5) w.push('有一段轨道低于地面或水面，需要把它抬高。');
  return res;
}

// 实时运行用的列车状态
export class TrainSim {
  constructor(track, cars, pitch) {
    this.track = track;
    this.cars = cars;
    this.pitch = pitch;
    this.dwell = 4;
    this.onEvent = null;
    this.reset();
  }

  reset() {
    const tr = this.track;
    this.station = findStation(tr);
    this.L = tr.N * tr.ds;
    this.v = 0;
    this.a = 0;
    this.gv = 1; this.gl = 0; this.gf = 0;
    this.lap = 0;
    this.lapTime = 0;
    this.lastLapTime = 0;
    this.stalled = false;
    this.slowTime = 0;
    this.topSpeed = 0;
    this.sinceDepart = 0;
    if (this.station) {
      this.stopS = Math.max(0, (this.station.ks + this.station.len) * tr.ds - 1.5);
      this.s = this.stopS % this.L;
      this.state = 'dwell';
      this.timer = 2.5;
    } else {
      this.s = 0;
      this.v = STATION_SPEED;
      this.state = 'run';
      this.timer = 0;
    }
  }

  dispatch() {
    if (this.state === 'dwell') this.timer = 0;
  }

  push() {
    this.v += 7;
    this.stalled = false;
    this.slowTime = 0;
  }

  kindAt(s) {
    const tr = this.track;
    let k = Math.floor(s / tr.ds) % tr.N;
    if (k < 0) k += tr.N;
    return tr.kind[k];
  }

  slopeAt(s) {
    const tr = this.track;
    let k = Math.floor(s / tr.ds) % tr.N;
    if (k < 0) k += tr.N;
    return tr.T[k * 3 + 1];
  }

  step(dt) {
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.substep(h);
    this.updateG();
  }

  substep(h) {
    const tr = this.track;
    const { mu, drag } = friction(tr);
    const len = (this.cars - 1) * this.pitch;
    let ty = 0;
    for (let c = 0; c < this.cars; c++) ty += this.slopeAt(this.s - c * this.pitch);
    ty /= this.cars;
    const kf = this.kindAt(this.s), km = this.kindAt(this.s - len / 2), kr = this.kindAt(this.s - len);
    const any = (kd) => kf === kd || km === kd || kr === kd;
    const grav = -G * ty;
    let a = grav;
    const fr = mu * G * Math.sqrt(Math.max(0, 1 - ty * ty)) + drag * this.v * this.v;
    if (Math.abs(this.v) > 0.05) a -= Math.sign(this.v) * fr;
    else if (Math.abs(grav) < fr) a = 0;

    switch (this.state) {
      case 'dwell':
        this.v = 0;
        a = 0;
        this.timer -= h;
        if (this.timer <= 0) {
          this.state = 'depart';
          this.sinceDepart = 0;
          this.lapTime = 0;
          this.emit('depart');
        }
        break;
      case 'depart':
        a = clamp((STATION_SPEED - this.v) * 3, -3, 2.2);
        if (kf !== KIND.station) this.state = 'run';
        break;
      case 'arrive': {
        let d = this.stopS - this.s;
        d = ((d % this.L) + this.L) % this.L;
        if (d > this.L * 0.5) d = 0;
        const want = Math.min(STATION_SPEED, Math.sqrt(2 * 2.2 * d) + 0.25);
        a = clamp((want - this.v) * 6, -8, 3);
        if (d < 0.12) {
          this.v = 0;
          a = 0;
          this.state = 'dwell';
          this.timer = this.dwell;
          this.lap++;
          this.lastLapTime = this.lapTime;
          this.emit('arrive');
        }
        break;
      }
      default: {
        if (any(KIND.lift) && this.v < tr.opts.liftSpeed) {
          a = Math.max(a, 0) + Math.min(3, (tr.opts.liftSpeed - this.v) * 4);
          if (this.v < 0) this.v = 0;
        }
        if (any(KIND.launch) && this.v < tr.opts.launchSpeed && this.v > -0.5) a += LAUNCH_ACC;
        if (any(KIND.brake)) {
          if (this.v > BRAKE_SPEED) a -= Math.min(BRAKE_ACC, (this.v - BRAKE_SPEED) * 6 + 1);
          else if (this.v < BRAKE_SPEED - 0.3) a = Math.max(a, 0) + 1.5;
        }
        if (kf === KIND.station && this.station && this.sinceDepart > 20) {
          this.state = 'arrive';
        } else if (kf === KIND.station && !any(KIND.lift) && this.v < STATION_SPEED) {
          a = Math.max(a, 1.5);
        }
        break;
      }
    }
    this.v += a * h;
    this.a = a;
    this.s += this.v * h;
    this.sinceDepart += Math.abs(this.v) * h;
    if (this.s >= this.L) this.s -= this.L;
    if (this.s < 0) this.s += this.L;
    if (this.state !== 'dwell') this.lapTime += h;
    if (this.v > this.topSpeed) this.topSpeed = this.v;

    if (this.state === 'run' && Math.abs(this.v) < 0.5 && !any(KIND.lift) && !any(KIND.launch)) {
      this.slowTime += h;
      if (this.slowTime > 2.5 && !this.stalled) {
        this.stalled = true;
        this.emit('stalled');
      }
    } else if (Math.abs(this.v) > 2) {
      this.slowTime = 0;
      this.stalled = false;
    }
  }

  updateG() {
    const tr = this.track;
    let k = Math.floor(this.s / tr.ds) % tr.N;
    if (k < 0) k += tr.N;
    const { K, T, U, R } = tr;
    const v2 = this.v * this.v;
    const fx = v2 * K[k * 3] + this.a * T[k * 3];
    const fy = v2 * K[k * 3 + 1] + this.a * T[k * 3 + 1] + G;
    const fz = v2 * K[k * 3 + 2] + this.a * T[k * 3 + 2];
    this.gv = (fx * U[k * 3] + fy * U[k * 3 + 1] + fz * U[k * 3 + 2]) / G;
    this.gl = (fx * R[k * 3] + fy * R[k * 3 + 1] + fz * R[k * 3 + 2]) / G;
    this.gf = (fx * T[k * 3] + fy * T[k * 3 + 1] + fz * T[k * 3 + 2]) / G;
    this.kind = tr.kind[k];
  }

  emit(name) {
    if (this.onEvent) this.onEvent(name);
  }
}
