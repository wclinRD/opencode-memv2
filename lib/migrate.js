/**
 * Schema definition and forward-only migrations for the detmem database.
 *
 * Kept separate from lib/sqlite.js so the query surface and the schema surface
 * can change independently. Everything here runs once per database file, the
 * first time it is opened in a process.
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  session_id TEXT NOT NULL,
  title TEXT,
  ts TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0,
  project_dir TEXT
);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project',
  project_dir TEXT,
  confidence REAL NOT NULL DEFAULT 0.8,
  ts TEXT NOT NULL,
  sources TEXT
);
CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_ts ON transcripts(ts);
CREATE INDEX IF NOT EXISTS idx_facts_kind ON facts(kind);
CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope);
`;

/**
 * Does the FTS index need to be rebuilt?
 *
 * The tokenizer changed from unicode61 (which cannot segment CJK at all) to
 * trigram, so an index built by an older revision is unusable. Rebuilding is a
 * full table copy, so it must only happen when the index is genuinely absent or
 * wrong — otherwise every OpenCode start would pay for it.
 */
function ftsNeedsRebuild(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transcripts_fts'")
    .get();
  if (!row || typeof row.sql !== "string") return true;
  return !/trigram/i.test(row.sql);
}

/** Is a named index already present on this database? */
function indexExists(db, name) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name);
}

/**
 * Give the facts table a uniqueness constraint, collapsing rows that already
 * violate it.
 *
 * Facts represent current state, not an audit log: one row per
 * (kind, key, scope, project) with the newest value winning. Without the
 * constraint every recapture of a session appended another copy of each fact —
 * measured on a live install at 135 rows, mostly duplicates of `convention: the`.
 *
 * `project_dir` is indexed as an expression because SQLite treats NULL as
 * distinct in a unique index, which would let every project-less row through.
 */
function migrateFacts(db) {
  // Only collapse duplicates when the constraint is genuinely absent. Doing it
  // unconditionally would make every process start pay for a full-table DELETE
  // scan of a store that is duplicate-free by construction.
  //
  // The order is forced: SQLite refuses to build a unique index while violating
  // rows exist, so the DELETE has to come first on a legacy database.
  if (!indexExists(db, "idx_facts_identity")) {
    db.exec(`
      DELETE FROM facts WHERE id NOT IN (
        SELECT MAX(id) FROM facts GROUP BY kind, key, scope, COALESCE(project_dir, '')
      )
    `);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_identity
    ON facts(kind, key, scope, COALESCE(project_dir, ''))
  `);
}

/**
 * Bring an existing database up to the current schema.
 *
 * CREATE TABLE IF NOT EXISTS will not retrofit columns onto an existing table,
 * so missing columns are added explicitly and a stale FTS index is replaced.
 */
export function migrate(db) {
  const cols = new Set(db.prepare("PRAGMA table_info(transcripts)").all().map((r) => r.name));
  if (!cols.has("message_id")) db.exec("ALTER TABLE transcripts ADD COLUMN message_id TEXT");
  if (!cols.has("project_dir")) db.exec("ALTER TABLE transcripts ADD COLUMN project_dir TEXT");
  // NULL message_id values are distinct in SQLite, so legacy rows coexist.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_transcripts_message ON transcripts(message_id)");

  migrateFacts(db);

  // A healthy-but-incomplete index is the case ftsNeedsRebuild cannot see: the
  // tokenizer is right so it reports "fine", yet rows are missing and `detmem_stats`
  // reports inSync:false forever. storeMessage writes both rows in one transaction
  // so this should not happen, but "should not" is not a repair strategy — and the
  // only other cure would be deleting the user's memory.
  if (!ftsNeedsRebuild(db)) {
    backfillMissingFts(db);
    return;
  }

  db.exec("DROP TABLE IF EXISTS transcripts_fts");
  db.exec(`
    CREATE VIRTUAL TABLE transcripts_fts USING fts5(
      content,
      session_id UNINDEXED,
      role UNINDEXED,
      ts UNINDEXED,
      tokenize = 'trigram'
    );
  `);
  backfillMissingFts(db);
}

/**
 * Copy any transcript that has no FTS row into the index.
 *
 * Two counts, so the common case — an index that is complete — costs one indexed
 * COUNT rather than a full scan of the transcripts table.
 */
function backfillMissingFts(db) {
  const mirrored = Number(db.prepare("SELECT COUNT(*) AS n FROM transcripts_fts").get().n);
  const stored = Number(
    db.prepare("SELECT COUNT(*) AS n FROM transcripts WHERE content IS NOT NULL AND content <> ''").get().n,
  );
  if (mirrored >= stored) return;

  db.exec(`
    INSERT INTO transcripts_fts(rowid, content, session_id, role, ts)
    SELECT t.id, t.content, t.session_id, t.role, t.ts
    FROM transcripts t
    WHERE t.content IS NOT NULL AND t.content <> ''
      AND NOT EXISTS (SELECT 1 FROM transcripts_fts f WHERE f.rowid = t.id)
  `);
}