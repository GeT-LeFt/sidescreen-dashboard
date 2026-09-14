'use strict';
// Fictional presentation fixtures. Never imported by the dashboard runtime.
module.exports = function showcaseData() {
  const now = Date.now();
  const main = {key:'codex-week',name:'Codex',windowMins:10080,pct:38,resetsAt:now+3*86400000};
  const secondary = {key:'codex-session',name:'Codex',windowMins:300,pct:14,resetsAt:now+3*3600000};
  const sessions = [
    {sid:'demo-ui',device:'Windows',title:'优化副屏布局',status:'running',detail:'npm run build',reply:'已完成布局调整，正在检查窄屏下的文字与间距。',ts:now},
    {sid:'demo-test',device:'Mac',title:'为音量控制补充测试',status:'running',detail:'node --test audio.test.js',reply:'正在验证静音恢复、设备切换与多应用音量控制。',ts:now-30000},
    {sid:'demo-docs',device:'Windows',title:'完善项目使用说明',status:'done',lastAct:'更新 README.md',reply:'使用说明已补齐：Page Up / Page Down 切换页面，F10 切换小屏；到达首尾页面后停止翻页。',ts:now-120000},
    {sid:'demo-theme',device:'Mac',title:'设计媒体页深色主题',status:'done',lastAct:'检查 wide.css',reply:'已统一背景、文字层级与琥珀色强调，并保留歌词切换的平滑过渡。',ts:now-240000},
  ].map(s=>({...s,source:'codex'}));
  const apps = [ ['edge','浏览器','e','#3b82f6'],['code','编辑器','</>','#5b9cf5'],['files','文件','文','#f59e0b'],['terminal','终端','>_','#64748b'],['music','音乐','♪','#ec4899'],['steam','游戏','S','#66c0f4'],['notes','笔记','N','#a78bfa'],['calendar','日历','日','#4fb6a5'] ].map(([id,label,ch,color])=>({id,label,ch,color,cmd:''}));
  return {
    '/api/sessions': {t:now,counts:{total:4,running:2,waiting:0,done:2},byDevice:{Windows:{total:2},Mac:{total:2}},sessions},
    '/api/claude/sessions': {t:now,counts:{total:4,running:2,waiting:0,done:2},byDevice:{Windows:{total:2},Mac:{total:2}},sessions},
    '/api/codex': {usage:{main,buckets:[main,secondary],todayTokens:42000,weekTokens:286000}},
    '/api/config': {rev:1,config:{apps,audio:{favorites:['扬声器','耳机']}}},
    '/api/nowplaying': {title:'桌边的微光',artist:'SideScreen · 原创展示文案',playing:true,dur:240,pos:96,cover:0,key:'demo-song',idx:2,lines:['让忙碌停在屏幕一角','把时间留给眼前的想法','桌边的微光，陪灵感慢慢发亮','一行代码，一次新的出发','此处为展示文案，并非真实歌曲']},
    '/api/audio': {ok:true,master:{vol:46,muted:false},mic:{muted:false},devices:[{id:'demo-speaker',name:'扬声器',default:true},{id:'demo-headset',name:'耳机',default:false}],sessions:[{pid:101,name:'浏览器',vol:65,muted:false},{pid:102,name:'音乐',vol:40,muted:false},{pid:103,name:'游戏',vol:75,muted:false},{pid:104,name:'通话',vol:55,muted:false}]},
    '/api/extras': {net:{ok:true,ping:8,rx:524288,tx:65536},weather:{ok:true,icon:'☀',temp:24,desc:'晴 · 示例天气',hi:27,lo:19,hourlyProb:[0,0,10,10,0,0]},calendar:{ok:true,events:[{time:'10:00',title:'设计评审（示例）'},{time:'14:00',title:'专注开发（示例）'},{time:'17:30',title:'今日复盘（示例）'}]},notify:{status:'allowed',recent:[{app:'任务',title:'使用说明已更新',body:'示例通知 · 可以开始下一项工作'}]},health:{ok:true,ms:18,upSince:now-7*86400000}},
  };
};
