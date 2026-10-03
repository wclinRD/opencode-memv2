/**
 * End-to-end system test against a real OpenCode server.
 *
 * There are no mocks anywhere here: the plugin under test is the one installed
 * in the caller's own `opencode.jsonc`, a real session is driven through
 * `opencode run`, and the assertions read the real SQLite file that the running
 * server wrote to.
 *
 * Because it needs an installed plugin and spends real model tokens it is
 * opt-in:
 *
 *   DETMEM_SYS_TEST=1 npm run test:system
 *
 * Environment:
 *   DETMEM_DB    path to the SQLite file the installed plugin writes to
 *                (default: ~/.opencode-detmem/detmem.sqlite)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildFtsQuery, buildLikeNeedle } from "../lib/extract.js";
import { closeAll, getDb, listFacts, searchMemory, stats } from "../lib/sqlite.js";

const ENABLED = process.env.DETMEM_SYS_TEST === "1";
const DB_PATH =
  process.env.DETMEM_DB || path.join(os.homedir(), ".opencode-detmem", "detmem.sqlite");
const skip = ENABLED ? false : "set DETMEM_SYS_TEST=1 to run (needs an installed plugin + model calls)";

/** Run `opencode run <prompt>` in a throwaway project directory. */
function runOpencode(prompt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "detmem-sys-"));
  return new Promise((resolve) => {
    const child = spawn("opencode", ["run", prompt], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
    child.on("close", (code) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, out });
    });
  });
}

/** Poll until `check` returns a truthy value, or give up. */
async function waitFor(check, timeoutMs, stepMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Rows whose stored content contains the marker, read straight from SQLite. */
function rowsContaining(marker) {
  return getDb(DB_PATH)
    .prepare("SELECT session_id, role, content FROM transcripts WHERE content LIKE ?")
    .all(`%${marker}%`);
}

/**
 * Drive one real session and wait for its marker to land in the database.
 *
 * Waiting on a row-count increase is not good enough: the developer's own
 * OpenCode session is captured into the same database at the same time and would
 * satisfy such a condition on its own. The marker is unique per run, so only the
 * row under test can match it.
 */
async function runUntilStored(marker, prompt) {
  const run = await runOpencode(prompt);
  const rows = await waitFor(() => {
    const found = rowsContaining(marker);
    return found.length ? found : null;
  }, 90000);
  return { run, rows };
}

const REPLY_ONLY = "只回覆 OK 兩個字，不要做任何其他事。";

test("a real session is captured into the database", { skip, timeout: 300000 }, async (t) => {
  assert.ok(fs.existsSync(DB_PATH), `no database at ${DB_PATH} — is detmem installed?`);

  const marker = `sysmark${randomBytes(5).toString("hex")}`;
  const before = stats(DB_PATH).transcripts;
  t.diagnostic(`marker=${marker} rows before=${before}`);

  const { run, rows } = await runUntilStored(marker, `${marker}\n${REPLY_ONLY}`);
  t.diagnostic(`opencode run exited ${run.code}`);

  // The assistant often quotes the prompt back, so only the user row is counted.
  const asked = rows.filter((r) => r.role === "user");
  assert.equal(asked.length, 1, "the prompt should be stored exactly once");
  assert.match(asked[0].content, new RegExp(marker));
  assert.ok(stats(DB_PATH).transcripts > before);

  // The prompt hook prepends a memory block that the server then persists. If it
  // were captured verbatim, every prompt would quote the previous one's block and
  // the transcript would grow into nested snippets. A unique marker matches no
  // stored memory, so nothing is injected here — the dedicated test below covers
  // the injected case, which is the one that actually regressed.
  assert.ok(
    !asked[0].content.includes("Deterministic Memory (detmem)"),
    "the injected memory block must not be stored as conversation",
  );
});

test("captured content is retrievable through the search path", { skip, timeout: 300000 }, async (t) => {
  const marker = `retmark${randomBytes(5).toString("hex")}`;
  const { run, rows } = await runUntilStored(
    marker,
    `決定: ${marker} 這是一段系統測試的記憶內容\n${REPLY_ONLY}`,
  );
  t.diagnostic(`opencode run exited ${run.code}`);
  assert.equal(rows.filter((r) => r.role === "user").length, 1);

  const { transcripts } = searchMemory(DB_PATH, marker, 8, buildFtsQuery(marker), buildLikeNeedle(marker));
  assert.ok(transcripts.length > 0, `search found nothing for ${marker}`);
});

test("rule-based fact extraction fires on a real session", { skip, timeout: 300000 }, async (t) => {
  const marker = `factmark${randomBytes(5).toString("hex")}`;
  const { run, rows } = await runUntilStored(
    marker,
    `決定: ${marker} 採用 trigram 讓中文可搜尋\n${REPLY_ONLY}`,
  );
  t.diagnostic(`opencode run exited ${run.code}`);
  assert.equal(rows.filter((r) => r.role === "user").length, 1);

  const facts = await waitFor(() => {
    const all = listFacts(DB_PATH, { limit: 500 });
    return all.some((f) => String(f.value).includes(marker)) ? all : null;
  }, 30000, 500);
  assert.ok(facts, `no extracted fact mentions ${marker}`);
  assert.ok(
    facts.some((f) => f.kind === "decision" && String(f.value).includes(marker)),
    "the fact should be classified as a decision",
  );
});

test("an injected memory block is not captured back into the transcript", { skip, timeout: 300000 }, async (t) => {
  // Two turns are needed. The first plants a phrase; the second asks about that
  // same phrase, which is what actually makes the prompt hook fire. A single
  // turn against an empty store would inject nothing and the assertion below
  // would pass without proving anything.
  const phrase = `注入測試詞${randomBytes(4).toString("hex")}`;
  const first = await runUntilStored(phrase, `決定: ${phrase} 這是為了驗證注入行為\n${REPLY_ONLY}`);
  t.diagnostic(`plant turn exited ${first.run.code}`);

  const marker = `injmark${randomBytes(5).toString("hex")}`;
  const second = await runUntilStored(marker, `${phrase}\n${marker}\n${REPLY_ONLY}`);
  t.diagnostic(`recall turn exited ${second.run.code}`);

  const asked = second.rows.filter((r) => r.role === "user");
  assert.equal(asked.length, 1);
  assert.match(asked[0].content, new RegExp(marker), "the prompt itself is stored");
  assert.ok(
    !asked[0].content.includes("Deterministic Memory (detmem)"),
    "the recalled memory block must be stripped before storage",
  );
  assert.ok(
    !asked[0].content.startsWith('"'),
    "the server's wrapping quote must not survive into storage",
  );
  assert.match(asked[0].content, new RegExp(phrase), "the user's own words are kept");
});

test.after(() => closeAll());
