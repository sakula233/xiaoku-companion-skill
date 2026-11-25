#!/usr/bin/env node
/**
 * companion.mjs — 独立会话伴侣 CLI 与 MCP 一体化入口（零外部依赖、随用随跑、跑完即退）
 *
 * 常用命令：
 *   node scripts/companion.mjs context [--query "关键词"]
 *   node scripts/companion.mjs remember [--title "周五长沙面试"] [--phase planned] [--facts '{"city":"长沙"}'] [--quote "..."] [--emotion warmth] [--hangup "周五面试结果"] [--digest "..."]
 *   node scripts/companion.mjs recall [--query "面试"] [--all]
 *   node scripts/companion.mjs profile [--name "阿泽"] [--aliases "阿泽,小泽"] [--call-user "老陈"] [--bio "..."] [--add-boundary "..."] [--add-interest "..."] [--add-joke "..."]
 *   node scripts/companion.mjs daily [--mood "愉快"] [--energy "充足"] [--summary "今天淘到一张老电影原声带"]
 *   node scripts/companion.mjs project --name "深夜电台" [--status active] [--stage "定开场白"] [--settings '{"theme":"雨夜"}'] [--note "..."]
 *   node scripts/companion.mjs forget [--event-id evt-xxx | --query "面试" | --all]
 *   node scripts/companion.mjs weather --text "周六长沙晚上冷不冷"
 *   node scripts/companion.mjs export [--out ./my-companion.capsule.json] [--note "换电脑备份"]
 *   node scripts/companion.mjs import --in ./my-companion.capsule.json [--mode replace|merge]
 *   node scripts/companion.mjs reset [--name "小库"]
 *   node scripts/companion.mjs status
 *   node scripts/companion.mjs mcp
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { openLocalCompanion, localDateString } from './lib/store.mjs';
import { queryWeatherFactCard } from './lib/weather.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(__dirname, '..');

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        if (flags[key] === undefined) flags[key] = next;
        else if (Array.isArray(flags[key])) flags[key].push(next);
        else flags[key] = [flags[key], next];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { cmd: positional[0] || 'context', positional: positional.slice(1), flags };
}

function splitList(val) {
  if (!val) return [];
  const arr = Array.isArray(val) ? val : [val];
  return arr
    .flatMap((item) => String(item).split(/[,，]/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseJsonOrNote(raw) {
  if (!raw || typeof raw === 'boolean') return {};
  if (typeof raw === 'object') return raw;
  const trimmed = String(raw).trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return { note: trimmed };
    }
  }
  // 支持简易 key=value,key2=value2 写法，降低命令行转义负担
  if (trimmed.includes('=')) {
    const out = {};
    for (const pair of trimmed.split(/[,;，；]/)) {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }
    }
    if (Object.keys(out).length) return out;
  }
  return { note: trimmed };
}

export async function runCliCommand(argv, { dataDirOverride = null, fetchImpl = fetch } = {}) {
  const { cmd, flags } = parseFlags(argv);
  const dataDir = dataDirOverride || (typeof flags['data-dir'] === 'string' ? flags['data-dir'] : process.env.COMPANION_SKILL_DATA_DIR || null);

  if (cmd === 'help' || flags.help) {
    return {
      ok: true,
      commands: ['context', 'remember', 'recall', 'profile', 'rename', 'daily', 'project', 'forget', 'weather', 'export', 'import', 'reset', 'status', 'mcp'],
    };
  }

  if (cmd === 'weather') {
    return queryWeatherFactCard({
      text: typeof flags.text === 'string' ? flags.text : '',
      city: typeof flags.city === 'string' ? flags.city : '',
      date: typeof flags.date === 'string' ? flags.date : '',
      period: typeof flags.period === 'string' ? flags.period : '',
      fetchImpl,
    });
  }

  const store = openLocalCompanion({ skillRoot: SKILL_ROOT, dataDir });
  try {
    switch (cmd) {
      case 'context': {
        const query = typeof flags.query === 'string' ? flags.query : '';
        return { ok: true, ...store.buildSessionContext({ query }) };
      }

      case 'status': {
        return { ok: true, ...store.getStatusSummary() };
      }

      case 'rename':
      case 'profile': {
        const updated = store.updateProfile({
          name: typeof flags.name === 'string' ? flags.name : undefined,
          keepOldAlias: flags['keep-old-alias'] === true,
          aliases: splitList(flags.aliases),
          gender: typeof flags.gender === 'string' ? flags.gender : undefined,
          bio: typeof flags.bio === 'string' ? flags.bio : undefined,
          appearanceSummary: typeof flags.appearance === 'string' ? flags.appearance : undefined,
          appearanceTraits: splitList(flags['appearance-traits']),
          addTraits: splitList(flags['add-trait']),
          addInterests: splitList(flags['add-interest']),
          callUser: typeof flags['call-user'] === 'string' ? flags['call-user'] : undefined,
          addUserBoundaries: splitList(flags['add-boundary']),
          addUserPreferences: splitList(flags['add-pref']),
          addInsideJokes: splitList(flags['add-joke']),
        });
        return { ok: true, profile: updated };
      }

      case 'remember': {
        const results = {};
        if (typeof flags['call-user'] === 'string' || flags['add-boundary'] || flags['add-pref'] || flags['add-joke'] || flags['add-interest']) {
          results.profile = store.updateProfile({
            callUser: typeof flags['call-user'] === 'string' ? flags['call-user'] : undefined,
            addUserBoundaries: splitList(flags['add-boundary']),
            addUserPreferences: splitList(flags['add-pref']),
            addInsideJokes: splitList(flags['add-joke']),
            addInterests: splitList(flags['add-interest']),
          });
        }
        let eventRecord = null;
        if (typeof flags.title === 'string' || typeof flags['event-id'] === 'string') {
          eventRecord = store.upsertEvent({
            eventId: typeof flags['event-id'] === 'string' ? flags['event-id'] : null,
            title: typeof flags.title === 'string' ? flags.title : undefined,
            phase: typeof flags.phase === 'string' ? flags.phase : 'planned',
            domain: typeof flags.domain === 'string' ? flags.domain : 'reality',
            facts: parseJsonOrNote(flags.facts),
            quote: typeof flags.quote === 'string' ? flags.quote : (typeof flags.title === 'string' ? flags.title : ''),
          });
          results.event = eventRecord;
        }
        if (typeof flags.emotion === 'string') {
          results.emotion = store.recordEmotion({
            kind: flags.emotion,
            quote: typeof flags.quote === 'string' ? flags.quote : flags.emotion,
            eventId: eventRecord?.eventId || (typeof flags['event-id'] === 'string' ? flags['event-id'] : null),
            resolveId: typeof flags['resolve-id'] === 'string' ? flags['resolve-id'] : null,
          });
        }
        if (typeof flags.hangup === 'string') {
          results.hangup = store.upsertHangup({
            topic: flags.hangup,
            status: typeof flags['hangup-status'] === 'string' ? flags['hangup-status'] : 'open',
            eventId: eventRecord?.eventId || null,
          });
        }
        if (typeof flags['resolve-hangup'] === 'string') {
          results.resolvedHangup = store.upsertHangup({
            id: flags['resolve-hangup'].startsWith('hng-') ? flags['resolve-hangup'] : null,
            topic: flags['resolve-hangup'].startsWith('hng-') ? undefined : flags['resolve-hangup'],
            status: 'resolved',
          });
        }
        if (typeof flags.digest === 'string') {
          results.digest = store.addSessionDigest(flags.digest);
        }
        return { ok: true, committed: results };
      }

      case 'recall': {
        const events = store.searchEvents({
          query: typeof flags.query === 'string' ? flags.query : '',
          domain: typeof flags.domain === 'string' ? flags.domain : null,
          includeClosed: flags.all === true,
          limit: flags.limit ? Number(flags.limit) : 20,
        });
        return { ok: true, count: events.length, events };
      }

      case 'daily': {
        const res = store.ensureDailyLife({
          day: typeof flags.day === 'string' ? flags.day : localDateString(),
          mood: typeof flags.mood === 'string' ? flags.mood : undefined,
          energy: typeof flags.energy === 'string' ? flags.energy : undefined,
          summary: typeof flags.summary === 'string' ? flags.summary : undefined,
          arc: typeof flags.arc === 'string' ? flags.arc : undefined,
          force: flags.force === true,
        });
        return { ok: true, ...res };
      }

      case 'project': {
        const prj = store.upsertProject({
          projectId: typeof flags['project-id'] === 'string' ? flags['project-id'] : null,
          name: typeof flags.name === 'string' ? flags.name : '',
          status: typeof flags.status === 'string' ? flags.status : 'active',
          stage: typeof flags.stage === 'string' ? flags.stage : '构思中',
          settings: parseJsonOrNote(flags.settings),
          note: typeof flags.note === 'string' ? flags.note : '',
        });
        return { ok: true, project: prj };
      }

      case 'forget': {
        const res = store.forget({
          eventId: typeof flags['event-id'] === 'string' ? flags['event-id'] : null,
          query: typeof flags.query === 'string' ? flags.query : '',
          all: flags.all === true,
          reason: typeof flags.reason === 'string' ? flags.reason : 'user-requested',
        });
        return { ok: true, ...res };
      }

      case 'export': {
        const capsule = store.exportCapsule({
          note: typeof flags.note === 'string' ? flags.note : '',
        });
        const defaultName = `${store.profile.name}-${localDateString()}.capsule.json`;
        const outPath = path.resolve(typeof flags.out === 'string' ? flags.out : path.join(store.dataDir, defaultName));
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(capsule, null, 2) + '\n', 'utf8');
        return {
          ok: true,
          outPath,
          companionName: capsule.companionName,
          counts: capsule.counts,
          sha256: capsule.integrity.sha256,
        };
      }

      case 'import': {
        const inFile = typeof flags.in === 'string' ? flags.in : '';
        if (!inFile) throw new Error('请通过 --in <path.capsule.json> 指定要导入的记忆胶囊文件');
        const resolvedIn = path.resolve(inFile);
        if (!fs.existsSync(resolvedIn)) throw new Error(`找不到导入文件: ${resolvedIn}`);
        const capsule = JSON.parse(fs.readFileSync(resolvedIn, 'utf8'));
        const mode = typeof flags.mode === 'string' ? flags.mode : 'replace';
        const res = store.importCapsule(capsule, {
          mode,
          skipVerify: flags['skip-verify'] === true,
        });
        return { ...res, inPath: resolvedIn };
      }

      case 'reset': {
        return store.resetToBlank({
          newName: typeof flags.name === 'string' ? flags.name : '',
        });
      }

      default:
        throw new Error(`未知命令: ${cmd}`);
    }
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// 标准 MCP (JSON-RPC 2.0 over stdio) 模式：node scripts/companion.mjs mcp
// ---------------------------------------------------------------------------

export function createMcpDispatcher({ dataDir = null, fetchImpl = fetch } = {}) {
  const tools = [
    {
      name: 'companion_get_context',
      description: '读取当前专属伴侣的人设名字、今日心情与日常、用户称呼与边界、待跟进挂念及匹配的事件记忆。每次开始对话时先调用。',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: '可选检索词，用于召回特定过往事件' } },
      },
      run: (args) => runCliCommand(['context', ...(args?.query ? ['--query', String(args.query)] : [])], { dataDirOverride: dataDir, fetchImpl }),
    },
    {
      name: 'companion_remember',
      description: '将会话中发生的新事件进展、情绪温度、待跟进挂念或本次会话摘要直接写入本地记忆库。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          eventId: { type: 'string' },
          phase: { type: 'string', enum: ['planned', 'in_progress', 'completed', 'cancelled'] },
          domain: { type: 'string', enum: ['reality', 'fictional-project'] },
          facts: { type: 'object' },
          quote: { type: 'string' },
          emotion: { type: 'string', enum: ['warmth', 'gratitude', 'shared_joy', 'worry', 'friction', 'repair'] },
          hangup: { type: 'string' },
          resolveHangup: { type: 'string' },
          digest: { type: 'string' },
        },
      },
      run: (args = {}) => {
        const cli = ['remember'];
        if (args.title) cli.push('--title', String(args.title));
        if (args.eventId) cli.push('--event-id', String(args.eventId));
        if (args.phase) cli.push('--phase', String(args.phase));
        if (args.domain) cli.push('--domain', String(args.domain));
        if (args.facts) cli.push('--facts', JSON.stringify(args.facts));
        if (args.quote) cli.push('--quote', String(args.quote));
        if (args.emotion) cli.push('--emotion', String(args.emotion));
        if (args.hangup) cli.push('--hangup', String(args.hangup));
        if (args.resolveHangup) cli.push('--resolve-hangup', String(args.resolveHangup));
        if (args.digest) cli.push('--digest', String(args.digest));
        return runCliCommand(cli, { dataDirOverride: dataDir, fetchImpl });
      },
    },
    {
      name: 'companion_update_profile',
      description: '重命名伴侣角色（如改名叫小张/阿泽）或记录用户希望被怎么称呼、明确边界、共同的梗与兴趣。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '新的伴侣角色名字' },
          aliases: { type: 'array', items: { type: 'string' } },
          bio: { type: 'string' },
          callUser: { type: 'string', description: '对用户的专属称呼' },
          addBoundary: { type: 'string' },
          addInterest: { type: 'string' },
          addJoke: { type: 'string' },
        },
      },
      run: (args = {}) => {
        const cli = ['profile'];
        if (args.name) cli.push('--name', String(args.name));
        if (Array.isArray(args.aliases) && args.aliases.length) cli.push('--aliases', args.aliases.join(','));
        if (args.bio) cli.push('--bio', String(args.bio));
        if (args.callUser) cli.push('--call-user', String(args.callUser));
        if (args.addBoundary) cli.push('--add-boundary', String(args.addBoundary));
        if (args.addInterest) cli.push('--add-interest', String(args.addInterest));
        if (args.addJoke) cli.push('--add-joke', String(args.addJoke));
        return runCliCommand(cli, { dataDirOverride: dataDir, fetchImpl });
      },
    },
    {
      name: 'companion_update_daily',
      description: '更新伴侣角色自己今天的虚拟日常生活、心情和精力。',
      inputSchema: {
        type: 'object',
        properties: {
          mood: { type: 'string' },
          energy: { type: 'string' },
          summary: { type: 'string' },
          arc: { type: 'string' },
        },
      },
      run: (args = {}) => {
        const cli = ['daily'];
        if (args.mood) cli.push('--mood', String(args.mood));
        if (args.energy) cli.push('--energy', String(args.energy));
        if (args.summary) cli.push('--summary', String(args.summary));
        if (args.arc) cli.push('--arc', String(args.arc));
        return runCliCommand(cli, { dataDirOverride: dataDir, fetchImpl });
      },
    },
    {
      name: 'companion_query_weather',
      description: '查询城市与日期/时段的真实天气预报事实卡片（Open-Meteo）。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '自然语言查天气，如 周六长沙晚上' },
          city: { type: 'string' },
          date: { type: 'string' },
          period: { type: 'string' },
        },
      },
      run: (args = {}) => {
        const cli = ['weather'];
        if (args.text) cli.push('--text', String(args.text));
        if (args.city) cli.push('--city', String(args.city));
        if (args.date) cli.push('--date', String(args.date));
        if (args.period) cli.push('--period', String(args.period));
        return runCliCommand(cli, { dataDirOverride: dataDir, fetchImpl });
      },
    },
    {
      name: 'companion_forget',
      description: '按用户明确要求遗忘某件事或清空本地记忆。',
      inputSchema: {
        type: 'object',
        properties: {
          eventId: { type: 'string' },
          query: { type: 'string' },
          all: { type: 'boolean' },
        },
      },
      run: (args = {}) => {
        const cli = ['forget'];
        if (args.eventId) cli.push('--event-id', String(args.eventId));
        if (args.query) cli.push('--query', String(args.query));
        if (args.all) cli.push('--all');
        return runCliCommand(cli, { dataDirOverride: dataDir, fetchImpl });
      },
    },
    {
      name: 'companion_capsule',
      description: '导出或导入本地专属记忆胶囊文件（.capsule.json）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['export', 'import'] },
          filePath: { type: 'string' },
          mode: { type: 'string', enum: ['replace', 'merge'] },
          note: { type: 'string' },
        },
        required: ['action'],
      },
      run: (args = {}) => {
        if (args.action === 'export') {
          const cli = ['export'];
          if (args.filePath) cli.push('--out', String(args.filePath));
          if (args.note) cli.push('--note', String(args.note));
          return runCliCommand(cli, { dataDirOverride: dataDir, fetchImpl });
        }
        const cli = ['import', '--in', String(args.filePath || ''), '--mode', String(args.mode || 'replace')];
        return runCliCommand(cli, { dataDirOverride: dataDir, fetchImpl });
      },
    },
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));

  async function handleJsonRpc(msg) {
    if (!msg || msg.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'xiaoku-companion-skill', version: '1.0.0' },
          },
        };
      case 'notifications/initialized':
        return null;
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
        };
      case 'tools/call': {
        const tool = byName.get(params?.name);
        if (!tool) {
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool: ${params?.name}` }], isError: true } };
        }
        try {
          const out = await tool.run(params?.arguments || {});
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false } };
        } catch (err) {
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(err?.message || err) }], isError: true } };
        }
      }
      default:
        if (isNotification) return null;
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  }

  return { handleJsonRpc, tools };
}

const isDirectEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectEntry) {
  const args = process.argv.slice(2);
  if (args[0] === 'mcp') {
    const { handleJsonRpc } = createMcpDispatcher();
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const resp = await handleJsonRpc(JSON.parse(trimmed));
        if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
      } catch {}
    }
  } else {
    runCliCommand(args)
      .then((res) => {
        process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      })
      .catch((err) => {
        process.stderr.write(JSON.stringify({ ok: false, error: String(err?.message || err) }) + '\n');
        process.exitCode = 1;
      });
  }
}
