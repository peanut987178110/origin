/* =========================================================================
   db.js · 潮汐服务端数据层（Node 22 内置 SQLite，无第三方依赖）
   -------------------------------------------------------------------------
   五张表，对应 JD 里要做的五件事：
     devices     静默注册：一台设备 = 一个匿名账号
     usage       每日额度：按设备、按 UTC 日期计数
     events      埋点：漏斗 / 留存 / A/B 全靠这张表（字段对齐 docs/13）
     memories    长期记忆：服务端抽取，带 due 日期支持"主动关怀"
     experiments A/B 分组：一台设备在一个实验里的组别一旦分定就不变

   隐私取舍（写进 docs/12）：
     · 不存聊天原文。events 里只存长度、角色、耗时这类元数据。
     · 记忆存的是模型抽取的短句，用户可在 App 里逐条删除（DELETE /v1/memory/:id）。
     · 删除账号会级联删掉该设备的全部记忆与事件（DELETE /v1/me）。
   ========================================================================= */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');

function open(file) {
  const db = new DatabaseSync(file || ':memory:');
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS devices (
      device_id   TEXT PRIMARY KEY,
      token_hash  TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL,
      country     TEXT,
      lang        TEXT,
      plan        TEXT NOT NULL DEFAULT 'free',
      age_ok      INTEGER NOT NULL DEFAULT 0,
      persona     TEXT,
      nickname    TEXT
    );

    CREATE TABLE IF NOT EXISTS usage (
      device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
      day       TEXT NOT NULL,
      turns     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (device_id, day)
    );

    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id  TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      ts         TEXT NOT NULL,
      props      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_name_ts ON events(name, ts);
    CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id, ts);

    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id   TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      content     TEXT NOT NULL,
      importance  INTEGER NOT NULL DEFAULT 3,
      due         TEXT,
      followed_up INTEGER NOT NULL DEFAULT 0,
      source      TEXT NOT NULL DEFAULT 'auto',
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mem_device ON memories(device_id);

    CREATE TABLE IF NOT EXISTS experiments (
      device_id  TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
      exp        TEXT NOT NULL,
      variant    TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      PRIMARY KEY (device_id, exp)
    );
  `);
  return db;
}

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);

function makeStore(db) {
  const q = {
    insDevice: db.prepare(`INSERT INTO devices (device_id, token_hash, created_at, country, lang) VALUES (?, ?, ?, ?, ?)`),
    devByToken: db.prepare(`SELECT * FROM devices WHERE token_hash = ?`),
    devById: db.prepare(`SELECT * FROM devices WHERE device_id = ?`),
    updProfile: db.prepare(`UPDATE devices SET lang = COALESCE(?, lang), country = COALESCE(?, country),
                            persona = COALESCE(?, persona), nickname = COALESCE(?, nickname),
                            age_ok = COALESCE(?, age_ok) WHERE device_id = ?`),
    setPlan: db.prepare(`UPDATE devices SET plan = ? WHERE device_id = ?`),
    usageGet: db.prepare(`SELECT turns FROM usage WHERE device_id = ? AND day = ?`),
    usageInc: db.prepare(`INSERT INTO usage (device_id, day, turns) VALUES (?, ?, 1)
                          ON CONFLICT(device_id, day) DO UPDATE SET turns = turns + 1`),
    evIns: db.prepare(`INSERT INTO events (device_id, name, ts, props) VALUES (?, ?, ?, ?)`),
    memIns: db.prepare(`INSERT INTO memories (device_id, type, content, importance, due, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    memList: db.prepare(`SELECT id, type, content, importance, due, followed_up, source, created_at FROM memories WHERE device_id = ? ORDER BY created_at DESC`),
    memDel: db.prepare(`DELETE FROM memories WHERE id = ? AND device_id = ?`),
    memCount: db.prepare(`SELECT COUNT(*) n FROM memories WHERE device_id = ?`),
    memDupe: db.prepare(`SELECT id FROM memories WHERE device_id = ? AND lower(content) = lower(?)`),
    memFollowed: db.prepare(`UPDATE memories SET followed_up = 1 WHERE id = ? AND device_id = ?`),
    expGet: db.prepare(`SELECT variant FROM experiments WHERE device_id = ? AND exp = ?`),
    expIns: db.prepare(`INSERT INTO experiments (device_id, exp, variant, assigned_at) VALUES (?, ?, ?, ?)`),
    delDevice: db.prepare(`DELETE FROM devices WHERE device_id = ?`)
  };

  return {
    db,

    /* 静默注册：返回明文 token 只此一次；库里只存哈希。 */
    register(country, lang) {
      const deviceId = 'd_' + crypto.randomBytes(9).toString('hex');
      const token = crypto.randomBytes(24).toString('base64url');
      q.insDevice.run(deviceId, sha(token), nowIso(), country || null, lang || null);
      return { deviceId, token };
    },

    deviceByToken(token) {
      if (!token) return null;
      return q.devByToken.get(sha(token)) || null;
    },
    device(id) { return q.devById.get(id) || null; },

    updateProfile(id, p) {
      q.updProfile.run(p.lang ?? null, p.country ?? null, p.persona ?? null, p.nickname ?? null,
        p.age_ok === undefined ? null : (p.age_ok ? 1 : 0), id);
    },
    setPlan(id, plan) { q.setPlan.run(plan, id); },

    usedToday(id) { const r = q.usageGet.get(id, today()); return r ? r.turns : 0; },
    countTurn(id) { q.usageInc.run(id, today()); },

    track(id, name, props, ts) {
      q.evIns.run(id, String(name).slice(0, 48), ts || nowIso(), props ? JSON.stringify(props).slice(0, 2000) : null);
    },

    addMemory(id, m, source) {
      if (q.memDupe.get(id, m.content)) return false;           // 同一条事实不重复记
      if (q.memCount.get(id).n >= 200) return false;           // 单人上限，防止无限增长
      q.memIns.run(id, m.type, m.content, m.importance || 3, m.due || null, source || 'auto', nowIso());
      return true;
    },
    memories(id) { return q.memList.all(id); },
    deleteMemory(id, memId) { return q.memDel.run(memId, id).changes > 0; },
    markFollowed(id, memId) { q.memFollowed.run(memId, id); },

    /* A/B：按 device_id 哈希分组，稳定且均匀；第一次查询时落库，之后永远读库里的值。 */
    variant(id, exp, variants) {
      const got = q.expGet.get(id, exp);
      if (got) return got.variant;
      const h = parseInt(sha(id + '|' + exp).slice(0, 8), 16);
      const v = variants[h % variants.length];
      q.expIns.run(id, exp, v, nowIso());
      return v;
    },

    deleteDevice(id) { q.delDevice.run(id); }
  };
}

module.exports = { open, makeStore, sha };
