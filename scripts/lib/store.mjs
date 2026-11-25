/**
 * store.mjs — 独立会话伴侣本地存储引擎（node:sqlite + FTS5 + 档案定制 + 胶囊导入导出）
 *
 * 设计要点：
 * 1. 零外部依赖：仅使用 Node 内置 node:sqlite、node:fs、node:crypto。
 * 2. 开箱空白：首次运行自动从 resources/persona.template.json 初始化专属本地档案，无任何历史聊天脏数据。
 * 3. 自由改名与专属演化：名字、称呼、兴趣、边界、事件进展、情绪余波、虚拟日常、共创项目全部落在本地 data/。
 * 4. 可校验胶囊导出/导入：支持 SHA-256 完整性校验，支持 replace（整包迁移）和 merge（增量合并）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

const DAY_MS = 86_400_000;
export const CAPSULE_FORMAT = 'companion-skill-capsule-v1';

export const EMOTION_EFFECTS = Object.freeze({
  warmth:     { value:  0.32, tailHours: 24, label: '温和愉快', reason: '刚聊得投缘' },
  gratitude:  { value:  0.38, tailHours: 36, label: '心里挺暖', reason: '被认真惦记或道谢' },
  shared_joy: { value:  0.48, tailHours: 30, label: '雀跃',     reason: '一起高兴的事成了' },
  worry:      { value: -0.22, tailHours: 36, label: '有点挂心', reason: '惦记着对方提到的难处' },
  friction:   { value: -0.42, tailHours: 48, label: '有点闷',   reason: '刚才话赶话有点不痛快' },
  repair:     { value:  0.30, tailHours: 24, label: '释然',     reason: '误会说开翻篇了' },
});

export const VALID_PHASES = Object.freeze(['planned', 'in_progress', 'completed', 'cancelled']);
export const VALID_DOMAINS = Object.freeze(['reality', 'fictional-project']);
export const VALID_PROJECT_STATUS = Object.freeze(['active', 'paused', 'completed', 'cancelled']);

export function localDateString(ms = Date.now()) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function uniqueStrings(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const s = String(raw ?? '').trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function deterministicDailyFallback(profile, day) {
  const interests = profile?.worldSeed?.dailyInterests || [];
  const defaultMood = profile?.worldSeed?.defaultMood || '平淡';
  const defaultEnergy = profile?.worldSeed?.defaultEnergy || '平稳';
  let h = 0;
  for (let i = 0; i < day.length; i++) h = (h * 31 + day.charCodeAt(i)) | 0;
  const picked = interests.length ? interests[Math.abs(h) % interests.length] : null;
  const summary = picked
    ? `今天抽空在弄「${picked}」，顺手记了两笔小想法。`
    : '今天安安静静待着，按自己的节奏打发时间。';
  return { mood: defaultMood, energy: defaultEnergy, summary, arc: picked || '' };
}

function materializeEvent(eventId, domain, history) {
  const facts = {};
  let title = '';
  let phase = 'planned';
  for (const patch of history) {
    if (patch.title) title = patch.title;
    if (patch.phase) phase = patch.phase;
    if (patch.facts && typeof patch.facts === 'object') {
      for (const [k, v] of Object.entries(patch.facts)) {
        if (v === null) delete facts[k];
        else facts[k] = { value: v, quote: patch.quote, at: patch.at };
      }
    }
  }
  const first = history[0];
  const latest = history[history.length - 1];
  return {
    eventId,
    domain,
    title,
    phase,
    facts,
    history,
    quote: latest.quote,
    createdAt: first.at,
    updatedAt: latest.at,
  };
}

export function openLocalCompanion({ skillRoot, dataDir = null } = {}) {
  if (!skillRoot) throw new Error('skillRoot is required');
  const templatePath = path.join(skillRoot, 'resources', 'persona.template.json');
  const resolvedDataDir = dataDir ? path.resolve(dataDir) : path.join(skillRoot, 'data');
  const profilePath = path.join(resolvedDataDir, 'profile.json');
  const dbPath = path.join(resolvedDataDir, 'memory.sqlite');
  const backupDir = path.join(resolvedDataDir, 'backups');

  fs.mkdirSync(resolvedDataDir, { recursive: true });

  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const isFirstInit = !fs.existsSync(profilePath);

  function loadProfile() {
    if (!fs.existsSync(profilePath)) {
      const fresh = {
        ...structuredClone(template),
        id: `companion-${randomUUID().slice(0, 8)}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      fs.writeFileSync(profilePath, JSON.stringify(fresh, null, 2) + '\n', 'utf8');
      return fresh;
    }
    const raw = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    return {
      ...structuredClone(template),
      ...raw,
      voice: { ...structuredClone(template.voice), ...(raw.voice || {}) },
      worldSeed: { ...structuredClone(template.worldSeed), ...(raw.worldSeed || {}) },
      appearance: { ...structuredClone(template.appearance), ...(raw.appearance || {}) },
      userProfile: { ...structuredClone(template.userProfile), ...(raw.userProfile || {}) },
    };
  }

  function saveProfile(nextProfile) {
    const normalized = {
      ...nextProfile,
      aliases: uniqueStrings([nextProfile.name, ...(nextProfile.aliases || [])]),
      updatedAt: Date.now(),
    };
    const tmp = `${profilePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, profilePath);
    return normalized;
  }

  let profile = loadProfile();
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      eventId TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      phase TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      record TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS event_search USING fts5(eventId UNINDEXED, body);
    CREATE TABLE IF NOT EXISTS emotions (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      eventId TEXT,
      resolveId TEXT,
      quote TEXT NOT NULL,
      record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_life (
      day TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shared_projects (
      projectId TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hangups (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_digests (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      summary TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tombstones (
      kind TEXT NOT NULL,
      targetId TEXT NOT NULL,
      at INTEGER NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (kind, targetId)
    );
  `);

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function getBarrierAt() {
    const row = db.prepare("SELECT value FROM meta WHERE key='forget_barrier_at'").get();
    return row ? Number(row.value) : -1;
  }

  function setBarrierAt(at) {
    const prev = getBarrierAt();
    const next = Math.max(prev, at);
    db.prepare("INSERT INTO meta(key,value) VALUES ('forget_barrier_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(next));
    return next;
  }

  function isBlocked(kind, id) {
    if (!id) return false;
    return !!db.prepare('SELECT 1 FROM tombstones WHERE kind=? AND targetId=?').get(kind, id);
  }

  function indexEvent(record) {
    db.prepare('DELETE FROM event_search WHERE eventId=?').run(record.eventId);
    const body = [
      record.title,
      ...Object.entries(record.facts || {}).map(([k, v]) => `${k}:${JSON.stringify(v.value)}`),
      ...(record.history || []).map((p) => p.quote || ''),
    ].join('\n');
    db.prepare('INSERT INTO event_search(eventId, body) VALUES (?, ?)').run(record.eventId, body);
  }

  function rebuildSearchIndex() {
    db.exec('DELETE FROM event_search');
    const rows = db.prepare('SELECT record FROM events').all();
    for (const r of rows) {
      indexEvent(JSON.parse(r.record));
    }
  }

  function updateProfile(changes = {}) {
    const next = structuredClone(profile);
    if (changes.name && String(changes.name).trim()) {
      const oldName = next.name;
      next.name = String(changes.name).trim();
      next.aliases = uniqueStrings([next.name, ...(changes.keepOldAlias ? [oldName] : []), ...(changes.aliases || [])]);
    } else if (Array.isArray(changes.aliases) && changes.aliases.length) {
      next.aliases = uniqueStrings([next.name, ...next.aliases, ...changes.aliases]);
    }
    if (changes.gender) next.gender = String(changes.gender).trim();
    if (changes.bio) next.bio = String(changes.bio).trim();
    if (changes.appearanceSummary) next.appearance.summary = String(changes.appearanceSummary).trim();
    if (Array.isArray(changes.appearanceTraits) && changes.appearanceTraits.length) {
      next.appearance.traits = uniqueStrings(changes.appearanceTraits);
    }
    if (Array.isArray(changes.addTraits) && changes.addTraits.length) {
      next.voice.traits = uniqueStrings([...(next.voice.traits || []), ...changes.addTraits]);
    }
    if (Array.isArray(changes.addInterests) && changes.addInterests.length) {
      next.worldSeed.dailyInterests = uniqueStrings([...(next.worldSeed.dailyInterests || []), ...changes.addInterests]);
    }
    if (changes.callUser !== undefined && changes.callUser !== null) {
      next.userProfile.preferredCallName = String(changes.callUser).trim();
    }
    if (Array.isArray(changes.addUserBoundaries) && changes.addUserBoundaries.length) {
      next.userProfile.boundaries = uniqueStrings([...(next.userProfile.boundaries || []), ...changes.addUserBoundaries]);
    }
    if (Array.isArray(changes.addUserPreferences) && changes.addUserPreferences.length) {
      next.userProfile.preferences = uniqueStrings([...(next.userProfile.preferences || []), ...changes.addUserPreferences]);
    }
    if (Array.isArray(changes.addInsideJokes) && changes.addInsideJokes.length) {
      next.userProfile.insideJokes = uniqueStrings([...(next.userProfile.insideJokes || []), ...changes.addInsideJokes]);
    }
    profile = saveProfile(next);
    return profile;
  }

  function ensureDailyLife({ day = localDateString(), mood, energy, summary, arc, force = false, now = Date.now() } = {}) {
    const existingRow = db.prepare('SELECT record FROM daily_life WHERE day=?').get(day);
    if (existingRow && !force && !summary && !mood && !energy && !arc) {
      return { updated: false, daily: JSON.parse(existingRow.record) };
    }
    const prev = existingRow ? JSON.parse(existingRow.record) : null;
    const fallback = deterministicDailyFallback(profile, day);
    const record = {
      day,
      mood: mood || prev?.mood || fallback.mood,
      energy: energy || prev?.energy || fallback.energy,
      summary: summary || prev?.summary || fallback.summary,
      arc: arc !== undefined ? arc : (prev?.arc ?? fallback.arc),
      at: now,
    };
    db.prepare(`INSERT INTO daily_life(day, at, record) VALUES (?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET at=excluded.at, record=excluded.record`)
      .run(day, now, JSON.stringify(record));
    return { updated: true, daily: record };
  }

  function upsertEvent({
    eventId = null,
    title,
    phase = 'planned',
    domain = 'reality',
    facts = {},
    quote = '',
    at = Date.now(),
  } = {}) {
    if (!VALID_DOMAINS.includes(domain)) throw new Error(`Invalid domain: ${domain}`);
    if (!VALID_PHASES.includes(phase)) throw new Error(`Invalid phase: ${phase}`);

    // 若未传 eventId，尝试匹配同标题同领域的未完结事件以便自然续接进展
    let resolvedId = eventId ? String(eventId).trim() : '';
    if (!resolvedId && title) {
      const match = db.prepare(`SELECT eventId, record FROM events WHERE domain=? AND phase NOT IN ('completed','cancelled')`)
        .all(domain)
        .map((r) => JSON.parse(r.record))
        .find((r) => r.title === String(title).trim());
      if (match) resolvedId = match.eventId;
    }
    if (!resolvedId) resolvedId = `evt-${randomUUID().slice(0, 8)}`;
    if (isBlocked('event', resolvedId) || at <= getBarrierAt()) return null;

    const existing = db.prepare('SELECT record FROM events WHERE eventId=?').get(resolvedId);
    if (!existing && (!title || !String(title).trim())) {
      throw new Error('新建事件必须提供 title');
    }
    const history = existing ? JSON.parse(existing.record).history : [];
    const patch = {
      at,
      ...(title ? { title: String(title).trim() } : {}),
      ...(phase ? { phase } : {}),
      facts: facts && typeof facts === 'object' && !Array.isArray(facts) ? facts : {},
      quote: String(quote || title || '').trim(),
    };
    history.push(patch);
    history.sort((a, b) => a.at - b.at);

    const record = materializeEvent(resolvedId, domain, history);
    db.prepare(`INSERT INTO events(eventId, domain, phase, updatedAt, record) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(eventId) DO UPDATE SET domain=excluded.domain, phase=excluded.phase, updatedAt=excluded.updatedAt, record=excluded.record`)
      .run(resolvedId, domain, record.phase, record.updatedAt, JSON.stringify(record));
    indexEvent(record);
    return record;
  }

  function searchEvents({ query = '', domain = null, includeClosed = false, limit = 12 } = {}) {
    const floor = getBarrierAt();
    const clauses = ['e.updatedAt > ?'];
    const args = [floor];
    if (domain) {
      clauses.push('e.domain = ?');
      args.push(domain);
    }
    if (!includeClosed) {
      clauses.push("e.phase NOT IN ('completed', 'cancelled')");
    }
    const q = String(query || '').trim();
    if (q) {
      clauses.push(`(e.eventId IN (SELECT eventId FROM event_search WHERE event_search MATCH ?)
        OR instr(lower(e.record), lower(?)) > 0)`);
      args.push('"' + q.replaceAll('"', '""') + '"', q);
    }
    const sql = `SELECT e.record FROM events e WHERE ${clauses.join(' AND ')} ORDER BY e.updatedAt DESC LIMIT ?`;
    return db.prepare(sql).all(...args, limit).map((r) => JSON.parse(r.record)).filter((r) => !isBlocked('event', r.eventId));
  }

  function recordEmotion({ kind, quote, eventId = null, resolveId = null, at = Date.now() } = {}) {
    if (!Object.hasOwn(EMOTION_EFFECTS, kind)) {
      throw new Error(`无效情绪类型: ${kind}（支持: ${Object.keys(EMOTION_EFFECTS).join(', ')}）`);
    }
    if (at <= getBarrierAt()) return null;
    const id = `emo-${randomUUID().slice(0, 8)}`;
    const record = { id, at, kind, eventId, resolveId: kind === 'repair' ? resolveId : null, quote: String(quote || kind).trim() };
    db.prepare('INSERT INTO emotions(id, at, kind, eventId, resolveId, quote, record) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, at, kind, eventId, record.resolveId, record.quote, JSON.stringify(record));
    return record;
  }

  function readEmotionSnapshot(now = Date.now()) {
    const floor = getBarrierAt();
    const rows = db.prepare('SELECT record FROM emotions WHERE at > ? AND at <= ? ORDER BY at ASC')
      .all(floor, now)
      .map((r) => JSON.parse(r.record))
      .filter((r) => !isBlocked('event', r.eventId));

    const resolvedIds = new Set(rows.filter((r) => r.kind === 'repair' && r.resolveId).map((r) => r.resolveId));
    const positive = rows.filter((r) => r.kind !== 'friction');
    const activeDays = new Set(positive.map((r) => localDateString(r.at)));
    const eventCount = db.prepare('SELECT count(*) AS c FROM events WHERE updatedAt > ?').get(floor)?.c || 0;

    const todayDaily = ensureDailyLife({ day: localDateString(now), now }).daily;
    const snapshot = {
      mood: todayDaily.mood,
      energy: todayDaily.energy,
      reason: todayDaily.summary,
      shortTerm: null,
      aftereffects: [],
      relationship: {
        stage: activeDays.size >= 3 || (activeDays.size >= 2 && eventCount >= 3)
          ? '熟稔老友'
          : (eventCount >= 1 || positive.length >= 1 ? '渐熟朋友' : '刚认识'),
        activeDays: activeDays.size,
        recordedEvents: eventCount,
        recentBasis: positive.slice(-3).map((r) => ({ kind: r.kind, quote: r.quote, day: localDateString(r.at) })),
      },
    };

    let strongest = 0;
    let dominant = null;
    for (const row of rows) {
      if (resolvedIds.has(row.id)) continue;
      const age = Math.max(0, now - row.at);
      const eff = EMOTION_EFFECTS[row.kind];
      if (!eff) continue;
      const shortVal = Math.abs(eff.value) * 0.5 ** (age / (30 * 60_000));
      if (shortVal >= 0.05 && shortVal > strongest) {
        strongest = shortVal;
        dominant = { row, eff, intensity: Math.round(Math.min(1, shortVal) * 100) };
      }
      if (age <= 7 * DAY_MS) {
        const tailWeight = 0.5 ** (age / (eff.tailHours * 3_600_000));
        if (tailWeight >= 0.08) {
          snapshot.aftereffects.push({
            id: row.id,
            kind: row.kind,
            basis: row.quote,
            day: localDateString(row.at),
          });
        }
      }
    }
    snapshot.aftereffects = snapshot.aftereffects.slice(-3);
    if (dominant) {
      snapshot.mood = dominant.eff.label;
      snapshot.reason = dominant.eff.reason;
      snapshot.shortTerm = {
        kind: dominant.row.kind,
        intensity: dominant.intensity,
        basis: dominant.row.quote,
      };
    }
    return snapshot;
  }

  function upsertHangup({ id = null, topic, status = 'open', eventId = null, at = Date.now() } = {}) {
    let resolvedId = id || '';
    if (!resolvedId && topic) {
      const found = db.prepare("SELECT id, record FROM hangups WHERE status='open'").all()
        .map((r) => JSON.parse(r.record))
        .find((r) => r.topic === String(topic).trim());
      if (found) resolvedId = found.id;
    }
    if (!resolvedId) resolvedId = `hng-${randomUUID().slice(0, 8)}`;
    const prevRow = db.prepare('SELECT record FROM hangups WHERE id=?').get(resolvedId);
    const prev = prevRow ? JSON.parse(prevRow.record) : null;
    const record = {
      id: resolvedId,
      topic: String(topic || prev?.topic || '').trim(),
      status,
      eventId: eventId ?? prev?.eventId ?? null,
      createdAt: prev?.createdAt ?? at,
      updatedAt: at,
    };
    db.prepare(`INSERT INTO hangups(id, status, updatedAt, record) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, updatedAt=excluded.updatedAt, record=excluded.record`)
      .run(resolvedId, status, at, JSON.stringify(record));
    return record;
  }

  function upsertProject({ projectId = null, name, status = 'active', stage = '构思中', settings = {}, note = '', at = Date.now() } = {}) {
    if (!VALID_PROJECT_STATUS.includes(status)) throw new Error(`Invalid project status: ${status}`);
    let resolvedId = projectId ? String(projectId).trim() : '';
    if (!resolvedId && name) {
      const existingByName = db.prepare('SELECT record FROM shared_projects').all()
        .map((r) => JSON.parse(r.record))
        .find((r) => r.name === String(name).trim());
      if (existingByName) resolvedId = existingByName.projectId;
    }
    if (!resolvedId) resolvedId = `prj-${randomUUID().slice(0, 8)}`;
    const prevRow = db.prepare('SELECT record FROM shared_projects WHERE projectId=?').get(resolvedId);
    const prev = prevRow ? JSON.parse(prevRow.record) : null;
    const resolvedName = String(name || prev?.name || '').trim();
    if (!resolvedName) throw new Error('共创项目需要提供名称 name');
    const beats = [...(prev?.beats || [])];
    if (note && String(note).trim()) {
      beats.push({ at, stage, note: String(note).trim() });
    }
    const record = {
      projectId: resolvedId,
      name: resolvedName,
      status,
      stage: stage || prev?.stage || '构思中',
      settings: { ...(prev?.settings || {}), ...(settings || {}) },
      beats: beats.slice(-20),
      createdAt: prev?.createdAt ?? at,
      updatedAt: at,
    };
    db.prepare(`INSERT INTO shared_projects(projectId, status, updatedAt, record) VALUES (?, ?, ?, ?)
      ON CONFLICT(projectId) DO UPDATE SET status=excluded.status, updatedAt=excluded.updatedAt, record=excluded.record`)
      .run(resolvedId, status, at, JSON.stringify(record));
    return record;
  }

  function addSessionDigest(summary, at = Date.now()) {
    const s = String(summary || '').trim();
    if (!s) return null;
    const id = `dig-${randomUUID().slice(0, 8)}`;
    db.prepare('INSERT INTO session_digests(id, at, summary) VALUES (?, ?, ?)').run(id, at, s);
    return { id, at, day: localDateString(at), summary: s };
  }

  function forget({ eventId = null, query = '', all = false, reason = 'user-requested', at = Date.now() } = {}) {
    return tx(() => {
      if (all) {
        const barrierAt = setBarrierAt(at);
        db.exec('DELETE FROM events; DELETE FROM event_search; DELETE FROM emotions; DELETE FROM shared_projects; DELETE FROM hangups; DELETE FROM session_digests;');
        profile = saveProfile({
          ...profile,
          userProfile: structuredClone(template.userProfile),
        });
        return { mode: 'all', barrierAt, forgottenCount: -1 };
      }

      const targets = new Set();
      if (eventId) targets.add(String(eventId).trim());
      if (query && String(query).trim()) {
        const matched = searchEvents({ query, includeClosed: true, limit: 50 });
        for (const ev of matched) targets.add(ev.eventId);
      }
      let count = 0;
      for (const id of targets) {
        const del = db.prepare('DELETE FROM events WHERE eventId=?').run(id);
        db.prepare('DELETE FROM event_search WHERE eventId=?').run(id);
        db.prepare("DELETE FROM hangups WHERE json_extract(record, '$.eventId')=?").run(id);
        db.prepare('INSERT OR REPLACE INTO tombstones(kind, targetId, at, reason) VALUES (?, ?, ?, ?)')
          .run('event', id, at, reason);
        if (del.changes > 0) count++;
      }
      return { mode: 'targeted', forgottenIds: [...targets], forgottenCount: count };
    });
  }

  function buildSessionContext({ query = '', now = Date.now() } = {}) {
    const floor = getBarrierAt();
    const dailyOut = ensureDailyLife({ day: localDateString(now), now });
    const emotion = readEmotionSnapshot(now);
    const activeEvents = searchEvents({ query: '', includeClosed: false, limit: 8 });
    const matchedEvents = query ? searchEvents({ query, includeClosed: true, limit: 8 }) : [];
    const openHangups = db.prepare("SELECT record FROM hangups WHERE status='open' AND updatedAt > ? ORDER BY updatedAt DESC LIMIT 5")
      .all(floor).map((r) => JSON.parse(r.record));
    const activeProjects = db.prepare("SELECT record FROM shared_projects WHERE status='active' AND updatedAt > ? ORDER BY updatedAt DESC LIMIT 5")
      .all(floor).map((r) => JSON.parse(r.record));
    const recentDigests = db.prepare('SELECT id, at, summary FROM session_digests WHERE at > ? ORDER BY at DESC LIMIT 4')
      .all(floor).map((r) => ({ id: r.id, day: localDateString(r.at), summary: r.summary }));
    const recentDaily = db.prepare('SELECT record FROM daily_life ORDER BY day DESC LIMIT 3')
      .all().map((r) => JSON.parse(r.record));

    const totalInteractions = activeEvents.length + recentDigests.length;
    return {
      isBrandNewCompanion: isFirstInit || (totalInteractions === 0 && emotion.relationship.recordedEvents === 0),
      today: localDateString(now),
      companion: {
        id: profile.id,
        name: profile.name,
        gender: profile.gender,
        aliases: profile.aliases,
        bio: profile.bio,
        appearance: profile.appearance,
        voice: profile.voice,
        interests: profile.worldSeed?.dailyInterests || [],
      },
      user: profile.userProfile,
      state: {
        mood: emotion.mood,
        energy: emotion.energy,
        moodReason: emotion.reason,
        shortTermReaction: emotion.shortTerm,
        unresolvedAftereffects: emotion.aftereffects,
        relationship: emotion.relationship,
      },
      dailyLife: {
        today: dailyOut.daily,
        recentDays: recentDaily,
      },
      memory: {
        openHangups,
        activeEvents: activeEvents.map((e) => ({
          eventId: e.eventId,
          domain: e.domain,
          title: e.title,
          phase: e.phase,
          facts: Object.fromEntries(Object.entries(e.facts || {}).map(([k, v]) => [k, v.value])),
          latestQuote: e.quote,
          updatedDay: localDateString(e.updatedAt),
        })),
        queryMatchedEvents: matchedEvents.map((e) => ({
          eventId: e.eventId,
          domain: e.domain,
          title: e.title,
          phase: e.phase,
          facts: Object.fromEntries(Object.entries(e.facts || {}).map(([k, v]) => [k, v.value])),
          latestQuote: e.quote,
          updatedDay: localDateString(e.updatedAt),
        })),
        activeProjects,
        recentSessionDigests: recentDigests,
      },
    };
  }

  function exportCapsule({ note = '' } = {}) {
    const payload = {
      profile,
      forgetBarrierAt: getBarrierAt(),
      events: db.prepare('SELECT record FROM events ORDER BY updatedAt ASC').all().map((r) => JSON.parse(r.record)),
      emotions: db.prepare('SELECT record FROM emotions ORDER BY at ASC').all().map((r) => JSON.parse(r.record)),
      dailyLife: db.prepare('SELECT record FROM daily_life ORDER BY day ASC').all().map((r) => JSON.parse(r.record)),
      sharedProjects: db.prepare('SELECT record FROM shared_projects ORDER BY updatedAt ASC').all().map((r) => JSON.parse(r.record)),
      hangups: db.prepare('SELECT record FROM hangups ORDER BY updatedAt ASC').all().map((r) => JSON.parse(r.record)),
      sessionDigests: db.prepare('SELECT id, at, summary FROM session_digests ORDER BY at ASC').all(),
      tombstones: db.prepare('SELECT kind, targetId, at, reason FROM tombstones ORDER BY at ASC').all(),
    };
    const sha256 = stableHash(payload);
    return {
      format: CAPSULE_FORMAT,
      exportedAt: new Date().toISOString(),
      companionName: profile.name,
      note: String(note || '').trim(),
      counts: {
        events: payload.events.length,
        emotions: payload.emotions.length,
        dailyLife: payload.dailyLife.length,
        sharedProjects: payload.sharedProjects.length,
        hangups: payload.hangups.length,
        sessionDigests: payload.sessionDigests.length,
      },
      integrity: { algorithm: 'sha256', sha256 },
      payload,
    };
  }

  function saveAutoBackup(prefix = 'auto') {
    const counts = db.prepare('SELECT count(*) AS c FROM events').get()?.c || 0;
    const digests = db.prepare('SELECT count(*) AS c FROM session_digests').get()?.c || 0;
    if (counts === 0 && digests === 0 && profile.name === template.name) return null;
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(backupDir, `${prefix}-${stamp}.capsule.json`);
    fs.writeFileSync(file, JSON.stringify(exportCapsule({ note: `auto-backup:${prefix}` }), null, 2) + '\n', 'utf8');
    return file;
  }

  function importCapsule(capsule, { mode = 'replace', skipVerify = false } = {}) {
    if (!capsule || capsule.format !== CAPSULE_FORMAT || !capsule.payload) {
      throw new Error(`不支持的记忆胶囊格式（期望 ${CAPSULE_FORMAT}）`);
    }
    if (!skipVerify) {
      const expected = capsule.integrity?.sha256;
      const actual = stableHash(capsule.payload);
      if (!expected || expected !== actual) {
        throw new Error('记忆胶囊 SHA-256 完整性校验未通过，文件可能已损坏或被非预期篡改（如系手动编辑可加 --skip-verify）');
      }
    }
    if (!['replace', 'merge'].includes(mode)) {
      throw new Error(`未知导入模式: ${mode}（支持 replace 或 merge）`);
    }

    const backupFile = saveAutoBackup(`pre-import-${mode}`);
    const p = capsule.payload;

    tx(() => {
      if (mode === 'replace') {
        db.exec('DELETE FROM meta; DELETE FROM events; DELETE FROM event_search; DELETE FROM emotions; DELETE FROM daily_life; DELETE FROM shared_projects; DELETE FROM hangups; DELETE FROM session_digests; DELETE FROM tombstones;');
        if (typeof p.forgetBarrierAt === 'number' && p.forgetBarrierAt >= 0) {
          setBarrierAt(p.forgetBarrierAt);
        }
        profile = saveProfile({
          ...structuredClone(template),
          ...(p.profile || {}),
        });
      } else if (p.profile) {
        // merge 模式下合并用户画像、兴趣和特征，若本地还是默认名且导入包有自定义名字则采纳
        updateProfile({
          ...(profile.name === template.name && p.profile.name ? { name: p.profile.name, aliases: p.profile.aliases } : { aliases: p.profile.aliases }),
          callUser: profile.userProfile?.preferredCallName || p.profile.userProfile?.preferredCallName || '',
          addTraits: p.profile.voice?.traits || [],
          addInterests: p.profile.worldSeed?.dailyInterests || [],
          addUserBoundaries: p.profile.userProfile?.boundaries || [],
          addUserPreferences: p.profile.userProfile?.preferences || [],
          addInsideJokes: p.profile.userProfile?.insideJokes || [],
        });
      }

      for (const t of p.tombstones || []) {
        db.prepare('INSERT OR REPLACE INTO tombstones(kind, targetId, at, reason) VALUES (?, ?, ?, ?)')
          .run(t.kind, t.targetId, t.at, t.reason || 'imported');
      }
      for (const ev of p.events || []) {
        if (isBlocked('event', ev.eventId)) continue;
        const cur = db.prepare('SELECT updatedAt, record FROM events WHERE eventId=?').get(ev.eventId);
        if (!cur) {
          db.prepare('INSERT INTO events(eventId, domain, phase, updatedAt, record) VALUES (?, ?, ?, ?, ?)')
            .run(ev.eventId, ev.domain || 'reality', ev.phase || 'planned', ev.updatedAt || Date.now(), JSON.stringify(ev));
        } else if (mode === 'merge') {
          const prevRec = JSON.parse(cur.record);
          const mergedHistory = [...(prevRec.history || []), ...(ev.history || [])];
          const dedup = [];
          const seen = new Set();
          for (const item of mergedHistory.sort((a, b) => a.at - b.at)) {
            const k = JSON.stringify(item);
            if (!seen.has(k)) { seen.add(k); dedup.push(item); }
          }
          const nextRec = materializeEvent(ev.eventId, ev.domain || prevRec.domain, dedup);
          db.prepare('UPDATE events SET phase=?, updatedAt=?, record=? WHERE eventId=?')
            .run(nextRec.phase, nextRec.updatedAt, JSON.stringify(nextRec), ev.eventId);
        }
      }
      for (const em of p.emotions || []) {
        db.prepare('INSERT OR IGNORE INTO emotions(id, at, kind, eventId, resolveId, quote, record) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(em.id, em.at, em.kind, em.eventId || null, em.resolveId || null, em.quote || '', JSON.stringify(em));
      }
      for (const dl of p.dailyLife || []) {
        db.prepare(`INSERT INTO daily_life(day, at, record) VALUES (?, ?, ?)
          ON CONFLICT(day) DO UPDATE SET at=excluded.at, record=excluded.record WHERE excluded.at >= daily_life.at`)
          .run(dl.day, dl.at || Date.now(), JSON.stringify(dl));
      }
      for (const prj of p.sharedProjects || []) {
        db.prepare(`INSERT INTO shared_projects(projectId, status, updatedAt, record) VALUES (?, ?, ?, ?)
          ON CONFLICT(projectId) DO UPDATE SET status=excluded.status, updatedAt=excluded.updatedAt, record=excluded.record WHERE excluded.updatedAt >= shared_projects.updatedAt`)
          .run(prj.projectId, prj.status || 'active', prj.updatedAt || Date.now(), JSON.stringify(prj));
      }
      for (const h of p.hangups || []) {
        db.prepare(`INSERT INTO hangups(id, status, updatedAt, record) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status=excluded.status, updatedAt=excluded.updatedAt, record=excluded.record WHERE excluded.updatedAt >= hangups.updatedAt`)
          .run(h.id, h.status || 'open', h.updatedAt || Date.now(), JSON.stringify(h));
      }
      for (const dig of p.sessionDigests || []) {
        db.prepare('INSERT OR IGNORE INTO session_digests(id, at, summary) VALUES (?, ?, ?)')
          .run(dig.id, dig.at, dig.summary);
      }
      rebuildSearchIndex();
    });

    return {
      ok: true,
      mode,
      companionName: profile.name,
      backupFile,
      importedCounts: capsule.counts,
    };
  }

  function resetToBlank({ newName = '' } = {}) {
    const backupFile = saveAutoBackup('pre-reset');
    tx(() => {
      db.exec('DELETE FROM meta; DELETE FROM events; DELETE FROM event_search; DELETE FROM emotions; DELETE FROM daily_life; DELETE FROM shared_projects; DELETE FROM hangups; DELETE FROM session_digests; DELETE FROM tombstones;');
    });
    const fresh = {
      ...structuredClone(template),
      id: `companion-${randomUUID().slice(0, 8)}`,
      ...(newName && String(newName).trim() ? { name: String(newName).trim(), aliases: [String(newName).trim()] } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    profile = saveProfile(fresh);
    return { ok: true, companionName: profile.name, backupFile };
  }

  function getStatusSummary() {
    const counts = {
      events: db.prepare('SELECT count(*) AS c FROM events').get()?.c || 0,
      emotions: db.prepare('SELECT count(*) AS c FROM emotions').get()?.c || 0,
      dailyLife: db.prepare('SELECT count(*) AS c FROM daily_life').get()?.c || 0,
      sharedProjects: db.prepare('SELECT count(*) AS c FROM shared_projects').get()?.c || 0,
      openHangups: db.prepare("SELECT count(*) AS c FROM hangups WHERE status='open'").get()?.c || 0,
      sessionDigests: db.prepare('SELECT count(*) AS c FROM session_digests').get()?.c || 0,
    };
    return {
      dataDir: resolvedDataDir,
      dbPath,
      profilePath,
      companion: {
        id: profile.id,
        name: profile.name,
        aliases: profile.aliases,
        preferredUserCallName: profile.userProfile?.preferredCallName || '',
      },
      counts,
    };
  }

  function close() {
    db.close();
  }

  return {
    get profile() { return profile; },
    dataDir: resolvedDataDir,
    updateProfile,
    ensureDailyLife,
    upsertEvent,
    searchEvents,
    recordEmotion,
    readEmotionSnapshot,
    upsertHangup,
    upsertProject,
    addSessionDigest,
    forget,
    buildSessionContext,
    exportCapsule,
    importCapsule,
    resetToBlank,
    getStatusSummary,
    close,
  };
}
