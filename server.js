// 副屏仪表盘服务端 — 零依赖 Node.js
// 数据源: os 模块(CPU/RAM) + nvidia-smi(GPU) + Codex 官方 App Server(只读额度) + Claude/Codex 会话活动
'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { readCodexAccountUsage } = require('./codex-usage');

const PORT = 3777;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// 该地区直连 Anthropic 被拦, 必须走本地代理(Clash Verge 等)。默认读环境变量, 回退 7897。
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy ||
                  process.env.HTTP_PROXY || process.env.http_proxy || 'http://127.0.0.1:7897';

// ---------------- 配置系统 (管理页驱动) ----------------

const CONFIG_FILE = path.join(__dirname, 'config.json');
const VERSION = '1.0.0';

const DEFAULT_CONFIG = {
  device: { name: 'Windows 副屏' },
  theme: { accent: '#3987e5' },
  rotation: { keyCycles: false, intervalSec: 20 },   // keyCycles=亮度键翻页(这块屏上很别扭,默认关); intervalSec=自动轮换秒数(0=关)
  hotkey: { enabled: false, mods: 3, vk: 39, label: 'Ctrl + Alt + →' },   // 小副屏全局热键翻页
  wideHotkey: { enabled: true },   // 宽屏全局热键 PageUp/PageDown 翻页(系统级, 不需焦点; 副作用: 全局占用这两键)
  lyrics: { enabled: true, offsetSec: 0 },   // 正在播放+歌词(SMTC+lrclib 实时, 不落盘); offsetSec=歌词提前/延后微调(0.1s 级)
  usage: { intervalMin: 1 },        // Codex 额度刷新间隔(分钟), 1 为下限
  clock: { showSeconds: false },    // 时钟面板是否显示秒
  pageToast: { enabled: true },     // 切页时短暂显示页名
  net: { enabled: true, pingHost: '223.5.5.5' },          // 网速+延迟采集
  weather: { enabled: true, city: '', lat: null, lon: null, label: '' },   // 天气(管理台搜城市写入经纬度)
  calendar: { icsUrl: '' },         // 日程 ICS 订阅地址
  disk: { enabled: true },          // 磁盘空间/温度
  notify: { enabled: false },       // 手机通知监听(需 Windows 授权通知访问, 默认关)
  mouseGuard: { enabled: false, games: ['cs2', 'csgo', 'valorant', 'cf', 'crossfire', 'r5apex'] },   // 鼠标围栏; games=全屏时收紧围栏到游戏屏的进程名
  dashboardWindow: { topmost: true }, // 两块仪表盘窗口共用置顶开关；启动脚本也读取此设置
  health: { url: '' },              // 服务器健康检查地址(宽副屏右侧小卡), 空=不检查
  audio: { favorites: ['Realtek'] },   // 按本机输出设备名称设置筛选关键字
  apps: [                            // 宽副屏操控台·应用启动器(cmd 经 "start" 执行, 支持 exe 名/完整路径/协议)
    { id: 'edge',    label: 'Edge',   cmd: 'msedge',            color: '#0ea5e9', ch: 'e' },
    { id: 'vscode',  label: 'VS Code', cmd: 'code',             color: '#3b82f6', ch: '</>' },
    { id: 'steam',   label: 'Steam',  cmd: 'steam://open/main', color: '#66c0f4', ch: 'S', long: 'steamPanel' },
    { id: 'ncm',     label: '网易云',  cmd: 'orpheus://',        color: '#dd001b', ch: '♪' },
    { id: 'terminal', label: '终端',   cmd: 'wt',                color: '#334155', ch: '>_' },
    { id: 'wechat',  label: '微信',    cmd: 'weixin://',         color: '#22c55e', ch: '微' },
    { id: 'obs',     label: 'OBS',    cmd: 'obs64',             color: '#6b7280', ch: 'O' },
    { id: 'files',   label: '文件',    cmd: 'explorer',          color: '#f59e0b', ch: '文' },
  ],
  pages: [
    { name: '总览', panels: [
      { id: 'p1', type: 'gpu',   w: 2, h: 2 },
      { id: 'p2', type: 'pet',   w: 2, h: 2 },
      { id: 'p3', type: 'cpu',   w: 1, h: 1 },
      { id: 'p4', type: 'ram',   w: 1, h: 1 },
      { id: 'p5', type: 'usage', w: 2, h: 2 },
      { id: 'p6', type: 'clock', w: 2, h: 1 },
    ]},
    { name: 'Claude', panels: [
      { id: 'q1', type: 'pet',   w: 2, h: 2 },
      { id: 'q2', type: 'usage', w: 2, h: 2 },
      { id: 'q3', type: 'clock', w: 2, h: 2 },
      { id: 'q4', type: 'text',  w: 2, h: 2, title: '提示', content: '在管理页自定义这块面板\nhttp://localhost:3777/admin' },
    ]},
  ],
};

let config = DEFAULT_CONFIG;
let cfgRev = 1;
try { config = Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch { /* 用默认并落盘 */ }
function saveConfig() {
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  cfgRev++;
}
if (!fs.existsSync(CONFIG_FILE)) saveConfig();

// 当前显示第几页 (服务端持有, 管理页/亮度键都能翻)
const view = { pageIdx: 0, lastRotate: Date.now() };
// 宽屏翻页脉冲: 全局热键(PageUp/PageDown)按一下 seq++ 记方向。
// 宽屏页码是前端自管的(触摸/边缘手势也改它), 服务端只发"翻页事件"不做绝对页码权威, 不会打架。
// 推送走 SSE(按键即时推, 几十毫秒到)+ /api/stats 里的 seq 兜底(SSE 断线时靠 1s 轮询补上)。
const widePage = { seq: 0, dir: 0 };
const wideSse = new Set();   // 宽屏 SSE 连接(EventSource), 热键触发时即时广播
function wideSsePush(dir) {
  const line = `event: page\ndata: ${dir}\n\n`;
  for (const res of wideSse) { try { res.write(line); } catch {} }
}
function nextPage(step) {
  const n = Math.max(1, (config.pages || []).length);
  view.pageIdx = ((view.pageIdx + (step || 1)) % n + n) % n;
  view.lastRotate = Date.now();
}
setInterval(() => {   // 自动轮换
  const s = config.rotation && config.rotation.intervalSec;
  if (s > 0 && Date.now() - view.lastRotate >= s * 1000) nextPage(1);
}, 1000);

// 物理按键/热键统一入口: 有全屏提醒时先"确认消除", 否则翻页
function triggerButton(steps, src) {
  if (alert.active) { ackAlert(); console.log('[' + (src || 'key') + '] 确认提醒 ->', alert.type); return { acked: true }; }
  nextPage(steps || 1);
  console.log('[' + (src || 'key') + '] 翻页 x' + (steps || 1) + ' -> 第', view.pageIdx + 1, '页');
  return { pageIdx: view.pageIdx };
}

// ---------------- 性能采样 ----------------

// CPU 型号短名: "AMD Ryzen 7 9800X3D 8-Core Processor" -> "9800X3D"; "Intel Core i7-13700K" -> "i7-13700K"
function cpuShort(model) {
  const m = model.match(/i\d-\d{3,5}\w*|Ryzen\s+\d+\s+(\w*X3D|\w+)|(\w*X3D)|\d{4,5}[A-Z]{0,3}/i);
  if (m) return (m[1] || m[2] || m[0]).trim();
  return model.replace(/\(R\)|\(TM\)|CPU|Processor|Core|\d+-Core|@.*/gi, '').trim().split(/\s+/).pop() || model;
}
const state = {
  cpu: { util: 0, model: os.cpus()[0].model.trim(), short: cpuShort(os.cpus()[0].model), clock: 0, hist: [], clockHist: [] },
  ram: { usedGB: 0, totalGB: os.totalmem() / 2 ** 30, hist: [] },
  gpu: { name: '', short: '', util: 0, temp: 0, power: 0, vramUsed: 0, vramTotal: 0, clock: 0, fan: 0,
         hist: [], powerHist: [], vramHist: [], clockHist: [], fanHist: [], ok: false },
  io: { read: 0, write: 0, readHist: [], writeHist: [], ok: false },   // 磁盘读写字节/秒
  sys: { procs: 0, bootMs: (Date.now() - os.uptime() * 1000) },        // 进程数 + 开机时刻
};

let prevCpuTimes = cpuTimes();
function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

function sampleCpuRam() {
  const cur = cpuTimes();
  const dTotal = cur.total - prevCpuTimes.total;
  const dIdle = cur.idle - prevCpuTimes.idle;
  prevCpuTimes = cur;
  if (dTotal > 0) state.cpu.util = Math.round((1 - dIdle / dTotal) * 100);
  state.ram.usedGB = (os.totalmem() - os.freemem()) / 2 ** 30;
  const cpus = os.cpus();
  state.cpu.clock = cpus.length ? cpus[0].speed : 0;   // MHz(Windows 报告当前/标称频率)
}

function sampleGpu() {
  execFile(
    'nvidia-smi',
    ['--query-gpu=name,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total,clocks.sm,fan.speed',
     '--format=csv,noheader,nounits'],
    { timeout: 5000 },
    (err, stdout) => {
      if (err) { state.gpu.ok = false; return; }
      const p = stdout.trim().split(',').map(s => s.trim());
      if (p.length < 7) return;
      state.gpu.name = p[0];
      state.gpu.short = p[0].replace(/NVIDIA|GeForce/gi, '').trim();
      state.gpu.util = Number(p[1]) || 0;
      state.gpu.temp = Number(p[2]) || 0;
      state.gpu.power = Number(p[3]) || 0;
      state.gpu.vramUsed = Number(p[4]) || 0;
      state.gpu.vramTotal = Number(p[5]) || 0;
      state.gpu.clock = Number(p[6]) || 0;
      state.gpu.fan = Number(p[7]) || 0;   // 风扇转速 %([N/A] -> 0)
      state.gpu.ok = true;
    }
  );
}

function pushHist() {
  const push = (arr, v) => { arr.push(v); if (arr.length > 12) arr.shift(); };
  push(state.cpu.hist, state.cpu.util);
  push(state.cpu.clockHist, Math.round(state.cpu.clock));
  push(state.ram.hist, Number(state.ram.usedGB.toFixed(2)));
  push(state.gpu.hist, state.gpu.util);
  push(state.gpu.powerHist, Math.round(state.gpu.power));
  push(state.gpu.vramHist, Math.round(state.gpu.vramUsed));
  push(state.gpu.clockHist, state.gpu.clock);
  push(state.gpu.fanHist, state.gpu.fan);
  push(state.io.readHist, Math.round(state.io.read));
  push(state.io.writeHist, Math.round(state.io.write));
}

setInterval(sampleCpuRam, 2000);
// nvidia-smi is a short-lived process, so a 2s cadence caused needless process churn.
// Ten seconds is still responsive enough for a dashboard while cutting launches by 80%.
setInterval(sampleGpu, 10000);
setInterval(pushHist, 5000);
sampleCpuRam(); sampleGpu();

// 磁盘 I/O + 进程数: 用系统自带的原生 typeperf 常驻采样。
// 只查询 PhysicalDisk(0*)，明确绕开 H:/I: 两个无介质 USB 读卡器；不再启动 80+MB 的 PowerShell，
// 也不再使用会枚举所有磁盘的 PhysicalDisk(_Total)。
let perfChild = null;
function spawnPerfExtra() {
  if (perfChild) return;
  const typeperf = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'typeperf.exe');
  const child = spawn(typeperf, [
    '\\PhysicalDisk(0*)\\Disk Read Bytes/sec',
    '\\PhysicalDisk(0*)\\Disk Write Bytes/sec',
    '\\System\\Processes',
    '-si', '5',
  ], { windowsHide: true });
  perfChild = child;
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('"') || line.includes('(PDH-CSV')) continue;
      const cols = Array.from(line.matchAll(/"([^"]*)"/g), m => m[1]);
      if (cols.length < 4) continue;
      const read = Number(cols[1]), write = Number(cols[2]), procs = Number(cols[3]);
      if (!Number.isFinite(read) || !Number.isFinite(write)) continue;
      state.io.read = Math.max(0, read);
      state.io.write = Math.max(0, write);
      state.io.ok = true;
      if (Number.isFinite(procs)) state.sys.procs = Math.max(0, Math.round(procs));
    }
  });
  child.on('exit', () => { perfChild = null; state.io.ok = false; setTimeout(spawnPerfExtra, 15000); });
  child.on('error', () => { perfChild = null; state.io.ok = false; });
}
spawnPerfExtra();

// kiosk 位置看门狗改由独立的交互式计划任务运行(watch-position.ps1)——
// node 子进程拿不到桌面访问权(proc=False, 见调试记录), 必须内联在有桌面权限的进程里跑。

// ---------------- Claude 会话活动 (桌宠状态) ----------------

// 优先用 hooks 事件(精确、含授权/完成)；hooks 未注册或过期时回退到扫 JSONL 尾部
const ACTIVITY_FILE = path.join(os.homedir(), '.claude', 'sidescreen-activity.json');
const activity = {
  state: 'sleeping',   // permission | tool | thinking | done | idle | sleeping
  tool: null,
  notice: null,
  ts: null,            // 该状态的产生时刻，前端用它触发一次性动画
  lastActiveMs: null,
  activeSessions: 0,
  source: 'jsonl-tail',
};

let hookRec = null;
function readHookFile() {
  try { hookRec = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); }
  catch { /* 文件不存在/正在替换：沿用上次 */ }
}

// 远程设备 (如 Mac) 通过 POST /api/activity-report 上报, 与本机 hooks 同权合并
const remoteDevices = {};   // name -> { state, tool, notice, ts }
/* 远程「每会话」快照: 本机会话是一个 sid 一个文件, 远程没有文件系统可读 -> 在内存里按 设备|会话 攒。
   有了它, Mac 上的对话才能和本机对话一样一张张列在会话页上, 而不是只并成设备的一个总状态。
   注意远程事件多半是脱敏的(detail/notice/cwd 为空, sid 是哈希), 只当状态骨架用。 */
const remoteSessions = new Map();   // "设备|sid" -> { device, sid, state, kind, tool, detail, notice, cwd, ts }

/* 远程事件转发进 supervisor 总线(127.0.0.1:3778)。
   为什么走这条路而不是让 Mac 直连 3778: supervisor 只绑回环, 远程连不上; 而把它绑到网上就等于
   把「启停服务」那些控制接口一起暴露出去。所以入口放在本来就对网开放的副屏这边, 收到再从
   localhost 投进总线 —— 不增加任何对外暴露面, supervisor 挂了也只是没历史, 副屏照常显示。
   fire-and-forget: 转发失败绝不影响副屏自己的显示。 */
const BUS_URL = { host: '127.0.0.1', port: 3778, path: '/api/bus/ingest' };
function forwardToBus(evt) {
  try {
    const data = Buffer.from(JSON.stringify(evt), 'utf8');
    const r = http.request({
      host: BUS_URL.host, port: BUS_URL.port, path: BUS_URL.path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => res.resume());
    r.on('error', () => {});                       // supervisor 没起就静默跳过
    r.setTimeout(1500, () => { try { r.destroy(); } catch {} });
    r.end(data);
  } catch { /* 忽略 */ }
}

/* 设备在线状态: 以 supervisor 总线为准(它是汇总所有设备事件的那一层)。
   每 10s 拉一次缓存; supervisor 不可达就退回副屏自己算的那份, 并在响应里标明 source,
   免得面板显示了却不知道这数字是谁给的。 */
let busDevices = { list: null, at: 0 };
function pollBusDevices() {
  try {
    const r = http.request({ host: BUS_URL.host, port: BUS_URL.port, path: '/api/devices', method: 'GET' }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        try { const j = JSON.parse(d); if (Array.isArray(j)) busDevices = { list: j, at: Date.now() }; }
        catch { /* 忽略 */ }
      });
    });
    r.on('error', () => { busDevices = { list: null, at: Date.now() }; });
    r.setTimeout(1500, () => { try { r.destroy(); } catch {} });
    r.end();
  } catch { /* 忽略 */ }
}
setInterval(pollBusDevices, 10 * 1000);
setTimeout(pollBusDevices, 3000);
const REMOTE_SESS_MAX = 200;        // 上限兜底, 防异常上报把内存撑爆
function remoteSessionPut(device, sid, s, cwd, name, reply) {
  if (!sid) return;
  const key = device + '|' + sid;
  const prev = remoteSessions.get(key);
  remoteSessions.set(key, {
    device, sid: String(sid),
    state: s.state, kind: s.kind || null, tool: s.tool || null,
    detail: s.detail || null, notice: s.notice || null, cwd: cwd || null,
    // 会话名/最后回复: 上报方脱敏时可能不带, 或这一刻转录里还没有文字回复(全是工具输出) ->
    // 沿用这个会话上次报过的, 别让卡片上的名字和回复忽有忽无(PC 那边 lastReplyFor 也是这个 sticky 策略)
    name: name || (prev && prev.name) || null,
    reply: reply || (prev && prev.reply) || null,
    ts: Date.now(),
  });
  if (remoteSessions.size > REMOTE_SESS_MAX) {   // 淘汰最旧的
    const oldest = [...remoteSessions.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) remoteSessions.delete(oldest[0]);
  }
}

// 与 hook.js 相同的事件->状态映射 (远程端直接发原始 hook JSON)
const NEEDS_YOU = new Set(['permission_prompt', 'agent_needs_input', 'elicitation_dialog']);
function deriveHookState(d) {
  switch (d.hook_event_name) {
    case 'UserPromptSubmit': return { state: 'thinking' };
    case 'PreToolUse':       return { state: 'tool', tool: d.tool_name };
    case 'PostToolUse':
    case 'PostToolUseFailure': return { state: 'thinking' };
    case 'PermissionRequest':  return { state: 'permission', tool: d.tool_name };
    case 'PermissionDenied':   return { state: 'thinking' };
    case 'SubagentStart':      return { state: 'tool', tool: 'Agent' };
    case 'SubagentStop':       return { state: 'thinking' };
    case 'Stop':               return { state: 'done' };
    case 'SessionEnd':         return { state: 'ended' };
    case 'Notification': {
      const t = d.type || d.notification_type;
      if (NEEDS_YOU.has(t)) return { state: 'permission', notice: d.message };
      if (t === 'agent_completed') return { state: 'done' };
      if (t === 'idle_prompt') return { state: 'idle' };
      return null;
    }
    default: return null;
  }
}

const STATE_PRIO = { permission: 4, tool: 3, thinking: 3, done: 2, idle: 1, ended: 1, sleeping: 0 };

// 读文件尾部若干字节，返回最后一条能解析的 JSON 记录
function readLastRecord(file, bytes = 96 * 1024) {
  let fd;
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const len = st.size - start;
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i].trim();
      if (!s.startsWith('{')) continue;
      try { return JSON.parse(s); } catch { /* 截断的首行，继续往前 */ }
    }
  } catch { /* ignore */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
  return null;
}

// 靠"最后一条记录是什么"判断，而不是靠"多久没写文件"。
// 这样长时间思考(不写盘)也能正确显示为 working。
function classify(rec) {
  if (!rec) return null;
  if (rec.type === 'user') return 'working';          // 用户刚发问，Claude 该干活了
  if (rec.type === 'assistant') {
    const content = rec.message && rec.message.content;
    if (Array.isArray(content) && content.some(c => c.type === 'tool_use')) {
      return 'working';                                // 发起了工具调用，正在执行
    }
    return 'done';                                     // 回答完毕
  }
  return null;
}

const MIN = 60 * 1000;

// 全屏提醒: 进入 permission/done 时锁存, 需按键/热键确认才消除(不自动消失)
const alert = { active: false, type: null, ts: 0 };
let prevAlertState = null;
function ackAlert() { alert.active = false; }

// 扫 JSONL：拿最近活动时间 + 活跃会话数（两种模式都要），并给出回退状态
function scanFiles() {
  const now = Date.now();
  let newest = 0, newestFile = null, active5m = 0;
  let dirs;
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files;
    try { files = fs.readdirSync(path.join(PROJECTS_DIR, d.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(PROJECTS_DIR, d.name, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = full; }
      if (now - st.mtimeMs < 5 * MIN) active5m++;
    }
  }
  if (!newest) return null;
  activity.lastActiveMs = newest;
  activity.activeSessions = active5m;

  const age = now - newest;
  if (age > 30 * MIN) return 'sleeping';
  const verdict = classify(readLastRecord(newestFile));
  if (verdict === 'working') return age < 15 * MIN ? 'thinking' : 'idle';
  return age < 10 * MIN ? 'idle' : 'sleeping';
}

// 把 hook 事件 + 它的年龄，折算成当前该显示的状态
function decay(state, age) {
  switch (state) {
    case 'permission': return age < 30 * MIN ? 'permission' : 'idle';   // 授权提示会一直挂着等你
    case 'done':       return age < 12000 ? 'done' : (age < 10 * MIN ? 'idle' : 'sleeping');
    case 'tool':       return age < 15 * MIN ? 'tool' : 'idle';
    case 'thinking':   return age < 15 * MIN ? 'thinking' : 'idle';
    case 'idle':
    case 'ended':      return age < 10 * MIN ? 'idle' : 'sleeping';
    default:           return null;
  }
}

function computeActivity() {
  const fallback = scanFiles();
  readHookFile();
  const now = Date.now();

  // 候选池: 本机 hooks + 各远程设备, 各自按事件年龄衰减后比优先级, 平级比新鲜度
  const cands = [];
  if (hookRec && hookRec.ts && now - hookRec.ts < 30 * MIN) {
    const st = decay(hookRec.state, now - hookRec.ts);
    if (st) cands.push({ st, tool: hookRec.tool, notice: hookRec.notice, ts: hookRec.ts, device: 'PC', src: 'hooks' });
  }
  for (const [name, r] of Object.entries(remoteDevices)) {
    if (!r.ts || now - r.ts >= 30 * MIN) continue;
    const st = decay(r.state, now - r.ts);
    if (st) cands.push({ st, tool: r.tool, notice: r.notice, ts: r.ts, device: name, src: 'remote' });
  }

  if (cands.length) {
    cands.sort((a, b) => (STATE_PRIO[b.st] || 0) - (STATE_PRIO[a.st] || 0) || b.ts - a.ts);
    const w = cands[0];
    activity.source = w.src;
    activity.state = w.st;
    activity.tool = w.tool || null;
    activity.notice = w.notice || null;
    activity.ts = w.ts;
    activity.device = w.device;
    latchAlert(w.st, w.ts);
    return;
  }
  activity.source = 'jsonl-tail';
  activity.state = fallback || 'sleeping';
  activity.tool = null;
  activity.notice = null;
  activity.ts = activity.lastActiveMs;
  activity.device = 'PC';
  latchAlert(activity.state, activity.ts);
}

// 只在"新进入" permission/done 时锁存提醒(边沿触发), 之后一直显示到确认
function latchAlert(state, ts) {
  if ((state === 'permission' || state === 'done') && state !== prevAlertState) {
    alert.active = true;
    alert.type = state;
    alert.ts = ts || Date.now();
  }
  prevAlertState = state;
}
setInterval(computeActivity, 1000);
computeActivity();

// ---------------- Claude 会话面板 (per-session hooks 快照 + 转录尾读, 全程只读) ----------------
// hook.js 给每个会话写 ~/.claude/sidescreen-activity/<sid>.json (最新事件快照);
// "最后一条回复"从 ~/.claude/projects/<cwd转目录名>/<sid>.jsonl 转录尾部提取。
// 只读, 不删不写任何 ~/.claude 下的文件(桌宠共用这套快照)。
// 本机会话卡上显示的设备名(远程设备名由上报方自己带)。想改叫法就在 config.json 里写 device.local
const LOCAL_DEVICE = (config.device && config.device.local) || 'PC';
/* 「刚才在干什么」记忆: hook 的 detail(读 xx / 改 xx / $ 命令)只在 PreToolUse 那一下有,
   工具一跑完就变 thinking、detail 归空。只显示当下的话, 大部分时间就剩一句"思考中…"。
   所以在服务端按会话记住最后一个非空动作, 供卡片回填 —— 纯内存, 重启即忘, 不落盘。 */
const lastActMemo = new Map();   // key(设备|sid) -> { act, ts }
function lastActRemember(key, detail, tool) {
  const act = detail || (tool ? '用 ' + tool : null);
  if (!act) return;
  lastActMemo.set(key, { act, ts: Date.now() });
  if (lastActMemo.size > 300) {   // 兜底清理: 丢掉半小时以上没动的
    const cut = Date.now() - 30 * 60 * 1000;
    for (const [k, v] of lastActMemo) if (v.ts < cut) lastActMemo.delete(k);
  }
}
function lastActOf(key) { const v = lastActMemo.get(key); return v ? v.act : null; }
const SESS_DIR = path.join(os.homedir(), '.claude', 'sidescreen-activity');
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects');
const SESS_ACTIVE_MS = 30 * 60 * 1000;
const sessSnapCache = new Map();   // sid -> {mtime, data}
const sessReplyCache = new Map();  // sid -> {mtime, size, text}
const sessPathCache = new Map();   // sid -> 转录 jsonl 真实路径(找到就缓存, 位置不变)

// 转录目录名 = 会话「启动时」的 cwd, 不随后续 cd/子代理变。而 hooks 事件里的 cwd 是「当下」的,
// 二者可能不同(如从 D:\mywork 起、跑进 D:\mywork\clawd-badge)。所以按 sid 找文件, 不靠 cwd 拼路径。
function findTranscript(sid, cwdHint) {
  const cached = sessPathCache.get(sid);
  if (cached && fs.existsSync(cached)) return cached;
  if (cwdHint) {   // 先试当前 cwd 拼的路径(命中最快), 不中再遍历
    const guess = path.join(PROJ_DIR, String(cwdHint).replace(/[:\\/]/g, '-'), sid + '.jsonl');
    if (fs.existsSync(guess)) { sessPathCache.set(sid, guess); return guess; }
  }
  let dirs = [];
  try { dirs = fs.readdirSync(PROJ_DIR); } catch {}
  for (const d of dirs) {
    const p = path.join(PROJ_DIR, d, sid + '.jsonl');
    if (fs.existsSync(p)) { sessPathCache.set(sid, p); return p; }
  }
  return null;   // 找不到不缓存(转录可能刚开始还没落盘, 下次再找)
}

// 会话标题: 扫全文件找标题行(只 parse 含 title 的短行, 跳过大消息行)。
// custom-title(用户手改, 一次性写在中部)优先于 ai-title(自动起名, 尾部不断重写)。
function readTitle(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let custom = null, ai = null;
  for (const l of text.split('\n')) {
    if (l.indexOf('"custom-title"') >= 0) { try { const j = JSON.parse(l); if (j.customTitle) custom = j.customTitle; } catch {} }
    else if (l.indexOf('"ai-title"') >= 0) { try { const j = JSON.parse(l); if (j.aiTitle) ai = j.aiTitle; } catch {} }
  }
  return custom || ai;   // 都取最后一条; 有手改名就用手改名
}

function lastReplyFor(sid, cwd) {
  try {
    const file = findTranscript(sid, cwd);
    if (!file) return null;
    const st = fs.statSync(file);   // 不存在直接走 catch
    const c = sessReplyCache.get(sid);
    if (c && c.mtime === st.mtimeMs && c.size === st.size) return c;
    const start = Math.max(0, st.size - 1048576);   // 只读尾部 1MB(工具输出密集时文字回复可能离尾部较远)
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    // 会话标题: 手改名(custom-title)是权威, 但它只在改名那一刻写一次, 多半在文件靠前位置,
    // 尾部窗口会漏 -> 必须扫全文件(只对短的 title 行 parse, 大消息行跳过)。
    // ai-title 随对话不断重写, 取最后一条; custom-title 优先(桌面应用也这么显示)。
    let title = readTitle(file);
    if (!title && c && c.title) title = c.title;   // 万一没标题行 -> 沿用上次
    let text = null, turn = null;
    for (let i = lines.length - 1; i >= 0 && !text; i--) {
      if (!lines[i] || lines[i][0] !== '{') continue;   // 首行可能被截断, parse 失败也无妨
      try {
        const j = JSON.parse(lines[i]);
        /* 这一轮到底答完没 —— 以转录里"最后一条主线 user/assistant 记录"为准。
           桌面应用不一定发 Stop 事件(实测会话答完了快照仍停在 thinking), 光靠 hook 判断不出来。
             assistant 带 tool_use -> 正在跑工具;  assistant 纯文字 -> 这轮说完了;
             user(含工具结果回填)  -> 轮到 Claude 干活。
           子代理记录(isSidechain)跳过: 子任务先答完不代表主线答完。 */
        if (turn === null && !j.isSidechain && (j.type === 'user' || j.type === 'assistant')) {
          const arr = j.message && Array.isArray(j.message.content) ? j.message.content : null;
          turn = j.type === 'user' ? 'working'
               : (arr && arr.some(it => it && it.type === 'tool_use')) ? 'working' : 'done';
        }
        if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
          for (let k = j.message.content.length - 1; k >= 0; k--) {
            const it = j.message.content[k];
            if (it && it.type === 'text' && it.text && it.text.trim()) {
              // 洗掉 markdown 记号, 面板上纯文本更好读
              text = it.text.replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 240); break;
            }
          }
        }
      } catch { /* 半截行 */ }
    }
    if (!text && c && c.text) text = c.text;   // 尾窗里暂时没有文字回复 -> 沿用上一次找到的
    const info = { mtime: st.mtimeMs, size: st.size, text, title, turn };
    sessReplyCache.set(sid, info);
    return info;
  } catch { return null; }
}

// 会话面板诊断日志: 判定结果变化时记一块(sid/标题/原始state/推断status/是否被并入), 排查用。
const SESS_LOG = path.join(__dirname, 'sessions.log');
let sessLogSig = '';
function sessLog(raw, keptN) {
  const sig = raw.map(r => r.sid + r.status + (r.dropOf || '')).join('|');
  if (sig === sessLogSig) return;   // 没变化不刷屏
  sessLogSig = sig;
  const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
  const body = raw.map(r =>
    `  ${r.sid} | ${pad((r.title || r.proj || '?').slice(0, 22), 22)} | state=${pad(r.state, 10)} kind=${pad(r.kind || '-', 8)} age=${pad(Math.round(r.age / 1000) + 's', 6)} -> ${pad(r.status, 8)}${r.dropOf ? '  [同名并入 ' + r.dropOf + ']' : ''}`
  ).join('\n');
  const block = `[${new Date().toLocaleTimeString()}] 活跃快照 ${raw.length} 个 / 显示 ${keptN} 个\n${body}\n`;
  try {
    fs.appendFileSync(SESS_LOG, block);
    const st = fs.statSync(SESS_LOG);   // 超 256KB 截半, 防无限增长
    if (st.size > 262144) { const b = fs.readFileSync(SESS_LOG); fs.writeFileSync(SESS_LOG, b.slice(b.length - 131072)); }
  } catch { /* 日志失败不影响主流程 */ }
}

function getClaudeSessions(debug) {
  let files = [];
  try { files = fs.readdirSync(SESS_DIR).filter(f => f.endsWith('.json')); } catch { /* 目录未建 */ }
  const now = Date.now();
  const raw = [];
  for (const f of files) {
    const p = path.join(SESS_DIR, f);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (now - st.mtimeMs > SESS_ACTIVE_MS) continue;   // 30 分钟没动静的不算活跃
    const sid = f.slice(0, -5);
    let c = sessSnapCache.get(sid);
    if (!c || c.mtime !== st.mtimeMs) {
      try { c = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(p, 'utf8')) }; sessSnapCache.set(sid, c); }
      catch { continue; }
    }
    const d = c.data;
    if (!d || !d.ts || d.state === 'ended') continue;
    const age = now - d.ts;
    const info = lastReplyFor(sid, d.cwd);
    /* 状态判定, 按可信度排:
       ① permission —— 只有 hook 知道"正在等你点", 转录里看不出来, 最优先;
       ② 转录实况(info.turn) —— 答完没以转录最后一条主线记录为准。桌面应用不一定发 Stop,
          光看 hook 会让答完的会话一直挂"运行中", 直到 3 分钟超时才翻 —— 状态是秒表翻的不是事实翻的;
       ③ 转录读不到(刚开会话/尾窗全是大工具输出)才退回原来的年龄近似: tool 10 分钟、thinking 3 分钟。*/
    let status;
    if (d.state === 'permission') status = 'waiting';
    else if (info && info.turn) status = info.turn === 'working' ? 'running' : 'done';
    else if (d.state === 'done' || d.state === 'idle') status = 'done';
    else if (d.state === 'tool' && age < 10 * 60 * 1000) status = 'running';
    else if (d.state === 'thinking' && age < 3 * 60 * 1000) status = 'running';
    else status = 'done';
    const memoKey = LOCAL_DEVICE + '|' + sid;
    lastActRemember(memoKey, d.detail, d.tool);
    raw.push({
      sid: sid.slice(0, 8), fullSid: sid, cwd: d.cwd || '',
      device: LOCAL_DEVICE,                  // 本机会话; 远程的在下面追加
      lastAct: lastActOf(memoKey),           // 工具跑完 detail 会空 -> 卡片用这个回填"刚做完什么"
      proj: d.cwd ? String(d.cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '未知项目',
      title: (info && info.title) || null,   // 会话名(如"副屏设计"), 没有就让前端退回项目名
      status, state: d.state,
      kind: d.kind || (d.state === 'permission' ? 'approve' : null),
      tool: d.tool || null, detail: d.detail || null, notice: d.notice || null,
      ts: d.ts, reply: (info && info.text) || null,
      age, dropOf: null,
    });
  }
  /* 远程设备(Mac 等)的会话: 没有转录可读, 只能按 hook 事件年龄近似 —— 与本机的第③档同一套规则。
     标题/正文多半被源头脱敏掉了, 那就用「设备 + 短 sid」当名字, 至少能区分是哪一台的哪个对话。 */
  for (const r of remoteSessions.values()) {
    const age = now - r.ts;
    if (age > SESS_ACTIVE_MS) continue;                  // 与本机同一条活跃线: 30 分钟
    let status;
    if (r.state === 'permission') status = 'waiting';
    else if (r.state === 'done' || r.state === 'idle') status = 'done';
    else if (r.state === 'tool' && age < 10 * 60 * 1000) status = 'running';
    else if (r.state === 'thinking' && age < 3 * 60 * 1000) status = 'running';
    else status = 'done';
    const short = r.sid.slice(0, 8);
    const memoKey = r.device + '|' + r.sid;
    lastActRemember(memoKey, r.detail, r.tool);
    raw.push({
      sid: short, fullSid: r.device + ':' + r.sid, cwd: r.cwd || '',
      device: r.device,
      lastAct: lastActOf(memoKey),
      proj: r.cwd ? String(r.cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : (r.device + ' 会话'),
      title: r.name || null,   // 远程报上来的会话名/别名; 没有就让前端退回 proj
      status, state: r.state, kind: r.kind || null,
      tool: r.tool || null, detail: r.detail || null, notice: r.notice || null,
      ts: r.ts, reply: r.reply || null, age, dropOf: null,
    });
  }
  // 归并 resume 链: 桌面/CLI 续聊会派生新 session_id 但继承同一标题, 造成同名会话多张卡。
  // 同一 title 只保留 ts 最新的那张(旧的自动消失); 无 title 的用 fullSid 作键, 不归并。
  // 键上带设备: 两台机器各开一个同名会话是两回事, 别归并成一张卡。
  const best = new Map();
  for (const r of raw) {
    const key = r.device + (r.title ? '|T:' + r.title : '|S:' + r.fullSid);
    const cur = best.get(key);
    if (!cur || r.ts > cur.ts) best.set(key, r);
  }
  for (const r of raw) {
    const win = best.get(r.device + (r.title ? '|T:' + r.title : '|S:' + r.fullSid));
    if (win !== r) r.dropOf = win.sid;   // 被并入了哪张(仅日志用)
  }
  const out = raw.filter(r => !r.dropOf);
  const rank = { waiting: 0, running: 1, done: 2 };
  out.sort((a, b) => rank[a.status] - rank[b.status] || b.ts - a.ts);
  const counts = { total: out.length, running: 0, waiting: 0, done: 0 };
  for (const s of out) counts[s.status]++;
  // 按设备分组的条数: 给前端做「PC 2 · Mac 1」这种小计, 一眼看出哪台在忙
  const byDevice = {};
  for (const s of out) {
    const d = (byDevice[s.device] = byDevice[s.device] || { total: 0, running: 0, waiting: 0, done: 0 });
    d.total++; d[s.status]++;
  }
  sessLog(raw, out.length);
  const view = { counts, byDevice, sessions: out.slice(0, 8), t: now };
  if (debug) view.raw = raw.map(r => ({ sid: r.sid, device: r.device, title: r.title, proj: r.proj, state: r.state, kind: r.kind, ageSec: Math.round(r.age / 1000), status: r.status, dropOf: r.dropOf }));
  return view;
}

// ---------------- Codex 官方额度 (App Server JSON-RPC) ----------------
// 真实采集走 codex-usage.js 的 account/rateLimits/read + account/usage/read。
// 副屏不读取、不记录、不写入 Codex 的认证文件；登录态与刷新由 Codex 官方进程自行管理。

const usage = {
  data: null,        // Codex 动态额度桶 + token 活动摘要
  fetchedAt: null,
  error: null,
  inFlight: false,
  nextTryAt: 0,
  backoffMs: 60 * 1000,
};


// 通过 HTTP 代理的 CONNECT 隧道建 TLS 连接的 https.Agent (零依赖)
function proxyAgent() {
  const pu = new URL(PROXY_URL);
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (opts, cb) => {
    const req = http.request({
      host: pu.hostname, port: pu.port || 80, method: 'CONNECT',
      path: `${opts.host}:${opts.port || 443}`,
      headers: { Host: `${opts.host}:${opts.port || 443}` },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { cb(new Error(`代理 CONNECT ${res.statusCode}`)); return; }
      const t = tls.connect({ socket, servername: opts.host }, () => cb(null, t));
      t.on('error', e => cb(e));
    });
    req.on('error', e => cb(e));
    req.end();
  };
  return agent;
}

// ---------------- Codex 额度历史落盘 (codex-usage-history.jsonl) ----------------
// 每次成功拉到额度就采一个点 {t,b:{额度桶key:百分比},r:{额度桶key:重置时间}}；
// 动态桶结构兼容未来新增短周期额度或模型专属额度。按成功轮询逐分钟保存，即使百分比没变也保留时间密度。
// 【永久保留, 只留本机】当前双额度桶约 150 字节/分钟，约 75 MB/年；原始记录不淘汰，长范围只在接口出图时抽稀。
// 只追加、从不重写整表: 重写一旦中途崩/断电就等于把历史截断了, 追加没有这个风险。
// 另做每日冷备(.bak), 且只在源不比备份小时才覆盖 —— 绝不用一个更小的文件盖掉好备份。
// 文件已在 .gitignore 里, 不会跟着公开仓库出去。
const USAGE_HIST_FILE = path.join(__dirname, 'codex-usage-history.jsonl');
const USAGE_HIST_BAK = USAGE_HIST_FILE + '.bak';
let usageHist = [];
try {
  usageHist = fs.readFileSync(USAGE_HIST_FILE, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(p => p && p.t);
  console.log('[usage] 历史已加载', usageHist.length, '点(永久保留)');
} catch { /* 首次运行无文件 */ }
function usageHistBackup() {
  try {
    const src = fs.statSync(USAGE_HIST_FILE).size;
    let bak = 0;
    try { bak = fs.statSync(USAGE_HIST_BAK).size; } catch { /* 还没备份过 */ }
    if (src >= bak) fs.copyFileSync(USAGE_HIST_FILE, USAGE_HIST_BAK);
  } catch (e) { console.log('[usage] 历史冷备失败:', e.message); }
}
setTimeout(usageHistBackup, 60 * 1000);                    // 起来一分钟后先备一份
setInterval(usageHistBackup, 24 * 3600 * 1000);            // 之后每天一次
function usageHistBytes() {
  try { return fs.statSync(USAGE_HIST_FILE).size; } catch { return 0; }
}
/* 长档位(尤其"全部")点数会很多: 全塞给前端既费带宽、SVG 折线也画不动。
   按时间分桶抽稀, 每桶只留"三条线里最高的那个真实采样点" —— 保住峰值(到底有没有摸到 100%),
   给出去的都是真实采样、不是插值; 首尾点强制保留(左端 = 真正最早那条记录, 右端 = 现在)。
   阈值给到 4000: 宽屏图区才 ~3700px, 再多也超出像素分辨率了; 4000 点以内一律原样给, 不动它。
   注意采样点是不等距的(没变化就 5 分钟才记一个), 桶宽按时间算才不会把稀疏时段抹平。 */
const USAGE_HIST_MAX_POINTS = 4000;
function thinHist(pts, maxN) {
  if (pts.length <= maxN) return pts;
  const hi = p => Math.max(0, ...Object.values(p.b || {}).map(Number).filter(Number.isFinite));
  const t0 = pts[0].t, span = (pts[pts.length - 1].t - t0) || 1, bw = span / maxN;
  const out = [];
  let bi = -1, best = null;
  for (const p of pts) {
    const b = Math.floor((p.t - t0) / bw);
    if (b !== bi) { if (best) out.push(best); bi = b; best = p; }
    else if (hi(p) > hi(best)) best = p;
  }
  if (best) out.push(best);
  if (out[0] !== pts[0]) out.unshift(pts[0]);
  const last = pts[pts.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}
function usageHistAppend(d) {
  if (!d || !Array.isArray(d.buckets)) return;
  const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
  const p = { t: Date.now(), b: {}, r: {} };
  for (const x of d.buckets) {
    if (!x || !x.key) continue;
    p.b[x.key] = r1(x.pct);
    p.r[x.key] = x.resetsAt || null;
  }
  const last = usageHist[usageHist.length - 1];
  // 只防同一次轮询被意外并发写两遍；正常的一分钟采样即使数值相同也照样落盘。
  if (last && p.t - last.t < 45 * 1000 &&
      JSON.stringify(last.b || {}) === JSON.stringify(p.b) &&
      JSON.stringify(last.r || {}) === JSON.stringify(p.r)) return;
  usageHist.push(p);
  try { fs.appendFileSync(USAGE_HIST_FILE, JSON.stringify(p) + '\n'); } catch (e) { console.log('[usage] 历史写盘失败:', e.message); }
  // 这里从前有个"每 500 点重写文件裁掉 30 天外"的分支, 已删: 永久保留 = 只追加, 不重写。
}

async function fetchUsage() {
  if (usage.inFlight) return;
  if (Date.now() < usage.nextTryAt) return;
  usage.inFlight = true;
  try {
    const data = await readCodexAccountUsage();
    usage.data = data;
    usage.limits = data.buckets || [];
    usage.fetchedAt = Date.now();
    usage.error = null;
    usageHistAppend(data);
    usage.backoffMs = 60 * 1000;
    const ivMin = Math.max(1, (config.usage && config.usage.intervalMin) || 1);
    usage.nextTryAt = Date.now() + ivMin * 60 * 1000 - 5000;
  } catch (e) {
    usage.error = e.message || 'Codex 用量读取失败';
    usage.nextTryAt = Date.now() + usage.backoffMs;
    usage.backoffMs = Math.min(usage.backoffMs * 2, 10 * 60 * 1000);
    console.log('[codex-usage] error:', usage.error);
  } finally {
    usage.inFlight = false;
  }
}
// 启动后快速取首帧；之后每分钟检查一次，实际频率由 intervalMin/错误退避控制。
setTimeout(() => { fetchUsage(); setInterval(fetchUsage, 60 * 1000); }, 2500);

// ---------------- 正在播放 + 歌词 (SMTC + lrclib) ----------------
// nowplaying.ps1 读系统媒体信息; 歌词从 lrclib.net(社区歌词库)实时查, 仅本地显示, 不落盘不缓存到磁盘。

const np = {
  playing: false, title: '', artist: '', album: '', dur: 0, pos: 0, posAt: 0,
  key: '', lines: null, fetching: false, fetchedKey: '',
};

function parseLRC(text) {
  if (!text) return [];
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const tags = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const body = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) {
      const t = (+m[1]) * 60 + (+m[2]) + (m[3] ? +('0.' + m[3]) : 0);
      out.push({ t, text: body });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function lrclibGet(u) {
  return new Promise((resolve) => {
    const url = new URL(u);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'GET',
      headers: { 'User-Agent': 'sidescreen-dashboard/1.0 (personal use)' }, timeout: 8000,
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(data) : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// 通用 HTTPS GET(自定义头, 直连——网易云/QQ 是国内服务器不走代理), 返回 {status, text}
function rawGet(urlStr, headers) {
  return new Promise(resolve => {
    let u; try { u = new URL(urlStr); } catch { return resolve({ status: 0, text: '' }); }
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, headers || {}),
      timeout: 9000,
    }, res => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode, text: d })); });
    req.on('error', () => resolve({ status: 0, text: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: '' }); });
    req.end();
  });
}
const jparse = t => { try { return JSON.parse(t); } catch { return null; } };
// 名字相似(去掉括号/空格/大小写后包含即可)——过滤山寨翻唱: 时长必须接近
const norm = s => String(s || '').toLowerCase().replace(/[\s（）()【】\[\]・·,，.。'"!！?？-]/g, '');
function durOK(a, b) { return !b || !a ? true : Math.abs(a - b) <= 8; }   // 时长差 ≤8s 视为同一首(dur 未知则放行)

// 网易云: 搜索 + 歌词(带山寨过滤: 时长接近 + 名字匹配)
async function neteaseFetch(title, artist, dur) {
  const H = { 'Referer': 'https://music.163.com', 'Cookie': 'appver=8.0.0' };
  const r = await rawGet('https://music.163.com/api/search/get/web?type=1&offset=0&total=true&limit=8&s=' + encodeURIComponent(title + ' ' + artist), H);
  const j = jparse(r.text); const songs = j && j.result && j.result.songs;
  if (!songs || !songs.length) return null;
  const nt = norm(title), na = norm(artist);
  const cands = songs.map(s => {
    const sd = (s.duration || 0) / 1000;
    const nameHit = norm(s.name).includes(nt) || nt.includes(norm(s.name));
    const artHit = na && (s.artists || []).some(a => norm(a.name).includes(na) || na.includes(norm(a.name)));
    return { id: s.id, sd, score: (nameHit ? 2 : 0) + (artHit ? 2 : 0) + (durOK(sd, dur) ? 1 : -3), dd: Math.abs(sd - (dur || sd)) };
  }).filter(c => c.score > 0 && durOK(c.sd, dur)).sort((a, b) => b.score - a.score || a.dd - b.dd);
  if (!cands.length) return null;
  const ly = await rawGet('https://music.163.com/api/song/lyric?os=pc&lv=-1&kv=-1&tv=-1&id=' + cands[0].id, H);
  const lj = jparse(ly.text); const lrc = lj && lj.lrc && lj.lrc.lyric;
  const lines = lrc ? parseLRC(lrc) : [];
  return lines.length ? lines : null;
}

// QQ音乐: smartbox 智能提示搜索(无需签名, 自带正版曲库+相关性排序) + fcg_query_lyric_new 歌词
// 注: musicu.fcg 搜索现需 sign, client_search_cp 返回 500, 唯 smartbox 稳定可用(2026-07 实测)
async function qqFetch(title, artist, dur) {
  const H = { 'Referer': 'https://y.qq.com/' };
  const r = await rawGet('https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?format=json&g_tk=5381&key=' + encodeURIComponent(title + ' ' + artist), H);
  const j = jparse(r.text.replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
  const items = j && j.data && j.data.song && j.data.song.itemlist;
  if (!items || !items.length) return null;
  const nt = norm(title);
  const pick = items.find(s => norm(s.name).includes(nt) || nt.includes(norm(s.name))) || items[0];   // smartbox 无时长, 靠名字匹配+相关性排序
  if (!pick || !pick.mid) return null;
  const ly = await rawGet('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?format=json&nobase64=1&g_tk=5381&songmid=' + pick.mid, H);
  const lj = jparse(ly.text.replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
  const lrc = lj && lj.lyric;
  const lines = lrc ? parseLRC(lrc) : [];
  return lines.length ? lines : null;
}

async function lrclibFetch(title, artist, album, dur) {
  const q = (k, v) => k + '=' + encodeURIComponent(v);
  let r = await lrclibGet('https://lrclib.net/api/get?' +
    [q('track_name', title), q('artist_name', artist), q('album_name', album || ''), dur ? q('duration', Math.round(dur)) : ''].filter(Boolean).join('&'));
  if (!r || !r.syncedLyrics) {
    const arr = await lrclibGet('https://lrclib.net/api/search?' + [q('track_name', title), q('artist_name', artist)].join('&'));
    if (Array.isArray(arr) && arr.length) {
      arr.sort((a, b) => Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur));
      r = arr.find(x => x.syncedLyrics) || arr[0];
    }
  }
  return r && r.syncedLyrics ? parseLRC(r.syncedLyrics) : null;
}

// 歌词链路: 网易云 → QQ音乐 → lrclib(每个源异常/查不到自动降级)
async function fetchLyrics(title, artist, album, dur) {
  const sources = [
    ['QQ音乐', () => qqFetch(title, artist, dur)],
    ['网易云', () => neteaseFetch(title, artist, dur)],
    ['lrclib', () => lrclibFetch(title, artist, album, dur)],
  ];
  for (const [name, fn] of sources) {
    try {
      const lines = await fn();
      if (lines && lines.length) { console.log('[lyrics] ' + name + ' 命中 «' + title + '» ' + lines.length + ' 行'); return lines; }
    } catch (e) { console.log('[lyrics] ' + name + ' 异常:', e.message); }
  }
  console.log('[lyrics] 三源均无 «' + title + '»');
  return [];
}

function curPos() {
  const off = (config.lyrics && +config.lyrics.offsetSec) || 0;   // 0.1s 级歌词微调(管理台设)
  if (!np.posAt) return np.pos + off;
  return np.pos + off + (np.playing ? (Date.now() - np.posAt) / 1000 : 0);
}

let npChild = null;   // 正在播放读取进程(config.lyrics.enabled 控制启停)
function spawnNowPlaying() {
  if (npChild) return;
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'nowplaying.ps1')], { windowsHide: true });
  npChild = child;
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      np.playing = !!m.playing;
      if (m.title != null) {
        np.title = m.title; np.artist = m.artist || ''; np.album = m.album || '';
        np.dur = m.dur || 0; np.pos = m.pos || 0; np.posAt = m.posAt || Date.now();
        np.cover = m.cover || 0;   // SMTC 封面落盘时刻(0=无封面), 前端拿它当缓存键
        const key = np.title + '|' + np.artist;
        if (key !== np.key) {   // 换歌 -> 查新歌词
          np.key = key; np.lines = null;
          if (np.title && !np.fetching) {
            np.fetching = true;
            fetchLyrics(np.title, np.artist, np.album, np.dur)
              .then(lines => { if (np.key === key) { np.lines = lines; np.fetchedKey = key; } })
              .finally(() => { np.fetching = false; });
          }
        }
      }
    }
  });
  child.on('exit', () => { npChild = null; if (config.lyrics && config.lyrics.enabled) setTimeout(spawnNowPlaying, 8000); });
  child.on('error', () => { npChild = null; });
}
// 仅当 config.lyrics.enabled 时启动 SMTC 读取(管理台可开关, 变更即时生效)
if (config.lyrics && config.lyrics.enabled) spawnNowPlaying();

function nowPlayingView() {
  if (!np.title) return { playing: false };
  const pos = curPos();
  let idx = -1;
  if (np.lines && np.lines.length) {
    for (let i = 0; i < np.lines.length; i++) { if (np.lines[i].t <= pos + 0.2) idx = i; else break; }
  }
  const line = idx >= 0 ? np.lines[idx].text : '';
  const next = (np.lines && idx + 1 < np.lines.length) ? np.lines[idx + 1].text : '';
  return {
    playing: np.playing, title: np.title, artist: np.artist,
    pos: Math.round(pos), dur: Math.round(np.dur),
    line, next,
    cover: np.cover || 0,                                  // 封面版本(0=无), /api/nowplaying/cover?k= 取图
    lines: np.lines ? np.lines.map(l => l.text) : null,   // 全部歌词文本(前端做多行滚动)
    idx,                                                   // 当前行索引(-1=还没到第一句)
    key: np.key,                                           // 歌曲标识(换歌时前端重建)
    lyricsState: np.fetching ? 'loading' : (np.lines == null ? 'idle' : (np.lines.length ? 'ok' : 'none')),
  };
}

// ---------------- 扩展组件采集 (网速/通知/磁盘/天气/日程) ----------------
// 采集脚本(*.ps1)/解析库(*-lib.js)缺失时静默跳过, 部署齐后重启即生效。

const extras = {
  net: { rx: 0, tx: 0, ping: null, rxHist: [], txHist: [], ok: false },
  weather: null,
  calendar: null,
  disk: null,
  notify: { status: 'off', recent: [], seq: 0 },
};

// 通用 HTTPS GET: 先直连, 失败再走本地代理(有些接口国内可直连, 有些要代理)
function httpGetRaw(urlStr, useProxy, redirects) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      agent: useProxy ? proxyAgent() : undefined,
      headers: { 'User-Agent': 'Mozilla/5.0 sidescreen-dashboard' },
      timeout: 20000,
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && (redirects || 0) < 3) {
        res.resume();
        resolve(httpGetRaw(new URL(res.headers.location, urlStr).href, useProxy, (redirects || 0) + 1));
        return;
      }
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.end();
  });
}
async function tryGet(urlStr) {
  try { const r = await httpGetRaw(urlStr, false); if (r.status === 200) return r.text; throw new Error('HTTP ' + r.status); }
  catch { const r = await httpGetRaw(urlStr, true); if (r.status === 200) return r.text; throw new Error('HTTP ' + r.status); }
}
const tryGetJson = async u => JSON.parse(await tryGet(u));

// --- 网速: 长驻 net-monitor.ps1, 每秒一行 {rx,tx,ping} ---
let netChild = null;
function spawnNet() {
  if (netChild) return;
  const f = path.join(__dirname, 'net-monitor.ps1');
  if (!fs.existsSync(f)) return;
  const host = (config.net && config.net.pingHost) || '223.5.5.5';
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f, '-PingHost', host], { windowsHide: true });
  netChild = child;
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try {
        const m = JSON.parse(line);
        extras.net.rx = m.rx || 0; extras.net.tx = m.tx || 0;
        if (m.ping !== undefined) extras.net.ping = m.ping;
        extras.net.ok = true;
        extras.net.rxHist.push(m.rx || 0); extras.net.txHist.push(m.tx || 0);
        if (extras.net.rxHist.length > 60) { extras.net.rxHist.shift(); extras.net.txHist.shift(); }
      } catch {}
    }
  });
  child.on('exit', () => { netChild = null; extras.net.ok = false; if (!config.net || config.net.enabled !== false) setTimeout(spawnNet, 8000); });
  child.on('error', () => { netChild = null; });
}
if (!config.net || config.net.enabled !== false) spawnNet();

// --- 手机通知: 长驻 notify-listener.ps1 (UserNotificationListener) ---
let notifyChild = null;
function spawnNotify() {
  if (notifyChild) return;
  const f = path.join(__dirname, 'notify-listener.ps1');
  if (!fs.existsSync(f)) { extras.notify.status = 'missing'; return; }
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f], { windowsHide: true });
  notifyChild = child;
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try {
        const m = JSON.parse(line);
        if (m.status) { extras.notify.status = m.status; continue; }
        extras.notify.seq++;
        extras.notify.recent.unshift({
          id: extras.notify.seq,
          app: m.app || '', title: m.title || '', body: m.body || '',
          ts: m.ts || Date.now(),
        });
        extras.notify.recent = extras.notify.recent.slice(0, 20);
      } catch {}
    }
  });
  child.on('exit', () => {
    notifyChild = null;
    // 权限被拒/系统不支持时脚本会主动退出 —— 不要循环重启, 等用户开权限后在管理台重新开关
    const st = extras.notify.status;
    if (config.notify && config.notify.enabled && st !== 'denied' && st !== 'unsupported') setTimeout(spawnNotify, 15000);
  });
  child.on('error', () => { notifyChild = null; });
}
if (config.notify && config.notify.enabled) spawnNotify();

// --- 磁盘空间: Node 原生 statfs，每 5 分钟读取系统盘和本项目所在盘 ---
// 不再每分钟启动 PowerShell/CIM-RPC 查询，也永远不探测 H:/I: 无介质读卡器。
function pollDisk() {
  if (config.disk && config.disk.enabled === false) return;
  const roots = Array.from(new Set([
    path.parse(process.env.SystemRoot || 'C:\\Windows').root,
    path.parse(__dirname).root,
  ].filter(Boolean)));
  Promise.all(roots.map(root => new Promise(resolve => {
    fs.statfs(root, (err, s) => {
      if (err || !s || !s.blocks || !s.bsize) return resolve(null);
      resolve({
        letter: root.replace(/[\\/:]/g, '').toUpperCase(),
        freeGB: Number((s.bavail * s.bsize / 2 ** 30).toFixed(1)),
        totalGB: Number((s.blocks * s.bsize / 2 ** 30).toFixed(1)),
      });
    });
  }))).then(drives => {
    extras.disk = { ok: true, drives: drives.filter(Boolean), temps: [], at: Date.now() };
  }).catch(() => {});
}
setTimeout(pollDisk, 5000);
setInterval(pollDisk, 5 * 60 * 1000);

// --- 天气: Open-Meteo, 每 20 分钟 ---
let weatherLib = null;
try { weatherLib = require('./weather-lib.js'); } catch {}
async function pollWeather() {
  const wc = config.weather || {};
  if (wc.enabled === false) return;
  if (!wc.lat || !wc.lon) { extras.weather = { ok: false, err: '在管理台设置城市' }; return; }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${wc.lat}&longitude=${wc.lon}` +
    '&current_weather=true&hourly=precipitation_probability,temperature_2m' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3';
  try {
    const j = await tryGetJson(url);
    if (!weatherLib) { extras.weather = { ok: false, err: '缺 weather-lib' }; return; }
    const m = weatherLib.mapForecast(j, Date.now());
    extras.weather = Object.assign({ ok: true, city: wc.label || wc.city || '', updated: Date.now() }, m);
  } catch (e) {
    if (!extras.weather || !extras.weather.ok) extras.weather = { ok: false, err: '天气获取失败' };
    console.log('[weather]', e.message);
  }
}
setTimeout(pollWeather, 3000);
setInterval(pollWeather, 20 * 60 * 1000);

// --- 日程: ICS 订阅, 每 10 分钟 ---
let icsLib = null;
try { icsLib = require('./ics-lib.js'); } catch {}
async function pollCalendar() {
  let url = config.calendar && config.calendar.icsUrl;
  if (!url) { extras.calendar = { ok: false, icsSet: false }; return; }
  url = url.replace(/^webcal:/i, 'https:');
  if (!icsLib) { extras.calendar = { ok: false, icsSet: true, err: '缺 ics-lib' }; return; }
  try {
    const text = await tryGet(url);
    const evs = icsLib.parseICS(text, Date.now());
    extras.calendar = { ok: true, icsSet: true, events: evs.slice(0, 5), at: Date.now() };
  } catch (e) {
    if (!extras.calendar || !extras.calendar.ok) extras.calendar = { ok: false, icsSet: true, err: '日历获取失败' };
    console.log('[calendar]', e.message);
  }
}
setTimeout(pollCalendar, 4000);
setInterval(pollCalendar, 10 * 60 * 1000);

// ---------------- HTTP 服务 ----------------

// ==================== 宽副屏(/wide)专用能力 ====================

// --- 24h 级历史环形缓冲: 三档 300 点(2s=10分钟 / 12s=1小时 / 72s=6小时), 供磁贴详情弹层 ---
const RING_N = 300;
const rings = {};   // metric -> [tier0[], tier1[], tier2[]]
let ringTick = 0;
function ringSample() {
  ringTick++;
  const vals = {
    gpuUtil: state.gpu.util, gpuTemp: state.gpu.temp, gpuPower: Math.round(state.gpu.power),
    gpuFan: state.gpu.fan, gpuClock: state.gpu.clock, vram: Number((state.gpu.vramUsed / 1024).toFixed(2)),
    cpuUtil: state.cpu.util, cpuClock: state.cpu.clock, ram: Number(state.ram.usedGB.toFixed(2)),
    ioRead: Math.round(state.io.read), ioWrite: Math.round(state.io.write),
    ping: extras.net.ping || 0, rx: extras.net.rx || 0, tx: extras.net.tx || 0, procs: state.sys.procs,
  };
  for (const k of Object.keys(vals)) {
    const r = rings[k] || (rings[k] = [[], [], []]);
    const push = (arr, v) => { arr.push(v); if (arr.length > RING_N) arr.shift(); };
    push(r[0], vals[k]);
    if (ringTick % 6 === 0) push(r[1], vals[k]);
    if (ringTick % 36 === 0) push(r[2], vals[k]);
  }
}
setInterval(ringSample, 2000);
const RING_STEP = [2, 12, 72];   // 每档的秒步长

// --- 服务器健康检查(config.health.url, 30s 一测, 直连) ---
extras.health = null;
let healthUpSince = 0;
async function pollHealth() {
  const url = config.health && config.health.url;
  if (!url) { extras.health = null; return; }
  const t0 = Date.now();
  try {
    const r = await httpGetRaw(url, false);
    const ok = r.status >= 200 && r.status < 500;
    if (ok && !healthUpSince) healthUpSince = Date.now();
    if (!ok) healthUpSince = 0;
    extras.health = { ok, ms: Date.now() - t0, status: r.status, upSince: healthUpSince, ts: Date.now() };
  } catch (e) {
    healthUpSince = 0;
    extras.health = { ok: false, ms: null, error: e.message, upSince: 0, ts: Date.now() };
  }
}
setInterval(pollHealth, 30 * 1000);
setTimeout(pollHealth, 5000);

// --- 音频代理桥(audio-agent.ps1: 主音量/分应用/设备切换/麦克风) ---
const audio = { child: null, state: null, ts: 0 };
function spawnAudio() {
  if (audio.child) return;
  const f = path.join(__dirname, 'audio-agent.ps1');
  if (!fs.existsSync(f)) return;
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f], { windowsHide: true });
  audio.child = child;
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try {
        const m = JSON.parse(line);
        if (m.master) { audio.state = m; audio.ts = Date.now(); }
        else if (m.ack && !m.ok) console.log('[audio] cmd fail:', m.ack, m.err || '');
      } catch {}
    }
  });
  child.on('exit', () => { audio.child = null; setTimeout(spawnAudio, 8000); });
  child.on('error', () => { audio.child = null; });
}
spawnAudio();
setInterval(() => { if (!audio.child) spawnAudio(); }, 60 * 1000);   // agent 文件后到位也能自动接上
function audioSend(line) {
  if (!audio.child) return false;
  try { audio.child.stdin.write(line + '\n'); return true; } catch { return false; }
}

// --- Steam 本地库(steam-lib.js, 懒加载 + 20s 缓存) ---
let steamLib = null, steamCache = { ts: 0, data: null };
function getSteamData() {
  if (Date.now() - steamCache.ts < 20 * 1000 && steamCache.data) return steamCache.data;
  try {
    if (!steamLib) steamLib = require('./steam-lib.js');
    const games = steamLib.listGames();
    const downloads = steamLib.downloads ? steamLib.downloads() : [];
    steamCache = { ts: Date.now(), data: { ok: true, games: games.slice(0, 24), downloads } };
  } catch (e) { steamCache = { ts: Date.now(), data: { ok: false, error: e.message, games: [], downloads: [] } }; }
  return steamCache.data;
}

// --- FPS(PresentMon, 存在 tools\PresentMon*.exe 才启用; 跟随 mouse-guard 的游戏检测自动启停) ---
const fpsState = { available: false, running: false, game: '', fps: 0, low1: 0, frameMs: 0, hist: [] };
let fpsChild = null, fpsFrames = [], fpsCol = -1;
function findPresentMon() {
  try {
    const dir = path.join(__dirname, 'tools');
    for (const f of fs.readdirSync(dir)) if (/^PresentMon.*\.exe$/i.test(f)) return path.join(dir, f);
  } catch {}
  return null;
}
// SoundVolumeView(NirSoft): 分应用输出设备路由(Win11 原生 IAudioPolicyConfig 签名对不上, 改用它)
function findSvv() {
  try { const p = path.join(__dirname, 'tools', 'svv', 'SoundVolumeView.exe'); if (fs.existsSync(p)) return p; } catch {}
  return null;
}
// 把某进程的默认输出设备设为 deviceId(all 角色); 每个 pid 各设一次。
// deviceId='__sysdefault__' -> "DefaultRenderDevice"(跟随系统默认, 取消单独指定)
function routeAppOutput(pids, deviceId) {
  const svv = findSvv();
  if (!svv || !deviceId) return false;
  const dev = deviceId === '__sysdefault__' ? 'DefaultRenderDevice' : String(deviceId);
  for (const pid of (pids || [])) {
    if (!pid) continue;
    execFile(svv, ['/SetAppDefault', dev, 'all', String(pid | 0)], { timeout: 8000 }, () => {});
  }
  return true;
}
function startFps(procName) {
  const exe = findPresentMon();
  fpsState.available = !!exe;
  if (!exe || fpsChild) return;
  const child = spawn(exe, ['--output_stdout', '--process_name', procName + '.exe', '--stop_existing_session', '--no_console_stats', '--terminate_on_proc_exit'], { windowsHide: true });
  fpsChild = child; fpsFrames = []; fpsCol = -1;
  fpsState.running = true; fpsState.game = procName;
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      const cells = line.split(',');
      if (fpsCol < 0) {   // 表头行: 找帧时间列(版本间列名不同)
        const idx = cells.findIndex(c => /MsBetweenPresents|FrameTime/i.test(c));
        if (idx >= 0) fpsCol = idx;
        continue;
      }
      const ms = parseFloat(cells[fpsCol]);
      if (!isFinite(ms) || ms <= 0) continue;
      fpsFrames.push(ms); if (fpsFrames.length > 240) fpsFrames.shift();
    }
  });
  child.on('exit', () => { fpsChild = null; fpsState.running = false; });
  child.on('error', () => { fpsChild = null; fpsState.running = false; });
}
function stopFps() { if (fpsChild) { try { fpsChild.kill(); } catch {} fpsChild = null; } fpsState.running = false; fpsState.fps = 0; }
setInterval(() => {   // 计算 + 自动启停
  fpsState.available = !!findPresentMon();
  let guard = null;
  try { guard = JSON.parse(fs.readFileSync(path.join(__dirname, 'mouse-guard.state.json'), 'utf8')); } catch {}
  const gaming = guard && guard.state === 'lock' && guard.detail;
  if (gaming && !fpsChild && fpsState.available) startFps(guard.detail);
  if (!gaming && fpsChild) stopFps();
  if (fpsFrames.length > 10) {
    const avg = fpsFrames.reduce((a, b) => a + b, 0) / fpsFrames.length;
    const sorted = [...fpsFrames].sort((a, b) => b - a);
    const p99 = sorted[Math.max(0, Math.floor(sorted.length * 0.01) - 1)] || sorted[0];
    fpsState.fps = Math.round(1000 / avg);
    fpsState.low1 = Math.round(1000 / p99);
    fpsState.frameMs = Number(avg.toFixed(1));
    fpsState.hist.push(Number(avg.toFixed(1))); if (fpsState.hist.length > 60) fpsState.hist.shift();
  }
}, 3000);

// --- 防息屏(常驻小进程按住 SetThreadExecutionState) ---
let awakeChild = null;
function setAwake(on) {
  if (on && !awakeChild) {
    const cmd = "Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; while($true){ [W.P]::SetThreadExecutionState(2147483651) | Out-Null; Start-Sleep -Seconds 50 }";
    awakeChild = spawn('powershell', ['-NoProfile', '-Command', cmd], { windowsHide: true });
    awakeChild.on('exit', () => { awakeChild = null; });
  } else if (!on && awakeChild) { try { awakeChild.kill(); } catch {} awakeChild = null; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.gif': 'image/gif',
  '.png': 'image/png', '.webm': 'video/webm',
  '.sh': 'text/plain; charset=utf-8',   // Mac 接入脚本 public/mac/install.sh, 给 curl 下载用
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// 开机自启 = 任务计划程序(登录时触发), 用户在管理页里切换。
// 曾用 HKCU Run 注册表项, 但机器上 20+ 个开机启动项(Steam/Riot Vanguard/Ollama/Clash 等)拥堵时,
// explorer 触发的 Run 项会被 Windows 静默跳过(不报错), 2026-07-12 实测出现过一次。
// 任务计划由系统任务调度服务直接管理, 不依赖 explorer 那条链路, 更抗拥堵。
const TASK_NAME = 'SidescreenDashboardAutostart';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';   // 旧机制, 仅用于清理残留
const RUN_NAME = 'SidescreenDashboard';
const START_SCRIPT = path.join(__dirname, 'start-sidescreen.ps1');
function queryAutostart(cb) {
  execFile('schtasks', ['/query', '/tn', TASK_NAME], (err) => cb(!err));
}
function setAutostart(on, cb) {
  if (!on) { execFile('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], () => cb(null)); return; }
  const psCmd =
    `$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${START_SCRIPT}"'; ` +
    `$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; ` +
    `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1); ` +
    `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $a -Trigger $t -Settings $s -Force | Out-Null`;
  execFile('powershell', ['-NoProfile', '-Command', psCmd], (err) => cb(err));
}

// ---------------- 鼠标护栏 (mouse-guard.ps1) ----------------
// 状态由守卫每 5s 写一次极小心跳；不再为每次 API 请求启动 PowerShell/WMI 查询进程。
//   GET  /api/mouseguard          -> { running, enabled }
//   POST /api/mouseguard {on}     -> 开/关并持久化 config.mouseGuard.enabled
const GUARD_SCRIPT = path.join(__dirname, 'mouse-guard.ps1');
const GUARD_STATE_FILE = path.join(__dirname, 'mouse-guard.state.json');
const GUARD_HEARTBEAT_MAX_MS = 15000;
function queryMouseGuard(cb) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(GUARD_STATE_FILE, 'utf8')); } catch {}
  const age = s && Number.isFinite(Number(s.ts)) ? Date.now() - Number(s.ts) : Infinity;
  const running = !!(s && s.state !== 'off' && age >= 0 && age <= GUARD_HEARTBEAT_MAX_MS);
  cb(running, s);
}
function setMouseGuard(on, cb) {
  if (!fs.existsSync(GUARD_SCRIPT)) return cb(new Error('mouse-guard.ps1 missing'));
  if (!on) { execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', GUARD_SCRIPT, '-Mode', 'off'], { windowsHide: true, timeout: 10000 }, err => cb(err)); return; }
  // 开: 经 Start-Process 二段启动成独立常驻进程(node 直接 spawn 会秒死, 实测; -Mode on 已有实例时静默退出不重复)
  const psCmd = `Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${GUARD_SCRIPT}','-Mode','on' -WindowStyle Hidden`;
  execFile('powershell', ['-NoProfile', '-Command', psCmd], { windowsHide: true, timeout: 10000 }, err => cb(err));
}
if (config.mouseGuard && config.mouseGuard.enabled) setTimeout(() => setMouseGuard(true, () => {}), 3000);

// Cache native window reads briefly so each dashboard page does not spawn its own query.
let topmostCache = null, topmostRead = null, topmostBusy = false;
function runTopmost(mode) {
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-File', path.join(__dirname, 'dashboard-topmost.ps1'), '-Mode', mode],
      { windowsHide: true, timeout: 10000, encoding: 'utf8' }, (err, out) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(out.replace(/^\uFEFF/, '').trim())); } catch (e) { reject(e); }
      });
  });
}
async function readTopmost() {
  if (topmostCache && Date.now() - topmostCache.at < 10000) return topmostCache.value;
  if (!topmostRead) topmostRead = runTopmost('query').then(value => {
    topmostCache = { value, at: Date.now() }; return value;
  }).finally(() => { topmostRead = null; });
  return topmostRead;
}

function lanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    if (/vEthernet|Loopback|MuMu|VMware|Tailscale/i.test(name)) continue;
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal && n.address.startsWith('192.168.')) return n.address;
    }
  }
  return '127.0.0.1';
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      cpu: state.cpu, ram: state.ram, gpu: state.gpu, io: state.io,
      sys: { procs: state.sys.procs, uptimeMs: Date.now() - state.sys.bootMs }, t: Date.now(),
      cfgRev, pageIdx: view.pageIdx, pageCount: (config.pages || []).length,
      wpSeq: widePage.seq, wpDir: widePage.dir,   // 宽屏翻页脉冲(全局热键)
    }));
    return;
  }
  if (u.pathname === '/api/codex') {
    return json(res, 200, {
      usage: usage.data, fetchedAt: usage.fetchedAt, error: usage.error,
    });
  }
  if (u.pathname === '/api/claude') {
    // 兼容小副屏旧调用: 会话活动仍在这里，额度已经来自 Codex App Server。
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      usage: usage.data, fetchedAt: usage.fetchedAt, error: usage.error, activity, alert,
    }));
    return;
  }
  if (u.pathname === '/api/claude/sessions') {   // 会话面板: 按 session 维度的心跳快照
    return json(res, 200, getClaudeSessions(u.searchParams.get('debug')));   // ?debug=1 附带原始判定
  }
  if (u.pathname === '/api/usage/detail') {   // 额度详情: 全部限额条目 + 历史走势(给宽屏弹层)
    const hq = u.searchParams.get('hours');
    const hn = hq == null ? 24 : Number(hq);
    const hours = Number.isFinite(hn) ? hn : 24;         // ≤0 = 全部历史(永久保留, 不再有 30 天上限)
    const cut = hours > 0 ? Date.now() - hours * 3600 * 1000 : 0;
    // 窗口外再多带一个点当"锚": 否则半夜关机后早上看 6 小时档, 线只画得出右边一小截。
    // 有了锚点, 前端能把周额度按"值不动"平推到左边缘(锚点落在 viewBox 外, SVG 自己会裁掉)。
    const i0 = usageHist.findIndex(p => p.t >= cut);
    const win = i0 < 0 ? usageHist.slice(-1) : usageHist.slice(Math.max(0, i0 - 1));
    return json(res, 200, {
      usage: usage.data, limits: usage.limits || [],
      fetchedAt: usage.fetchedAt, error: usage.error, nextTryAt: usage.nextTryAt,
      intervalMin: Math.max(1, (config.usage && config.usage.intervalMin) || 1),
      history: thinHist(win, USAGE_HIST_MAX_POINTS),
      historyShown: win.length,                          // 抽稀前该档位实际有多少点
      historyTotal: usageHist.length,
      historyFrom: usageHist.length ? usageHist[0].t : null,
      historyBytes: usageHistBytes(),
      // 预估"还有多久到 100%"专用: 近 100 分钟原始点, 不受档位/抽稀影响(否则选"全部"时基准点会被抽走)
      recent: usageHist.filter(p => p.t >= Date.now() - 100 * 60 * 1000),
    });
  }
  if (u.pathname === '/api/extras') {
    return json(res, 200, {
      net: extras.net,
      weather: extras.weather,
      calendar: extras.calendar,
      disk: extras.disk,
      notify: Object.assign({ enabled: !!(config.notify && config.notify.enabled) }, extras.notify),
    });
  }
  if (u.pathname === '/api/geo') {   // 城市搜索(管理台设天气用), 服务端代查避免浏览器跨域
    const q = (u.searchParams.get('q') || '').trim();
    if (!q) return json(res, 400, { error: '缺 q' });
    try {
      const j = await tryGetJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=zh&format=json`);
      return json(res, 200, {
        results: (j.results || []).map(r => ({
          name: r.name, admin1: r.admin1 || '', country: r.country || '',
          lat: r.latitude, lon: r.longitude,
        })),
      });
    } catch (e) { return json(res, 502, { error: '搜索失败: ' + e.message }); }
  }
  if (u.pathname === '/api/system/reload-kiosk' && req.method === 'POST') {   // 杀掉 kiosk Edge 并重跑启动脚本
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'reload-kiosk.ps1')],
      { timeout: 60000 }, (err, out, errOut) => {
        fs.writeFileSync(path.join(__dirname, 'reload-kiosk.log'),
          `${new Date().toLocaleString()} err=${err ? err.message : 'none'}\nOUT:\n${out}\nERR:\n${errOut}\n`, 'utf8');
      });
    return json(res, 200, { ok: true });
  }
  if (u.pathname === '/api/config') {
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (!Array.isArray(body.pages) || !body.pages.length) return json(res, 400, { error: 'pages 不能为空' });
        const prevCycles = config.rotation && config.rotation.keyCycles;
        const prevHk = JSON.stringify(config.hotkey || {});
        const prevLy = !!(config.lyrics && config.lyrics.enabled);
        const prevNet = JSON.stringify(config.net || {});
        const prevNf = !!(config.notify && config.notify.enabled);
        const prevWx = JSON.stringify(config.weather || {});
        const prevCal = JSON.stringify(config.calendar || {});
        config = Object.assign({}, config, body);   // 合并而非替换: 管理台没提交的键(apps/health/mouseGuard 等)不能被冲掉
        saveConfig();
        if (view.pageIdx >= config.pages.length) view.pageIdx = 0;
        const nowCycles = config.rotation && config.rotation.keyCycles;
        if (nowCycles !== prevCycles) ddcSend('MODE ' + (nowCycles ? 'rotate' : 'native'));  // 只在开关变化时下发
        if (JSON.stringify(config.hotkey || {}) !== prevHk) applyHotkey();   // 热键变了 -> 重注册
        const nowLy = !!(config.lyrics && config.lyrics.enabled);           // 歌词开关变了 -> 启停读取进程
        if (nowLy && !prevLy) spawnNowPlaying();
        if (!nowLy && prevLy && npChild) { try { npChild.kill(); } catch {} }
        // 网速: 开关或 ping 主机变了 -> 重启采集进程
        const nowNet = JSON.stringify(config.net || {});
        if (nowNet !== prevNet) {
          if (netChild) { try { netChild.kill(); } catch {} }
          else if (!config.net || config.net.enabled !== false) spawnNet();
        }
        // 通知监听: 开关变了 -> 启停
        const nowNf = !!(config.notify && config.notify.enabled);
        if (nowNf && !prevNf) { extras.notify.status = 'off'; spawnNotify(); }
        if (!nowNf && prevNf && notifyChild) { try { notifyChild.kill(); } catch {} }
        // 天气/日历: 数据源变了 -> 立即重取
        if (JSON.stringify(config.weather || {}) !== prevWx) pollWeather();
        if (JSON.stringify(config.calendar || {}) !== prevCal) pollCalendar();
        return json(res, 200, { ok: true, rev: cfgRev });
      } catch { return json(res, 400, { error: 'JSON 无效' }); }
    }
    return json(res, 200, { config, rev: cfgRev });
  }
  if (u.pathname === '/api/page/next' && req.method === 'POST') { nextPage(1); return json(res, 200, { pageIdx: view.pageIdx }); }
  if (u.pathname === '/api/wide/page' && req.method === 'POST') {   // 全局热键翻宽屏: 记脉冲 + 即时 SSE 推
    let dir = 1;
    try { const b = await readBody(req); dir = (b.dir | 0) < 0 ? -1 : 1; } catch {}
    widePage.seq++; widePage.dir = dir;
    wideSsePush(dir);   // 立刻推给已连接的宽屏, 不等它下次轮询
    console.log('[wide-hotkey] 翻页', dir < 0 ? '上一页' : '下一页', 'seq', widePage.seq);
    return json(res, 200, { seq: widePage.seq, dir });
  }
  if (u.pathname === '/api/wide/events') {   // 宽屏翻页 SSE: 服务端主动推, 按键即时到
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('retry: 2000\n\n');   // 断线 2s 重连
    wideSse.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 25000);   // 心跳防中间层掐连接
    req.on('close', () => { clearInterval(ka); wideSse.delete(res); });
    return;
  }
  if (u.pathname === '/api/trigger' && req.method === 'POST') {   // 热键/外部触发: 同物理按键语义
    let steps = 1;
    try { const b = await readBody(req); steps = Math.max(1, b.steps | 0 || 1); } catch {}
    return json(res, 200, triggerButton(steps, 'hotkey'));
  }
  if (u.pathname === '/api/ack' && req.method === 'POST') { ackAlert(); return json(res, 200, { ok: true }); }
  if (u.pathname === '/api/nowplaying') { return json(res, 200, nowPlayingView()); }
  if (u.pathname === '/api/nowplaying/cover') {   // SMTC 专辑封面(nowplaying.ps1 落盘的原图)
    try {
      const img = fs.readFileSync(path.join(__dirname, 'np-cover.img'));
      const mime = img[0] === 0x89 ? 'image/png' : 'image/jpeg';   // PNG 魔数, 其余按 JPEG(浏览器会自嗅探)
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=3600' });   // ?k=版本号 变了自然换缓存
      return res.end(img);
    } catch { return json(res, 404, { error: '无封面' }); }
  }
  if (u.pathname === '/api/page/set' && req.method === 'POST') {
    try { const b = await readBody(req); view.pageIdx = Math.max(0, Math.min((config.pages.length - 1), b.i | 0)); view.lastRotate = Date.now(); } catch {}
    return json(res, 200, { pageIdx: view.pageIdx });
  }
  if (u.pathname === '/api/activity-report' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      /* 两种上报格式都收:
         ① 原始 hook JSON(带 hook_event_name) —— 老路子, 由本端 deriveHookState 归一化;
         ② 已归一化的 v=1 事件(mac-hook.js 发的, 已在源头脱敏) —— 直接采信它的 state/kind/tool。
         设备名优先取事件里的 device, 其次 ?device=, 最后兜底 remote。 */
      const isV1 = body && body.v === 1 && body.state;
      const dev = String((isV1 && body.device) || u.searchParams.get('device') || 'remote').slice(0, 24);
      const s = isV1
        ? { state: body.state, kind: body.kind || null, tool: body.tool || null, notice: body.notice || null, detail: body.detail || null }
        : deriveHookState(body);
      if (s) {
        remoteDevices[dev] = { state: s.state, tool: s.tool || null, notice: s.notice || null, ts: Date.now() };
        const sid = (isV1 ? body.sessionId : body.session_id) || null;
        // 卡片显示名优先级: 用户自定别名 > 会话名 > (都没有就退回 cwd 末段, 再退回"设备 会话")
        const name = isV1 ? (body.alias || body.title || null) : null;
        if (s.state === 'ended') remoteSessions.delete(dev + '|' + sid);   // 会话结束就撤卡
        else remoteSessionPut(dev, sid, s, body.cwd, name, isV1 ? body.reply : null);
        // 同一条事件转发进 supervisor 总线(历史/SSE/设备表都在那边)
        forwardToBus(isV1 ? body : Object.assign({ v: 1, device: dev, sessionId: sid, ts: Date.now() }, s));
      } else if (remoteDevices[dev]) remoteDevices[dev].ts = Date.now();   // 无关事件也算心跳
      return json(res, 200, { ok: true });
    } catch { return json(res, 400, { error: 'bad body' }); }
  }
  if (u.pathname === '/api/devices') {
    /* 设备表以 supervisor 总线为准 —— 它是所有设备事件的汇总层, 之前两边各算各的会对不上。
       这里只负责把总线那份翻译成本接口原有的形状(admin 页在用), 再把本机才知道的细状态
       (thinking/tool/permission…)贴回去。总线不可达就退回自己算的, source 字段标明数据来自谁。 */
    const now = Date.now();
    const localState = d => {
      if (d === LOCAL_DEVICE || d === 'PC') return activity.device === 'PC' ? activity.state : 'idle';
      const r = remoteDevices[d];
      if (!r) return null;
      return (now - r.ts < 30 * MIN) ? (decay(r.state, now - r.ts) || 'sleeping') : 'sleeping';
    };
    /* 取并集而不是照抄总线: 总线是内存环形缓冲, 它一重启就把设备忘光, 而副屏这边可能还留着
       这台设备的活跃会话 —— 那种时候照抄就会"显示得比自己知道的还少"(实测踩到过)。
       所以: 总线有的以总线为准(它是汇总层), 总线没有但本机确实还在跟的补上。 */
    const fresh = busDevices.list && now - busDevices.at < 60 * 1000;
    const seen = new Set();
    const list = [];
    if (fresh) {
      for (const d of busDevices.list) {
        seen.add(d.device);
        list.push({
          name: d.device === 'PC' ? 'PC (本机)' : d.device,
          state: d.online ? (localState(d.device) || 'idle') : 'sleeping',
          lastSeen: d.lastTs, local: d.device === 'PC' || d.device === LOCAL_DEVICE,
          online: d.online, sessions: d.sessions, from: 'bus',
        });
      }
    }
    if (!seen.has('PC') && !seen.has(LOCAL_DEVICE)) {
      list.unshift({ name: 'PC (本机)', state: localState('PC'), lastSeen: activity.lastActiveMs, local: true, online: true, from: 'local' });
      seen.add('PC');
    }
    // 本机还在跟、但总线不知道的远程设备(如总线刚重启): 按活跃会话数补进来
    const liveByDev = {};
    for (const r of remoteSessions.values()) {
      if (now - r.ts <= SESS_ACTIVE_MS) liveByDev[r.device] = (liveByDev[r.device] || 0) + 1;
    }
    for (const [n, r] of Object.entries(remoteDevices)) {
      if (seen.has(n)) continue;
      list.push({
        name: n, state: localState(n), lastSeen: r.ts, local: false,
        online: now - r.ts < 30 * MIN, sessions: liveByDev[n] || 0, from: 'local',
      });
    }
    return json(res, 200, { devices: list, source: fresh ? 'supervisor-bus+local' : 'local-fallback' });
  }
  if (u.pathname === '/api/system') {
    return new Promise(resolve => {
      queryAutostart(on => { json(res, 200, { autostart: on, ip: lanIP(), port: PORT, version: VERSION, brightness: ddc.lastBrightness }); resolve(); });
    });
  }
  if (u.pathname === '/api/system/autostart' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      execFile('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f'], () => {});   // 清理旧注册表机制残留(不管成败)
      setAutostart(!!b.on, err => json(res, err ? 500 : 200, err ? { error: String(err) } : { ok: true, autostart: !!b.on }));
    } catch { json(res, 400, { error: 'bad body' }); }
    return;
  }
  if (u.pathname === '/api/dashboard/topmost' && req.method === 'GET') {
    if (topmostBusy) { json(res, 503, { ok: false, error: '正在切换置顶状态' }); return; }
    try {
      const state = await readTopmost();
      json(res, 200, { ...state, desired: config.dashboardWindow?.topmost !== false });
    } catch { json(res, 503, { ok: false, error: '无法读取仪表盘置顶状态' }); }
    return;
  }
  if (u.pathname === '/api/dashboard/topmost' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { json(res, 400, { ok: false, error: '请求格式错误' }); return; }
    if (!body || typeof body.on !== 'boolean') { json(res, 400, { ok: false, error: 'on 必须是布尔值' }); return; }
    if (topmostBusy) { json(res, 409, { ok: false, error: '正在切换，请稍后重试' }); return; }
    topmostBusy = true;
    try {
      // Finish an older read before writing so it cannot overwrite the new state cache.
      if (topmostRead) await topmostRead.catch(() => {});
      const state = await runTopmost(body.on ? 'on' : 'off');
      topmostCache = { value: state, at: Date.now() };
      if (!state.ok) { json(res, 500, { ...state, error: '部分仪表盘窗口切换失败' }); return; }
      config.dashboardWindow = { ...config.dashboardWindow, topmost: body.on }; saveConfig();
      json(res, 200, { ...state, desired: body.on });
    } catch { json(res, 500, { ok: false, error: '仪表盘置顶切换失败' }); }
    finally { topmostBusy = false; }
    return;
  }
  if (u.pathname === '/api/mouseguard' && req.method === 'GET') {
    return new Promise(resolve => {
      queryMouseGuard((running, s) => {
        let state = 'off', stateDetail = '';
        if (running) {
          state = s.state || 'fence'; stateDetail = s.detail || '';
        }
        const mg = config.mouseGuard || {};
        json(res, 200, { running, enabled: !!mg.enabled, state, stateDetail, games: mg.games || [] });
        resolve();
      });
    });
  }
  if (u.pathname === '/api/mouseguard' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const patch = {};
      if ('on' in b) patch.enabled = !!b.on;
      if (Array.isArray(b.games)) patch.games = b.games.map(g => String(g).toLowerCase()).filter(Boolean);
      config.mouseGuard = Object.assign({}, config.mouseGuard, patch); saveConfig();   // 保留未提交字段; games 由护栏按文件时间热加载
      if (!('on' in b)) return json(res, 200, { ok: true, games: config.mouseGuard.games });   // 只改列表, 不动开关
      const on = !!b.on;
      return new Promise(resolve => {
        setMouseGuard(on, err => {
          if (err) { json(res, 500, { error: String(err.message || err) }); return resolve(); }
          // 开关是异步生效的，稍等守卫写入第一帧心跳后再返回。
          setTimeout(() => queryMouseGuard(running => { json(res, 200, { ok: true, running, enabled: on }); resolve(); }), 1200);
        });
      });
    } catch { return json(res, 400, { error: 'bad body' }); }
  }
  // ==================== 宽副屏 API ====================
  if (u.pathname === '/api/history') {   // 磁贴详情曲线: ?metric=gpuUtil&tier=0|1|2
    const metric = u.searchParams.get('metric') || 'gpuUtil';
    const tier = Math.max(0, Math.min(2, Number(u.searchParams.get('tier')) || 0));
    const r = rings[metric];
    return json(res, 200, { metric, tier, stepSec: RING_STEP[tier], points: r ? r[tier] : [] });
  }
  if (u.pathname === '/api/history/all') {   // 全指标近 n 点(看板磁贴底部折线, 一次拉齐)
    const n = Math.max(10, Math.min(RING_N, Number(u.searchParams.get('n')) || 60));
    const out = {};
    for (const k of Object.keys(rings)) out[k] = rings[k][0].slice(-n);
    return json(res, 200, out);
  }
  if (u.pathname === '/api/launch' && req.method === 'POST') {   // 应用启动(仅限 config.apps 配置项)
    try {
      const b = await readBody(req);
      const app = (config.apps || []).find(a => a.id === b.id);
      if (!app) return json(res, 404, { error: 'unknown app' });
      execFile('cmd', ['/c', 'start', '', app.cmd], { windowsHide: true }, () => {});
      return json(res, 200, { ok: true, launched: app.id });
    } catch { return json(res, 400, { error: 'bad body' }); }
  }
  if (u.pathname === '/api/power' && req.method === 'POST') {   // 电源操作(前端已做 1.5s 长按确认)
    try {
      const b = await readBody(req);
      const acts = {
        lock:     ['rundll32', ['user32.dll,LockWorkStation']],
        sleep:    ['rundll32', ['powrprof.dll,SetSuspendState', '0,1,0']],
        restart:  ['shutdown', ['/r', '/t', '3']],
        shutdown: ['shutdown', ['/s', '/t', '3']],
      };
      const a = acts[b.action];
      if (!a) return json(res, 400, { error: 'unknown action' });
      console.log('[power]', b.action);
      execFile(a[0], a[1], { windowsHide: true }, () => {});
      return json(res, 200, { ok: true, action: b.action });
    } catch { return json(res, 400, { error: 'bad body' }); }
  }
  if (u.pathname === '/api/system/screenshot' && req.method === 'POST') {   // 全屏截图存图片库
    const dir = path.join(os.homedir(), 'Pictures', 'Screenshots');
    const file = path.join(dir, 'sidescreen-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png');
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
      `if (-not (Test-Path '${dir}')) { New-Item -ItemType Directory -Force '${dir}' | Out-Null }; ` +
      `$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; ` +
      `$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; ` +
      `$g = [System.Drawing.Graphics]::FromImage($bmp); ` +
      `$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size); ` +
      `$bmp.Save('${file}'); $g.Dispose(); $bmp.Dispose()`;
    return new Promise(resolve => {
      execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 15000 }, err => {
        json(res, err ? 500 : 200, err ? { error: String(err) } : { ok: true, file });
        resolve();
      });
    });
  }
  if (u.pathname === '/api/system/awake' && req.method === 'POST') {   // 防息屏开关
    try { const b = await readBody(req); setAwake(!!b.on); return json(res, 200, { ok: true, awake: !!awakeChild }); }
    catch { return json(res, 400, { error: 'bad body' }); }
  }
  if (u.pathname === '/api/system/awake') return json(res, 200, { awake: !!awakeChild });
  if (u.pathname === '/api/audio' && req.method === 'GET') {
    return json(res, 200, audio.state ? Object.assign({ ok: true, ageMs: Date.now() - audio.ts }, audio.state) : { ok: false, error: 'audio agent not ready' });
  }
  if (u.pathname === '/api/audio' && req.method === 'POST') {   // {master}|{muteMaster}|{app,vol}|{app,muted}|{device}|{mic}|{apps,outDev}
    try {
      const b = await readBody(req);
      // 分应用输出设备路由(走 SoundVolumeView): {apps:[pid,...], outDev: 设备id}
      if ('outDev' in b) {
        const pids = Array.isArray(b.apps) ? b.apps : ('app' in b ? [b.app] : []);
        const ok = routeAppOutput(pids, b.outDev);
        return json(res, ok ? 200 : 503, ok ? { ok: true } : { error: 'SoundVolumeView 未安装' });
      }
      let sent = false;
      if ('master' in b) sent = audioSend('SETMASTER ' + Math.max(0, Math.min(100, b.master | 0)));
      else if ('muteMaster' in b) sent = audioSend('MUTEMASTER ' + (b.muteMaster ? 1 : 0));
      else if ('app' in b && 'vol' in b) sent = audioSend('SETAPP ' + (b.app | 0) + ' ' + Math.max(0, Math.min(100, b.vol | 0)));
      else if ('app' in b && 'muted' in b) sent = audioSend('MUTEAPP ' + (b.app | 0) + ' ' + (b.muted ? 1 : 0));
      else if ('device' in b) sent = audioSend('SETDEV ' + b.device);
      else if ('mic' in b) sent = audioSend('MICMUTE ' + (b.mic ? 1 : 0));
      else return json(res, 400, { error: 'unknown audio command' });
      return json(res, sent ? 200 : 503, sent ? { ok: true } : { error: 'audio agent not running' });
    } catch { return json(res, 400, { error: 'bad body' }); }
  }
  if (u.pathname === '/api/steam') return json(res, 200, getSteamData());
  if (u.pathname === '/api/steam/launch' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      let uri = null;
      try { if (!steamLib) steamLib = require('./steam-lib.js'); } catch {}
      if (b.appid) uri = 'steam://rungameid/' + (b.appid | 0);
      else if (b.open && /^[a-z/]+$/.test(b.open)) uri = 'steam://open/' + b.open;   // bigpicture|games|friends 等
      else if (b.store) uri = 'steam://store';
      if (!uri) return json(res, 400, { error: 'bad steam target' });
      execFile('cmd', ['/c', 'start', '', uri], { windowsHide: true }, () => {});
      return json(res, 200, { ok: true, uri });
    } catch { return json(res, 400, { error: 'bad body' }); }
  }
  if (u.pathname === '/api/fps') return json(res, 200, fpsState);
  if (u.pathname === '/api/captions' && req.method === 'POST') {   // Win+Ctrl+L 切换 Win11 实时字幕
    const ps = `$s='[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);'; Add-Type -Name K2 -Namespace W -MemberDefinition $s; [W.K2]::keybd_event(0x5B,0,0,[UIntPtr]::Zero); [W.K2]::keybd_event(0x11,0,0,[UIntPtr]::Zero); [W.K2]::keybd_event(0x4C,0,0,[UIntPtr]::Zero); [W.K2]::keybd_event(0x4C,0,2,[UIntPtr]::Zero); [W.K2]::keybd_event(0x11,0,2,[UIntPtr]::Zero); [W.K2]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)`;
    execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 8000 }, () => {});
    return json(res, 200, { ok: true });
  }
  if (u.pathname === '/api/media' && req.method === 'POST') {   // 媒体键注入(播放暂停/上一首/下一首), 对当前播放器全局有效
    try {
      const b = await readBody(req);
      const vk = { playpause: 0xB3, next: 0xB0, prev: 0xB1 }[b.key];
      if (!vk) return json(res, 400, { error: 'unknown key' });
      const ps = `$s='[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);'; Add-Type -Name K -Namespace W -MemberDefinition $s; [W.K]::keybd_event(${vk},0,0,[UIntPtr]::Zero); [W.K]::keybd_event(${vk},0,2,[UIntPtr]::Zero)`;
      execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 8000 }, () => {});
      return json(res, 200, { ok: true });
    } catch { return json(res, 400, { error: 'bad body' }); }
  }
  if (u.pathname === '/api/wide/brightness' && req.method === 'POST') {   // 长条屏 DDC 亮度(一次性写 0x10, 永不碰 0xCA)
    try {
      const b = await readBody(req);
      const v = Math.max(0, Math.min(100, b.value | 0));
      execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'brightness-strip.ps1'), '-Value', String(v)], { timeout: 10000 }, (err, out) => {});
      return json(res, 200, { ok: true, value: v });
    } catch { return json(res, 400, { error: 'bad body' }); }
  }
  if (u.pathname === '/wide' || u.pathname === '/wide/') {
    fs.readFile(path.join(PUBLIC_DIR, 'wide.html'), (err, buf) => {
      if (err) { res.writeHead(404); res.end('wide.html missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  if (u.pathname === '/api/system/brightness' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      desiredBrightness = Math.max(0, Math.min(100, b.value | 0));
      config.brightness = desiredBrightness; saveConfig();   // 记住, 作为按键写回目标
      ddcSend('SET ' + desiredBrightness);
      return json(res, 200, { ok: true });
    } catch { return json(res, 400, { error: 'bad body' }); }
  }
  if (u.pathname === '/admin' || u.pathname === '/admin/') {
    fs.readFile(path.join(PUBLIC_DIR, 'admin.html'), (err, buf) => {
      if (err) { res.writeHead(404); res.end('admin.html missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }
  let file = u.pathname === '/' ? '/index.html' : u.pathname;
  file = path.normalize(file).replace(/^([.][.][\\/])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(full);
    const noCache = (ext === '.html' || ext === '.js' || ext === '.css');   // 页面/脚本禁缓存, 改了立刻生效
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache, no-store, must-revalidate' : 'public, max-age=86400',
    });
    res.end(buf);
  });
});

// ---------------- DDC 亮度键代理 (物理按键 -> 翻页) ----------------
// 副屏按钮不发 HID 事件(纯固件), 唯一可感知的是亮度寄存器变化 -> ddc-agent.ps1 轮询并上报

const ddc = { child: null, lastBrightness: null };
const DDC_CMD_FILE = path.join(__dirname, 'ddc-cmd.txt');
// 管理台设定的亮度(写回目标)。存进 config.brightness, 默认 80(避免按键写回时闪到 0)
let desiredBrightness = (config.brightness != null) ? config.brightness : 80;

function ddcSend(line) {
  try { fs.appendFileSync(DDC_CMD_FILE, line + '\n'); } catch { /* agent 会在下轮读取 */ }
}

function spawnDdc() {
  if (ddc.child) return;   // 单例: 多个 agent 会抢 i2c 总线互相搞崩 + 按键双触发
  // 代理每几秒检查一次 ParentPid；Node 退出后它会自行退出，不需要 WMI 搜索/强杀历史进程。
  const child = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'ddc-agent.ps1'),
    '-ParentPid', String(process.pid),
  ], { windowsHide: true });
  ddc.child = child;
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      console.log('[ddc]', line);
      let m;
      if ((m = line.match(/^PRESS (\d+)(?:\s+(\d+))?/))) {
        if (config.rotation && config.rotation.keyCycles) {
          const steps = Math.max(1, parseInt(m[2] || '1', 10));
          triggerButton(steps, 'ddc');
        }
      } else if ((m = line.match(/^READY base[= ](-?\d+)/))) {
        // 代理就绪: 把亮度设到管理台保存的值, 让写回弹跳幅度小、不闪到 0
        ddcSend('SET ' + desiredBrightness);
        ddc.lastBrightness = desiredBrightness;
      } else if ((m = line.match(/^(SETOK|REFOUND base)[= ](\d+)/))) {
        ddc.lastBrightness = Number(m[2]);
      }
    }
  });
  child.stderr.on('data', d => console.log('[ddc:err]', d.toString().trim().slice(0, 300)));
  child.on('exit', (code) => {
    console.log('[ddc] agent 退出, code=', code);
    ddc.child = null;
    clearTimeout(ddc.respawnTimer);                    // 多个退出事件只排一次重生
    ddc.respawnTimer = setTimeout(spawnDdc, 5000);
  });
  child.on('error', () => { /* powershell 不可用等; exit 会触发重启 */ });
}
// 仅当用户在管理台显式开启"亮度键翻页"时才启动 DDC 代理。
// 这块屏(Realtek scaler)被 DDC 写入后会锁物理按钮, 该功能天生别扭, 默认关闭。
if (config.rotation && config.rotation.keyCycles) {
  spawnDdc();
  ddcSend('MODE rotate');
} else {
  console.log('[ddc] 亮度键翻页未开启, 不启动 DDC 代理(亮度键保持原生功能)');
}

// ---------------- 全局热键 (键盘 -> 翻页) ----------------
let hotkeyChild = null;
function applyHotkey() {
  const hk = config.hotkey || {};
  if (hotkeyChild) { try { hotkeyChild.kill(); } catch {} hotkeyChild = null; }
  if (!hk.enabled) return;
  try { fs.writeFileSync(path.join(__dirname, 'hotkey.json'), JSON.stringify({ mods: hk.mods | 0, vk: hk.vk | 0 })); } catch {}
  const c = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'hotkey-listener.ps1')], { windowsHide: true });
  hotkeyChild = c;
  c.stdout.on('data', d => console.log('[hotkey]', d.toString().trim()));
  c.on('exit', () => { if (hotkeyChild === c) hotkeyChild = null; });
  c.on('error', () => {});
}
applyHotkey();

// 宽屏全局热键 PageUp/PageDown(默认开; config.wideHotkey.enabled=false 可关)
let wideHotkeyChild = null;
function applyWideHotkey() {
  if (wideHotkeyChild) { try { wideHotkeyChild.kill(); } catch {} wideHotkeyChild = null; }
  if (config.wideHotkey && config.wideHotkey.enabled === false) return;
  const c = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'wide-hotkey-listener.ps1')], { windowsHide: true });
  wideHotkeyChild = c;
  c.stdout.on('data', d => console.log('[wide-hotkey]', d.toString().trim()));
  c.on('exit', () => { if (wideHotkeyChild === c) wideHotkeyChild = null; });
  c.on('error', () => {});
}
applyWideHotkey();

// 端口已被占用(如 start-sidescreen 误判重复起了本进程): 杀掉自己刚 spawn 的采集子进程再退出,
// 否则这些子进程(ddc-agent/net-monitor 等)会变孤儿, 与真正的 server 抢 DDC 总线并制造 churn。
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`[fatal] 端口 ${PORT} 已被占用, 本实例退出(另有 server 在跑)`);
    for (const c of [netChild, notifyChild, npChild, hotkeyChild, wideHotkeyChild, ddc.child]) { try { c && c.kill(); } catch {} }
    process.exit(0);
  }
  throw e;
});
server.listen(PORT, () => console.log(`sidescreen dashboard: http://localhost:${PORT}  admin: http://${lanIP()}:${PORT}/admin`));
