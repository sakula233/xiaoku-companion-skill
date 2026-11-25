import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCliCommand, createMcpDispatcher } from '../scripts/companion.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `xiaoku-skill-${prefix}-`));
}

test('1. 全新接入默认是空白小库，支持自由改名、专属称呼与互动记忆演化', async () => {
  const userADir = makeTempDir('userA');

  // 首次读取上下文：全新伴侣，默认名叫小库，零事件记录
  const initCtx = await runCliCommand(['context'], { dataDirOverride: userADir });
  assert.equal(initCtx.ok, true);
  assert.equal(initCtx.isBrandNewCompanion, true);
  assert.equal(initCtx.companion.name, '小库');
  assert.equal(initCtx.memory.activeEvents.length, 0);

  // 用户 A 将角色改名为「阿泽」，设定称呼「老陈」与边界
  const prof = await runCliCommand([
    'profile',
    '--name', '阿泽',
    '--call-user', '老陈',
    '--add-boundary', '不聊薪资数字',
    '--add-interest', '黑胶唱片',
  ], { dataDirOverride: userADir });
  assert.equal(prof.ok, true);
  assert.equal(prof.profile.name, '阿泽');
  assert.equal(prof.profile.userProfile.preferredCallName, '老陈');
  assert.ok(prof.profile.userProfile.boundaries.includes('不聊薪资数字'));

  // 记下一件计划中的事 + 情绪 + 挂念
  const rem1 = await runCliCommand([
    'remember',
    '--title', '周六去长沙面试',
    '--phase', 'planned',
    '--facts', '{"city":"长沙","day":"周六"}',
    '--quote', '这周六得去长沙面一家新公司',
    '--emotion', 'worry',
    '--hangup', '周六长沙面试顺不顺利',
    '--digest', '老陈提到周六去长沙面试，稍微有点紧张。',
  ], { dataDirOverride: userADir });
  assert.equal(rem1.ok, true);
  assert.ok(rem1.committed.event.eventId.startsWith('evt-'));

  // 后续会话再次读取上下文：已不再是空白角色，能准确召回事件、挂念与改名后的身份
  const nextCtx = await runCliCommand(['context', '--query', '长沙'], { dataDirOverride: userADir });
  assert.equal(nextCtx.isBrandNewCompanion, false);
  assert.equal(nextCtx.companion.name, '阿泽');
  assert.equal(nextCtx.user.preferredCallName, '老陈');
  assert.equal(nextCtx.memory.openHangups.length, 1);
  assert.equal(nextCtx.memory.queryMatchedEvents.length, 1);
  assert.equal(nextCtx.memory.queryMatchedEvents[0].facts.city, '长沙');

  // 事件进展更新（同标题自动续接同一条事件并了结挂念）
  await runCliCommand([
    'remember',
    '--title', '周六去长沙面试',
    '--phase', 'completed',
    '--facts', '{"result":"拿到offer"}',
    '--quote', '长沙那家面试过了！',
    '--emotion', 'shared_joy',
    '--resolve-hangup', '周六长沙面试顺不顺利',
  ], { dataDirOverride: userADir });

  const recalled = await runCliCommand(['recall', '--query', 'offer', '--all'], { dataDirOverride: userADir });
  assert.equal(recalled.count, 1);
  assert.equal(recalled.events[0].phase, 'completed');
  assert.equal(recalled.events[0].history.length, 2);

  fs.rmSync(userADir, { recursive: true, force: true });
});

test('2. 导出/导入记忆胶囊（SHA-256 校验 + 跨环境迁移 + 另一位新用户保持空白隔离）', async () => {
  const originDir = makeTempDir('origin');
  const migratedDir = makeTempDir('migrated');
  const anotherUserDir = makeTempDir('userB');
  const capsulePath = path.join(originDir, 'aze.capsule.json');

  await runCliCommand(['profile', '--name', '小夏', '--call-user', '阿林'], { dataDirOverride: originDir });
  await runCliCommand([
    'remember',
    '--title', '下个月去大理旅居',
    '--phase', 'planned',
    '--facts', '{"destination":"大理"}',
    '--quote', '打算下个月去大理待两周',
  ], { dataDirOverride: originDir });
  await runCliCommand([
    'project',
    '--name', '深夜声音明信片',
    '--stage', '录第一期雨声',
    '--note', '定好每周三更新',
  ], { dataDirOverride: originDir });

  // 导出记忆胶囊
  const exp = await runCliCommand(['export', '--out', capsulePath, '--note', '迁移测试'], { dataDirOverride: originDir });
  assert.equal(exp.ok, true);
  assert.equal(exp.companionName, '小夏');
  assert.equal(exp.counts.events, 1);
  assert.equal(exp.counts.sharedProjects, 1);

  // 篡改检测：若胶囊内容被破坏，导入应拒绝并报错
  const rawCapsule = JSON.parse(fs.readFileSync(capsulePath, 'utf8'));
  const tamperedPath = path.join(originDir, 'tampered.capsule.json');
  const tampered = structuredClone(rawCapsule);
  tampered.payload.profile.name = '被篡改名字';
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered));
  await assert.rejects(
    () => runCliCommand(['import', '--in', tamperedPath], { dataDirOverride: migratedDir }),
    /SHA-256/
  );

  // 正常导入到新环境 migratedDir
  const imp = await runCliCommand(['import', '--in', capsulePath, '--mode', 'replace'], { dataDirOverride: migratedDir });
  assert.equal(imp.ok, true);
  assert.equal(imp.companionName, '小夏');

  const migratedCtx = await runCliCommand(['context', '--query', '大理'], { dataDirOverride: migratedDir });
  assert.equal(migratedCtx.companion.name, '小夏');
  assert.equal(migratedCtx.user.preferredCallName, '阿林');
  assert.equal(migratedCtx.memory.queryMatchedEvents.length, 1);
  assert.equal(migratedCtx.memory.activeProjects.length, 1);
  assert.equal(migratedCtx.memory.activeProjects[0].name, '深夜声音明信片');

  // 与此同时，新接入的另一位用户 userB 依然是全新空白的「小库」
  const userBCtx = await runCliCommand(['context'], { dataDirOverride: anotherUserDir });
  assert.equal(userBCtx.isBrandNewCompanion, true);
  assert.equal(userBCtx.companion.name, '小库');
  assert.equal(userBCtx.memory.activeEvents.length, 0);

  // 测试遗忘与重置
  const fg = await runCliCommand(['forget', '--query', '大理'], { dataDirOverride: migratedDir });
  assert.equal(fg.forgottenCount, 1);
  const afterForget = await runCliCommand(['recall', '--query', '大理', '--all'], { dataDirOverride: migratedDir });
  assert.equal(afterForget.count, 0);

  // 测试 merge 模式增量合并与 reset 重置回全新空白角色
  const mergeRes = await runCliCommand(['import', '--in', capsulePath, '--mode', 'merge'], { dataDirOverride: anotherUserDir });
  assert.equal(mergeRes.ok, true);
  assert.equal(mergeRes.companionName, '小夏');
  const mergedCtx = await runCliCommand(['context', '--query', '大理'], { dataDirOverride: anotherUserDir });
  assert.equal(mergedCtx.memory.queryMatchedEvents.length, 1);

  const resetRes = await runCliCommand(['reset', '--name', '新小库'], { dataDirOverride: migratedDir });
  assert.equal(resetRes.ok, true);
  assert.equal(resetRes.companionName, '新小库');
  assert.ok(resetRes.backupFile && fs.existsSync(resetRes.backupFile));
  const afterReset = await runCliCommand(['context'], { dataDirOverride: migratedDir });
  assert.equal(afterReset.isBrandNewCompanion, true);
  assert.equal(afterReset.companion.name, '新小库');

  fs.rmSync(originDir, { recursive: true, force: true });
  fs.rmSync(migratedDir, { recursive: true, force: true });
  fs.rmSync(anotherUserDir, { recursive: true, force: true });
});

test('3. 口语天气事实卡片与标准 MCP JSON-RPC 接口可用', async () => {
  const tempDir = makeTempDir('mcp');
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('geocoding-api.open-meteo.com')) {
      return {
        ok: true,
        json: async () => ({
          results: [{ name: '长沙市', admin1: '湖南省', country: '中国', latitude: 28.2, longitude: 112.97, timezone: 'Asia/Shanghai' }],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        current: { temperature_2m: 16.5, apparent_temperature: 15.2, weather_code: 2, wind_speed_10m: 9.4 },
        daily: {
          time: ['2026-11-25', '2026-11-26'],
          weather_code: [2, 61],
          temperature_2m_min: [11, 9],
          temperature_2m_max: [18, 14],
          precipitation_probability_max: [15, 80],
        },
        hourly: {
          time: ['2026-11-26T19:00', '2026-11-26T21:00'],
          temperature_2m: [11.5, 10.2],
          apparent_temperature: [9.8, 8.6],
          precipitation_probability: [75, 80],
          weather_code: [61, 61],
        },
      }),
    };
  };

  const weatherRes = await runCliCommand(
    ['weather', '--city', '长沙', '--date', '2026-11-26', '--period', '晚上'],
    { dataDirOverride: tempDir, fetchImpl: mockFetch }
  );
  assert.equal(weatherRes.ok, true);
  assert.equal(weatherRes.factCard.location.city, '长沙市');
  assert.equal(weatherRes.factCard.daily.weather, '小雨');
  assert.equal(weatherRes.factCard.period.period, '晚上');
  assert.equal(weatherRes.factCard.period.precipProbMaxPct, 80);

  const { handleJsonRpc } = createMcpDispatcher({ dataDir: tempDir, fetchImpl: mockFetch });
  const initResp = await handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(initResp.result.serverInfo.name, 'xiaoku-companion-skill');

  const listResp = await handleJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.ok(listResp.result.tools.length >= 6);

  const callResp = await handleJsonRpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'companion_update_profile', arguments: { name: '团子', callUser: '小周' } },
  });
  const parsed = JSON.parse(callResp.result.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.profile.name, '团子');

  fs.rmSync(tempDir, { recursive: true, force: true });
});
