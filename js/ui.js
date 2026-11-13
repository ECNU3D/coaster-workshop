// 界面：左侧的选项面板、测试结果、运行时的仪表、提示和弹窗
import { ENVIRONMENTS, WEATHERS } from './world.js';
import { TRACK_STYLES, TRACK_MATERIALS, KINDS } from './track.js';
import { SEAT_TYPES, THEMES, BODY_MATERIALS } from './train.js';
import { GEN_STYLES, THEME_PRESETS } from './generator.js';
import { SCENES } from './scenes.js';
import { DECOR_ITEMS } from './decor.js';
import { CAMERAS } from './ride.js';
import { clamp } from './util.js';

const $ = (sel) => document.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

const SWATCHES = ['#e63946', '#ff7a1a', '#f4c20d', '#2f9e44', '#22b8cf', '#1c7ed6', '#7048e8', '#e64980', '#f1f3f5', '#868e96', '#212529'];
const TIME_PRESETS = [['清晨', 6.6], ['正午', 12], ['黄昏', 17.7], ['夜晚', 22]];

export class UI {
  constructor(app) {
    this.app = app;
    this.sync = [];
    this.hudHidden = false;
    this.buildTop();
    this.buildTrackTab();
    this.buildTrainTab();
    this.buildSceneTab();
    this.buildDecorTab();
    this.buildRide();
    this.buildModals();
    $('#btn-begin').addEventListener('click', () => app.begin(false));
    const cont = $('#btn-continue');
    cont.hidden = !app.hasSave();
    cont.addEventListener('click', () => app.begin(true));
  }

  // ---------- 小组件 ----------
  sec(title, ...children) {
    return h('div', { class: 'sec' }, h('h4', { text: title }), ...children);
  }

  tip(text) {
    return h('p', { class: 'tip', text });
  }

  // 一组互斥的选项。render 决定每个选项长什么样
  choice(kind, items, onPick, render) {
    const wrap = h('div', { class: kind === 'card' ? 'cards' : 'chips' });
    const btns = new Map();
    for (const it of items) {
      const b = h('button', { class: kind, onclick: () => { this.app.audio.ui(); onPick(it.id); } }, ...(render ? render(it) : kind === 'card' ? [h('b', { text: it.name }), it.desc ? h('span', { text: it.desc }) : null] : [it.name]));
      btns.set(it.id, b);
      wrap.append(b);
    }
    wrap.set = (id) => btns.forEach((b, key) => b.classList.toggle('on', key === id));
    return wrap;
  }

  slider(label, min, max, step, fmt, onChange, live = false) {
    const val = h('span', { class: 'val' });
    const input = h('input', { type: 'range', min, max, step });
    input.addEventListener('input', () => {
      val.textContent = fmt(+input.value);
      if (live) onChange(+input.value);
    });
    if (!live) input.addEventListener('change', () => onChange(+input.value));
    const row = h('div', { class: 'row' }, h('label', { text: label }), input, val);
    row.set = (v) => { input.value = v; val.textContent = fmt(+v); };
    return row;
  }

  color(label, onChange) {
    const input = h('input', { type: 'color' });
    input.addEventListener('change', () => onChange(input.value));
    const sw = h('div', { class: 'swatches' }, SWATCHES.map((c) => h('i', { style: `background:${c}`, title: c, onclick: () => { input.value = c; onChange(c); } })));
    const row = h('div', { class: 'row' }, h('label', { text: label }), input, sw);
    row.set = (v) => { input.value = v; };
    return row;
  }

  check(label, onChange) {
    const input = h('input', { type: 'checkbox' });
    input.addEventListener('change', () => onChange(input.checked));
    const row = h('label', { class: 'row check' }, input, h('span', { text: label }));
    row.set = (v) => { input.checked = !!v; };
    return row;
  }

  select(label, items, onChange) {
    const sel = h('select', {}, items.map((it) => h('option', { value: it.id, text: it.name })));
    sel.addEventListener('change', () => onChange(sel.value));
    const row = h('div', { class: 'row' }, h('label', { text: label }), sel);
    row.set = (v) => { sel.value = v; };
    return row;
  }

  button(text, onClick, cls = '') {
    return h('button', { class: 'btn ' + cls, text, onclick: () => { this.app.audio.ui(); onClick(); } });
  }

  // ---------- 顶栏 ----------
  buildTop() {
    const app = this.app;
    $('#mode-switch').addEventListener('click', (e) => {
      const m = e.target.dataset.mode;
      if (m) app.setMode(m);
    });
    $('#tabs').addEventListener('click', (e) => {
      const tab = e.target.dataset.tab;
      if (!tab) return;
      for (const b of $('#tabs').children) b.classList.toggle('on', b.dataset.tab === tab);
      for (const id of ['track', 'train', 'scene', 'decor']) $('#tab-' + id).hidden = id !== tab;
      if (tab !== 'decor') {
        app.editor.armDecor(null);
        this.setDecorArmed(null);
      }
      this.tab = tab;
      this.updateHint();
    });
    this.tab = 'track';
    $('#btn-undo').addEventListener('click', () => app.undo());
    $('#btn-redo').addEventListener('click', () => app.redo());
    $('#btn-save').addEventListener('click', () => app.save());
    $('#btn-load').addEventListener('click', () => app.load());
    $('#btn-export').addEventListener('click', () => app.exportFile());
    const file = $('#file-import');
    $('#btn-import').addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      if (file.files[0]) app.importFile(file.files[0]);
      file.value = '';
    });
    $('#btn-help').addEventListener('click', () => ($('#modal-help').hidden = false));
    $('#btn-ride').addEventListener('click', () => app.startRide());
  }

  // ---------- 轨道 ----------
  buildTrackTab() {
    const app = this.app;
    const root = $('#tab-track');
    const opt = (key) => (v) => app.setTrackOpt(key, v);

    this.secTheme = this.sec('主题过山车',
      this.choice('card', THEME_PRESETS, (id) => app.generateThemed(id)),
      this.tip('点一下会连环境、列车、轨道外观和场景一起生成。同一个主题每点一次，布局、环境、时间、列车和布景都会换一种搭配。'));
    this.secGen = this.sec('一键生成',
      this.choice('card', GEN_STYLES.filter((s) => !s.hidden), (id) => app.generate(id)),
      this.tip('同一种类型每点一次，都会得到一条不同的轨道。'));
    this.drawBtn = this.button('开始手绘', () => {
      if (app.editor.tool === 'draw') app.editor.cancelDraw();
      else app.editor.startDraw();
    }, 'block');
    this.secDraw = this.sec('手绘路线', this.drawBtn,
      this.tip('镜头会切到正上方。按住鼠标左键在地面上画一圈，松开后自动生成轨道，起点就是站台的位置。'));

    // 专业模式：节点属性
    this.nodeTitle = h('div', { class: 'node-title' });
    const num = (prop) => {
      const input = h('input', { type: 'number', step: prop === 'roll' ? 5 : 0.5 });
      input.addEventListener('change', () => app.editor.setNodeProp(prop, +input.value || 0));
      return input;
    };
    this.nodeX = num('x'); this.nodeY = num('y'); this.nodeZ = num('z');
    this.nodeRoll = this.slider('倾斜角', -180, 180, 1, (v) => v + '°', (v) => app.editor.setNodeProp('roll', v));
    this.nodeKind = this.select('这一段的类型', KINDS, (v) => app.editor.setNodeProp('kind', v));
    this.nodeAuto = this.check('这里使用自动倾斜', (v) => app.editor.setNodeProp('auto', v));
    this.nodeScene = this.select('这一段的场景', SCENES, (v) => app.editor.setNodeProp('scene', v));
    this.nodeFields = h('div', {},
      h('div', { class: 'row xyz' }, h('label', { text: 'X / 高度 / Z' }), this.nodeX, this.nodeY, this.nodeZ),
      this.nodeRoll, this.nodeKind, this.nodeScene, this.nodeAuto,
      h('div', { class: 'btn-row' },
        this.button('上一个', () => app.editor.stepNode(-1), 'small'),
        this.button('下一个', () => app.editor.stepNode(1), 'small'),
        this.button('插入节点', () => app.editor.insertNode(), 'small'),
        this.button('删除节点', () => app.editor.deleteNode(), 'small')));
    this.nodeEmpty = h('div', { class: 'empty', text: '还没有选中节点。点击轨道上的圆点可以选中它，双击轨道可以加一个新节点。' });
    this.secNode = this.sec('节点', this.nodeTitle, this.nodeFields, this.nodeEmpty);

    this.secElem = this.sec('在选中节点后面插入',
      h('div', { class: 'btn-row' },
        this.button('驼峰', () => app.editor.addElement('hill'), 'small'),
        this.button('垂直回环', () => app.editor.addElement('loop'), 'small'),
        this.button('翻滚', () => app.editor.addElement('roll'), 'small'),
        this.button('螺旋', () => app.editor.addElement('helix'), 'small')),
      this.tip('回环的大小会按列车开到这里的速度自动计算。'));

    this.viewChips = this.choice('chip', [
      { id: 'persp', name: '透视' }, { id: 'top', name: '顶视' }, { id: 'front', name: '前视' }, { id: 'side', name: '侧视' },
    ], (id) => app.editor.setView(id));
    this.viewChips.set('persp');
    this.snapCheck = this.check('移动节点时吸附到 1 米网格', (v) => app.editor.setSnap(v));
    this.heatCheck = this.check('在轨道上显示 G 力热力图', (v) => app.setHeat(v));
    // 场景段：两种模式都能用
    this.shellCheck = this.check('显示山体和建筑的外壳', (v) => app.setShellVisible(v));
    this.shellCheck.set(true);
    this.secScene = this.sec('场景段',
      this.choice('chip', SCENES.filter((s) => s.id), (id) => app.autoScene(id)),
      h('div', { class: 'btn-row' }, this.button('清除全部场景段', () => app.autoScene(''), 'small')),
      this.shellCheck,
      this.tip('点一种场景，会在现有轨道上自动挑几段布置。室内场景会生成山体或建筑把轨道包起来，运行时列车在室内外之间穿行。关掉外壳可以看到里面。在专业模式里可以给每个节点单独指定场景。'));
    this.secView = this.sec('视图和辅助', this.viewChips, this.snapCheck, this.heatCheck,
      h('div', { class: 'btn-row' },
        this.button('整条轨道抬高 1 米', () => app.editor.shiftAll(1), 'small'),
        this.button('整条轨道降低 1 米', () => app.editor.shiftAll(-1), 'small')),
      this.tip('热力图的颜色：蓝色是失重，绿色接近 1G，黄色约 3G，红色是 5G 以上。'));

    this.styleCards = this.choice('card', TRACK_STYLES, opt('style'));
    this.matChips = this.choice('chip', TRACK_MATERIALS, opt('material'));
    this.railColor = this.color('钢轨颜色', opt('railColor'));
    this.spineColor = this.color('主梁颜色', opt('spineColor'));
    this.supportColor = this.color('支架颜色', opt('supportColor'));
    this.lightSel = this.select('轨道灯带', [{ id: 'off', name: '关闭' }, { id: 'night', name: '天黑以后亮' }, { id: 'on', name: '一直亮' }], opt('lights'));
    this.lightColor = this.color('灯带颜色', opt('lightColor'));
    this.bank = this.slider('自动倾斜', 0, 1, 0.05, (v) => Math.round(v * 100) + '%', opt('bank'));
    this.liftSpeed = this.slider('提升速度', 3, 12, 0.5, (v) => (v * 3.6).toFixed(0) + ' 公里/时', opt('liftSpeed'));
    this.launchSpeed = this.slider('弹射速度', 15, 55, 1, (v) => (v * 3.6).toFixed(0) + ' 公里/时', opt('launchSpeed'));

    root.append(
      this.secTheme, this.secGen, this.secDraw, this.secNode, this.secElem, this.secView, this.secScene,
      this.sec('轨道样式', this.styleCards),
      this.sec('材质和颜色', this.matChips, this.railColor, this.spineColor, this.supportColor),
      this.sec('灯带', this.lightSel, this.lightColor),
      this.sec('运行参数', this.bank, this.liftSpeed, this.launchSpeed,
        this.tip('自动倾斜会让轨道在转弯时向内侧倾斜，乘客受到的横向力更小。')),
    );
  }

  syncTrack() {
    const o = this.app.track.opts;
    this.styleCards.set(o.style);
    this.matChips.set(o.material);
    this.railColor.set(o.railColor);
    this.spineColor.set(o.spineColor);
    this.supportColor.set(o.supportColor);
    this.lightSel.set(o.lights);
    this.lightColor.set(o.lightColor);
    this.bank.set(o.bank);
    this.liftSpeed.set(o.liftSpeed);
    this.launchSpeed.set(o.launchSpeed);
    this.heatCheck.set(this.app.track.showHeat);
  }

  showNode(node, i, total) {
    const has = !!node;
    this.nodeFields.hidden = !has;
    this.nodeEmpty.hidden = has;
    this.nodeTitle.hidden = !has;
    if (!has) return;
    this.nodeTitle.textContent = `第 ${i + 1} 个节点，共 ${total} 个`;
    this.nodeX.value = node.p.x.toFixed(1);
    this.nodeY.value = node.p.y.toFixed(1);
    this.nodeZ.value = node.p.z.toFixed(1);
    this.nodeRoll.set(Math.round(node.roll));
    this.nodeKind.set(node.kind);
    this.nodeAuto.set(node.auto);
    this.nodeScene.set(node.scene || '');
  }

  setViewButton(name) {
    this.viewChips.set(name);
  }

  setDrawing(on) {
    this.drawing = on;
    this.drawBtn.textContent = on ? '取消手绘' : '开始手绘';
    this.drawBtn.classList.toggle('on', on);
    this.updateHint();
  }

  // ---------- 列车 ----------
  buildTrainTab() {
    const app = this.app;
    const root = $('#tab-train');
    const set = (key) => (v) => { app.setTrainOpt(key, v); this.syncTrain(); };
    this.themeCards = this.choice('card', THEMES, (id) => app.applyTheme(id), (t) => [
      h('b', { text: t.name }), h('span', { text: t.desc }),
      h('div', { class: 'dots' }, h('i', { style: `background:${t.body}` }), h('i', { style: `background:${t.accent}` })),
    ]);
    this.seatCards = this.choice('card', SEAT_TYPES, set('seat'));
    this.cars = this.slider('车厢数量', 1, 10, 1, (v) => v + ' 节', set('cars'));
    this.bodyColor = this.color('车身颜色', set('body'));
    this.accentColor = this.color('点缀颜色', set('accent'));
    this.seatColor = this.color('座椅颜色', set('seatColor'));
    this.bodyMat = this.choice('chip', BODY_MATERIALS, set('material'));
    root.append(
      this.sec('主题车厢', this.themeCards, this.tip('选一套主题会同时换掉乘坐方式、颜色和材质，之后还可以在下面单独调整。')),
      this.sec('乘坐方式', this.seatCards),
      this.sec('编组', this.cars),
      this.sec('颜色', this.bodyColor, this.accentColor, this.seatColor),
      this.sec('车身材质', this.bodyMat),
    );
  }

  syncTrain() {
    const t = this.app.state.train;
    this.themeCards.set(t.theme);
    this.seatCards.set(t.seat);
    this.cars.set(t.cars);
    this.bodyColor.set(t.body);
    this.accentColor.set(t.accent);
    this.seatColor.set(t.seatColor);
    this.bodyMat.set(t.material);
  }

  // ---------- 场景 ----------
  buildSceneTab() {
    const app = this.app;
    const root = $('#tab-scene');
    this.envCards = this.choice('card', ENVIRONMENTS, (id) => { app.setEnv(id); this.envCards.set(id); });
    this.weatherChips = this.choice('chip', WEATHERS, (id) => { app.setWeather(id); this.weatherChips.set(id); });
    const fmtTime = (v) => `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.floor((v % 1) * 60)).padStart(2, '0')}`;
    this.timeSlider = this.slider('时间', 0, 24, 0.1, fmtTime, (v) => app.setTime(v), true);
    this.timePresets = h('div', { class: 'chips', style: 'margin-top:8px' }, TIME_PRESETS.map(([name, v]) => h('button', { class: 'chip', text: name, onclick: () => { app.setTime(v); this.timeSlider.set(v); } })));
    this.autoTime = this.check('让时间自动流逝', (v) => app.setAutoTime(v));
    this.qualityChips = this.choice('chip', [{ id: 'low', name: '低' }, { id: 'mid', name: '中' }, { id: 'high', name: '高' }], (id) => { app.setQuality(id); this.qualityChips.set(id); });
    this.soundCheck = this.check('打开声音', (v) => { app.audio.init(); app.audio.setMuted(!v); this.syncSound(); });
    this.musicVol = this.slider('音乐音量', 0, 1, 0.05, (v) => Math.round(v * 100) + '%', (v) => app.audio.setMusicVolume(v), true);
    this.musicVol.set(app.audio.musicVolume);
    this.screamCheck = this.check('乘客的尖叫声和欢呼声', (v) => { app.audio.screamsOn = v; });
    this.screamCheck.set(true);
    root.append(
      this.sec('环境', this.envCards),
      this.sec('天气', this.weatherChips),
      this.sec('时间', this.timeSlider, this.timePresets, this.autoTime,
        this.tip('天黑以后，站台、轨道灯带、路灯和车灯会自动亮起来。')),
      this.sec('画质', this.qualityChips, this.tip('画面卡顿的话可以调低画质。')),
      this.sec('声音', this.soundCheck, this.musicVol, this.screamCheck,
        this.tip('设计时播放舒缓的音乐，运行时换成快节奏的音乐。音乐和人声都是程序实时合成的。')),
    );
  }

  syncScene() {
    const s = this.app.state.scene;
    this.envCards.set(s.env);
    this.weatherChips.set(s.weather);
    this.timeSlider.set(s.time);
    this.autoTime.set(s.autoTime);
    this.qualityChips.set(s.quality);
  }

  syncTime(v) {
    this.timeSlider.set(v.toFixed(1));
  }

  syncSound() {
    const on = !this.app.audio.muted;
    this.soundCheck.set(on);
    $('#btn-mute').textContent = on ? '声音：开' : '声音：关';
  }

  // ---------- 装饰道具 ----------
  buildDecorTab() {
    const app = this.app;
    const root = $('#tab-decor');
    const arm = (id) => {
      const next = app.editor.decorId === id ? null : id;
      app.editor.armDecor(next);
      this.setDecorArmed(next);
    };
    this.decorChips = this.choice('chip', DECOR_ITEMS.filter((d) => d.cat === 'decor'), arm);
    this.propChips = this.choice('chip', DECOR_ITEMS.filter((d) => d.cat === 'prop'), arm);
    this.sceneChips = this.choice('chip', DECOR_ITEMS.filter((d) => d.cat === 'scene'), arm);
    this.decorName = h('div', { class: 'node-title' });
    this.decorPanel = h('div', {}, this.decorName,
      h('div', { class: 'btn-row' },
        this.button('向左转', () => app.editor.rotateDecor(Math.PI / 12), 'small'),
        this.button('向右转', () => app.editor.rotateDecor(-Math.PI / 12), 'small'),
        this.button('放大', () => app.editor.scaleDecor(1.15), 'small'),
        this.button('缩小', () => app.editor.scaleDecor(1 / 1.15), 'small')),
      h('div', { class: 'btn-row' }, this.button('删除这一个', () => app.editor.deleteDecor(), 'small')));
    this.decorEmpty = h('div', { class: 'empty', text: '还没有选中装饰或道具。点一下场景里已经放好的东西，就可以移动、旋转、缩放或删除它。' });
    root.append(
      this.sec('装饰', this.decorChips),
      this.sec('大型布景', this.sceneChips, this.tip('石山可以放大到很大，当作背景。城门会自动跨在最近的一段轨道上。霸王龙会盯着列车看。')),
      this.sec('道具', this.propChips, this.tip('道具会动：摩天轮会转，烟花会放。光环门和隧道会自动套在离它最近的一段轨道上。')),
      this.sec('选中的物体', this.decorPanel, this.decorEmpty),
      this.sec('整理', this.button('清空全部装饰和道具', () => app.clearDecor(), 'block')),
    );
    this.showDecor(null);
  }

  setDecorArmed(id) {
    this.decorChips.set(id);
    this.propChips.set(id);
    this.sceneChips.set(id);
    this.armed = id;
    this.updateHint();
  }

  showDecor(item) {
    this.decorPanel.hidden = !item;
    this.decorEmpty.hidden = !!item;
    if (item) this.decorName.textContent = `${item.def.name}（大小 ${Math.round(item.scale * 100)}%）`;
  }

  // ---------- 测试结果 ----------
  updateStats(track) {
    const a = track.analysis;
    const root = $('#stats');
    root.textContent = '';
    root.append(h('h4', { text: '测试结果' }));
    if (!a) {
      root.append(h('div', { class: 'empty', text: '还没有轨道。' }));
      return;
    }
    const cell = (k, v) => h('div', {}, h('span', { text: k }), h('b', { text: v }));
    root.append(h('div', { class: 'stat-grid' },
      cell('全长', Math.round(a.length) + ' 米'),
      cell('最高时速', Math.round(a.maxSpeed * 3.6) + ' 公里'),
      cell('最高点', Math.round(a.maxHeight) + ' 米'),
      cell('最大落差', Math.round(a.maxDrop) + ' 米'),
      cell('最大正向 G', a.maxG.toFixed(1)),
      cell('最大负向 G', Math.min(a.minG, 1).toFixed(1)),
      cell('最大横向 G', a.maxLat.toFixed(1)),
      cell('翻转次数', a.inversions + ' 次'),
      cell('一圈用时', Math.round(a.duration) + ' 秒'),
      cell('失重时间', a.airtime.toFixed(1) + ' 秒'),
    ));
    const rating = (name, v) => h('div', { class: 'rating' }, h('span', { text: name }),
      h('div', { class: 'bar' }, h('i', { style: `width:${clamp(v * 10, 0, 100)}%` })), h('b', { text: v.toFixed(1) }));
    root.append(rating('刺激度', a.ratings.excitement), rating('强度', a.ratings.intensity), rating('眩晕度', a.ratings.nausea));
    const list = h('ul', { class: 'warns' });
    if (a.warnings.length) a.warnings.forEach((w) => list.append(h('li', { text: w })));
    else list.append(h('li', { class: 'ok', text: '没有发现问题，可以开始运行。' }));
    root.append(list);
  }

  // ---------- 模式和提示 ----------
  syncMode() {
    const mode = this.app.state.mode;
    for (const b of $('#mode-switch').children) b.classList.toggle('on', b.dataset.mode === mode);
    const pro = mode === 'pro';
    this.secGen.hidden = pro;
    this.secTheme.hidden = pro;
    this.secDraw.hidden = pro;
    this.secNode.hidden = !pro;
    this.secElem.hidden = !pro;
    this.secView.hidden = !pro;
    this.updateHint();
  }

  updateHint() {
    let text;
    if (this.drawing) text = '按住鼠标左键在地面上画一圈闭合的路线，松开后自动生成轨道。按 Esc 取消。';
    else if (this.armed) text = '点击地面放置。放好以后可以拖动，R 旋转，+ / - 缩放，Del 删除。按 Esc 结束放置。';
    else if (this.app.state.mode === 'pro') text = '点击圆点选中节点，拖动箭头移动。双击轨道加节点，Q / E 调倾斜角，Del 删除。';
    else text = '左键拖动旋转镜头，右键拖动平移，滚轮缩放。按空格开始运行。';
    $('#hint').textContent = text;
  }

  syncAll() {
    this.syncMode();
    this.syncTrack();
    this.syncTrain();
    this.syncScene();
    this.syncSound();
  }

  showStart(on) {
    const el = $('#start');
    el.classList.toggle('hide', !on);
    if (!on) setTimeout(() => (el.hidden = true), 800);
    $('#edit-ui').hidden = on;
  }

  // ---------- 运行界面 ----------
  buildRide() {
    const app = this.app;
    const sw = $('#cam-switch');
    this.camBtns = new Map();
    for (const c of CAMERAS) {
      const b = h('button', { onclick: () => app.ride.setCamera(c.id) }, c.name, h('small', { text: c.key }));
      this.camBtns.set(c.id, b);
      sw.append(b);
    }
    $('#btn-exit').addEventListener('click', () => app.stopRide());
    $('#btn-rec').addEventListener('click', () => app.ride.toggleRecording());
    $('#btn-shot').addEventListener('click', () => app.ride.screenshot());
    $('#btn-slow').addEventListener('click', () => { app.ride.slow = !app.ride.slow; this.setSlow(app.ride.slow); });
    $('#btn-pause').addEventListener('click', () => { app.ride.paused = !app.ride.paused; this.setPaused(app.ride.paused); });
    $('#btn-mute').addEventListener('click', () => { app.audio.setMuted(!app.audio.muted); this.syncSound(); });
    this.hud = {
      speed: $('#hud-speed'), height: $('#hud-height'), gv: $('#hud-gv'), gl: $('#hud-gl'), time: $('#hud-time'), gbar: $('#hud-gbar'),
    };
    this.msg = $('#ride-msg');
    this.msgKey = '';
  }

  setRiding(on) {
    $('#edit-ui').hidden = on;
    $('#ride-ui').hidden = !on;
    $('#ride-ui').classList.remove('clean');
    this.hudHidden = false;
    this.setPaused(false);
    this.setSlow(false);
    this.setRecording(false, 0);
    this.setMessage('', '');
  }

  setCameraButton(id) {
    this.camBtns.forEach((b, key) => b.classList.toggle('on', key === id));
  }

  setPaused(on) {
    const b = $('#btn-pause');
    b.textContent = on ? '继续' : '暂停';
    b.classList.toggle('on', on);
  }

  setSlow(on) {
    $('#btn-slow').classList.toggle('on', on);
  }

  toggleHud() {
    this.hudHidden = !this.hudHidden;
    $('#ride-ui').classList.toggle('clean', this.hudHidden);
    if (this.hudHidden) this.toast('界面已经隐藏，再按一次 H 可以恢复。');
  }

  setMessage(key, text, btnText, onBtn) {
    if (key === this.msgKey && !btnText) {
      if (key && this.msg.firstChild && this.msg.firstChild.nodeType === 3) this.msg.firstChild.textContent = text;
      return;
    }
    if (key === this.msgKey) return;
    this.msgKey = key;
    this.msg.textContent = '';
    this.msg.hidden = !key;
    if (!key) return;
    this.msg.append(text);
    if (btnText) this.msg.append(h('button', { class: 'btn primary small', text: btnText, onclick: onBtn }));
  }

  showStalled(on) {
    this.stalled = on;
    if (on) {
      this.setMessage('stalled', '列车动力不够，停在了半路。', '推一把（B）', () => {
        this.app.ride.sim.push();
        this.showStalled(false);
      });
    } else if (this.msgKey === 'stalled') this.setMessage('', '');
  }

  setHud(d) {
    const u = this.hud;
    u.speed.textContent = Math.round(d.speed);
    u.height.textContent = Math.round(d.height) + ' 米';
    u.gv.textContent = d.gv.toFixed(1);
    u.gl.textContent = Math.abs(d.gl).toFixed(1);
    u.time.textContent = d.lapTime.toFixed(1) + ' 秒';
    // G 力条的范围是 -2 到 6，1G 的位置在 37.5%
    const g = clamp(d.gv, -2, 6);
    const a = 37.5, b = ((g + 2) / 8) * 100;
    u.gbar.style.left = Math.min(a, b) + '%';
    u.gbar.style.width = Math.abs(b - a) + '%';
    u.gbar.style.background = g > 4.5 || g < -1 ? 'var(--bad)' : g > 3 || g < 0 ? 'var(--warn)' : 'var(--good)';
    if (this.stalled) return;
    if (d.state === 'dwell') this.setMessage('dwell', `列车在站台，${Math.max(0, d.timer).toFixed(0)} 秒后发车。按回车可以立刻发车。`);
    else if (this.msgKey === 'dwell') this.setMessage('', '');
  }

  setRecording(on, seconds) {
    const b = $('#btn-rec');
    b.classList.toggle('on', on);
    const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
    b.lastElementChild.textContent = on ? `停止录制 ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : '录制';
  }

  // ---------- 弹窗和提示 ----------
  buildModals() {
    const video = $('#video-preview');
    $('#video-close').addEventListener('click', () => {
      $('#modal-video').hidden = true;
      video.pause();
      if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
      this.videoUrl = null;
      video.removeAttribute('src');
    });
    $('#help-close').addEventListener('click', () => ($('#modal-help').hidden = true));
  }

  showVideo(url, name, size) {
    this.videoUrl = url;
    if (this.app.ride.active) {
      this.app.ride.paused = true;
      this.setPaused(true);
    }
    $('#video-preview').src = url;
    $('#video-info').textContent = `文件名：${name}，大小约 ${(size / 1048576).toFixed(1)} MB。点“保存视频”会下载到电脑上。`;
    const a = $('#video-save');
    a.href = url;
    a.download = name;
    $('#modal-video').hidden = false;
  }

  toast(text) {
    const el = h('div', { class: 'toast', text });
    const box = $('#toasts');
    box.append(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => (el.style.opacity = '0'), 4200);
    setTimeout(() => el.remove(), 4700);
  }
}
