/* 宽副屏 3840×1100 · 交互与数据(按 DESIGN-TOKENS.md 定稿参数实现) */
'use strict';
(() => {
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json()).catch(() => null);
const get = url => fetch(url).then(r => r.json()).catch(() => null);
const fmtT = s => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const fmtBps = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB/s' : Math.round(b / 1024) + ' KB/s';

/* ---------- Toast ---------- */
let toastT = null;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------- 折线图(design: viewBox 0 0 100 30, 底部留 4) ---------- */
function sparkPaths(vals, min, max) {
  if (!vals || vals.length < 2) return null;
  const lo = min != null ? min : Math.min(...vals);
  const hi = max != null ? max : Math.max(...vals);
  const span = (hi - lo) || 1;
  const n = vals.length;
  const pts = vals.map((v, i) => [(i / (n - 1)) * 100, 30 - ((v - lo) / span) * 26]);
  const line = 'M' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L');
  return { line, area: line + ' L100,30 L0,30 Z' };
}
function drawSpark(svg, vals, opts) {
  const p = sparkPaths(vals, opts && opts.min, opts && opts.max);
  if (!p) { svg.innerHTML = ''; return; }
  const aOp = (opts && opts.areaOp) || 0.10, lOp = (opts && opts.lineOp) || 0.55, w = (opts && opts.w) || 1.4;
  svg.innerHTML = `<path d="${p.area}" fill="var(--accent)" opacity="${aOp}"></path>` +
    `<path d="${p.line}" fill="none" stroke="var(--accent)" stroke-width="${w}" opacity="${lOp}" vector-effect="non-scaling-stroke"></path>`;
}

/* ---------- 页面切换(轨道 translateY + 边缘手势) ---------- */
const PAGE_NAMES = ['CODEX 对话', '仪表盘', '操控台', '媒体'];
const track = $('#track');
const QP = new URLSearchParams(location.search);
/* 换了页序(Claude 插到 0), 换存储键避免读到旧编号; 默认停在仪表盘(1) */
let page = QP.get('page') != null ? Number(QP.get('page')) : Number(localStorage.getItem('wide-page4') || 1);
let dragY = 0, dragging = false;
function applyPage() { track.style.transform = `translateY(${-(page * 1100) + dragY}px)`; }
function gotoPage(p, silent) {
  page = Math.max(0, Math.min(3, p)); dragY = 0;
  track.classList.remove('dragging'); applyPage();
  localStorage.setItem('wide-page4', page);
  if (!silent) {
    const pt = $('#pageToast'); pt.textContent = PAGE_NAMES[page]; pt.classList.add('show');
    clearTimeout(gotoPage._t); gotoPage._t = setTimeout(() => pt.classList.remove('show'), 1400);
  }
}
$$('.edge').forEach(edge => {
  let startY = null, pid = null;
  edge.addEventListener('pointerdown', e => {
    if (gameOn) return;   // 副驾驶页禁用切页手势
    startY = e.clientY; pid = e.pointerId; dragging = true;
    edge.classList.add('active'); track.classList.add('dragging');
    edge.setPointerCapture(pid);
  });
  edge.addEventListener('pointermove', e => {
    if (startY == null) return;
    const scale = window.innerHeight / 1100;
    let dy = (e.clientY - startY) / (scale || 1);
    if ((page === 0 && dy > 0) || (page === 3 && dy < 0)) dy *= 0.25;   // 橡皮筋
    dragY = dy; applyPage();
  });
  const end = e => {
    if (startY == null) return;
    const dy = dragY; startY = null; edge.classList.remove('active');
    setTimeout(() => dragging = false, 50);   // 复位! 否则滑一次页后磁贴点击永远被吞
    if (dy < -180 && page < 3) gotoPage(page + 1);
    else if (dy > 180 && page > 0) gotoPage(page - 1);
    else gotoPage(page, true);
  };
  edge.addEventListener('pointerup', end);
  edge.addEventListener('pointercancel', end);
});
/* 键盘切页 PageUp/PageDown: 统一走 wideFlip(弹层开着会先强制关闭再翻; 游戏副驾驶页不翻) */
window.addEventListener('keydown', e => {
  if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
  e.preventDefault();
  wideFlip(e.key === 'PageUp' ? -1 : 1);
});
if (!localStorage.getItem('omdash-edgehint')) {   // 首次提示 2.6s
  document.body.classList.add('edgehint');
  setTimeout(() => { document.body.classList.remove('edgehint'); localStorage.setItem('omdash-edgehint', '1'); }, 2600);
}
gotoPage(page, true);

/* ---------- 水平/垂直拖动 helper(design: hDrag/vDrag) ---------- */
/* 交互锁: 手指按着滑块/推子期间禁止重绘 DOM(否则 2s 轮询会把正在拖的元素换掉) */
let uiBusy = false, uiBusyT = null;
function lockUI() { uiBusy = true; clearTimeout(uiBusyT); }
function unlockUI() { clearTimeout(uiBusyT); uiBusyT = setTimeout(() => uiBusy = false, 600); }
function hDrag(rail, cb) {
  const set = e => { const r = rail.getBoundingClientRect(); cb(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))); };
  rail.addEventListener('pointerdown', e => {
    e.stopPropagation(); lockUI(); set(e);
    const mv = ev => set(ev);
    const up = () => { unlockUI(); window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
}
function vDrag(fader, cb) {
  const set = e => { const r = fader.getBoundingClientRect(); cb(Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height))); };
  fader.addEventListener('pointerdown', e => {
    e.stopPropagation(); lockUI(); set(e);
    const mv = ev => set(ev);
    const up = () => { unlockUI(); window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
}
function setRail(rail, pct) {
  const i = rail.querySelector('i'), k = rail.querySelector('.knob');
  if (i) i.style.width = pct + '%';
  if (k) k.style.left = pct + '%';
}

/* ---------- 长按(危险 1.5s 线性条 / 应用 0.6s 无进度) ---------- */
function bindHold(el, ms, onFire, onTap) {
  let t0 = 0, raf = 0, fired = false;
  const bar = el.querySelector('.holdbar');
  const tick = () => {
    const pct = Math.min(1, (performance.now() - t0) / ms);
    if (bar) bar.querySelector('i').style.width = (pct * 100) + '%';
    if (pct >= 1) { fired = true; end(); onFire(); return; }
    raf = requestAnimationFrame(tick);
  };
  const start = e => { fired = false; t0 = performance.now(); if (bar) bar.classList.add('active'); raf = requestAnimationFrame(tick); };
  const end = () => { cancelAnimationFrame(raf); if (bar) { bar.classList.remove('active'); bar.querySelector('i').style.width = '0%'; } };
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', () => { const was = fired; end(); if (!was && onTap && performance.now() - t0 < ms) onTap(); });
  el.addEventListener('pointerleave', end);
}

/* ---------- 弹层母版 ---------- */
const ovlMask = $('#ovlMask');
let ovlKind = null, dtlTimer = null;
function openOvl(kind, title, sub, bodyHtml) {
  ovlKind = kind;
  $('#ovlTitle').textContent = title; $('#ovlSub').textContent = sub || '';
  $('#ovlBody').innerHTML = bodyHtml;
  ovlMask.classList.add('show');
}
function closeOvl() { ovlMask.classList.remove('show'); ovlKind = null; clearInterval(dtlTimer); dtlTimer = null; }
ovlMask.addEventListener('pointerdown', e => { if (e.target === ovlMask) closeOvl(); });
$('#ovlClose').addEventListener('pointerup', closeOvl);
$('#ovl').addEventListener('pointerdown', e => e.stopPropagation());

/* ==================== 看板页 ==================== */

/* 性能磁贴(3×2 定稿: GPU/CPU/内存/显存/GPU功耗/网络延迟) */
const TILES = [
  { key: 'gpu',   title: 'GPU',  metric: 'gpuUtil',  detail: 'GPU' },
  { key: 'cpu',   title: 'CPU',  metric: 'cpuUtil',  detail: 'CPU' },
  { key: 'ram',   title: '内存',  metric: 'ram',      detail: '内存' },
  { key: 'vram',  title: '显存',  metric: 'vram',     detail: '显存' },
  { key: 'power', title: 'GPU 功耗', metric: 'gpuPower', detail: 'GPU 功耗' },
  { key: 'net',   title: '网络延迟', metric: 'ping',  detail: '网络' },
];
$('#perfGrid').innerHTML = TILES.map(t => `
  <div class="card ptile press-tile" data-tile="${t.key}">
    <div class="tt"><span class="name">${t.title}</span><span class="model" data-f="model"></span></div>
    <div class="mid">
      <div class="big"><span data-f="big">--</span><span class="unit" data-f="unit"></span></div>
      <div class="sub"><span class="v" data-f="subv">--</span><span class="l" data-f="subl"></span></div>
    </div>
    <svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none"></svg>
  </div>`).join('');

let stats = null, hist = {};
function tileSet(key, f, v) { const el = document.querySelector(`[data-tile="${key}"] [data-f="${f}"]`); if (el) el.textContent = v; }
function renderTiles() {
  if (!stats) return;
  const g = stats.gpu || {}, c = stats.cpu || {}, r = stats.ram || {}, io = stats.io || {};
  tileSet('gpu', 'model', g.short || ''); tileSet('gpu', 'big', g.util != null ? g.util : '--'); tileSet('gpu', 'unit', '%');
  tileSet('gpu', 'subv', (g.temp || 0) + '°C'); tileSet('gpu', 'subl', '核心温度');
  tileSet('cpu', 'model', c.short || ''); tileSet('cpu', 'big', c.util != null ? c.util : '--'); tileSet('cpu', 'unit', '%');
  tileSet('cpu', 'subv', ((c.clock || 0) / 1000).toFixed(1) + 'GHz'); tileSet('cpu', 'subl', '当前频率');
  tileSet('ram', 'big', (r.usedGB || 0).toFixed(1)); tileSet('ram', 'unit', 'GB');
  tileSet('ram', 'subv', Math.round((r.usedGB / (r.totalGB || 1)) * 100) + '%'); tileSet('ram', 'subl', '占用率');
  tileSet('vram', 'big', ((g.vramUsed || 0) / 1024).toFixed(1)); tileSet('vram', 'unit', 'GB');
  tileSet('vram', 'subv', Math.round(((g.vramUsed || 0) / (g.vramTotal || 1)) * 100) + '%'); tileSet('vram', 'subl', '占用率');
  tileSet('power', 'big', Math.round(g.power || 0)); tileSet('power', 'unit', 'W');
  tileSet('power', 'subv', Math.round(g.fan || 0) + '%'); tileSet('power', 'subl', 'GPU 风扇');
  const ping = (extras && extras.net && extras.net.ping);
  tileSet('net', 'big', ping != null ? ping : '--'); tileSet('net', 'unit', 'ms');
  tileSet('net', 'subv', extras && extras.net ? fmtBps(extras.net.rx || 0) : '--'); tileSet('net', 'subl', '下行');
  /* 操控台迷你性能卡 */
  const cg = $('#cGpu'); if (cg) cg.textContent = `${g.util != null ? g.util : '--'}% · ${g.temp || '--'}°C`;
  const cc = $('#cCpu'); if (cc) cc.textContent = `${c.util != null ? c.util : '--'}% · ${((c.clock || 0) / 1000).toFixed(1)}GHz`;
  const cr = $('#cRam'); if (cr) cr.textContent = `${(r.usedGB || 0).toFixed(1)} GB`;
}
function renderTileSparks() {
  for (const t of TILES) {
    const svg = document.querySelector(`[data-tile="${t.key}"] svg.spark`);
    if (svg && hist[t.metric]) drawSpark(svg, hist[t.metric]);
  }
}

/* 磁贴详情弹层 */
const DETAIL_META = {
  gpu:  { metric: 'gpuUtil', unit: '%', label: '利用率', kv: s => [['利用率', s.gpu.util + '%'], ['核心温度', s.gpu.temp + '°C'], ['功耗', Math.round(s.gpu.power) + 'W'], ['风扇', s.gpu.fan + '%'], ['显存', (s.gpu.vramUsed / 1024).toFixed(1) + '/' + Math.round(s.gpu.vramTotal / 1024) + 'GB'], ['核心频率', (s.gpu.clock / 1000).toFixed(2) + 'GHz']] },
  cpu:  { metric: 'cpuUtil', unit: '%', label: '利用率', kv: s => [['利用率', s.cpu.util + '%'], ['频率', (s.cpu.clock / 1000).toFixed(1) + 'GHz'], ['进程数', s.sys ? s.sys.procs : '--'], ['内存', s.ram.usedGB.toFixed(1) + 'GB'], ['磁盘读', fmtBps(s.io.read || 0)], ['磁盘写', fmtBps(s.io.write || 0)]] },
  ram:  { metric: 'ram', unit: 'GB', label: '内存占用', kv: s => [['已用', s.ram.usedGB.toFixed(1) + 'GB'], ['总量', Math.round(s.ram.totalGB) + 'GB'], ['占用率', Math.round(s.ram.usedGB / s.ram.totalGB * 100) + '%'], ['进程数', s.sys ? s.sys.procs : '--'], ['磁盘读', fmtBps(s.io.read || 0)], ['磁盘写', fmtBps(s.io.write || 0)]] },
  vram: { metric: 'vram', unit: 'GB', label: '显存占用', kv: s => [['已用', (s.gpu.vramUsed / 1024).toFixed(1) + 'GB'], ['总量', Math.round(s.gpu.vramTotal / 1024) + 'GB'], ['占用率', Math.round(s.gpu.vramUsed / (s.gpu.vramTotal || 1) * 100) + '%'], ['GPU 利用率', s.gpu.util + '%'], ['核心频率', (s.gpu.clock / 1000).toFixed(2) + 'GHz'], ['温度', s.gpu.temp + '°C']] },
  power:{ metric: 'gpuPower', unit: 'W', label: 'GPU 功耗', kv: s => [['功耗', Math.round(s.gpu.power) + 'W'], ['风扇', s.gpu.fan + '%'], ['温度', s.gpu.temp + '°C'], ['利用率', s.gpu.util + '%'], ['核心频率', (s.gpu.clock / 1000).toFixed(2) + 'GHz'], ['显存', (s.gpu.vramUsed / 1024).toFixed(1) + 'GB']] },
  net:  { metric: 'ping', unit: 'ms', label: '网络延迟', kv: () => [['延迟', (extras.net.ping != null ? extras.net.ping : '--') + 'ms'], ['下行', fmtBps(extras.net.rx || 0)], ['上行', fmtBps(extras.net.tx || 0)], ['状态', extras.net.ok ? '正常' : '异常'], ['丢包率', '—'], ['Ping 主机', '223.5.5.5']] },
};
let dtlTier = 1;
async function renderDetail(key) {
  const meta = DETAIL_META[key];
  const r = await get(`/api/history?metric=${meta.metric}&tier=${dtlTier}`);
  const svg = $('#dtlChart'); if (!svg) return;
  drawSpark(svg, (r && r.points) || [], { areaOp: 0.12, lineOp: 1, w: 1.2, min: 0 });
  const nowEl = $('#dtlNow');
  const last = r && r.points && r.points.length ? r.points[r.points.length - 1] : '--';
  if (nowEl) nowEl.innerHTML = `${esc(last)}<span class="u">${meta.unit}</span>`;
  if (stats) $('#dtlSide').innerHTML = meta.kv(stats).map(kv => `<div class="dtl-kv"><div class="k">${esc(kv[0])}</div><div class="v">${esc(kv[1])}</div></div>`).join('');
}
function openDetail(key) {
  const meta = DETAIL_META[key], t = TILES.find(x => x.key === key);
  dtlTier = 1;
  openOvl('detail', t.detail + (key === 'gpu' && stats ? ' · ' + (stats.gpu.short || '') : ''), '从看板磁贴打开', `
    <div id="dtl">
      <div id="dtlLeft">
        <svg id="dtlChart" viewBox="0 0 100 30" preserveAspectRatio="none"></svg>
        <div id="dtlNow">--</div>
        <div id="dtlRanges">
          <div class="range-btn press-sm" data-tier="0">10 分钟</div>
          <div class="range-btn on press-sm" data-tier="1">1 小时</div>
          <div class="range-btn press-sm" data-tier="2">6 小时</div>
        </div>
      </div>
      <div id="dtlSide"></div>
    </div>`);
  $$('#dtlRanges .range-btn').forEach(b => b.addEventListener('pointerup', () => {
    dtlTier = Number(b.dataset.tier);
    $$('#dtlRanges .range-btn').forEach(x => x.classList.toggle('on', x === b));
    renderDetail(key);
  }));
  renderDetail(key);
  dtlTimer = setInterval(() => renderDetail(key), 5000);
}
$('#perfGrid').addEventListener('pointerup', e => {
  const tile = e.target.closest('.ptile');
  if (tile && !dragging) openDetail(tile.dataset.tile);
});

/* 时钟 + 农历 + 吉祥物 */
function renderClock() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0'), ss = String(d.getSeconds()).padStart(2, '0');
  $('#clockTime').innerHTML = `${hh}:${mm}<span class="sec">${ss}</span>`;
  let lunar = '';
  try { const l = Lunar.date(d); lunar = ` · 农历${l.isLeap ? '闰' : ''}${l.monthCn}${l.dayCn}`; } catch {}
  $('#clockDate').innerHTML = `<b>${Lunar.weekCn ? Lunar.weekCn(d) : ''}</b> · ${d.getMonth() + 1}月${d.getDate()}日${lunar}`;
  $('#cTime').textContent = `${hh}:${mm}`;
  $('#cDate').textContent = `${d.getMonth() + 1}月${d.getDate()}日 ${Lunar.weekCn ? Lunar.weekCn(d) : ''}`;
  const g = $('#gClock'); if (g) g.textContent = `${hh}:${mm}`;
}
setInterval(renderClock, 1000); renderClock();
/* 像素吉祥物(16×16, --accent 着色) */
(() => {
  const P = ['0000011111100000','0000111111110000','0001111111111000','0011011111101100','0011011111101100','0111111111111110','0111111111111110','0111101111011110','0111111111111110','0011111111111100','0011101111011100','0001111111111000','0000110110110000','0001100110011000','0011000110001100','0000000000000000'];
  let svg = '';
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (P[y][x] === '1') svg += `<rect x="${x}" y="${y}" width="1" height="1" fill="var(--accent)"/>`;
  $('#mascot').innerHTML = svg;
})();

/* Codex 用量: 只读 Codex App Server，限额桶按官方实际返回动态显示。 */
function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (Math.round(n / 1e8) / 10) + 'B';
  if (n >= 1e6) return (Math.round(n / 1e5) / 10) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}
function latestDayTokenLine(u) {
  if (!u || !u.latestDayDate) return u && u.todayTokens != null ? '今日 ' + fmtTokens(u.todayTokens) + ' token' : '';
  const n = u.latestDayTokens != null ? u.latestDayTokens : u.todayTokens;
  const now = new Date(), today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const label = u.latestDayDate === today ? '今日' : u.latestDayDate.slice(5).replace('-', '/');
  return label + ' ' + fmtTokens(n) + ' token';
}
function shortLimitName(m) {
  if (!m) return '—';
  const win = m.windowMins === 10080 ? '周额度'
    : m.windowMins && m.windowMins % 60 === 0 ? (m.windowMins / 60) + ' 小时额度'
    : '额度';
  return (m.name || 'Codex') + ' ' + win;
}
function putUsageBar(rowSel, labelSel, pctSel, barSel, m) {
  const row = $(rowSel), pct = m && m.pct != null ? Math.round(m.pct) : null;
  if (row) row.classList.toggle('usage-hidden', !m);
  if (!m) return;
  $(labelSel).textContent = shortLimitName(m);
  $(pctSel).textContent = pct + '%';
  $(barSel).style.width = Math.min(100, Math.max(0, pct)) + '%';
}
async function pollCodex() {
  const c = await get('/api/codex'); if (!c) return;
  const u = c.usage || {}, main = u.main || null;
  const all = Array.isArray(u.buckets) ? u.buckets : [];
  const aux = all.filter(x => !main || x.key !== main.key);
  const mp = main && main.pct != null ? Math.round(main.pct) : null;
  const CIRC = 2 * Math.PI * 43;

  $('#usageSessPct').textContent = mp != null ? mp + '%' : '--';
  $('#usageRing').setAttribute('stroke-dasharray', `${((mp || 0) / 100) * CIRC} ${CIRC}`);
  $('#usageRingLabel').textContent = main ? shortLimitName(main) : 'Codex 周额度';
  putUsageBar('#usageAuxRow1', '#usageAuxLabel1', '#usageWeekPct', '#usageWeekBar', aux[0]);
  putUsageBar('#usageAuxRow2', '#usageAuxLabel2', '#usageScopedPct', '#usageScopedBar', aux[1]);

  // 有上次有效桶时继续显示额度；网络短暂失败只作为轻量状态，不把 25%/0% 覆盖成错误长串。
  let meta = '';
  if (main && main.resetsAt) meta = `主额度 ${fmtLeft(main.resetsAt - Date.now())}重置 · ${fmtAbs(main.resetsAt)}`;
  if (c.error && !main && !all.length) meta = '⚠ Codex 用量暂不可用 · 正在重试';
  else if (c.error && meta) meta += ' · 上次有效值';
  $('#usageMeta').textContent = meta || '—';
  const bits = [];
  const dayLine = latestDayTokenLine(u); if (dayLine) bits.push(dayLine);
  if (u.weekTokens != null) bits.push('近 7 日 ' + fmtTokens(u.weekTokens));
  if (u.summary && u.summary.lifetimeTokens != null) bits.push('累计 ' + fmtTokens(u.summary.lifetimeTokens));
  $('#usageTok').classList.remove('warn', 'crit');
  $('#usageTok').textContent = bits.join(' · ');

  /* ⓪ 页迷你额度窗联动；最多三条，有几种官方额度就显示几条。 */
  const mini = [main, ...aux].filter(Boolean).slice(0, 3);
  const slots = [
    ['#csUsageRow0', '#csMainLabel', '#csSessPct', '#csSessBar'],
    ['#csUsageRow1', '#csAuxLabel1', '#csWeekPct', '#csWeekBar'],
    ['#csUsageRow2', '#csAuxLabel2', '#csScPct', '#csScBar'],
  ];
  slots.forEach((s, i) => putUsageBar(...s, mini[i]));
  $('#csUsageMeta').textContent = meta || (u.weekTokens != null ? '近 7 日 ' + fmtTokens(u.weekTokens) + ' token' : '—');
}
setInterval(pollCodex, 30 * 1000); pollCodex();

/* ---------- 额度详情弹层(点会话额度卡打开): 全部限额 + 历史走势 ---------- */
const USG_COLORS = ['#5B9CF5', '#B48CF2', '#F59E0B', '#4FB6A5', '#F87171'];
let usgSeries = [];
function syncUsageSeries(d) {
  const lims = (d && d.limits) || [];
  usgSeries = lims.map((l, i) => ({
    k: l.key,
    label: l.label || l.name || l.limitId || 'Codex',
    hex: USG_COLORS[i % USG_COLORS.length],
    // 长周期额度在电脑关机时不会自己变化；只有重置时间没跨过去才允许横向补齐。
    hold: (l.windowMins || 0) >= 24 * 60,
    windowMins: l.windowMins || 0,
  }));
}
let usgHours = 24;
// 0 = 全部历史(服务端永久保留, 点多了会分桶抽稀后再给)
const USG_RANGES = [[1, '1 小时'], [6, '6 小时'], [12, '12 小时'], [24, '24 小时'], [24 * 7, '7 天'], [24 * 30, '30 天'], [0, '全部']];
function fmtAbs(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtLeft(ms) {
  if (ms <= 0) return '已过';
  const h = Math.floor(ms / 3600000), m = Math.round(ms % 3600000 / 60000);
  if (h >= 48) return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时后';
  return (h ? h + ' 小时 ' : '') + m + ' 分钟后';
}
function fmtDay(ts) { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; }
function fmtKB(b) {
  if (!b) return '—';
  return b < 1024 * 1024 ? Math.round(b / 1024) + ' KB' : (Math.round(b / 1048576 * 10) / 10) + ' MB';
}
function fmtAgo(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分前';
}
function usgKindLabel(l) { return l.label || shortLimitName(l); }
/* 按最近 1 小时的用量增速, 预估还有多久到 100%(给周额度卡用)。
   基准取"1 小时前那一刻"的采样值, 现值取限额接口的实时 percent, 算 %/小时后线性外推。
   history 点: {t,b:{额度桶key:%},r:{额度桶key:重置时间}}；期间若掉一大截视为重置过、不给预估。 */
function histVal(p, key) { return p && p.b ? p.b[key] : null; }
function projToFull(key, curPct, history) {
  if (!key || curPct == null) return null;
  const now = Date.now(), winStart = now - 3600 * 1000;
  const pts = (history || []).filter(p => histVal(p, key) != null);
  if (!pts.length) return null;
  let base = null;                                   // 窗口起点前最后一个点 = 1 小时前的值; 没有就用最早的点
  for (const p of pts) { if (p.t <= winStart) base = p; else break; }
  if (!base) base = pts[0];
  const dtH = (now - base.t) / 3600000;
  if (dtH < 1 / 12) return null;                      // 跨度不足 5 分钟, 估不准
  const dv = curPct - histVal(base, key);
  if (dv < -0.5) return { reset: true };              // 掉一大截 = 期间重置过
  const rate = dv / dtH;                              // %/小时
  if (rate < 0.05) return { flat: true };             // 基本不涨
  return { hours: (100 - curPct) / rate };
}
function fmtDur(h) {
  if (h >= 24) { const d = Math.floor(h / 24), r = Math.round(h % 24); return d + ' 天' + (r ? ' ' + r + ' 小时' : ''); }
  if (h >= 10) return Math.round(h) + ' 小时';
  return (Math.round(h * 10) / 10) + ' 小时';
}
function projLine(key, curPct, history) {
  if (curPct != null && curPct >= 100) return '<div class="proj crit">⏳ 已到本周上限</div>';
  const p = projToFull(key, curPct, history);
  if (!p) return '<div class="proj dim">⏳ 近 1 时样本不足 · 暂无预估</div>';
  if (p.reset) return '<div class="proj dim">⏳ 近 1 小时内已重置 · 重新累积中</div>';
  if (p.flat) return '<div class="proj dim">⏳ 近 1 小时基本不涨</div>';
  const cls = p.hours <= 6 ? 'proj crit' : p.hours <= 24 ? 'proj warn' : 'proj';
  return `<div class="${cls}">⏳ 按近 1 时速度 · 约 <b>${fmtDur(p.hours)}</b>到 100%</div>`;
}
function drawUsageChart(d) {
  const svg = $('#usgChart'), xl = $('#usgXlab'); if (!svg) return;
  const hist = d.history || [];
  // "全部"档(usgHours=0): 左端取最早那个采样点; 还没数据就退回 1 小时, 免得 span=0
  const now = Date.now();
  const t0 = usgHours > 0 ? now - usgHours * 3600 * 1000
                          : (hist.length ? Math.min(hist[0].t, now - 3600 * 1000) : now - 3600 * 1000);
  const span = now - t0;
  const X = t => ((t - t0) / span) * 1000;
  const Y = v => 290 - (v / 100) * 270;   // viewBox 1000x300, 上下留 10/20
  const gapMs = Math.max(span / 40, 20 * 60 * 1000);   // 断档(半夜关机 / 服务没跑)阈值
  let out = [25, 50, 75, 100].map(v =>
    `<line x1="0" x2="1000" y1="${Y(v)}" y2="${Y(v)}" stroke="#1a212c" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join('');
  /* 断档怎么画:
     - 长周期线: 仅当重置时间仍相同，才按上一个值平推过断档，到下一个采样点再阶跃；
     - 重置时间变了或短周期窗口: 断档期间发生了什么无法确认，一律断开，不做假插值。 */
  for (const s of usgSeries) {
    let dstr = '', prevT = 0, prevV = 0, prevReset = null;
    for (const p of hist) {
      const v = histVal(p, s.k);
      if (v == null) { prevT = 0; continue; }
      const x = X(p.t).toFixed(1), y = Y(v).toFixed(1);
      const gap = prevT && p.t - prevT > gapMs;
      const reset = p.r && p.r[s.k];
      if (gap && s.hold && reset === prevReset && v + 0.5 >= prevV) dstr += `L${x},${Y(prevV).toFixed(1)}L${x},${y}`;   // 同一周期才平推
      else dstr += `${!prevT || gap ? 'M' : 'L'}${x},${y}`;
      prevT = p.t; prevV = v; prevReset = reset;
    }
    if (dstr) out += `<path d="${dstr}" fill="none" stroke="${s.hex}" stroke-width="2.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  svg.innerHTML = out;
  /* 时间刻度(HTML 层, 不随 SVG 拉伸变形): 按档位选"整"时间步长, 短档到分钟、密一点 */
  if (xl) {
    const M = 60000, DAY = 1440 * M;
    const steps = [5 * M, 10 * M, 15 * M, 30 * M, 60 * M, 120 * M, 180 * M, 360 * M, 720 * M, DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY];
    let step = 0;
    for (const s of steps) { if (span / s <= 12) { step = s; break; } }   // 目标 ≤12 个刻度
    const mode = !step ? 'month' : step >= DAY ? 'day' : 'time';          // 半年以上没有合适步长 -> 按月
    const yearly = span > 400 * DAY;                                      // 跨年了就把年份标上, 否则"8月"分不清哪年
    const tickTs = [];
    if (mode === 'month') {                            // 按月初打点; 隔几个月取 12 的因子, 保证每年落在相同月份
      const per = [1, 2, 3, 6, 12].find(v => span / DAY / 30.44 / v <= 12) || 12;
      const c = new Date(t0); c.setDate(1); c.setHours(0, 0, 0, 0);
      while (c.getTime() < t0) c.setMonth(c.getMonth() + 1);
      for (; c.getTime() <= now; c.setMonth(c.getMonth() + per)) tickTs.push(c.getTime());
    } else if (mode === 'day') {                       // 按天: 对齐本地午夜
      const d0 = new Date(t0); d0.setHours(0, 0, 0, 0);
      for (let t = d0.getTime(); t <= now; t += step) { if (t >= t0) tickTs.push(t); }
    } else {                                           // 小时/分钟: 对齐"整"边界(中国 +8 为整小时, epoch 对齐即整点整分)
      for (let t = Math.ceil(t0 / step) * step; t <= now; t += step) tickTs.push(t);
    }
    xl.innerHTML = tickTs.map(t => {
      const dt = new Date(t), leftPct = (t - t0) / span * 100;
      const lb = mode === 'month' ? (yearly || !dt.getMonth() ? String(dt.getFullYear()).slice(2) + '/' + (dt.getMonth() + 1) : (dt.getMonth() + 1) + '月')
               : mode === 'day' ? (dt.getMonth() + 1) + '/' + dt.getDate()
               : String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
      const tf = leftPct < 4 ? 'translateX(0)' : leftPct > 96 ? 'translateX(-100%)' : 'translateX(-50%)';   // 两端不出界
      return `<span style="left:${leftPct.toFixed(1)}%;transform:${tf}">${lb}</span>`;
    }).join('');
  }
  /* 右端当前值标签: Y 轴刻度在左, 右端(=现在)原本没参照 -> 在右边贴各线当前 % (颜色对应图例)。
     几条线数值挨得近时(如刚重置后 16/18/20%)标签会叠成一坨 -> 防重叠: 按理想位置排序,
     相邻不足一个标签高就对半推开、迭代到收敛, 最后整体夹回框内。推开后仍靠颜色对应到各自的线。 */
  const nowEl = $('#usgNow');
  if (nowEl) {
    const curOf = new Map(((d && d.limits) || []).map(l => [l.key, l]));
    const items = [];
    for (const s of usgSeries) {
      let v = curOf.get(s.k) ? curOf.get(s.k).pct : null;
      if (v == null) { for (let i = hist.length - 1; i >= 0; i--) { const hv = histVal(hist[i], s.k); if (hv != null) { v = hv; break; } } }
      if (v == null) continue;
      items.push({ hex: s.hex, v, y: Y(v) / 300 * 100 });     // y = 理想位置(占框高的 %)
    }
    /* 先按理想位置画出来, 再用"真实量到的标签高"算间距(别写死常量: 字号/缩放变了会失准) */
    nowEl.innerHTML = items.map(it =>
      `<span style="top:${it.y.toFixed(1)}%;color:${it.hex}">${Math.round(it.v)}%</span>`).join('');
    const spans = [...nowEl.querySelectorAll('span')];
    items.forEach((it, i) => { it.el = spans[i]; });
    const boxH = nowEl.clientHeight || 640;
    const tagH = (spans[0] && spans[0].offsetHeight) || 37;
    const gap = Math.min(30, (tagH + 8) / boxH * 100);        // 标签实高 + 8px 呼吸空间
    items.sort((a, b) => a.y - b.y);
    for (let n = 0; n < 16 && items.length > 1; n++) {
      let moved = false;
      for (let i = 1; i < items.length; i++) {
        const over = items[i - 1].y + gap - items[i].y;
        if (over > 0.01) { items[i - 1].y -= over / 2; items[i].y += over / 2; moved = true; }
      }
      if (!moved) break;
    }
    if (items.length) {                                        // 整体平移夹回框内(保持已拉开的间距)
      const lo = gap / 2, hi = 100 - gap / 2;
      const down = Math.max(0, lo - items[0].y);
      for (const it of items) it.y += down;
      const up = Math.max(0, items[items.length - 1].y - hi);
      for (const it of items) it.y -= up;
    }
    for (const it of items) it.el.style.top = it.y.toFixed(1) + '%';   // 位置写回(元素已在, 别重建)
  }
  const hint = $('#usgEmpty');
  if (hint) hint.style.display = hist.length > 1 ? 'none' : '';
}
async function renderUsageOvl() {
  const d = await get('/api/usage/detail?hours=' + usgHours);
  if (!d || ovlKind !== 'usage') return;
  syncUsageSeries(d);
  drawUsageChart(d);
  $('#usgLegend').innerHTML = usgSeries.map(s => `<span><i style="background:${s.hex}"></i>${esc(s.label)}</span>`).join('');
  /* 各限额卡: Codex 官方返回几种额度就画几条，兼容主额度/模型额度/未来短周期额度。 */
  const sevCls = s => s === 'critical' || s === 'exceeded' ? 'crit' : (s === 'warning' || s === 'high' ? 'warn' : '');
  const lims = (d.limits && d.limits.length) ? d.limits : null;
  const rows = lims ? lims.map((l, i) => {
    const pct = Math.round(l.pct || 0);
    const rst = l.resetsAt || null;
    const color = (usgSeries[i] && usgSeries[i].hex) || USG_COLORS[i % USG_COLORS.length];
    // 只对 7 天及以上限额做一小时速度外推；短窗口滚动太快，外推没有实际意义。
    const isWeek = (l.windowMins || 0) >= 7 * 24 * 60;
    // 用 recent(近 100 分钟原始点)而不是 history: 长档位的 history 被抽稀过, 拿它算速度会失真
    const proj = isWeek ? projLine(l.key, l.pct, d.recent || d.history) : '';
    return `<div class="usg-limit">
      <div class="row"><span class="nm">${esc(usgKindLabel(l))}</span><b class="pv ${sevCls(l.severity)}">${pct}%</b></div>
      <div class="hbar"><i style="width:${Math.min(100, pct)}%;background:${color}"></i></div>
      <div class="rs">${rst ? '重置 ' + fmtLeft(rst - Date.now()) + ' · ' + fmtAbs(rst) : '—'}</div>
      ${proj}
    </div>`;
  }).join('') : '<div class="empty">尚未拉到额度数据</div>';
  const metas = [];
  metas.push(['上次更新', d.fetchedAt ? fmtAgo(Date.now() - d.fetchedAt) : '—']);
  metas.push(['采样间隔', d.intervalMin + ' 分钟']);
  // 点数攒过 4000 后, 服务端会分桶抽稀再给图 -> 明说抽到了多少点, 别让人以为图上是全量
  // 点数攒过 4000 后, 服务端会分桶抽稀再给图 -> 明说图上取了多少点, 别让人以为画的是全量
  const thin = d.historyShown && d.history && d.history.length < d.historyShown ? ' · 图取 ' + d.history.length + ' 点' : '';
  const from = d.historyFrom && !thin ? ', 起自 ' + fmtDay(d.historyFrom) : '';   // 抽稀时挤不下"起自", 让位(全部档 x 轴左端本来就写着起始日)
  metas.push(['历史样本', (d.historyTotal || 0) + ' 点 · ' + fmtKB(d.historyBytes) + ' · 永久留存' + from + thin]);
  const u = d.usage || {}, sm = u.summary || {};
  if (u.latestDayDate) metas.push([(u.latestDayDate.slice(5).replace('-', '/') + ' token'), fmtTokens(u.latestDayTokens)]);
  else if (u.todayTokens != null) metas.push(['今日 token', fmtTokens(u.todayTokens)]);
  if (u.weekTokens != null) metas.push(['近 7 日 token', fmtTokens(u.weekTokens)]);
  if (sm.lifetimeTokens != null) metas.push(['累计 token', fmtTokens(sm.lifetimeTokens)]);
  if (sm.longestRunningTurnSec != null) metas.push(['最长任务', Math.round(sm.longestRunningTurnSec / 60) + ' 分钟']);
  if (sm.currentStreakDays != null) metas.push(['连续使用', sm.currentStreakDays + ' 天']);
  if (u.resetCredits && u.resetCredits.availableCount != null) metas.push(['可用额度重置', u.resetCredits.availableCount + ' 次']);
  if (u.tokenActivityError) metas.push(['token 活动', '暂不可用']);
  if (d.error) metas.push(['刷新状态', d.limits && d.limits.length ? '上次有效值 · 正在重试' : '暂不可用 · 正在重试']);
  $('#usgSide').innerHTML = rows +
    `<div class="usg-meta">${metas.map(m => `<div class="mrow"><span>${esc(m[0])}</span><b>${esc(m[1])}</b></div>`).join('')}</div>`;
}
function openUsageOvl() {
  openOvl('usage', 'CODEX 用量', '官方 Codex App Server · 每分钟只读采样 · 限额桶动态识别', `
    <div id="usgOvl">
      <div id="usgLeft">
        <svg id="usgChart" viewBox="0 0 1000 300" preserveAspectRatio="none"></svg>
        <div id="usgNow"></div>
        <div id="usgYlab"><span style="top:6.7%">100</span><span style="top:29.2%">75</span><span style="top:51.7%">50</span><span style="top:74.2%">25</span></div>
        <div id="usgXlab"></div>
        <div id="usgLegend"></div>
        <div id="usgEmpty">历史采样中 · 额度每次刷新自动记一个点</div>
        <div id="usgRanges">${USG_RANGES.map(([h, n]) =>
          `<div class="range-btn press-sm ${h === usgHours ? 'on' : ''}" data-h="${h}">${n}</div>`).join('')}</div>
      </div>
      <div id="usgSide"><div class="empty">读取中…</div></div>
    </div>`);
  $$('#usgRanges .range-btn').forEach(b => b.addEventListener('pointerup', () => {
    usgHours = Number(b.dataset.h);
    $$('#usgRanges .range-btn').forEach(x => x.classList.toggle('on', x === b));
    renderUsageOvl();
  }));
  renderUsageOvl();
  dtlTimer = setInterval(renderUsageOvl, 30 * 1000);
}
$('#usageCard').addEventListener('pointerup', () => { if (!dragging) openUsageOvl(); });

/* ==================== ⓪ Codex 会话页 ==================== */
const CS_KIND = { approve: '等你批授权', choose: '等你选选项', reply: '等你回复' };
const CS_CHIP = { running: '运行中', waiting: '等你操作', done: '已完成' };
/* 设备配色: 两台机器的对话混在一列里, 靠颜色+短标一眼分开。
   没登记过的设备名会走 hash 兜底配色, 以后再接第三台也不用改代码。 */
const CS_DEV_COLOR = { 'PC': '#5B9CF5', 'Windows': '#4FB6A5', 'Mac': '#B48CF2' };
const CS_DEV_FALLBACK = ['#4FB6A5', '#E08B4F', '#C77DBB', '#7C9BE0'];
function csDevLabel(d) {
  return String(d || 'PC').replace(/\s*·\s*Codex\s*$/i, '');
}
function csDevColor(d) {
  if (CS_DEV_COLOR[d]) return CS_DEV_COLOR[d];
  let h = 0; for (const ch of String(d || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CS_DEV_FALLBACK[h % CS_DEV_FALLBACK.length];
}
/* 已读键带上设备: 两台机器的短 sid 理论上会撞, 撞了就会"我标了这台的已读, 那台的卡也没了" */
function csKey(s) { return (s.device || 'PC') + ':' + s.sid; }
/* MCP 工具名原样是 mcp__Claude_Browser__javascript_tool 这种, 又长又难读 -> 压成「服务 · 方法」。
   动作文案是 hook 从 PreToolUse 现算的, 普通工具已经是"读 xx / 改 xx / $ 命令"了, 只需收拾 MCP 这类。 */
function csAct(t) {
  const m = String(t || '').match(/^(?:用\s+)?mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  return m ? m[1].replace(/_/g, ' ') + ' · ' + m[2].replace(/_/g, ' ') : t;
}
function csAge(ms) { const m = Math.round(ms / 60000); return m < 1 ? '刚刚' : m + ' 分钟前'; }
/* 已读表: sid -> 知悉时刻的事件 ts。会话再动 ts 就变新 -> 自动重新算"未读" */
let csRead = {};
try { csRead = JSON.parse(localStorage.getItem('cs-read') || '{}'); } catch {}
function csMarkRead(sid, ts) {
  csRead[sid] = ts;
  const cut = Date.now() - 24 * 3600 * 1000;   // 顺手清一天前的旧记录
  for (const k of Object.keys(csRead)) if (csRead[k] < cut) delete csRead[k];
  localStorage.setItem('cs-read', JSON.stringify(csRead));
  csSig = ''; pollSessions();
}
let csSig = '', csLast = null;
async function getSessionSnapshot() {
  /* supervisor 是 Codex 会话的唯一汇总层：本机 hooks/App Server 与 Mac 中继事件都在这里。
     旧 /api/claude/sessions 只作 supervisor 暂时不可达时的本机兜底，避免管理台重启瞬间整页闪空。 */
  try {
    const res = await fetch('http://127.0.0.1:3778/api/sessions', { cache: 'no-store' });
    if (res.ok) return await res.json();
  } catch { /* 退回 3777 本机快照 */ }
  return await get('/api/claude/sessions');
}
async function pollSessions() {
  const r = await getSessionSnapshot(); if (!r) return;
  csLast = r;
  const c = r.counts || {};
  /* 已完成且点过"知悉"的隐藏; 会话若有新动静(ts 更新)会自动重新出现 */
  const list = (r.sessions || []).filter(s => !(s.status === 'done' && csRead[csKey(s)] >= s.ts));
  const hidden = (r.sessions || []).length - list.length;
  $('#csTotal').textContent = Math.max(0, (c.total || 0) - hidden);
  $('#csRunning').textContent = c.running || 0;
  $('#csWaiting').textContent = c.waiting || 0;
  $('#csWaitWrap').classList.toggle('warn', (c.waiting || 0) > 0);
  // 项目目录只用于诊断，不是会话名。正式标题来自 App Server thread.name；
  // name 尚未生成时显示中性文案，绝不把 PCB学习/mywork 之类项目名顶上来。
  const name = s => s.displayName || s.title || (s.source === 'codex'
    ? (s.titleUnavailable ? 'Mac 本地会话（标题未同步）' : 'Codex 对话') : '会话');
  /* msg 行: 有等待的就"叫", 否则安静地报最新会话 */
  const w = list.find(s => s.status === 'waiting');
  const msgEl = $('#csMsg');
  if (w) {
    msgEl.textContent = `⚠ ${name(w)} · ${CS_KIND[w.kind] || '等你操作'}${w.tool ? ' · ' + w.tool : ''}`;
    msgEl.classList.add('warn');
  } else {
    const top = list[0];
    msgEl.textContent = top ? `${name(top)} · ${top.detail || CS_CHIP[top.status]}` : '暂无活跃会话';
    msgEl.classList.remove('warn');
  }
  /* 分两列: 左=运行中(含等你操作), 右=已完成; 各按时间倒序(最新在上) */
  const byTs = (a, b) => b.ts - a.ts;
  const running = list.filter(s => s.status !== 'done').sort(byTs);
  const done = list.filter(s => s.status === 'done').sort(byTs);
  $('#csRunN').textContent = running.length;
  $('#csDoneN').textContent = done.length;
  /* 内容签名没变就不动 DOM(分钟数进签名, 年龄跳分钟时刷新) */
  const sig = JSON.stringify(list.map(s => [s.device, s.sid, s.status, s.ts, s.title, s.titleUnavailable, s.detail, s.lastAct, (s.reply || '').slice(0, 60), Math.floor((r.t - s.ts) / 60000)]));
  if (sig === csSig) return;
  csSig = sig;
  const card = s => {
    /* 「正在干什么」: detail 是 hook 从 PreToolUse 的 tool_input 现算的(读 xx / 改 xx / $ 命令…)。
       工具跑完事件就变 thinking、detail 归空 —— 那时退回显示 lastAct(刚做完的那件事),
       否则一句干巴巴的"思考中…"什么信息都没有。 */
    const act = s.status === 'waiting'
      ? `<div class="act warn">⚠ ${esc(CS_KIND[s.kind] || '等你操作')}${s.tool ? ' · approve: ' + esc(s.tool) : ''}</div>`
      : s.detail
        ? `<div class="act live">▶ ${esc(csAct(s.detail))}</div>`
        : s.status === 'running'
          ? `<div class="act">思考中…${s.lastAct ? ' · 刚 ' + esc(csAct(s.lastAct)) : ''}</div>`
          : `<div class="act">${s.lastAct ? '最后动作: ' + esc(csAct(s.lastAct)) : ''}</div>`;
    const dev = s.device || 'PC';
    const devLabel = csDevLabel(dev);
    return `<div class="cs-card ${s.status}" ${s.status === 'done' ? `data-ack="${esc(csKey(s))}" data-ts="${s.ts}"` : ''}
        style="--dev:${csDevColor(dev)}">
      <div class="head"><span class="cs-dev">${esc(devLabel)}</span><span class="proj">${esc(name(s))}</span><span class="sid">#${esc(s.sid)}</span>
        <span class="cs-chip ${s.status}">${CS_CHIP[s.status]}</span><span class="age">${csAge(r.t - s.ts)}</span></div>
      ${act}
      <div class="reply">${s.reply ? '<b>最后回复:</b>' + esc(s.reply) : '<b>暂无回复文本</b>'}</div>
      ${s.status === 'done' ? '<div class="ack">✓ 已完成 · 点一下标记已读</div>' : ''}
    </div>`;
  };
  /* 设备小计: 「PC 2 · Mac 1」；只有一台设备时不显示。 */
  const bd = r.byDevice || {};
  const devs = Object.keys(bd);
  $('#csDevs').innerHTML = devs.length > 1
    ? devs.map(d => `<span style="--dev:${csDevColor(d)}"><i></i>${esc(csDevLabel(d))} <b>${bd[d].total}</b>${bd[d].waiting ? ' ⚠' + bd[d].waiting : ''}</span>`).join('')
    : '';
  $('#csRunBody').innerHTML = running.map(card).join('') || '<div class="empty">无运行中会话</div>';
  $('#csDoneBody').innerHTML = done.map(card).join('') || '<div class="empty">无已完成会话</div>';
  /* 已完成卡: 点按知悉 -> 渐隐消失 */
  $$('#csDoneBody .cs-card[data-ack]').forEach(el => el.addEventListener('pointerup', () => {
    if (dragging) return;
    el.classList.add('fade');
    setTimeout(() => csMarkRead(el.dataset.ack, Number(el.dataset.ts)), 250);
  }));
}
setInterval(pollSessions, 5000); pollSessions();
$('#csUsage').addEventListener('pointerup', () => { if (!dragging) openUsageOvl(); });
$('#csUsageBtn').addEventListener('pointerup', () => openUsageOvl());

/* 滚动歌词: 换歌重建行, 行号变化时平滑滚动居中 + 按距离渐隐 */
function renderScrollLyrics(wrap, lines, idx, key) {
  if (!wrap) return;
  const has = lines && lines.length;
  if (!has) {
    const ek = '__empty:' + (np && np.lyricsState === 'none' ? 'none' : (np && np.lyricsState === 'loading' ? 'load' : 'idle'));
    if (wrap._key !== ek) {
      wrap.innerHTML = '<div class="lyr-empty">' + (np && np.lyricsState === 'none' ? '(无歌词)' : (np && np.lyricsState === 'loading' ? '歌词加载中…' : '♪')) + '</div>';
      wrap._key = ek; wrap._scroll = null; wrap._idx = -999;
    }
    return;
  }
  if (wrap._key !== key) {   // 换歌 -> 重建所有行
    wrap._key = key; wrap._idx = -999;
    wrap.innerHTML = '<div class="lyr-scroll">' + lines.map((t, i) => `<div class="lyr-line" data-i="${i}">${esc(t || '♪')}</div>`).join('') + '</div>';
    wrap._scroll = wrap.querySelector('.lyr-scroll');
  }
  const scroll = wrap._scroll; if (!scroll || !scroll.children.length) return;
  const kids = scroll.children;
  const center = idx < 0 ? 0 : Math.min(kids.length - 1, idx);
  const slotH = kids[0].offsetHeight || 74;
  scroll.style.transform = `translateY(${wrap.clientHeight / 2 - (center + 0.5) * slotH}px)`;   // 当前行垂直居中
  if (wrap._idx !== idx) {
    wrap._idx = idx;
    for (let i = 0; i < kids.length; i++) {
      const d = Math.abs(i - center);
      kids[i].classList.toggle('cur', idx >= 0 && i === idx);
      kids[i].style.opacity = (idx >= 0 && i === idx) ? 1 : Math.max(0.10, 0.6 - d * 0.15);
    }
  }
}

/* 正在播放 + 歌词 */
let np = null;
async function pollNp() {
  np = await get('/api/nowplaying');
  const playing = np && np.title;   // 有媒体会话就显示(暂停也显示歌名), playing 只控制播放键图标
  $('#npTitle').textContent = playing ? np.title : '未在播放';
  $('#npArtist').textContent = playing ? (np.artist || '—') : '—';
  $('#npBar').style.width = playing && np.dur ? (np.pos / np.dur * 100) + '%' : '0%';
  $('#npPos').textContent = fmtT(np && np.pos); $('#npDur').textContent = fmtT(np && np.dur);
  /* 专辑封面: SMTC 缩略图, cover 是版本号, 变了才换图 */
  const cov = playing && np.cover ? np.cover : 0;
  if (pollNp._cover !== cov) {
    pollNp._cover = cov;
    [$('#npCover'), $('#mCover')].forEach(el => {
      if (!el) return;
      el.classList.toggle('has-img', !!cov);
      el.style.backgroundImage = cov ? `url(/api/nowplaying/cover?k=${cov})` : '';
    });
  }
  const lyrLines = playing ? np.lines : null;
  const lyrIdx = playing && np.idx != null ? np.idx : -1;
  const lyrKey = playing ? (np.key || np.title) : '';
  renderScrollLyrics($('#lyricsCard'), lyrLines, lyrIdx, lyrKey);
  renderScrollLyrics($('#mLyrics'), lyrLines, lyrIdx, lyrKey);
  /* 媒体页信息 */
  $('#mTitle').textContent = playing ? np.title : '未在播放';
  $('#mArtist').textContent = playing ? (np.artist || '—') : '—';
  $('#mProgBar').style.width = playing && np.dur ? (np.pos / np.dur * 100) + '%' : '0%';
  $('#mProgKnob').style.left = playing && np.dur ? (np.pos / np.dur * 100) + '%' : '0%';
  $('#mProgT').textContent = `${fmtT(np && np.pos)} / ${fmtT(np && np.dur)}`;
  $('#playIcon').innerHTML = playing && np.playing ? '<path d="M7 4h4v16H7zM13 4h4v16h-4z"/>' : '<path d="M7 4l13 8-13 8z"/>';
  $('#cNp').textContent = playing ? np.title : '—';
}
setInterval(pollNp, 1000); pollNp();

/* 天气 / 日程 / 通知 / 健康 */
let extras = null, dndOn = localStorage.getItem('wide-dnd') === '1';
function renderExtras() {
  if (!extras) return;
  const w = extras.weather;
  if (w && w.ok) {
    $('#wIcon').textContent = w.icon; $('#wTemp').textContent = Math.round(w.temp) + '°';
    $('#wDesc').textContent = w.desc; $('#wHiLo').textContent = `${Math.round(w.hi)}° / ${Math.round(w.lo)}°`;
    const hrs = (w.hourlyProb || []).slice(0, 3);
    const h0 = new Date().getHours();
    $('#wFc').innerHTML = hrs.map((p, i) => `<div class="h">${(h0 + i + 1) % 24}时<b>${p}%</b></div>`).join('');
    $('#mwIcon').textContent = w.icon; $('#mwTemp').textContent = Math.round(w.temp) + '°';
    $('#mwDesc').textContent = `${w.desc} · ${Math.round(w.hi)}°/${Math.round(w.lo)}°`;
  }
  const cal = extras.calendar;
  const calList = $('#calList');
  if (cal && cal.ok && cal.events && cal.events.length) {
    calList.innerHTML = cal.events.slice(0, 5).map(ev => `<div class="cal-item"><span class="t">${esc(ev.time || ev.t || '')}</span><span class="n">${esc(ev.title || ev.name || '')}</span></div>`).join('');
  } else if (cal && cal.today && cal.today.length) {
    calList.innerHTML = cal.today.slice(0, 5).map(ev => `<div class="cal-item"><span class="t">${esc(ev.time || '')}</span><span class="n">${esc(ev.title || '')}</span></div>`).join('');
  } else calList.innerHTML = `<div class="empty">${cal && cal.icsSet === false ? '未设置日历订阅' : '今日无日程'}</div>`;
  const nt = extras.notify;
  const ntfList = $('#ntfList');
  if (nt && nt.recent && nt.recent.length && !dndOn) {
    ntfList.innerHTML = nt.recent.slice(0, 4).map(n => `
      <div class="ntf-item"><div class="ic">${esc((n.app || '?')[0])}</div>
      <div class="tx"><div class="a">${esc(n.app)} · ${esc(n.title)}</div><div class="b">${esc(n.body)}</div></div></div>`).join('');
  } else ntfList.innerHTML = `<div class="empty">${dndOn ? '勿扰中' : (nt && nt.status === 'allowed' ? '暂无通知' : '未开启通知权限')}</div>`;
  const gm = $('#gameNtfList');
  if (gm && nt && nt.recent) gm.innerHTML = nt.recent.slice(0, 3).map(n => `
      <div class="ntf-item"><div class="ic">${esc((n.app || '?')[0])}</div>
      <div class="tx"><div class="a">${esc(n.app)}</div><div class="b">${esc(n.title)}</div></div></div>`).join('') || '<div class="empty">无</div>';
  const h = extras.health, dot = $('#healthDot');
  if (h) {
    dot.className = h.ok ? 'ok' : 'bad'; dot.id = 'healthDot';
    dot.classList.add(h.ok ? 'ok' : 'bad');
    $('#healthName').textContent = 'home-server · ' + (h.ok ? '正常' : '离线');
    const up = h.upSince ? Math.floor((Date.now() - h.upSince) / 86400000) : 0;
    $('#healthMeta').textContent = h.ok ? `${h.ms} ms · 已运行 ${up} 天` : (h.error || 'HTTP ' + h.status);
  } else { $('#healthName').textContent = '服务器未配置'; $('#healthMeta').textContent = '管理台可设置健康检查地址'; }
}
async function pollExtras() { extras = await get('/api/extras'); renderExtras(); renderTiles(); }
setInterval(pollExtras, 5000); pollExtras();

/* 全局热键翻页: 弹层开着时强制关闭并翻页(不用先手动退出); 游戏副驾驶页仍不翻 */
function wideFlip(dir) {
  if (gameOn) return;
  if (ovlMask.classList.contains('show')) closeOvl();          // 母版弹层(声音/额度/Steam/详情)
  ['#appOutPick', '#outPick'].forEach(s => { const el = $(s); if (el) el.remove(); });   // 小设备选择器
  // 到顶/到底就停住, 不绕回另一端(试过循环翻页, 用户明确要保持原样: 会话页再往上就是不动)
  gotoPage(Math.max(0, Math.min(3, page + (dir < 0 ? -1 : 1))));
}
/* 主通道 = SSE: 按键即时推, 几十毫秒到, 跟手 */
let wideEs = null;
function connectWideSse() {
  try { wideEs = new EventSource('/api/wide/events'); } catch { return; }
  wideEs.addEventListener('page', e => { lastWpSeq = null; wideFlip(Number(e.data)); });   // 收到即翻, 并让轮询重记基线避免重复翻
  wideEs.onerror = () => {};   // EventSource 自带重连(retry)
}
connectWideSse();
/* 兜底 = 轮询 seq: SSE 万一断了, 靠 1s 轮询补上(不会和 SSE 重复翻: SSE 翻完把基线清了) */
let lastWpSeq = null;
async function pollStats() {
  stats = await get('/api/stats'); renderTiles(); renderGame();
  if (stats && stats.wpSeq != null) {
    if (lastWpSeq == null) lastWpSeq = stats.wpSeq;
    else if (stats.wpSeq !== lastWpSeq) {
      const dir = stats.wpDir; lastWpSeq = stats.wpSeq;
      wideFlip(dir);
    }
  }
}
setInterval(pollStats, 1000); pollStats();
async function pollHist() { hist = (await get('/api/history/all?n=60')) || {}; renderTileSparks(); renderGameSparks(); }
setInterval(pollHist, 5000); pollHist();

/* ==================== 音频 ==================== */
let audio = null, volDragging = false, miniSig = '', ovlSig = '';
/* 设备真名: 取括号内内容(扬声器 (ADAM Audio D3V ) -> ADAM Audio D3V) */
function devName(n) {
  const m = String(n || '').match(/\(([^)]*)\)/);
  return ((m ? m[1] : String(n || '').replace(/^扬声器\s*/, '')).trim()) || String(n || '');
}
/* 按软件名合并会话(斗鱼开两个直播间=两个进程 -> 合并成一条, 控制时对全部 pid 生效) */
function aggSessions(list) {
  const map = new Map();
  for (const s of (list || [])) {
    const key = s.display || s.name || String(s.pid);
    let g = map.get(key);
    if (!g) { g = { key, name: s.display || s.name, pids: [], vol: 0, muted: true }; map.set(key, g); }
    g.pids.push(s.pid);
    g.vol = Math.max(g.vol, s.vol);      // 组音量取最大
    g.muted = g.muted && !!s.muted;      // 全部静音才算静音
  }
  return [...map.values()].slice(0, 8);
}
function aggSig(gs) { return gs.map(g => g.key + ':' + g.pids.join('.')).join('|'); }
function audioApp(pids, patch) { (pids || []).forEach(p => post('/api/audio', Object.assign({ app: p }, patch))); }
function renderAudio() {
  const m = audio && audio.master;
  const vol = m ? m.vol : null;
  ['#volVal', '#volVal2', '#volVal3'].forEach(s => { const el = $(s); if (el) el.textContent = vol != null ? vol : '--'; });
  if (!volDragging && !uiBusy) $$('[data-slider^="volume"]').forEach(r => setRail(r, vol || 0));
  const mb = $('#sndMuteBtn'); if (mb && m) mb.classList.toggle('muted', !!m.muted);
  $$('[data-vmute]').forEach(el => el.classList.toggle('muted', !!(m && m.muted)));   // 底栏喇叭静音态联动
  const micBtn = $('#btnMic'); if (micBtn && audio && audio.mic) micBtn.classList.toggle('on', !!audio.mic.muted);
  /* 操控台迷你混音条: 合并后按 idx 原地更新, 手指按着时完全不动 DOM */
  const wrap = $('#sndApps');
  if (wrap && audio && audio.sessions && !uiBusy) {
    const gs = aggSessions(audio.sessions.filter(s => s.pid !== 0));
    const sig = aggSig(gs);
    if (sig !== miniSig) {
      miniSig = sig;
      wrap.innerHTML = gs.map((g, i) => `
        <div class="snd-app ${g.muted ? 'muted' : ''}" data-idx="${i}">
          <div class="ic">${esc((g.name || '?')[0].toUpperCase())}</div>
          <div class="bar"><div class="rail" data-idx="${i}"><i style="width:${g.muted ? 0 : g.vol}%"></i></div></div>
          <div class="nm">${esc(g.name)}</div>
        </div>`).join('') || '<div class="empty" style="flex:1">无活动音频会话</div>';
      wrap.querySelectorAll('.rail[data-idx]').forEach(rail => { const g = gs[+rail.dataset.idx]; hDrag(rail, pct => {
        const v = Math.round(pct * 100);
        rail.querySelector('i').style.width = (pct * 100) + '%';
        const col = rail.closest('.snd-app');
        if (col && col.classList.contains('muted')) { col.classList.remove('muted'); g.muted = false; audioApp(g.pids, { muted: false }); }
        g.vol = v;
        clearTimeout(rail._t); rail._t = setTimeout(() => audioApp(g.pids, { vol: v }), 120);
      }); });
    } else {
      gs.forEach((g, i) => {
        const col = wrap.querySelector(`.snd-app[data-idx="${i}"]`);
        if (!col) return;
        col.classList.toggle('muted', !!g.muted);
        const bi = col.querySelector('.rail > i'); if (bi) bi.style.width = (g.muted ? 0 : g.vol) + '%';
      });
    }
  }
  if (ovlKind === 'sound' && !uiBusy) renderSoundOvl();
  const outLb = $('#outputLb');
  if (outLb && audio && audio.devices) {
    const def = audio.devices.find(d => d.default);
    outLb.textContent = def ? devName(def.name).slice(0, 10) : '输出';
  }
}
async function pollAudio() { const a = await get('/api/audio'); if (a && a.ok !== false) audio = a; renderAudio(); }
setInterval(pollAudio, 2000); pollAudio();

$$('[data-slider^="volume"]').forEach(rail => hDrag(rail, pct => {
  volDragging = true; clearTimeout(hDrag._vt); hDrag._vt = setTimeout(() => volDragging = false, 800);
  setRail(rail, pct * 100);
  const v = Math.round(pct * 100);
  ['#volVal', '#volVal2', '#volVal3'].forEach(s => { const el = $(s); if (el) el.textContent = v; });
  clearTimeout(hDrag._va); hDrag._va = setTimeout(() => post('/api/audio', { master: v }), 120);
}));
let briVal = Number(localStorage.getItem('wide-bright') || 80);
$$('[data-slider="bright"]').forEach(rail => { setRail(rail, briVal); hDrag(rail, pct => {
  briVal = Math.round(pct * 100); setRail(rail, briVal);
  $('#briVal').textContent = briVal; localStorage.setItem('wide-bright', briVal);
  clearTimeout(hDrag._bt); hDrag._bt = setTimeout(() => post('/api/wide/brightness', { value: briVal }), 250);
}); });
$('#briVal').textContent = briVal;
function toggleMasterMute() {
  if (!audio || !audio.master) return;
  const next = !audio.master.muted;
  audio.master.muted = next; renderAudio();   // 乐观更新: 三页喇叭/操控台按钮立即联动
  post('/api/audio', { muteMaster: next }).then(() => setTimeout(pollAudio, 300));
}
const mbtn = $('#sndMuteBtn');
if (mbtn) mbtn.addEventListener('pointerup', toggleMasterMute);
$$('[data-vmute]').forEach(el => el.addEventListener('pointerup', e => { e.stopPropagation(); toggleMasterMute(); }));

/* 声音弹层 */
let devSig = '';
function renderSoundOvl() {
  if (!audio) return;
  const devs = $('#sndDevList');
  const favs = favDevices();
  const dsig = favs.map(d => d.id + (d.default ? '*' : '')).join(',');
  if (devs && dsig !== devSig) {
    devSig = dsig;
    devs.innerHTML = favs.map(d => `
    <div class="dev press-sm ${d.default ? 'on' : ''}" data-dev="${esc(d.id)}">
      <svg viewBox="0 0 24 24"><path d="M4 14a8 8 0 0 1 16 0"/><rect x="2.5" y="14" width="4.5" height="6" rx="2"/><rect x="17" y="14" width="4.5" height="6" rx="2"/></svg>
      <div class="tx"><div class="nm">${esc(devName(d.name))}</div><div class="ds">${d.default ? '当前输出' : ''}</div></div>
      ${d.default ? '<span class="tag">✓ 默认</span>' : ''}
    </div>`).join('');
    devs.querySelectorAll('.dev').forEach(el => el.addEventListener('pointerup', () => {
      post('/api/audio', { device: el.dataset.dev }).then(() => { toast('已切换输出设备'); setTimeout(pollAudio, 600); });
    }));
  }
  const mrail = $('#sndOvlRail');
  if (mrail && audio.master && !volDragging && !uiBusy) { setRail(mrail, audio.master.vol); $('#sndOvlVal').textContent = audio.master.vol; }
  const mix = $('#mixCols');
  if (mix) {
    const gs = aggSessions((audio.sessions || []).filter(s => s.pid !== 0)).slice(0, 6);
    const sig = aggSig(gs);
    if (sig !== ovlSig || !mix.children.length) {   // 结构变了才重建, 否则原地更新(拖动中的推子绝不销毁)
      ovlSig = sig;
      mix.innerHTML = gs.map((g, i) => `
        <div class="mix ${g.muted ? 'muted' : ''}" data-idx="${i}">
          <div class="ic">${esc((g.name || '?')[0].toUpperCase())}</div>
          <div class="nm">${esc(g.name)}</div>
          <div class="fader" data-idx="${i}"><i style="height:${g.muted ? 0 : g.vol}%"></i></div>
          <div class="v">${g.muted ? 0 : g.vol}</div>
          <div class="mut press-sm" data-idx="${i}">${g.muted ? '取消静音' : '静音'}</div>
          <div class="appout press-sm" data-idx="${i}"><svg viewBox="0 0 24 24"><path d="M4 14a8 8 0 0 1 16 0"/><rect x="2.5" y="14" width="4.5" height="6" rx="2"/><rect x="17" y="14" width="4.5" height="6" rx="2"/></svg><span>${esc(appOutLabel(g.name))}</span></div>
        </div>`).join('') || '<div class="empty">无活动音频会话</div>';
      mix.querySelectorAll('.appout[data-idx]').forEach(b => { const g = gs[+b.dataset.idx]; b.addEventListener('pointerup', e => {
        e.stopPropagation(); openAppOutPick(b, g);
      }); });
      mix.querySelectorAll('.fader[data-idx]').forEach(f => { const g = gs[+f.dataset.idx]; vDrag(f, pct => {
        const v = Math.round(pct * 100);
        f.querySelector('i').style.height = (pct * 100) + '%';
        const col = f.closest('.mix'); col.querySelector('.v').textContent = v;
        if (col.classList.contains('muted')) {   // 静音态直接拖 -> 解除静音
          col.classList.remove('muted'); col.querySelector('.mut').textContent = '静音'; g.muted = false;
          audioApp(g.pids, { muted: false });
        }
        g.vol = v;
        clearTimeout(f._t); f._t = setTimeout(() => audioApp(g.pids, { vol: v }), 120);
      }); });
      mix.querySelectorAll('.mut[data-idx]').forEach(b => { const g = gs[+b.dataset.idx]; b.addEventListener('pointerup', e => {
        e.stopPropagation();
        const col = b.closest('.mix');
        const willMute = !col.classList.contains('muted');
        audioApp(g.pids, { muted: willMute }); g.muted = willMute; setTimeout(pollAudio, 500);
        col.classList.toggle('muted', willMute); b.textContent = willMute ? '取消静音' : '静音';
        const bi = col.querySelector('.fader > i'); if (bi) bi.style.height = (willMute ? 0 : g.vol) + '%';   // 静音归零, 取消静音恢复
        col.querySelector('.v').textContent = willMute ? 0 : g.vol;
      }); });
    } else {
      gs.forEach((g, i) => {
        const col = mix.querySelector(`.mix[data-idx="${i}"]`);
        if (!col) return;
        col.classList.toggle('muted', !!g.muted);
        col.querySelector('.mut').textContent = g.muted ? '取消静音' : '静音';
        const bi = col.querySelector('.fader > i'); if (bi) bi.style.height = (g.muted ? 0 : g.vol) + '%';
        col.querySelector('.v').textContent = g.muted ? 0 : g.vol;
      });
    }
  }
  const micB = $('#micBigBtn');
  if (micB && audio.mic) {
    micB.classList.toggle('muted', !!audio.mic.muted);
    $('#micState').textContent = audio.mic.muted ? '已静音' : '拾音中';
    $('#micState').className = audio.mic.muted ? 'off' : '';
    $('#micState').id = 'micState';
    $('#micName').textContent = audio.mic.name || '';
  }
}
function openSoundOvl() {
  ovlSig = ''; devSig = '';   // 强制重建弹层内容
  openOvl('sound', '声音控制', '点弹层外空白关闭', `
    <div id="sndOvl">
      <div id="sndDevCol"><h4 class="ovl-h4">声音输出</h4><div id="sndDevList"></div>
        <div id="sndOvlMaster"><div class="lbl">主音量</div>
          <div style="display:flex;align-items:center;gap:20px">
            <div class="rail" id="sndOvlRail" style="flex:1;height:16px;border-radius:8px;background:#1a212c;position:relative"><i style="position:absolute;left:0;top:0;bottom:0;border-radius:8px;background:var(--accent)"></i><div class="knob" style="position:absolute;top:50%;transform:translate(-50%,-50%);width:44px;height:44px;border-radius:50%;background:#F5F8FC;box-shadow:0 2px 10px rgba(0,0,0,.6)"></div></div>
            <span id="sndOvlVal" style="font-size:34px;font-weight:800;font-family:'JetBrains Mono'">--</span>
          </div></div>
      </div>
      <div id="mixWrap"><h4 class="ovl-h4">分应用音量 · 拖推子调音量 · 静音 · 点「输出设备」切换</h4><div id="mixCols"></div></div>
      <div id="micCol"><h4 class="ovl-h4">麦克风</h4>
        <div id="micBigBtn" class="press-sm"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg><span>点按静音 · 方便盲按</span></div>
        <div id="micState">—</div><div id="micName"></div>
      </div>
    </div>`);
  hDrag($('#sndOvlRail'), pct => {
    setRail($('#sndOvlRail'), pct * 100); $('#sndOvlVal').textContent = Math.round(pct * 100);
    clearTimeout(openSoundOvl._t); openSoundOvl._t = setTimeout(() => post('/api/audio', { master: Math.round(pct * 100) }), 120);
  });
  $('#micBigBtn').addEventListener('pointerup', () => {
    if (audio && audio.mic) post('/api/audio', { mic: !audio.mic.muted }).then(() => setTimeout(pollAudio, 500));
  });
  renderSoundOvl();
}
$('#sndTile').addEventListener('pointerup', e => {
  if (e.target.closest('.rail') || e.target.closest('.mute-btn') || uiBusy) return;   // 拖滑条不触发; 点迷你应用列=打开完整控制
  openSoundOvl();
});

/* ==================== 操控台: 应用启动 ==================== */
async function initApps() {
  const r = await get('/api/config');
  const apps = (r && r.config && r.config.apps) || [];
  $('#appGrid').innerHTML = apps.map(a => `
    <div class="app press-tile" data-app="${esc(a.id)}" ${a.long ? 'data-long="1"' : ''}>
      <div class="ic" style="background:${esc(a.color || '#334155')}">${esc(a.ch || a.label[0])}</div>
      <div class="lb">${esc(a.label)}</div>
      ${a.long ? '<span class="hint">长按更多</span>' : ''}
    </div>`).join('');
  $$('#appGrid .app').forEach(el => {
    const id = el.dataset.app;
    if (el.dataset.long) bindHold(el, 600, () => openSteamOvl(), () => launchApp(id));
    else el.addEventListener('pointerup', () => launchApp(id));
  });
}
function launchApp(id) { post('/api/launch', { id }).then(r => toast(r && r.ok ? '已启动' : '启动失败')); }
initApps();

/* Steam 弹层 */
async function openSteamOvl() {
  openOvl('steam', 'STEAM', '短按图标=直接打开 · 点弹层外关闭', `
    <div id="steamOvl">
      <div id="steamActs">
        <div class="sact primary press-tile" data-sopen="bigpicture"><div class="a">大屏模式</div><div class="b">在主屏启动 Big Picture</div></div>
        <div class="sact press-tile" data-sopen="store"><div class="a">商店</div><div class="b">Steam 商店</div></div>
        <div class="sact press-tile" data-sopen="games"><div class="a">游戏库</div><div class="b" id="stLibCount">—</div></div>
        <div class="sact press-tile" data-sopen="friends"><div class="a">好友</div><div class="b">好友列表</div></div>
      </div>
      <div><h4 class="ovl-h4" style="margin-bottom:14px">最近游戏</h4><div id="steamRecent"><div class="empty">读取中…</div></div></div>
      <div id="steamSide"><h4 class="ovl-h4">下载 / 更新</h4><div id="steamDl"><div class="empty">无进行中的下载</div></div></div>
    </div>`);
  $$('[data-sopen]').forEach(el => el.addEventListener('pointerup', () => {
    post('/api/steam/launch', { open: el.dataset.sopen === 'store' ? undefined : el.dataset.sopen, store: el.dataset.sopen === 'store' || undefined });
    toast('已发送到 Steam');
  }));
  const s = await get('/api/steam');
  if (!s || !s.ok) { $('#steamRecent').innerHTML = `<div class="empty">${esc((s && s.error) || 'Steam 未找到')}</div>`; return; }
  $('#stLibCount').textContent = `共 ${s.games.length}+ 款`;
  const fmtAgo = ts => { if (!ts) return ''; const d = Math.floor((Date.now() / 1000 - ts) / 86400); return d <= 0 ? '今天' : d === 1 ? '昨天' : d + ' 天前'; };
  $('#steamRecent').innerHTML = s.games.slice(0, 4).map(g => `
    <div class="sgame">
      <div class="ic">${esc(g.name[0])}</div>
      <div class="tx"><div class="a">${esc(g.name)}</div><div class="b">${g.sizeGB} GB · 上次 ${fmtAgo(g.lastPlayed)}</div></div>
      <div class="go press-sm" data-appid="${g.appid}">${g.updating ? '更新中' : '启动'}</div>
    </div>`).join('');
  $$('#steamRecent .go').forEach(b => b.addEventListener('pointerup', () => {
    post('/api/steam/launch', { appid: Number(b.dataset.appid) }); toast('正在启动游戏…');
  }));
  if (s.downloads && s.downloads.length) {
    $('#steamDl').innerHTML = s.downloads.map(d => {
      const pct = d.bytesToDownload ? Math.round(d.bytesDownloaded / d.bytesToDownload * 100) : 0;
      return `<div class="dl"><div class="a">${esc(d.name)}</div><div class="b">${(d.bytesDownloaded / 2 ** 30).toFixed(1)} / ${(d.bytesToDownload / 2 ** 30).toFixed(1)} GB</div><div class="hbar"><i style="width:${pct}%"></i></div></div>`;
    }).join('');
  }
}

/* ==================== 底栏动作 ==================== */
let pomoEnd = 0, pomoT = null;
document.body.addEventListener('pointerup', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'screenshot') post('/api/system/screenshot').then(r => toast(r && r.ok ? '已截图 → 图片库' : '截图失败'));
  else if (act === 'micmute') { if (audio && audio.mic) post('/api/audio', { mic: !audio.mic.muted }).then(() => { pollAudio(); toast(audio.mic.muted ? '麦克风已开启' : '麦克风已静音'); }); }
  else if (act === 'dnd') { dndOn = !dndOn; localStorage.setItem('wide-dnd', dndOn ? '1' : '0'); $('#btnDnd').classList.toggle('on', dndOn); toast(dndOn ? '勿扰已开启(隐藏通知)' : '勿扰已关闭'); renderExtras(); }
  else if (act === 'awake') post('/api/system/awake', { on: !$('#btnAwake').classList.contains('on') }).then(r => { $('#btnAwake').classList.toggle('on', r && r.awake); toast(r && r.awake ? '防息屏已开启' : '防息屏已关闭'); });
  else if (act === 'note') toast('便签:后续版本接入');
  else if (act === 'pomo') {
    if (pomoEnd) { pomoEnd = 0; clearInterval(pomoT); $('#pomoLb').textContent = '番茄钟'; $('#btnPomo').classList.remove('on'); toast('番茄钟已取消'); }
    else {
      pomoEnd = Date.now() + 25 * 60 * 1000; $('#btnPomo').classList.add('on'); toast('番茄钟 25:00 开始');
      pomoT = setInterval(() => {
        const left = pomoEnd - Date.now();
        if (left <= 0) { clearInterval(pomoT); pomoEnd = 0; $('#pomoLb').textContent = '番茄钟'; $('#btnPomo').classList.remove('on'); toast('🍅 番茄钟完成!'); return; }
        $('#pomoLb').textContent = fmtT(left / 1000);
      }, 1000);
    }
  }
  else if (act === 'net' || act === 'bt') toast('系统开关暂未接入(需要系统权限)');
  else if (act === 'captions') post('/api/captions').then(r => toast(r && r.ok ? '已切换实时字幕' : '暂未接入'));
  else if (act === 'copilot') enterGame('手动进入', true);
  else if (act === 'output') toggleOutPick();
});
$$('[data-power]').forEach(el => bindHold(el, 1500, () => {
  post('/api/power', { action: el.dataset.power });
  toast({ lock: '锁屏中…', sleep: '进入睡眠…', restart: '3 秒后重启', shutdown: '3 秒后关机' }[el.dataset.power]);
}, () => toast('长按 1.5 秒触发')));
$$('[data-media]').forEach(el => el.addEventListener('pointerup', () => post('/api/media', { key: el.dataset.media })));

/* ---------- 输出设备快切: 按钮上方弹小列表(只显示 config.audio.favorites 匹配的设备) ---------- */
let CFG = null;
get('/api/config').then(r => { CFG = (r && r.config) || {}; });
function favDevices() {
  if (!audio || !audio.devices) return [];
  const favs = (CFG && CFG.audio && CFG.audio.favorites) || ['ADAM', 'Realtek'];
  const list = audio.devices.filter(d => favs.some(f => d.name.toLowerCase().includes(String(f).toLowerCase())));
  return list.length ? list : audio.devices;   // 一个都匹配不上就退回全列表
}
/* 分应用输出: 记住每个应用上次选的设备(localStorage), 按钮上显示 */
const SYS_DEFAULT = '__sysdefault__';
function appOutLabel(name) {
  const id = localStorage.getItem('appout:' + name);
  if (!id) return '输出设备';
  if (id === SYS_DEFAULT) return '跟随默认';
  if (!audio || !audio.devices) return '输出设备';
  const d = audio.devices.find(x => x.id === id);
  return d ? devName(d.name).slice(0, 8) : '输出设备';
}
function openAppOutPick(anchor, g) {
  const old = $('#appOutPick'); if (old) old.remove();
  const devs = favDevices();
  if (!devs.length) { toast('音频服务未就绪'); return; }
  const savedId = localStorage.getItem('appout:' + g.name);
  // 选项 = 跟随系统默认 + 各收藏设备
  const opts = [{ id: SYS_DEFAULT, label: '跟随系统默认', sys: true }]
    .concat(devs.map(d => ({ id: d.id, label: devName(d.name) })));
  const panel = document.createElement('div');
  panel.id = 'appOutPick';
  panel.innerHTML = `<div class="hd">${esc(g.name)} 的输出</div>` + opts.map(o => `
    <div class="opt press-sm ${o.id === savedId ? 'on' : ''}" data-dev="${esc(o.id)}">
      <svg viewBox="0 0 24 24">${o.sys
        ? '<path d="M12 3v18M4 8h16M4 16h16"/><circle cx="12" cy="12" r="9"/>'
        : '<path d="M4 14a8 8 0 0 1 16 0"/><rect x="2.5" y="14" width="4.5" height="6" rx="2"/><rect x="17" y="14" width="4.5" height="6" rx="2"/>'}</svg>
      <span>${esc(o.label)}</span>${o.id === savedId ? '<b>✓</b>' : ''}
    </div>`).join('');
  document.body.appendChild(panel);
  const br = anchor.getBoundingClientRect();
  const scale = 3840 / document.documentElement.getBoundingClientRect().width || 1;
  const w = 620;
  panel.style.left = Math.min(3840 - 30 - w, Math.max(20, (br.left + br.width / 2) * scale - w / 2)) + 'px';
  panel.style.bottom = (1100 - br.top * scale + 14) + 'px';
  panel.querySelectorAll('.opt').forEach(el => el.addEventListener('pointerup', e => {
    e.stopPropagation();
    const devId = el.dataset.dev;
    post('/api/audio', { apps: g.pids, outDev: devId }).then(r => {
      if (r && r.ok) {
        localStorage.setItem('appout:' + g.name, devId);
        const lb = anchor.querySelector('span'); if (lb) lb.textContent = appOutLabel(g.name);
        toast(g.name + ' 输出 → ' + el.querySelector('span').textContent);
      } else toast((r && r.error) || '设置失败');
    });
    panel.remove();
  }));
  setTimeout(() => document.body.addEventListener('pointerdown', function close(e) {
    if (!e.target.closest('#appOutPick')) { const p = $('#appOutPick'); if (p) p.remove(); document.body.removeEventListener('pointerdown', close); }
  }), 50);
}
function toggleOutPick() {
  const old = $('#outPick');
  if (old) { old.remove(); return; }
  const devs = favDevices();
  if (!devs.length) { toast('音频服务未就绪'); return; }
  const btn = $('#btnOutput'); const br = btn.getBoundingClientRect();
  const scale = 3840 / document.documentElement.getBoundingClientRect().width || 1;
  const panel = document.createElement('div');
  panel.id = 'outPick';
  panel.innerHTML = devs.map(d => `
    <div class="opt press-sm ${d.default ? 'on' : ''}" data-dev="${esc(d.id)}">
      <svg viewBox="0 0 24 24"><path d="M4 14a8 8 0 0 1 16 0"/><rect x="2.5" y="14" width="4.5" height="6" rx="2"/><rect x="17" y="14" width="4.5" height="6" rx="2"/></svg>
      <span>${esc(devName(d.name))}</span>
      ${d.default ? '<b>✓</b>' : ''}
    </div>`).join('');
  document.body.appendChild(panel);
  const px = Math.min(3840 - 40 - 720, Math.max(20, (br.left + br.width / 2) * scale - 360));
  panel.style.left = px + 'px';
  panel.style.bottom = (1100 - br.top * scale + 16) + 'px';
  panel.querySelectorAll('.opt').forEach(el => el.addEventListener('pointerup', e => {
    e.stopPropagation();
    post('/api/audio', { device: el.dataset.dev }).then(() => { setTimeout(pollAudio, 600); });
    panel.querySelectorAll('.opt').forEach(x => { x.classList.toggle('on', x === el); x.querySelector('b') && x.querySelector('b').remove(); });
    el.insertAdjacentHTML('beforeend', '<b>✓</b>');
    toast('输出 → ' + el.querySelector('span').textContent);
    setTimeout(() => panel.remove(), 500);
  }));
  setTimeout(() => document.body.addEventListener('pointerdown', function close(e) {
    if (!e.target.closest('#outPick') && !e.target.closest('#btnOutput')) { const p = $('#outPick'); if (p) p.remove(); document.body.removeEventListener('pointerdown', close); }
  }), 50);
}

/* ==================== 游戏副驾驶 ==================== */
let gameOn = false, gameSince = 0, gameManual = false, gameDismissed = '';
function enterGame(name, manual) {
  gameOn = true; gameManual = !!manual; gameSince = gameSince || Date.now();
  $('#gameName').textContent = name;
  $('#gameIcon').textContent = (name || 'G')[0].toUpperCase();
  $('#page-game').classList.add('show');
}
function exitGame() { gameOn = false; gameSince = 0; gameManual = false; $('#page-game').classList.remove('show'); }
$('#gameExit').addEventListener('pointerup', () => { gameDismissed = $('#gameName').textContent; exitGame(); });
async function pollGuard() {
  const g = await get('/api/mouseguard');
  const gaming = g && g.state === 'lock' && g.stateDetail;
  if (gaming && !gameOn && g.stateDetail !== gameDismissed) enterGame(g.stateDetail, false);
  else if (!gaming && gameOn && !gameManual) { exitGame(); gameDismissed = ''; }
  else if (!gaming) gameDismissed = '';
  if (gameOn && gameSince) {
    const s = Math.floor((Date.now() - gameSince) / 1000);
    $('#gameMeta').textContent = `本次已运行 ${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}${gameManual ? '' : ' · 检测到游戏进程'}`;
    $('#gRun').textContent = `本次已运行 ${Math.floor(s / 60)} 分钟`;
  }
}
setInterval(pollGuard, 5000); pollGuard();
async function pollFps() {
  if (!gameOn) return;
  const f = await get('/api/fps'); if (!f) return;
  if (!f.available) { $('#fpsBig').innerHTML = '<span style="font-size:80px;color:#525E6E">需 PresentMon</span>'; $('#fpsLow').textContent = '--'; $('#fpsMs').textContent = '--'; return; }
  $('#fpsBig').innerHTML = `${f.fps || '--'}<span class="u">FPS</span>`;
  $('#fpsLow').textContent = f.low1 || '--';
  $('#fpsMs').textContent = (f.frameMs || '--') + 'ms';
  if (f.hist && f.hist.length > 1) drawSpark($('#fpsSpark'), f.hist.map(v => -v), {});
}
setInterval(pollFps, 3000);
function renderGame() {
  if (!gameOn || !stats) return;
  const g = stats.gpu, c = stats.cpu;
  $('#gGpu').innerHTML = `${g.util}<span class="unit">%</span>`;
  $('#gGpuClk').textContent = (g.clock / 1000).toFixed(2);
  $('#gGpuT').innerHTML = `${g.temp}<span class="unit">°C</span>`;
  $('#gGpuP').textContent = Math.round(g.power);
  $('#gCpu').innerHTML = `${c.util}<span class="unit">%</span>`;
  $('#gCpuClk').textContent = (c.clock / 1000).toFixed(1);
  $('#gVram').innerHTML = `${(g.vramUsed / 1024).toFixed(1)}<span class="unit">GB</span>`;
  $('#gVramP').textContent = Math.round(g.vramUsed / (g.vramTotal || 1) * 100);
  const ping = extras && extras.net ? extras.net.ping : null;
  $('#gPing').innerHTML = `${ping != null ? ping : '--'}<span class="unit">ms</span>`;
  $('#gRx').textContent = extras && extras.net ? (extras.net.rx / 1048576).toFixed(1) : '--';
}
function renderGameSparks() {
  if (!gameOn) return;
  $$('#gameGrid [data-gspark]').forEach(svg => { const m = svg.dataset.gspark; if (hist[m]) drawSpark(svg, hist[m]); });
}

/* 通知清除(仅前端隐藏) */
$('#ntfClear').addEventListener('pointerup', () => { if (extras && extras.notify) { extras.notify.recent = []; renderExtras(); } });

/* 初始化状态 */
$('#btnDnd').classList.toggle('on', dndOn);
get('/api/system/awake').then(r => { if (r) $('#btnAwake').classList.toggle('on', !!r.awake); });

/* 调试参数: ?game=1 强制副驾驶, ?ovl=sound|steam|detail 自动开弹层 */
if (QP.get('game')) setTimeout(() => enterGame('cs2', true), 800);
if (QP.get('ovl') === 'sound') setTimeout(openSoundOvl, 1200);
if (QP.get('ovl') === 'steam') setTimeout(openSteamOvl, 1200);
if (QP.get('ovl') === 'detail') setTimeout(() => openDetail('gpu'), 1200);
if (QP.get('ovl') === 'usage') setTimeout(openUsageOvl, 1200);
})();
