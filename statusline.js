#!/usr/bin/env node
// Claude Code statusline 桥接：把官方 rate_limits 落盘给副屏仪表盘，同时打印一行正常状态栏。
// 注册: ~/.claude/settings.json 的 statusLine.command = node "此文件路径"
// 官方字段: rate_limits.five_hour / seven_day 各含 used_percentage + resets_at (仅 Pro/Max, 首个 API 响应后出现)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.homedir(), '.claude', 'sidescreen-usage.json');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => {
  let d = {};
  try { d = JSON.parse(raw); } catch { /* 输入异常时也要打印状态栏, 不能崩 */ }

  // 1) 落盘给仪表盘 —— 只在拿到 rate_limits 时更新, 避免用空值覆盖上次好数据
  try {
    const rl = d.rate_limits;
    if (rl && (rl.five_hour || rl.seven_day)) {
      const payload = {
        rate_limits: rl,
        model: d.model && d.model.display_name,
        contextPct: d.context_window && d.context_window.used_percentage,
        ts: Date.now(),
      };
      const tmp = OUT + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, OUT);   // 原子替换, 防止仪表盘读到半截文件
    }
  } catch { /* 落盘失败不影响状态栏渲染 */ }

  // 2) 打印一行正常状态栏 (模型 + 上下文条 + 两个额度窗口)
  process.stdout.write(renderBar(d));
});

function bar(pct, width) {
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const filled = Math.round((p / 100) * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

function renderBar(d) {
  const model = (d.model && d.model.display_name) || 'Claude';
  const ctx = d.context_window && d.context_window.used_percentage;
  const parts = [`[${model}]`];
  if (typeof ctx === 'number') parts.push(`${bar(ctx, 10)} ${Math.round(ctx)}% ctx`);
  const rl = d.rate_limits || {};
  const seg = [];
  if (rl.five_hour && typeof rl.five_hour.used_percentage === 'number') {
    seg.push(`5h ${Math.round(rl.five_hour.used_percentage)}%`);
  }
  if (rl.seven_day && typeof rl.seven_day.used_percentage === 'number') {
    seg.push(`7d ${Math.round(rl.seven_day.used_percentage)}%`);
  }
  if (seg.length) parts.push(seg.join(' · '));
  return parts.join('  ');
}
