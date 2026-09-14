'use strict';
// Scan publish candidates without printing matching values.
const fs = require('fs');
const cp = require('child_process');
const files = cp.execFileSync('git', ['ls-files','-z'], {encoding:'utf8'}).split('\0').filter(Boolean);
const checks = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['API key', /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,})\b/],
  ['JWT', /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/],
  ['personal IPv4', /\b(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|47\.113\.190\.177)\b/],
  ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
];
let hits=0;
for(const f of files){
  if(!fs.existsSync(f))continue;
  if(/(?:^|\/)(?:config\.json|auth\.json|\.env|scratchpad|\.codex-backups)|\.(?:jsonl|log|secret|zip)$/.test(f)){console.log('FORBIDDEN FILE '+f);hits++;}
  if(!/\.(?:js|cjs|json|html|css|md|ps1|cmd|svg)$/.test(f)||f==='tools/audit-public.cjs')continue;
  const s=fs.readFileSync(f,'utf8');
  for(const [kind,re] of checks)if(re.test(s)){console.log('REVIEW '+kind+' in '+f);hits++;}
}
console.log(JSON.stringify({files:files.length,findings:hits}));
process.exitCode=hits?1:0;
