#!/usr/bin/env node
// Claude Code hooks 桥接：把生命周期事件落盘给副屏仪表盘。
// 以 async 钩子运行，不阻塞工具调用；任何异常都静默吞掉，绝不影响 Claude Code。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.homedir(), '.claude', 'sidescreen-activity.json');
// 每个会话单独一个文件，桌宠据此同时显示多个会话（互不覆盖）
const DIR = path.join(os.homedir(), '.claude', 'sidescreen-activity');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => {
  try { handle(JSON.parse(raw)); } catch { /* 输入异常 -> 什么也不做 */ }
  process.exit(0);   // 永远 exit 0：exit 2 会阻塞工具调用
});
// stdin 迟迟不来也不要挂死
setTimeout(() => process.exit(0), 4000).unref();

// 需要你介入的通知类型
const NEEDS_YOU = new Set(['permission_prompt', 'agent_needs_input', 'elicitation_dialog']);

function derive(d) {
  const ev = d.hook_event_name;
  switch (ev) {
    case 'UserPromptSubmit': return { state: 'thinking' };
    case 'PreToolUse':       return { state: 'tool', tool: d.tool_name, detail: deriveDetail(d) };
    case 'PostToolUse':
    case 'PostToolUseFailure': return { state: 'thinking' };
    case 'PermissionRequest':  return { state: 'permission', kind: 'approve', tool: d.tool_name, detail: deriveDetail(d) };
    case 'PermissionDenied':   return { state: 'thinking' };
    case 'SubagentStart':      return { state: 'tool', tool: 'Agent', detail: '子任务' };
    case 'SubagentStop':       return { state: 'thinking' };
    case 'Stop':               return { state: 'done' };
    case 'SessionEnd':         return { state: 'ended' };
    case 'Notification': {
      const t = d.type || d.notification_type;
      if (NEEDS_YOU.has(t)) {
        // 细分交互类型: 批授权 / 选选项 / 回话
        const kind = t === 'permission_prompt' ? 'approve' : (t === 'elicitation_dialog' ? 'choose' : 'reply');
        return { state: 'permission', kind, notice: d.message };
      }
      if (t === 'agent_completed') return { state: 'done' };
      if (t === 'idle_prompt') return { state: 'idle' };
      return null;                       // auth_success 等无关类型：忽略
    }
    default: return null;
  }
}

// 从 tool_input 里提炼一句人话："改 main.js" / "$ npm install" / "搜 foo"
function deriveDetail(d) {
  const t = d.tool_name;
  const inp = d.tool_input || {};
  const base = (p) => { try { return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop(); } catch { return ''; } };
  const clip = (s, n) => { try { return String(s).replace(/\s+/g, ' ').trim().slice(0, n); } catch { return ''; } };
  switch (t) {
    case 'Read':         return inp.file_path ? '读 ' + base(inp.file_path) : null;
    case 'Edit':         return inp.file_path ? '改 ' + base(inp.file_path) : null;
    case 'Write':        return inp.file_path ? '写 ' + base(inp.file_path) : null;
    case 'NotebookEdit': return inp.notebook_path ? '改 ' + base(inp.notebook_path) : null;
    case 'Bash':         return inp.command ? '$ ' + clip(inp.command, 44) : null;
    case 'PowerShell':   return inp.command ? '> ' + clip(inp.command, 44) : null;
    case 'Grep':         return inp.pattern ? '搜 ' + clip(inp.pattern, 30) : null;
    case 'Glob':         return inp.pattern ? '找 ' + clip(inp.pattern, 30) : null;
    case 'Task': case 'Agent': return '起了个子任务';
    case 'WebFetch':     return inp.url ? '抓 ' + base(inp.url) : '联网';
    case 'WebSearch':    return inp.query ? '搜网 ' + clip(inp.query, 30) : '联网搜索';
    case 'TodoWrite':    return '更新待办';
    default:             return t || null;
  }
}

function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
  catch { try { fs.unlinkSync(tmp); } catch { /* 忽略 */ } }
}

function handle(d) {
  const s = derive(d);
  if (!s) return;
  const payload = {
    state: s.state,
    kind: s.kind || null,
    tool: s.tool || null,
    detail: s.detail || null,
    notice: s.notice || null,
    event: d.hook_event_name,
    sessionId: d.session_id || null,
    cwd: d.cwd || null,
    ts: Date.now(),
  };
  const text = JSON.stringify(payload);
  writeAtomic(OUT, text);               // 单文件：副屏仪表盘沿用（最后写入者）
  // 每会话文件：桌宠据此同时显示多个会话
  if (d.session_id) {
    try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* 忽略 */ }
    writeAtomic(path.join(DIR, d.session_id + '.json'), text);
  }
}
