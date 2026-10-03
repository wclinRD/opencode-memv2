/**
 * SQLite persistence for detmem, built on node:sqlite (DatabaseSync).
 *
 * Why node:sqlite instead of shelling out to the `sqlite3` CLI: the previous
 * implementation wrote `sql` to the CLI's stdin and silently dropped the `params`
 * argument. Unbound `?` placeholders made SQLite insert NULL, so every stored
 * message was garbage and search always returned empty. DatabaseSync binds
 * parameters properly, and avoids one process spawn per query.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { SCHEMA, ftsDrift, migrate } from "./migrate.js";

const DEFAULT_DB_DIR = path.join(os.homedir(), ".opencode-detmem");
export const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, "detmem.sqlite");

/** dbPath -> DatabaseSync. Open once, reused for the process lifetime. */
const handles = new Map();

/** Open (and cache) a database handle, creating the schema on first use. */
export function getDb(dbPath = DEFAULT_DB_PATH) {
  const existing = handles.get(dbPath);
  if (existing) return existing;

  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // setup() runs once per location, so several plugin instances share this file
  // inside one machine — and a second opencode server may hold it too. Without a
  // busy timeout SQLite returns SQLITE_BUSY the instant a writer overlaps, which
  // would abort the capture subscription for the rest of the process.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  handles.set(dbPath, db);
  return db;
}

/**
 * Drop cached handles. Used by tests and on plugin teardown.
 *
 * Handles are keyed by path and shared by every instance, so this closes the
 * handle other live instances are using too. They recover — the next getDb reopens
 * the file — but a caller already holding the handle sees "database is not open",
 * so teardown is not safe to run while another instance is mid-query.
 */
export function closeAll() {
  for (const db of handles.values()) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  handles.clear();
}

/**
 * Insert one message. Idempotent on message_id so repeated session captures
 * (session.step.ended fires several times per turn) cannot duplicate rows.
 *
 * The transcript row and its FTS mirror are written in one transaction. They must
 * land together: if the process died between them the index would be missing a
 * row, and the backfill in migrate.js only repairs an index that is absent or
 * built with the wrong tokenizer — not one that is merely incomplete.
 *
 * @returns {{ stored: boolean, reason?: string, text: string }}
 */
export function storeMessage(dbPath, entry) {
  const { messageId = null, sessionId, title = null, ts, role, content, tool = null, synthetic = false, projectDir = null } = entry;
  const text = String(content || "").trim();
  if (!text) return { stored: false, reason: "empty", text: "" };

  const db = getDb(dbPath);
  const syn = synthetic ? 1 : 0;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO transcripts
       (message_id, session_id, title, ts, role, content, tool, synthetic, project_dir)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Only mirror into FTS when the base row was really inserted, so rowids never
  // accumulate orphans.
  const mirror = db.prepare(
    `INSERT INTO transcripts_fts(rowid, content, session_id, role, ts) VALUES (?, ?, ?, ?, ?)`,
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    const res = insert.run(messageId, sessionId, title, ts, role, text, tool, syn, projectDir);
    if (Number(res.changes) === 0) {
      db.exec("COMMIT");
      return { stored: false, reason: "duplicate", text };
    }
    mirror.run(Number(res.lastInsertRowid), text, sessionId, role, ts);
    db.exec("COMMIT");
  } catch (err) {
    // ROLLBACK can itself throw — on a closed handle, or after a failed COMMIT
    // ("no transaction is active") — and would then replace the real error.
    try {
      db.exec("ROLLBACK");
    } catch {
      /* nothing to roll back */
    }
    throw err;
  }

  return { stored: true, text };
}

/**
 * Escape a value for use inside a LIKE pattern paired with `ESCAPE '\'`.
 *
 * buildLikeNeedle deliberately keeps `_`, and user text can contain `%` too.
 * Unescaped, the needle `a_c` matches `aXc` just as readily as the literal `a_c`.
 */
function likePattern(needle) {
  return `%${String(needle).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Full-text + LIKE search across transcripts and facts.
 *
 * Two passes, concatenated in that order — they are NOT re-sorted together:
 *  1. FTS5 MATCH, ordered by bm25. The expression comes from buildFtsQuery,
 *     which neutralises FTS5 syntax characters, so hostile input degrades to
 *     "no results" instead of throwing.
 *  2. LIKE on the longest run, which is the only way to match terms below the
 *     trigram tokenizer's 3-character minimum, ordered by recency.
 *
 * A LIKE-only hit therefore never outranks an FTS hit however old it is. Keeping
 * the bm25 ordering intact is the point: recomputing it across both passes would
 * require scoring rows the LIKE pass cannot rank.
 */
export function searchMemory(dbPath, query, limit = 8, ftsExpression = null, likeNeedle = null) {
  const empty = { transcripts: [], facts: [] };
  if (!query) return empty;
  const db = getDb(dbPath);

  const seen = new Set();
  // Identity is the transcripts rowid — exposed as `rid` by both passes, since the
  // FTS mirror is keyed on it. session_id+ts is not enough: extractMessage falls
  // back to `new Date().toISOString()` when an entry carries no time.created, so
  // every such entry in one capture shares a millisecond and all but the first
  // would vanish from results.
  const key = (r) => r.rid;
  let transcripts = [];

  if (ftsExpression) {
    try {
      const rows = db
        .prepare(
          `SELECT snippet(transcripts_fts, 0, '【', '】', ' … ', 12) AS snip,
                  transcripts_fts.rowid AS rid, session_id, ts, role
             FROM transcripts_fts
            WHERE transcripts_fts MATCH ?
            ORDER BY bm25(transcripts_fts, 10.0, 1.0, 0.0, 0.0)
            LIMIT ?`,
        )
        .all(ftsExpression, limit);
      for (const r of rows) {
        seen.add(key(r));
        transcripts.push(r);
      }
    } catch (err) {
      console.error("[detmem] FTS query failed:", String(err));
    }
  }

  if (likeNeedle) {
    try {
      const rows = db
        .prepare(
          `SELECT substr(content, 1, 160) AS snip, id AS rid, session_id, ts, role
             FROM transcripts
            WHERE content LIKE ? ESCAPE '\\'
            ORDER BY ts DESC
            LIMIT ?`,
        )
        .all(likePattern(likeNeedle), limit);
      for (const r of rows) {
        if (seen.has(key(r))) continue;
        seen.add(key(r));
        transcripts.push(r);
      }
    } catch (err) {
      console.error("[detmem] transcript LIKE search failed:", String(err));
    }
  }
  transcripts = transcripts.slice(0, limit);

  let facts = [];
  if (likeNeedle) {
    try {
      const pattern = likePattern(likeNeedle);
      facts = db
        .prepare(
          `SELECT kind, key, value, confidence, ts
             FROM facts
            WHERE value LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\'
            ORDER BY confidence DESC, ts DESC
            LIMIT ?`,
        )
        .all(pattern, pattern, limit);
    } catch (err) {
      console.error("[detmem] facts search failed:", String(err));
    }
  }

  return { transcripts, facts };
}

/** Insert rule-extracted facts. Returns how many rows landed. */
export function storeFacts(dbPath, facts, meta = {}) {
  if (!Array.isArray(facts) || facts.length === 0) return 0;
  const db = getDb(dbPath);
  // REPLACE relies on the identity index, so a repeat capture refreshes the
  // existing row (latest value and timestamp win) instead of appending a copy.
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO facts (kind, key, value, scope, project_dir, confidence, ts, sources)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ts = new Date().toISOString();
  const scope = meta.scope || "project";

  // One transaction, like storeMessage: a capture refreshes a whole fact set, and
  // a crash mid-loop would otherwise leave some rows from this capture and some
  // from the previous one, with nothing recording that it happened.
  db.exec("BEGIN IMMEDIATE");
  let n = 0;
  try {
    for (const f of facts) {
      stmt.run(
        f.kind,
        String(f.key).slice(0, 80),
        f.value,
        scope,
        meta.projectDir || null,
        typeof f.confidence === "number" ? f.confidence : 0.8,
        ts,
        meta.sessionId || null,
      );
      n++;
    }
    db.exec("COMMIT");
  } catch (err) {
    // ROLLBACK can itself throw on a closed handle, which would mask the real error.
    try {
      db.exec("ROLLBACK");
    } catch {
      /* handle already gone */
    }
    throw err;
  }
  return n;
}

/** List stored facts, optionally filtered by kind. */
export function listFacts(dbPath, options) {
  let { kind = null, limit = 20 } = options || {};
  // Model-supplied arguments reach SQLite as bound values, and a non-string or
  // fractional one comes back as "datatype mismatch". Anything unusable becomes
  // "no filter" / the default page size rather than an error the user sees.
  if (typeof kind !== "string" || kind === "") kind = null;
  if (!Number.isInteger(limit) || limit < 1) limit = 20;
  const db = getDb(dbPath);
  const base = `SELECT id, kind, key, value, scope, confidence, ts FROM facts`;
  if (kind) {
    return db.prepare(`${base} WHERE kind = ? ORDER BY ts DESC LIMIT ?`).all(kind, limit);
  }
  return db.prepare(`${base} ORDER BY ts DESC LIMIT ?`).all(limit);
}

/** Row counts, plus an FTS/transcripts consistency check. */
export function stats(dbPath) {
  const db = getDb(dbPath);
  const count = (sql) => {
    const row = db.prepare(sql).get();
    return row ? Number(row.c) : 0;
  };
  const transcripts = count("SELECT COUNT(*) AS c FROM transcripts");
  const fts = count("SELECT COUNT(*) AS c FROM transcripts_fts");
  const facts = count("SELECT COUNT(*) AS c FROM facts");
  // Same helper migrate repairs with, so `inSync` can never disagree with the fix.
  const { orphanFts, missingFts } = ftsDrift(db);
  return { transcripts, fts, facts, orphanFts, missingFts, inSync: orphanFts === 0 && missingFts === 0, dbPath };
}
