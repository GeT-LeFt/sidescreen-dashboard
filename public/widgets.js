/* 共享组件库: 渲染器 + 数据更新器。仪表盘(index)与管理台舞台(admin)共用,
   保证"管理台预览 = 副屏真实画面"。所有更新器都接受 root(document 或舞台元素)。 */
(function () {
'use strict';
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TYPE_META = {
  gpu: ['🎮', 'GPU'], cpu: ['🧠', 'CPU'], ram: ['💾', '内存'],
  pet: ['🦀', 'Clawd'], usage: ['📊', '额度'], clock: ['🕐', '时钟'], text: ['📝', '文本'],
  lyrics: ['🎵', '歌词'], net: ['🌐', '网速'], weather: ['⛅', '天气'],
  calendar: ['📅', '日程'], disk: ['💽', '磁盘'], notify: ['🔔', '通知'],
  fan: ['🌀', '风扇'], gpupower: ['⚡', 'GPU功耗'], vram: ['🧬', '显存'], gpuclock: ['📈', 'GPU频率'],
  cpuclock: ['🎛️', 'CPU频率'], diskio: ['📀', '磁盘IO'], uptime: ['⏱️', '运行时长'], procs: ['🧩', '进程数'],
};
// 性能类面板集合(统一版式: 标题+数字+参数可调, 折线固定底部不受调整影响, 颜色随主色)
const PERF_TYPES = ['gpu', 'cpu', 'ram', 'net', 'fan', 'gpupower', 'vram', 'gpuclock', 'cpuclock', 'diskio', 'uptime', 'procs'];

function sizeClass(p) { if (!p) return 'sz-md'; const a = (p.w || 1) * (p.h || 1); return a >= 4 ? 'sz-lg' : a >= 2 ? 'sz-md' : 'sz-sm'; }

// 统一性能面板模板: head(大标题+型号chip + 右上参数chip) / mid(大数字+单位 + 一行参数) / 底部折线
function pf(o) {
  const head = `<div class="tile-head"><div class="perf-title"><span class="label">${o.title}</span>` +
    `${o.model ? `<span class="chip model" data-p="${o.model}">–</span>` : ''}</div>` +
    `${o.chip ? `<span class="chip" data-p="${o.chip}">–</span>` : ''}</div>`;
  const mid = `<div class="perf-mid"><div class="hero"><span data-p="${o.hero}">–</span>${o.unit ? `<small>${o.unit}</small>` : ''}</div>` +
    `${o.param != null ? `<div class="perf-param">${o.param}</div>` : ''}</div>`;
  const spark = o.spark ? `<div class="perf-spark"><svg data-p="${o.spark}" viewBox="0 0 280 100" preserveAspectRatio="none"></svg></div>` : '';
  return head + mid + spark;
}

/* ---------- 渲染器 ---------- */
const RENDER = {
  gpu: (p, sz) => pf({ title: 'GPU', model: 'gpuShort', chip: 'gpuTemp', hero: 'gpuUtil', unit: '%',
    param: '功耗 <span data-p="gpuPower">–</span> W', spark: 'gpuSpark' }),
  cpu: (p, sz) => pf({ title: 'CPU', model: 'cpuShort', chip: 'cpuClockChip', hero: 'cpuUtil', unit: '%',
    param: '频率 <span data-p="cpuClock">–</span> GHz', spark: 'cpuSpark' }),
  ram: (p, sz) => pf({ title: '内存', model: 'ramTotal', chip: 'ramPct', hero: 'ramUsed', unit: 'GB',
    param: '可用 <span data-p="ramFree">–</span> GB', spark: 'ramSpark' }),
  fan: (p, sz) => pf({ title: '风扇', model: 'gpuShort', hero: 'gpuFan', unit: '%',
    param: 'GPU 散热', spark: 'fanSpark' }),
  gpupower: (p, sz) => pf({ title: '功耗', model: 'gpuShort', hero: 'gpuPower', unit: 'W',
    param: 'GPU 实时功耗', spark: 'powerSpark' }),
  vram: (p, sz) => pf({ title: '显存', chip: 'vramTotal', hero: 'vramUsed', unit: 'GB',
    param: '占用 <span data-p="vramPct">–</span>%', spark: 'vramSpark' }),
  gpuclock: (p, sz) => pf({ title: 'GPU 频率', model: 'gpuShort', hero: 'gpuClock', unit: 'MHz',
    param: '核心频率', spark: 'gpuClockSpark' }),
  cpuclock: (p, sz) => pf({ title: 'CPU 频率', model: 'cpuShort', hero: 'cpuClockG', unit: 'GHz',
    param: '当前频率', spark: 'cpuClockSpark' }),
  diskio: (p, sz) => `<div class="tile-head"><div class="perf-title"><span class="label">磁盘 I/O</span></div></div>
      <div class="perf-mid net-rows">
        <div class="net-row"><span class="net-arrow dl">读</span><span class="net-down io-read" data-p="ioRead">–</span></div>
        <div class="net-row"><span class="net-arrow ul">写</span><span class="net-up io-write" data-p="ioWrite">–</span></div>
      </div>
      <div class="perf-spark"><svg data-p="ioSpark" viewBox="0 0 280 100" preserveAspectRatio="none"></svg></div>`,
  uptime: (p, sz) => pf({ title: '运行时长', hero: 'upText', param: '开机以来' }),
  procs: (p, sz) => pf({ title: '进程数', hero: 'procs', param: '<span data-p="procsSub">–</span> 个进程运行中' }),
  pet(p, sz) {
    return `<div class="pet idle" data-p="pet">
        <div class="clawd-soccer" data-p="soccer"></div>
        <img class="clawd-mag" src="/clawd-magnifier.gif" alt="Clawd">
      </div>
      <span class="zzz" style="right:28%; top:16%">z</span>
      <span class="zzz z2" style="right:22%; top:10%">z</span>
      <div class="pet-status" data-p="petStatus">…</div>
      <div class="pet-sub" data-p="petSub"></div>`;
  },
  usage(p, sz) {
    const foot = sz !== 'sm'
      ? `<div class="usage-foot"><span class="live" data-p="usageStatus">连接中…</span><span class="tok" data-p="usageToken"></span></div>` : '';
    const rows = ['mSession|当前会话', 'mWeekAll|本周 · 全部模型', 'mWeekScoped|本周 · Fable'].map(x => {
      const [k, n] = x.split('|');
      return `<div class="meter" data-m="${k}">
        <div class="row1"><span class="name">${n}</span><span class="pct">–</span></div>
        <div class="track"><div class="fill"></div></div>
        ${sz !== 'sm' ? '<div class="row2"><span class="reset"></span></div>' : ''}
      </div>`;
    }).join('');
    return `<div class="tile-head"><span class="label">Claude 额度</span><span class="chip">Max 5×</span></div>
      <div class="meters">${rows}</div>${foot}`;
  },
  clock(p, sz) {
    return `<div class="clock-big" data-p="clockBig">--:--</div><div class="clock-date" data-p="clockDate"></div>`;
  },
  lyrics(p, sz) {
    return `<div class="tile-head"><span class="label">🎵 正在播放</span><span class="chip" data-p="npStatus">—</span></div>
      <div class="np-meta"><div class="np-title" data-p="npTitle">未在播放</div><div class="np-artist" data-p="npArtist"></div></div>
      <div class="np-lyric"><div class="np-line" data-p="npLine"></div><div class="np-next" data-p="npNext"></div></div>`;
  },
  text(p, sz) {
    return `<div class="tile-head"><span class="label">${esc(p.title || '备注')}</span></div>
      <div class="text-body">${esc(p.content || '')}</div>`;
  },
  net(p, sz) {
    return `<div class="tile-head"><div class="perf-title"><span class="label">网速</span></div><span class="chip" data-p="netPing">– ms</span></div>
      <div class="perf-mid net-rows">
        <div class="net-row"><span class="net-arrow dl">↓</span><span class="net-down" data-p="netDown">–</span></div>
        <div class="net-row"><span class="net-arrow ul">↑</span><span class="net-up" data-p="netUp">–</span></div>
      </div>
      <div class="perf-spark"><svg data-p="netSpark" viewBox="0 0 280 100" preserveAspectRatio="none"></svg></div>`;
  },
  weather(p, sz) {
    return `<div class="tile-head"><span class="label">天气 · <span data-p="wxCity">–</span></span><span class="chip" data-p="wxHiLo">–</span></div>
      <div class="wx-main"><span class="wx-icon" data-p="wxIcon">⛅</span>
        <span class="wx-temp"><span data-p="wxTemp">–</span><small>°C</small></span>
        <div class="wx-side"><div class="wx-desc" data-p="wxDesc">加载中…</div><div class="wx-updated" data-p="wxUpd"></div></div>
      </div>
      <div class="wx-rain" data-p="wxRain">–</div>`;
  },
  calendar(p, sz) {
    return `<div class="tile-head"><span class="label">日程</span><span class="chip" data-p="calChip">–</span></div>
      <div class="cal-main">
        <div class="cal-count" data-p="calCount">–</div>
        <div class="cal-title" data-p="calTitle">加载中…</div>
        <div class="cal-when" data-p="calWhen"></div>
      </div>
      <div class="cal-next" data-p="calNext"></div>`;
  },
  disk(p, sz) {
    return `<div class="tile-head"><span class="label">磁盘</span><span class="chip" data-p="diskTemp">–</span></div>
      <div class="disk-rows" data-p="diskRows"></div>`;
  },
  notify(p, sz) {
    return `<div class="tile-head"><span class="label">手机通知</span><span class="chip" data-p="ntfChip">–</span></div>
      <div class="ntf-list" data-p="ntfList"><div class="ntf-empty">暂无通知</div></div>`;
  },
};

/* ---------- 字段级布局 (大小/对齐/位置) ----------
   p.fields = { 字段: { s: 倍率, a: 'left|center|right', x: px, y: px } }
   兼容旧格式 p.fs = { 字段: 倍率 } */
const PERF_FS = { title: '.label', value: '.hero', param: '.perf-param' };   // 性能类通用: 标题/数字/参数(折线不可调)
const FS_FIELDS = {
  gpu: PERF_FS, cpu: PERF_FS, ram: PERF_FS, fan: PERF_FS, gpupower: PERF_FS,
  vram: PERF_FS, gpuclock: PERF_FS, cpuclock: PERF_FS, uptime: PERF_FS, procs: PERF_FS,
  net:    { title: '.label', down: '.net-down', up: '.net-up' },
  diskio: { title: '.label', read: '.io-read', write: '.io-write' },
  clock:  { time: '.clock-big', date: '.clock-date' },
  usage:  { title: '.label', name: '.name', pct: '.pct', reset: '.row2' },
  text:   { title: '.label', content: '.text-body' },
  lyrics: { title: '.label', meta: '.np-meta', line: '.np-line', next: '.np-next' },
  pet:    { status: '.pet-status', sub: '.pet-sub' },
  weather:{ title: '.label', temp: '.wx-temp', desc: '.wx-desc', rain: '.wx-rain' },
  calendar:{ title: '.label', count: '.cal-count', event: '.cal-title', when: '.cal-when' },
  disk:   { title: '.label', rows: '.disk-rows' },
  notify: { title: '.label', items: '.ntf-list' },
};
// 管理台检查器用: [key, 中文名, 是否可对齐]。性能类统一 数值/参数/标题
const PERF_DEFS = [['value', '数值', 0], ['param', '参数', 1], ['title', '标题', 1]];
const FIELD_DEFS = {
  gpu: PERF_DEFS, cpu: PERF_DEFS, ram: PERF_DEFS, fan: PERF_DEFS, gpupower: PERF_DEFS,
  vram: PERF_DEFS, gpuclock: PERF_DEFS, cpuclock: PERF_DEFS, uptime: PERF_DEFS, procs: PERF_DEFS,
  net:    [['down', '下行速度', 0], ['up', '上行速度', 0], ['title', '标题', 1]],
  diskio: [['read', '读取速度', 0], ['write', '写入速度', 0], ['title', '标题', 1]],
  clock:  [['time', '时间', 1], ['date', '日期', 1]],
  usage:  [['pct', '百分比', 0], ['name', '条目名', 0], ['reset', '重置行', 0], ['title', '标题', 1]],
  text:   [['content', '内容', 1], ['title', '标题', 1]],
  lyrics: [['line', '当前句', 1], ['next', '下一句', 1], ['meta', '歌名/歌手', 1], ['title', '标题', 1]],
  pet:    [['status', '状态文字', 1], ['sub', '副文字', 1]],
  weather:[['temp', '温度', 0], ['desc', '天气描述', 1], ['rain', '降雨提示', 1], ['title', '标题', 1]],
  calendar:[['count', '倒计时', 1], ['event', '事件标题', 1], ['when', '时间', 1], ['title', '标题', 1]],
  disk:   [['rows', '磁盘列表', 0], ['title', '标题', 1]],
  notify: [['items', '通知列表', 0], ['title', '标题', 1]],
};

function fieldConf(p, k) {
  if (p.fields && p.fields[k]) return p.fields[k];
  if (p.fs && typeof p.fs[k] === 'number') return { s: p.fs[k] };   // 旧格式兼容
  return null;
}
function applyFieldLayout(t, p) {
  const defs = FS_FIELDS[p.type];
  if (!defs) return;
  for (const k of Object.keys(defs)) {
    const c = fieldConf(p, k);
    if (!c) continue;
    t.querySelectorAll(defs[k]).forEach(el => {
      if (c.s && c.s !== 1) el.style.zoom = c.s;
      if (c.a) {
        el.style.textAlign = c.a;
        el.style.alignSelf = c.a === 'center' ? 'center' : c.a === 'right' ? 'flex-end' : 'flex-start';
        if (el.style.display !== 'flex') el.style.width = '100%';
      }
      if (c.x || c.y) el.style.transform = `translate(${c.x || 0}px, ${c.y || 0}px)`;
    });
  }
}

/* ---------- 走势图 ---------- */
function spark(svg, data, opts) {
  opts = opts || {};
  if (!svg || !data || data.length < 2) return;
  const vb = svg.viewBox.baseVal, W = vb.width, H = vb.height;
  const padT = opts.padTop == null ? 14 : opts.padTop;
  const hi = opts.max != null ? opts.max : Math.max(Math.max.apply(null, data) * 1.3, opts.floor || 1);
  const n = data.length, inset = 5;
  const pts = data.map((v, i) => [(W - inset) * i / (n - 1), H - (H - padT) * Math.min(v / hi, 1)]);
  const gid = 'g' + Math.random().toString(36).slice(2, 8);
  const line = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const lastX = pts[n - 1][0].toFixed(1);
  svg.innerHTML =
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
       <stop offset="0%" stop-color="var(--accent, #3987e5)" stop-opacity=".38"/>
       <stop offset="100%" stop-color="var(--accent, #3987e5)" stop-opacity="0"/></linearGradient></defs>` +
    `<path d="M0,${H} L${pts.map(p => p.map(x => x.toFixed(1)).join(',')).join(' L')} L${lastX},${H} Z" fill="url(#${gid})"/>` +
    `<polyline points="${line}" fill="none" stroke="var(--accent, #3987e5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` +
    `<circle cx="${lastX}" cy="${pts[n - 1][1].toFixed(1)}" r="3.6" fill="var(--accent, #3987e5)" stroke="#171716" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
}
// 双线走势(下行主色 + 上行灰), 共用同一坐标系
function spark2(svg, a, b, opts) {
  opts = opts || {};
  if (!svg || !a || a.length < 2) return;
  const vb = svg.viewBox.baseVal, W = vb.width, H = vb.height;
  const padT = opts.padTop == null ? 12 : opts.padTop;
  const hi = Math.max(Math.max.apply(null, a.concat(b || [0])) * 1.25, 1024);
  const inset = 5;
  const toPts = arr => arr.map((v, i) => [(W - inset) * i / (arr.length - 1), H - (H - padT) * Math.min(v / hi, 1)]);
  const pa = toPts(a);
  const gid = 'g' + Math.random().toString(36).slice(2, 8);
  let html =
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
       <stop offset="0%" stop-color="var(--accent, #3987e5)" stop-opacity=".32"/>
       <stop offset="100%" stop-color="var(--accent, #3987e5)" stop-opacity="0"/></linearGradient></defs>` +
    `<path d="M0,${H} L${pa.map(p => p.map(x => x.toFixed(1)).join(',')).join(' L')} L${pa[pa.length - 1][0].toFixed(1)},${H} Z" fill="url(#${gid})"/>` +
    `<polyline points="${pa.map(p => p.map(x => x.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="var(--accent, #3987e5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  if (b && b.length >= 2) {
    const pb = toPts(b);
    html += `<polyline points="${pb.map(p => p.map(x => x.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="rgba(255,255,255,.30)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  }
  svg.innerHTML = html;
}

/* ---------- 数据更新器 (root = document 或管理台舞台) ---------- */
const put = (root, key, val) => root.querySelectorAll(`[data-p="${key}"]`).forEach(el => { el.textContent = val; });

function fmtUptime(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + ' 分';
  const h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return d + ' 天 ' + (h % 24) + ' 时';
  return h + ' 时 ' + (m % 60) + ' 分';
}
function updateStats(root, s) {
  if (!s || !s.gpu) return;
  const g = s.gpu, c = s.cpu, r = s.ram, io = s.io || {}, sys = s.sys || {};
  // GPU
  put(root, 'gpuShort', g.short || 'GPU');
  put(root, 'gpuUtil', g.ok ? g.util : '–');
  root.querySelectorAll('[data-p="gpuTemp"]').forEach(el => { el.textContent = g.temp + '°C'; el.classList.toggle('hot', g.temp >= 80); });
  put(root, 'gpuPower', Math.round(g.power));
  put(root, 'gpuClock', g.clock);
  put(root, 'gpuFan', g.ok ? g.fan : '–');
  // 显存
  put(root, 'vramUsed', (g.vramUsed / 1024).toFixed(1));
  put(root, 'vramTotal', '共 ' + (g.vramTotal / 1024).toFixed(0) + ' GB');
  put(root, 'vramPct', g.vramTotal ? Math.round(g.vramUsed / g.vramTotal * 100) : '–');
  // CPU
  put(root, 'cpuShort', c.short || '');
  put(root, 'cpuUtil', c.util);
  const cg = (c.clock / 1000).toFixed(1);
  put(root, 'cpuClock', cg); put(root, 'cpuClockG', cg); put(root, 'cpuClockChip', cg + ' GHz');
  // 内存
  put(root, 'ramUsed', r.usedGB.toFixed(1));
  put(root, 'ramTotal', '共 ' + r.totalGB.toFixed(0) + ' GB');
  put(root, 'ramFree', (r.totalGB - r.usedGB).toFixed(1));
  put(root, 'ramPct', Math.round(r.usedGB / r.totalGB * 100) + '%');
  // 磁盘 I/O
  put(root, 'ioRead', io.ok ? fmtBps(io.read) : '–');
  put(root, 'ioWrite', io.ok ? fmtBps(io.write) : '–');
  // 系统
  put(root, 'upText', sys.uptimeMs != null ? fmtUptime(sys.uptimeMs) : '–');
  put(root, 'procs', sys.procs || '–'); put(root, 'procsSub', sys.procs || '–');
  // 折线(颜色随主色, 位置固定底部)
  const sp = (key, data, opts) => root.querySelectorAll(`[data-p="${key}"]`).forEach(el => spark(el, data, opts));
  sp('gpuSpark', g.hist, { floor: 20, padTop: 14 });
  sp('cpuSpark', c.hist, { floor: 20, padTop: 14 });
  sp('ramSpark', r.hist, { max: r.totalGB, padTop: 14 });
  sp('fanSpark', g.fanHist, { floor: 20, padTop: 14 });
  sp('powerSpark', g.powerHist, { padTop: 14 });
  sp('vramSpark', g.vramHist, { max: g.vramTotal, padTop: 14 });
  sp('gpuClockSpark', g.clockHist, { padTop: 14 });
  sp('cpuClockSpark', c.clockHist, { padTop: 14 });
  root.querySelectorAll('[data-p="ioSpark"]').forEach(el => spark2(el, io.readHist || [], io.writeHist || [], { padTop: 12 }));
}

function fmtReset(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  const hhmm = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return '重置 今天 ' + hhmm;
  return '重置 周' + ['日', '一', '二', '三', '四', '五', '六'][d.getDay()] + ' ' + hhmm;
}
function fmtRemain(ms) {
  if (!ms) return '';
  const diff = ms - Date.now();
  if (diff <= 0) return '即将重置';
  const m = Math.round(diff / 60000);
  if (m < 60) return '还剩 ' + m + ' 分';
  if (m < 1440) return '还剩 ' + Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
  return '还剩 ' + Math.floor(m / 1440) + ' 天 ' + Math.floor((m % 1440) / 60) + ' 时';
}
function setMeter(root, key, m) {
  root.querySelectorAll(`[data-m="${key}"]`).forEach(el => {
    const pctEl = el.querySelector('.pct'), fill = el.querySelector('.fill'), reset = el.querySelector('.reset');
    if (!m) { pctEl.textContent = '–'; fill.style.width = '0%'; if (reset) reset.textContent = ''; return; }
    const sev = m.severity || (m.pct >= 90 ? 'critical' : m.pct >= 70 ? 'warning' : 'normal');
    el.classList.toggle('crit', sev === 'critical');
    el.classList.toggle('warn', sev === 'warning' || sev === 'serious');
    pctEl.textContent = Math.round(m.pct) + '%';
    fill.style.width = Math.min(m.pct, 100) + '%';
    if (reset) reset.textContent = m.resetsAt ? (fmtReset(m.resetsAt) + ' · ' + fmtRemain(m.resetsAt)) : '';
  });
}
function updateUsage(root, c) {
  if (!c) return;
  if (c.usage) {
    setMeter(root, 'mSession', c.usage.session);
    setMeter(root, 'mWeekAll', c.usage.weekAll);
    const sc = c.usage.weekScoped;
    if (sc && sc.label) root.querySelectorAll('[data-m="mWeekScoped"] .name').forEach(el => { el.textContent = '本周 · ' + sc.label; });
    setMeter(root, 'mWeekScoped', sc);
  }
  root.querySelectorAll('[data-p="usageStatus"]').forEach(el => {
    if (c.error) { el.classList.add('stale'); el.textContent = c.error; }
    else if (c.fetchedAt) { el.classList.remove('stale'); el.textContent = '官方数据 · ' + new Date(c.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' 更新'; }
  });
  // 令牌剩余有效期
  root.querySelectorAll('[data-p="usageToken"]').forEach(el => {
    const t = c.tokenExpiresAt;
    if (!t) { el.textContent = ''; el.classList.remove('warn', 'crit'); return; }
    const min = Math.round((t - Date.now()) / 60000);
    el.classList.toggle('crit', min <= 0);
    el.classList.toggle('warn', min > 0 && min < 30);
    if (min <= 0) el.textContent = '🔑 令牌已过期';
    else if (min < 60) el.textContent = '🔑 令牌 ' + min + ' 分后过期';
    else el.textContent = '🔑 令牌 ' + Math.floor(min / 60) + ' 时 ' + (min % 60) + ' 分后过期';
  });
}

function updateClock(root, cfg) {
  const n = new Date();
  const hm = n.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const withSec = cfg && cfg.clock && cfg.clock.showSeconds;
  put(root, 'clockBig', withSec ? n.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : hm);
  put(root, 'usageClock', hm);
  put(root, 'clockDate', n.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) + ' 周' + ['日', '一', '二', '三', '四', '五', '六'][n.getDay()]);
}

// 歌词: 换行时上滑淡出 → 新句下方滑入
function updateNowPlaying(root, n) {
  if (!n) return;
  put(root, 'npStatus', n.playing ? '▶' : (n.title ? '⏸' : '—'));
  put(root, 'npTitle', n.title || '未在播放');
  put(root, 'npArtist', n.artist || '');
  const stTxt = { loading: '查歌词…', none: '未找到歌词', idle: '', ok: '' }[n.lyricsState] || '';
  const line = n.line || '', next = n.next || stTxt;
  root.querySelectorAll('.np-lyric').forEach(box => {
    const cur = box.querySelector('.np-line'), nx = box.querySelector('.np-next');
    if ((box.dataset.line || '') === line) { if (nx.textContent !== next) nx.textContent = next; return; }
    if (box.dataset.swap) {
      // 后台标签页定时器被节流可能卡住 swap 态: 超时强制复位, 避免歌词永久冻结
      if (Date.now() - (+box.dataset.swapAt || 0) < 1500) return;
      box.classList.remove('np-out', 'np-in'); delete box.dataset.swap;
    }
    box.dataset.swap = '1'; box.dataset.swapAt = Date.now();
    box.classList.add('np-out');                     // 旧句上滑淡出
    setTimeout(() => {
      cur.textContent = line; nx.textContent = next; box.dataset.line = line;
      box.classList.remove('np-out'); box.classList.add('np-in');   // 新句从下方就位(无动画)
      setTimeout(() => { box.classList.remove('np-in'); delete box.dataset.swap; }, 40);   // 松开 -> 滑入
    }, 270);
  });
}

/* ---------- 扩展组件 (网速/天气/日程/磁盘/通知) ---------- */
function fmtBps(b) {
  if (b == null) return '–';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB/s';
  if (b >= 1024) return Math.round(b / 1024) + ' KB/s';
  return Math.round(b) + ' B/s';
}
function agoText(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  if (m < 1440) return Math.floor(m / 60) + ' 小时前';
  return Math.floor(m / 1440) + ' 天前';
}
function fmtEventWhen(ev) {
  const s = new Date(ev.startMs), now = new Date();
  const hm = t => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const sameDay = s.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86400000).toDateString() === s.toDateString();
  const day = sameDay ? '今天' : tomorrow ? '明天' : '周' + ['日', '一', '二', '三', '四', '五', '六'][s.getDay()] + ' ' + (s.getMonth() + 1) + '/' + s.getDate();
  if (ev.allDay) return day + ' 全天';
  return day + ' ' + hm(ev.startMs) + (ev.endMs ? ' – ' + hm(ev.endMs) : '');
}
function updateExtras(root, x) {
  if (!x) return;
  // 网速
  if (x.net) {
    put(root, 'netPing', x.net.ping == null ? '– ms' : Math.round(x.net.ping) + ' ms');
    put(root, 'netDown', x.net.ok ? fmtBps(x.net.rx) : '–');
    put(root, 'netUp', x.net.ok ? fmtBps(x.net.tx) : '–');
    root.querySelectorAll('[data-p="netSpark"]').forEach(el => spark2(el, x.net.rxHist || [], x.net.txHist || [], { padTop: 12 }));
  }
  // 天气
  const w = x.weather;
  if (root.querySelector('[data-p="wxTemp"]')) {
    if (w && w.ok) {
      put(root, 'wxCity', w.city || '–');
      put(root, 'wxTemp', Math.round(w.temp));
      put(root, 'wxIcon', w.icon || '⛅');
      put(root, 'wxDesc', w.desc || '–');
      put(root, 'wxHiLo', Math.round(w.hi) + '° / ' + Math.round(w.lo) + '°');
      put(root, 'wxUpd', w.updated ? new Date(w.updated).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' 更新' : '');
      root.querySelectorAll('[data-p="wxRain"]').forEach(el => {
        const soon = w.rainSoonMin != null;
        el.classList.toggle('warn', soon);
        el.textContent = soon
          ? `🌧 ${w.rainSoonMin <= 5 ? '现在' : '约 ' + w.rainSoonMin + ' 分钟后'}可能降雨 (${w.probMax2h || '–'}%)`
          : `未来 2 小时无降雨${w.probMax2h != null ? ' (' + w.probMax2h + '%)' : ''}`;
      });
    } else {
      put(root, 'wxDesc', (w && w.err) || '在管理台设置城市');
      put(root, 'wxRain', '–');
    }
  }
  // 日程
  const cal = x.calendar;
  if (root.querySelector('[data-p="calCount"]')) {
    if (!cal || !cal.icsSet) {
      put(root, 'calChip', '未设置');
      put(root, 'calCount', '—');
      put(root, 'calTitle', '在管理台设置日历订阅');
      put(root, 'calWhen', ''); put(root, 'calNext', '');
    } else if (!cal.ok) {
      put(root, 'calChip', '!'); put(root, 'calTitle', cal.err || '日历获取失败');
    } else {
      const now = Date.now();
      const evs = (cal.events || []).filter(e => (e.endMs || e.startMs + 3600000) > now);
      const todayN = evs.filter(e => new Date(e.startMs).toDateString() === new Date().toDateString()).length;
      put(root, 'calChip', todayN ? '今天 ' + todayN + ' 条' : '今天无');
      const ev = evs[0];
      if (!ev) {
        put(root, 'calCount', '🎉');
        put(root, 'calTitle', '近两周没有日程');
        put(root, 'calWhen', ''); put(root, 'calNext', '');
      } else {
        const mins = Math.round((ev.startMs - now) / 60000);
        root.querySelectorAll('[data-p="calCount"]').forEach(el => {
          el.classList.remove('now', 'soon');
          if (mins <= 0) { el.textContent = '进行中'; el.classList.add('now'); }
          else if (mins < 60) { el.textContent = mins + ' 分钟后'; if (mins <= 15) el.classList.add('soon'); }
          else if (mins < 1440) el.textContent = Math.floor(mins / 60) + ' 小时后';
          else el.textContent = Math.floor(mins / 1440) + ' 天后';
        });
        put(root, 'calTitle', ev.title || '(无标题)');
        put(root, 'calWhen', fmtEventWhen(ev));
        const ev2 = evs[1];
        put(root, 'calNext', ev2 ? '之后: ' + (ev2.title || '(无标题)') + ' · ' + fmtEventWhen(ev2) : '');
      }
    }
  }
  // 磁盘
  const dk = x.disk;
  if (root.querySelector('[data-p="diskRows"]')) {
    if (dk && dk.ok && dk.drives && dk.drives.length) {
      const maxT = (dk.temps || []).reduce((m, t) => Math.max(m, t.c || 0), 0);
      put(root, 'diskTemp', maxT ? maxT + '°C' : '—');
      const html = dk.drives.map(d => {
        const pct = d.totalGB ? Math.round((1 - d.freeGB / d.totalGB) * 100) : 0;
        const cls = pct >= 95 ? ' crit' : pct >= 85 ? ' warn' : '';
        const free = d.freeGB >= 1000 ? (d.freeGB / 1024).toFixed(1) + ' TB' : Math.round(d.freeGB) + ' GB';
        return `<div class="disk-row${cls}"><span class="dk-l">${esc(d.letter)}:</span><div class="track"><div class="fill" style="width:${pct}%"></div></div><span class="dk-v">${free} 可用</span></div>`;
      }).join('');
      root.querySelectorAll('[data-p="diskRows"]').forEach(el => { if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; } });
    }
  }
  // 手机通知
  const nf = x.notify;
  if (root.querySelector('[data-p="ntfList"]')) {
    let empty = '暂无通知';
    if (!nf || !nf.enabled) empty = '未开启 · 在管理台打开通知监听';
    else if (nf.status === 'denied') empty = '需在 Windows 设置授权通知访问';
    const items = (nf && nf.recent || []).slice(0, 4);
    const html = items.length
      ? items.map(i => `<div class="ntf-item"><div class="ntf-t"><b>${esc(i.app)}</b>${i.title ? ' · ' + esc(i.title) : ''}<span class="ntf-ago">${agoText(i.ts)}</span></div>${i.body ? `<div class="ntf-b">${esc(i.body)}</div>` : ''}</div>`).join('')
      : `<div class="ntf-empty">${empty}</div>`;
    put(root, 'ntfChip', items.length ? items.length + ' 条' : '—');
    root.querySelectorAll('[data-p="ntfList"]').forEach(el => { if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; } });
  }
}

window.W = {
  esc, TYPE_META, RENDER, FS_FIELDS, FIELD_DEFS, sizeClass,
  fieldConf, applyFieldLayout, spark, spark2, put,
  updateStats, updateUsage, updateClock, updateNowPlaying, updateExtras,
  fmtReset, fmtRemain, fmtBps,
};
})();
