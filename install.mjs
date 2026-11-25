#!/usr/bin/env node
/**
 * install.mjs — 将小库独立伴侣技能一键安装到目标工作区或本机全局技能目录
 *
 * 用法：
 *   node install.mjs --target /path/to/workspace   # 安装到 <workspace>/.agents/skills/xiaoku
 *   node install.mjs --global                      # 安装到 ~/.gemini/config/skills/xiaoku
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

let destBase = null;
let skillFolderName = 'xiaoku';

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--global') {
    destBase = path.join(os.homedir(), '.gemini', 'config', 'skills');
  } else if (argv[i] === '--target' && argv[i + 1]) {
    destBase = path.join(path.resolve(argv[i + 1]), '.agents', 'skills');
    i++;
  } else if (argv[i] === '--skill-dir-name' && argv[i + 1]) {
    skillFolderName = argv[i + 1];
    i++;
  }
}

if (!destBase) {
  destBase = path.join(process.cwd(), '.agents', 'skills');
}

const destDir = path.join(destBase, skillFolderName);
const ITEMS_TO_COPY = ['.gitignore', 'SKILL.md', 'resources', 'references', 'scripts', 'test'];

fs.mkdirSync(destDir, { recursive: true });
for (const item of ITEMS_TO_COPY) {
  const src = path.join(__dirname, item);
  if (!fs.existsSync(src)) continue;
  const dst = path.join(destDir, item);
  fs.cpSync(src, dst, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  installedTo: destDir,
  note: '安装完成！本地 data/ 未被覆盖，首次对话将初始化专属于你的伴侣角色。',
}, null, 2));
