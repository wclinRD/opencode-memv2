/**
 * Schema creation and forward-migration behaviour, exercised against real
 * SQLite files built to match what earlier revisions actually left on disk.
 *
 * No mocks: every legacy shape here is created with the same node:sqlite handle
 * the plugin uses.
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildFtsQuery, buildLikeNeedle } from "../lib/extract.js";
import { closeAll, getDb, listFacts, searchMemory, stats, storeFacts, storeMessage } from "../lib/sqlite.js";

let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "detmem-migrate-"));
});

after(() => {
  closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

function msg(overrides = {}) {
  return {
    messageId: "msg_migrate",
    sessionId: "ses_migrate",
    title: "Migration",
    ts: "2026-10-03T00:00:00.000Z",
    role: "user",
    content: "內容",
    tool: null,
    synthetic: false,
    projectDir: "/tmp/project",
    ...overrides,
  };
}

test("schema is created on a brand new database path", () => {
  const freshPath = path.join(dir, "nested", "deep", "fresh.sqlite");
  const s = stats(freshPath);
  assert.equal(s.transcripts, 0);
  assert.equal(s.facts, 0);
  assert.equal(s.inSync, true);
  assert.ok(fs.existsSync(freshPath), "parent directories are created on demand");
});

test("re-opening does not rebuild a healthy trigram index", () => {
  const reusePath = path.join(dir, "reuse.sqlite");
  storeMessage(reusePath, msg({ messageId: "msg_reuse", content: "索引重建成本很昂貴" }));
  closeAll();

  // A second open must leave the existing index alone; dropping and rebuilding it
  // on every process start would stall OpenCode on each launch.
  const sql = getDb(reusePath)
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transcripts_fts'")
    .get().sql;
  assert.match(sql, /trigram/, "index still uses the trigram tokenizer");

  const s = stats(reusePath);
  assert.equal(s.transcripts, 1, "data survived the re-open");
  assert.equal(s.fts, 1);
  assert.equal(s.inSync, true);

  const hit = searchMemory(reusePath, "索引重建", 5, buildFtsQuery("索引重建"), buildLikeNeedle("索引重建"));
  assert.ok(hit.transcripts.length > 0, "index still searchable after re-open");
});

test("migrates a real legacy database: adds columns, rebuilds FTS as trigram", () => {
  const legacyPath = path.join(dir, "legacy.sqlite");

  // Build a database in the exact shape the previous revision left behind:
  // no message_id / project_dir columns, and a unicode61 FTS index.
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      title TEXT,
      ts TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool TEXT,
      synthetic INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE transcripts_fts USING fts5(
      content, session_id UNINDEXED, role UNINDEXED, ts UNINDEXED,
      tokenize = 'unicode61'
    );
  `);
  legacy
    .prepare("INSERT INTO transcripts (session_id,title,ts,role,content,tool,synthetic) VALUES (?,?,?,?,?,?,?)")
    .run("ses_old", "Legacy", "2020-01-01T00:00:00.000Z", "user", "舊的記憶資料庫內容", null, 0);
  legacy.close();

  // Opening through getDb must migrate rather than fail.
  assert.equal(storeMessage(legacyPath, msg({ messageId: "msg_new", content: "post migration row" })).stored, true);

  const cols = new Set(getDb(legacyPath).prepare("PRAGMA table_info(transcripts)").all().map((r) => r.name));
  assert.ok(cols.has("message_id"), "message_id column added");
  assert.ok(cols.has("project_dir"), "project_dir column added");

  const s = stats(legacyPath);
  assert.equal(s.transcripts, 2, "legacy row preserved");
  assert.equal(s.fts, 2, "FTS backfilled for the legacy row too");
  assert.equal(s.inSync, true);

  // The rebuilt index must now match CJK, which unicode61 could not do.
  const hit = searchMemory(legacyPath, "舊的記憶", 5, buildFtsQuery("舊的記憶"), buildLikeNeedle("舊的記憶"));
  assert.ok(hit.transcripts.length > 0, "CJK search works after migration to trigram");
});

test("fact rows predating the identity index are collapsed on open", () => {
  const legacyPath = path.join(dir, "legacy-facts.sqlite");
  stats(legacyPath); // create the schema without the identity index
  const db = getDb(legacyPath);
  db.exec("DROP INDEX IF EXISTS idx_facts_identity");
  for (let i = 0; i < 5; i++) {
    db.prepare(
      "INSERT INTO facts (kind, key, value, scope, project_dir, confidence, ts) VALUES (?,?,?,?,?,?,?)",
    ).run("decision", "dup", `v${i}`, "project", "/p", 0.9, `2026-01-0${i + 1}T00:00:00.000Z`);
  }
  assert.equal(listFacts(legacyPath, { kind: "decision", limit: 50 }).length, 5);

  // Re-opening runs migrate, which must dedupe and rebuild the index.
  closeAll();
  const rows = listFacts(legacyPath, { kind: "decision", limit: 50 });
  assert.equal(rows.length, 1, "duplicates collapsed");
  assert.equal(rows[0].value, "v4", "the newest row is kept");

  storeFacts(legacyPath, [{ kind: "decision", key: "dup", value: "v9", confidence: 0.9 }], { projectDir: "/p" });
  assert.equal(listFacts(legacyPath, { kind: "decision", limit: 50 }).length, 1, "index is enforcing identity");
});

test("an FTS index that is healthy but incomplete is repaired on open", () => {
  // ftsNeedsRebuild() only inspects the tokenizer, so a right-tokenizer index with
  // missing rows reports "fine" and used to leave stats().inSync false forever —
  // the only cure was deleting the user's memory. storeMessage writes both rows in
  // one transaction, but "should not happen" is not a repair strategy.
  const p = path.join(dir, "incomplete-fts.sqlite");
  storeMessage(p, { messageId: "a", sessionId: "s", ts: "2026-01-01T00:00:00.000Z", role: "user", content: "第一筆中文記憶" });
  storeMessage(p, { messageId: "b", sessionId: "s", ts: "2026-01-02T00:00:00.000Z", role: "user", content: "第二筆中文記憶" });

  const db = getDb(p);
  db.exec("DELETE FROM transcripts_fts WHERE rowid = (SELECT MAX(id) FROM transcripts)");
  const damaged = stats(p);
  assert.equal(damaged.transcripts, 2);
  assert.equal(damaged.fts, 1);
  assert.equal(damaged.inSync, false, "precondition: the index is out of sync");

  closeAll();
  const repaired = stats(p);
  assert.equal(repaired.fts, 2, "the missing mirror row is restored");
  assert.equal(repaired.inSync, true);

  const hit = searchMemory(p, "第二筆", 5, buildFtsQuery("第二筆"), buildLikeNeedle("第二筆"));
  assert.ok(hit.transcripts.length > 0, "the repaired row is searchable again");
});

test("an FTS row whose transcript is gone is deleted on open", () => {
  // stats().inSync folds orphanFts in, so leaving orphans makes the state exactly
  // as unrecoverable as a missing row — and the repair shares ftsDrift() with the
  // diagnostic precisely so the two cannot disagree.
  const p = path.join(dir, "orphan-fts.sqlite");
  storeMessage(p, { messageId: "a", sessionId: "s", ts: "2026-01-01T00:00:00.000Z", role: "user", content: "留下來的記憶" });
  storeMessage(p, { messageId: "b", sessionId: "s", ts: "2026-01-02T00:00:00.000Z", role: "user", content: "要被刪掉的那筆" });

  getDb(p).exec("DELETE FROM transcripts WHERE message_id = 'b'");
  assert.equal(stats(p).orphanFts, 1, "precondition: the mirror row is orphaned");
  assert.equal(stats(p).inSync, false);

  closeAll();
  const after = stats(p);
  assert.equal(after.orphanFts, 0, "the orphan is removed");
  assert.equal(after.missingFts, 0);
  assert.equal(after.inSync, true);
  assert.equal(after.transcripts, 1);
});

test("the repair and stats agree even when an empty row is mirrored", () => {
  // A plain pair of totals balances here (2 mirrored vs 2 non-empty) while a real
  // row is still unmirrored, which is how a count-based guard skipped repairs that
  // stats() kept reporting.
  const p = path.join(dir, "count-skew.sqlite");
  storeMessage(p, { messageId: "a", sessionId: "s", ts: "2026-01-01T00:00:00.000Z", role: "user", content: "有內容" });
  storeMessage(p, { messageId: "b", sessionId: "s", ts: "2026-01-02T00:00:00.000Z", role: "user", content: "有內容" });
  const db = getDb(p);
  // Simulate an older revision that mirrored a transcript whose content is now empty.
  db.exec("UPDATE transcripts SET content = '' WHERE message_id = 'b'");
  db.exec("DELETE FROM transcripts_fts WHERE rowid = (SELECT id FROM transcripts WHERE message_id = 'a')");

  assert.equal(stats(p).missingFts, 1, "the precise predicate sees the gap a count would miss");
  closeAll();
  assert.equal(stats(p).missingFts, 0, "repaired");
  assert.equal(stats(p).inSync, true);
});
