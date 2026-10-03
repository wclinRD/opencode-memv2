import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildFtsQuery, buildLikeNeedle } from "../lib/extract.js";
import { closeAll, getDb, listFacts, searchMemory, stats, storeFacts, storeMessage } from "../lib/sqlite.js";

let dir;
let dbPath;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "detmem-test-"));
  dbPath = path.join(dir, "detmem.sqlite");
});

after(() => {
  closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

function msg(overrides = {}) {
  return {
    messageId: "msg_1",
    sessionId: "ses_1",
    title: "Test session",
    ts: "2026-10-03T00:00:00.000Z",
    role: "user",
    content: "hello world",
    tool: null,
    synthetic: false,
    projectDir: "/tmp/project",
    ...overrides,
  };
}

// Regression test for the original bug: runSqlite ignored its `params`
// argument, so SQLite received unbound `?` and stored NULL for every column.
test("stores the real content string, not NULL", () => {
  assert.equal(storeMessage(dbPath, msg()).stored, true);

  const row = getDb(dbPath)
    .prepare("SELECT content, session_id, role, ts, title FROM transcripts WHERE message_id = ?")
    .get("msg_1");

  assert.equal(row.content, "hello world");
  assert.equal(row.session_id, "ses_1");
  assert.equal(row.role, "user");
  assert.equal(row.title, "Test session");
  assert.notEqual(row.content, null);
});

test("empty content is rejected without creating a row", () => {
  const before = stats(dbPath).transcripts;
  const result = storeMessage(dbPath, msg({ messageId: "msg_blank", content: "   " }));
  assert.equal(result.stored, false);
  assert.equal(result.reason, "empty");
  assert.equal(stats(dbPath).transcripts, before);
});

test("re-storing the same message id is idempotent (dedup)", () => {
  storeMessage(dbPath, msg({ messageId: "msg_dup", content: "duplicate me" }));
  const afterFirst = stats(dbPath).transcripts;

  for (let i = 0; i < 5; i++) {
    const res = storeMessage(dbPath, msg({ messageId: "msg_dup", content: "duplicate me" }));
    assert.equal(res.stored, false);
    assert.equal(res.reason, "duplicate");
  }

  assert.equal(stats(dbPath).transcripts, afterFirst, "no extra rows after repeated capture");

  const rows = getDb(dbPath).prepare("SELECT COUNT(*) AS c FROM transcripts WHERE message_id = ?").get("msg_dup");
  assert.equal(Number(rows.c), 1);
});

test("FTS index stays in sync with transcripts (no orphans)", () => {
  storeMessage(dbPath, msg({ messageId: "msg_sync1", content: "synchronisation probe alpha" }));
  storeMessage(dbPath, msg({ messageId: "msg_sync2", content: "synchronisation probe beta" }));
  // Duplicate must not add an FTS row either.
  storeMessage(dbPath, msg({ messageId: "msg_sync2", content: "synchronisation probe beta" }));

  const s = stats(dbPath);
  assert.equal(s.fts, s.transcripts, `fts=${s.fts} transcripts=${s.transcripts}`);
  assert.equal(s.orphanFts, 0);
  assert.equal(s.missingFts, 0);
  assert.equal(s.inSync, true);
});

test("full-text search finds stored content", () => {
  storeMessage(dbPath, msg({ messageId: "msg_fts", content: "Migrating the FTS5 index to node:sqlite" }));

  const { transcripts } = searchMemory(
    dbPath,
    "Migrating FTS5",
    5,
    buildFtsQuery("Migrating FTS5"),
    buildLikeNeedle("Migrating FTS5"),
  );
  assert.ok(transcripts.length > 0, "expected at least one snippet");
  assert.match(transcripts[0].snip, /Migrating|FTS5|node:sqlite/);
  assert.equal(transcripts[0].session_id, "ses_1");
});

test("CJK content is searchable, including via a longer question", () => {
  storeMessage(dbPath, msg({ messageId: "msg_cjk", content: "資料庫遷移到節點 SQLite 完成" }));

  const exact = searchMemory(dbPath, "資料庫", 5, buildFtsQuery("資料庫"), buildLikeNeedle("資料庫"));
  assert.ok(exact.transcripts.length > 0, "direct CJK term should hit");
  assert.match(exact.transcripts[0].snip, /資料庫/);

  // A whole Chinese sentence must still find the row via trigram expansion.
  const sentence = searchMemory(
    dbPath,
    "資料庫遷移的進度如何",
    5,
    buildFtsQuery("資料庫遷移的進度如何"),
    buildLikeNeedle("資料庫遷移的進度如何"),
  );
  assert.ok(sentence.transcripts.length > 0, "expanded trigrams should hit");
  assert.match(sentence.transcripts[0].snip, /資料庫/);
});

test("sub-trigram queries fall back to LIKE", () => {
  storeMessage(dbPath, msg({ messageId: "msg_short", content: "資料庫遷移" }));

  // Two characters is below the trigram minimum, so buildFtsQuery yields null
  // and only the LIKE pass can match.
  const expr = buildFtsQuery("資料");
  assert.equal(expr, null, "two characters cannot produce a trigram query");

  const { transcripts } = searchMemory(dbPath, "資料", 5, expr, buildLikeNeedle("資料"));
  assert.ok(transcripts.length > 0, "LIKE fallback should still find it");
  assert.match(transcripts[0].snip, /資料庫/);
});

test("a LIKE needle matches literally, not as a wildcard", () => {
  const wildPath = path.join(dir, "wildcard.sqlite");
  storeMessage(wildPath, msg({ messageId: "w1", content: "檔名是 a_c literal" }));
  storeMessage(wildPath, msg({ messageId: "w2", content: "檔名是 aXc 巧合" }));
  storeMessage(wildPath, msg({ messageId: "w3", content: "百分比 100% 有效" }));

  // `_` is a single-character wildcard in SQL LIKE. Unescaped, "a_c" also
  // matches "aXc"; the percent sign in a needle matches anything at all.
  // The FTS expression is passed as null so only the LIKE path runs — that is
  // the code under test, and FTS would otherwise answer first.
  const underscore = searchMemory(wildPath, "a_c", 10, null, buildLikeNeedle("a_c"));
  assert.deepEqual(
    underscore.transcripts.map((r) => r.snip),
    ["檔名是 a_c literal"],
    "_ must be a literal underscore",
  );

  const percent = searchMemory(wildPath, "100%", 10, null, buildLikeNeedle("100%"));
  assert.equal(percent.transcripts.length, 1, "% must be a literal percent sign");
});

test("hostile query input does not throw and degrades to no results", () => {
  const hostile = ['foo -bar" * (', "AND OR NOT NEAR:", "^bang", "a".repeat(5000), "'; DROP TABLE transcripts; --"];
  for (const q of hostile) {
    const result = searchMemory(dbPath, q, 5, buildFtsQuery(q), buildLikeNeedle(q));
    assert.ok(Array.isArray(result.transcripts));
    assert.ok(Array.isArray(result.facts));
  }
  assert.ok(stats(dbPath).transcripts > 0, "table must survive");
});

test("SQL-ish input is treated as literal text, not executed", () => {
  const q = "'; DROP TABLE transcripts; --";
  searchMemory(dbPath, q, 5, buildFtsQuery(q), buildLikeNeedle(q));
  const table = getDb(dbPath)
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='transcripts'")
    .get();
  assert.ok(table, "transcripts table survived");
});

test("facts are stored, filtered by kind, and ordered", () => {
  const stored = storeFacts(
    dbPath,
    [
      { kind: "decision", key: "db", value: "use node:sqlite", confidence: 0.9 },
      { kind: "todo", key: "tests", value: "add system test", confidence: 0.85 },
      { kind: "convention", key: "style", value: "semicolons", confidence: 0.7 },
    ],
    { scope: "project", projectDir: "/tmp/project", sessionId: "ses_1" },
  );
  assert.equal(stored, 3);

  const decisions = listFacts(dbPath, { kind: "decision", limit: 10 });
  assert.ok(decisions.length >= 1);
  assert.ok(decisions.every((r) => r.kind === "decision"));

  const all = listFacts(dbPath, { limit: 50 });
  assert.ok(all.length >= 3);
  assert.equal(listFacts(dbPath, { kind: "no_such_kind", limit: 10 }).length, 0);
});

test("facts are found by substring search", () => {
  const { facts } = searchMemory(dbPath, "node:sqlite", 5, buildFtsQuery("node:sqlite"), buildLikeNeedle("node:sqlite"));
  assert.ok(facts.some((f) => f.value.includes("node:sqlite")));
});

test("re-storing a fact refreshes it instead of duplicating it", () => {
  // Every recapture of a session re-derives the same facts. Facts are current
  // state, so the identity index must collapse repeats rather than grow.
  const dedupePath = path.join(dir, "dedupe.sqlite");
  const fact = { kind: "decision", key: "same-key", value: "first", confidence: 0.9 };
  storeFacts(dedupePath, [fact], { scope: "project", projectDir: "/p", sessionId: "ses_a" });
  storeFacts(dedupePath, [{ ...fact, value: "second" }], { scope: "project", projectDir: "/p", sessionId: "ses_b" });

  const rows = listFacts(dedupePath, { kind: "decision", limit: 50 });
  assert.equal(rows.length, 1, "the same key must not produce two rows");
  assert.equal(rows[0].value, "second", "the newest value wins");
});

test("facts with different keys or projects stay separate", () => {
  const sepPath = path.join(dir, "separate.sqlite");
  storeFacts(sepPath, [{ kind: "decision", key: "a", value: "v", confidence: 0.9 }], { projectDir: "/p1" });
  storeFacts(sepPath, [{ kind: "decision", key: "a", value: "v", confidence: 0.9 }], { projectDir: "/p2" });
  storeFacts(sepPath, [{ kind: "todo", key: "a", value: "v", confidence: 0.9 }], { projectDir: "/p1" });
  storeFacts(sepPath, [{ kind: "decision", key: "b", value: "v", confidence: 0.9 }], { projectDir: "/p1" });

  assert.equal(listFacts(sepPath, { limit: 50 }).length, 4, "project, kind and key each scope a fact");
});


test("stats reports real counts and consistency", () => {
  const s = stats(dbPath);
  assert.equal(s.dbPath, dbPath);
  assert.ok(s.transcripts >= 5);
  assert.ok(s.facts >= 3);
  assert.equal(s.fts, s.transcripts);
  assert.equal(s.inSync, true);
});

test("listFacts survives argument types a language model might produce", () => {
  const p = path.join(dir, "list-args.sqlite");
  storeFacts(p, [{ kind: "decision", key: "k", value: "v", confidence: 0.9 }], {});

  // Every one of these reached SQLite as a bound value before, and came back as
  // "datatype mismatch" — a failed tool call rather than a clamped result.
  for (const kind of [{}, [], 42, true, "", null, undefined, "decision"]) {
    assert.doesNotThrow(() => listFacts(p, { kind }), `kind=${JSON.stringify(kind)}`);
  }
  for (const limit of [null, 1.9, 0, -3, NaN, "5", undefined]) {
    assert.doesNotThrow(() => listFacts(p, { kind: "decision", limit }), `limit=${String(limit)}`);
  }
  assert.doesNotThrow(() => listFacts(p, null), "a null options object");
  assert.equal(listFacts(p, { kind: "decision", limit: 1.9 }).length, 1, "fractional limit falls back");
});

test("storeFacts writes a whole fact set or none of it", () => {
  const p = path.join(dir, "facts-atomic.sqlite");
  storeFacts(p, [{ kind: "decision", key: "good1", value: "a", confidence: 0.9 }], {});

  // `value: undefined` cannot be bound, so the batch throws partway. Without a
  // transaction the first row would already be committed.
  assert.throws(() =>
    storeFacts(
      p,
      [
        { kind: "decision", key: "good2", value: "b", confidence: 0.9 },
        { kind: "decision", key: "bad", value: undefined, confidence: 0.9 },
      ],
      {},
    ),
  );

  const keys = listFacts(p, { limit: 50 }).map((r) => r.key);
  assert.deepEqual(keys, ["good1"], "the successful row from this batch was rolled back");
});

test("storeMessage writes the row and its FTS mirror together", () => {
  const p = path.join(dir, "mirror-atomic.sqlite");
  storeMessage(p, msg({ messageId: "m1", content: "有內容的記憶" }));
  const s = stats(p);
  assert.equal(s.transcripts, 1);
  assert.equal(s.fts, 1, "the mirror row landed in the same transaction");
  assert.equal(s.inSync, true);
});
