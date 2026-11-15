// 临时审计脚本：看每份文档开头叠了哪些版本横幅、有没有已写好的 v5 文档
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const out = [];
function scan(dir) {
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    if (!f.endsWith('.md')) continue;
    const rel = (dir === '.' ? '' : dir + '/') + f;
    const t = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const head = t.slice(0, 1600);
    const tags = [];
    if (head.includes('v4.1.0 更新')) tags.push('v4.1');
    if (head.includes('当前交付口径（v4.0.0')) tags.push('v4.0');
    if (/v5/.test(head)) tags.push('v5?');
    out.push(rel.padEnd(44) + ' ' + String(t.length).padStart(6) + '  ' + tags.join(','));
  }
}
['.', 'docs', 'prompts', 'workflow', 'interview'].forEach(scan);
out.push('', 'docs/24 exists: ' + fs.existsSync(path.join(ROOT, 'docs/24_v5当前实现与发布门槛.md')));
out.push('docs/25 exists: ' + fs.existsSync(path.join(ROOT, 'docs/25_v5_Prompt与RAG实现.md')));
out.push('history dir: ' + fs.existsSync(path.join(ROOT, 'docs/history_before_v5')));
fs.writeFileSync(path.join(ROOT, 'tools/_audit_docs.txt'), out.join('\n'), 'utf8');
console.log('ok');
