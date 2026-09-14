'use strict';

// Codex 官方 App Server 的只读用量客户端。
// 不读取 auth.json / OAuth token，也不写任何 Codex 配置或凭据；认证与自动刷新完全交给 Codex 自己。

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

// Supervisor 以无终端任务启动时不会继承交互式终端里的代理变量。
// 只给 Codex App Server 的网络子进程补上用户已配置的本机代理；不读取、不写入登录凭据。
function appServerEnv() {
  const env = Object.assign({}, process.env);
  const hasProxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
    .some(k => String(env[k] || '').trim());
  if (!hasProxy) {
    env.HTTP_PROXY = 'http://127.0.0.1:7897';
    env.HTTPS_PROXY = 'http://127.0.0.1:7897';
    env.NO_PROXY = 'localhost,127.0.0.1,::1';
  }
  return env;
}

function findCodexExe() {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    path.join(os.homedir(), '.codex', 'plugins', '.plugin-appserver', 'codex.exe'),
    'codex',
  ].filter(Boolean);
  for (const exe of candidates) {
    if (exe === 'codex' || fs.existsSync(exe)) return exe;
  }
  return null;
}

function readCodexAccountUsageOnce(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const exe = findCodexExe();
    if (!exe) return reject(new Error('未找到 Codex App Server'));

    let child;
    try {
      child = spawn(exe, ['app-server'], {
        windowsHide: true,
        env: appServerEnv(),
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (e) {
      return reject(new Error('Codex App Server 启动失败: ' + e.message));
    }

    const rl = readline.createInterface({ input: child.stdout });
    const got = { rateLimits: null, accountUsage: null };
    let settled = false;
    const send = msg => {
      try { child.stdin.write(JSON.stringify(msg) + '\n'); }
      catch (e) { finish(e); }
    };
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { rl.close(); } catch {}
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
      if (err) reject(err);
      else resolve(normalize(got.rateLimits, got.accountUsage));
    };

    const timer = setTimeout(() => finish(new Error('Codex 用量读取超时')), timeoutMs);
    child.on('error', e => finish(new Error('Codex App Server 错误: ' + e.message)));
    child.on('exit', code => {
      if (!settled && (!got.rateLimits || !got.accountUsage)) {
        finish(new Error('Codex App Server 提前退出' + (code == null ? '' : ' (' + code + ')')));
      }
    });
    rl.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 0) {
        if (msg.error) return finish(new Error(msg.error.message || 'Codex 初始化失败'));
        send({ method: 'initialized', params: {} });
        send({ method: 'account/rateLimits/read', id: 1 });
        send({ method: 'account/usage/read', id: 2 });
        return;
      }
      if (msg.id === 1) {
        if (msg.error) return finish(new Error(msg.error.message || 'Codex 限额读取失败'));
        got.rateLimits = msg.result || {};
      }
      if (msg.id === 2) {
        // token 活动是附加信息；部分账户可能不返回，不应连带让限额面板失效。
        got.accountUsage = msg.error ? { error: msg.error.message || 'token 活动不可用' } : (msg.result || {});
      }
      if (got.rateLimits && got.accountUsage) finish();
    });

    send({
      method: 'initialize', id: 0,
      params: { clientInfo: { name: 'sidescreen_dashboard', title: 'Side-screen Dashboard', version: '1.0.0' } },
    });
  });
}

// App Server 每次启动还会并行预热插件目录等网络请求；代理刚切节点或 TLS 连接刚恢复时，
// 单次 wham/usage 偶尔会失败，但紧接着再读通常已经正常。把这种瞬时故障消化在一次采样里，
// 避免外层直接进入 1/2/4 分钟退避，让副屏看起来长时间不更新。
async function readCodexAccountUsage(timeoutMs = 20000) {
  const waits = [0, 700, 1600];
  let lastErr = null;
  for (let i = 0; i < waits.length; i++) {
    if (waits[i]) await new Promise(resolve => setTimeout(resolve, waits[i]));
    try { return await readCodexAccountUsageOnce(timeoutMs); }
    catch (e) {
      lastErr = e;
      const msg = String(e && e.message || '');
      // 配置/协议/可执行文件错误重试没有意义；网络发送、超时和子进程偶发提前退出才短重试。
      const transient = /error sending request|network|socket|tls|econn|timed?\s*out|超时|提前退出/i.test(msg);
      if (!transient) throw e;
    }
  }
  throw lastErr || new Error('Codex 用量读取失败');
}

function pctSeverity(pct, reached) {
  if (reached || pct >= 100) return 'critical';
  if (pct >= 85) return 'warning';
  return 'normal';
}

function windowName(mins) {
  if (!Number.isFinite(mins) || mins <= 0) return '额度';
  if (mins === 10080) return '周额度';
  if (mins % 10080 === 0) return (mins / 10080) + ' 周额度';
  if (mins % 1440 === 0) return (mins / 1440) + ' 天额度';
  if (mins % 60 === 0) return (mins / 60) + ' 小时额度';
  return mins + ' 分钟额度';
}

function localDateKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function normalize(rateResult, activityResult) {
  const fallback = rateResult && rateResult.rateLimits;
  const byId = rateResult && rateResult.rateLimitsByLimitId;
  const source = byId && Object.keys(byId).length
    ? byId
    : (fallback ? { [fallback.limitId || 'codex']: fallback } : {});
  const buckets = [];

  for (const [id, raw] of Object.entries(source)) {
    if (!raw) continue;
    const limitId = raw.limitId || id;
    const baseName = raw.limitName || (limitId === 'codex' ? 'Codex' : limitId);
    for (const slot of ['primary', 'secondary']) {
      const w = raw[slot];
      if (!w || w.usedPercent == null) continue;
      const pct = Number(w.usedPercent);
      const mins = Number(w.windowDurationMins) || 0;
      buckets.push({
        key: limitId + ':' + slot,
        limitId,
        slot,
        name: baseName,
        label: baseName + ' · ' + windowName(mins),
        pct,
        windowMins: mins,
        resetsAt: w.resetsAt ? Number(w.resetsAt) * 1000 : null,
        severity: pctSeverity(pct, raw.rateLimitReachedType),
        planType: raw.planType || null,
        rateLimitReachedType: raw.rateLimitReachedType || null,
        credits: raw.credits || null,
      });
    }
  }

  buckets.sort((a, b) => {
    const am = a.limitId === 'codex' ? 0 : 1;
    const bm = b.limitId === 'codex' ? 0 : 1;
    return am - bm || b.windowMins - a.windowMins || a.label.localeCompare(b.label, 'zh-CN');
  });
  const mainWindows = buckets.filter(b => b.limitId === 'codex');
  const main = mainWindows.slice().sort((a, b) => b.windowMins - a.windowMins)[0] || buckets[0] || null;
  const short = mainWindows.slice().sort((a, b) => a.windowMins - b.windowMins)[0] || null;
  const actualShort = short && main && short.key !== main.key ? short : null;
  const extra = buckets.find(b => !main || b.key !== main.key) || null;

  const summary = activityResult && activityResult.summary || null;
  const daily = Array.isArray(activityResult && activityResult.dailyUsageBuckets)
    ? activityResult.dailyUsageBuckets.map(x => ({ startDate: x.startDate, tokens: Number(x.tokens) || 0 }))
    : [];
  const todayKey = localDateKey();
  const todayTokens = (daily.find(x => x.startDate === todayKey) || {}).tokens || 0;
  const latestDay = daily.slice().sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)))[0] || null;
  const weekCut = new Date(); weekCut.setHours(0, 0, 0, 0); weekCut.setDate(weekCut.getDate() - 6);
  const weekTokens = daily.reduce((n, x) => {
    const t = Date.parse(x.startDate + 'T00:00:00');
    return n + (Number.isFinite(t) && t >= weekCut.getTime() ? x.tokens : 0);
  }, 0);

  return {
    main,
    short: actualShort,
    extra,
    buckets,
    summary,
    daily,
    todayTokens,
    latestDayTokens: latestDay ? latestDay.tokens : 0,
    latestDayDate: latestDay ? latestDay.startDate : null,
    weekTokens,
    resetCredits: rateResult && rateResult.rateLimitResetCredits || null,
    tokenActivityError: activityResult && activityResult.error || null,
    // 兼容小副屏现有组件；新宽屏直接使用 main/short/extra/buckets。
    session: actualShort || main,
    weekAll: main,
    weekScoped: extra ? Object.assign({}, extra, { label: extra.name }) : null,
  };
}

module.exports = { findCodexExe, readCodexAccountUsage, normalize, windowName };
