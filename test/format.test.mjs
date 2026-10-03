import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFtsQuery,
  extractMessage,
  formatContextBlock,
  stripInjectedBlock,
} from "../lib/extract.js";

test("buildFtsQuery neutralises FTS5 syntax characters", () => {
  const q = buildFtsQuery('foo -bar "baz" * (qux) AND OR NOT NEAR: ^bang');
  assert.ok(q, "expected a query");
  // Every term must be a fully quoted literal, so no operator can survive.
  for (const term of q.split(" OR ")) {
    assert.match(term, /^"[^"]*"$/, `unquoted term leaked: ${term}`);
    const inner = term.slice(1, -1);
    for (const ch of ["(", ")", ":", "^", "*"]) {
      assert.ok(!inner.includes(ch), `bare ${ch} leaked into ${term}`);
    }
  }
  assert.ok(q.includes('"foo"'));
  assert.ok(q.includes('"bar"'), "hyphen must become a separate literal token, not negation");
  assert.ok(q.includes('"AND"'), "operators must appear only as quoted literals");
});
test("buildFtsQuery expands CJK runs into overlapping trigrams", () => {
  // A CJK run is one \p{L}+ match; without expansion the whole sentence would be
  // searched as a single phrase and would never match.
  assert.equal(buildFtsQuery("資料庫"), '"資料庫"');
  assert.equal(buildFtsQuery("資料庫遷移"), '"資料庫" OR "料庫遷" OR "庫遷移"');
  assert.equal(
    buildFtsQuery("資料庫遷移的進度"),
    '"資料庫" OR "料庫遷" OR "庫遷移" OR "遷移的" OR "移的進" OR "的進度"',
  );
});
test("buildFtsQuery mixes CJK and Latin runs", () => {
  assert.equal(buildFtsQuery("FTS5 遷移測試"), '"FTS5" OR "遷移測" OR "移測試"');
});
test("buildFtsQuery returns null when nothing usable remains", () => {
  assert.equal(buildFtsQuery(""), null);
  assert.equal(buildFtsQuery(null), null);
  assert.equal(buildFtsQuery("   "), null);
  assert.equal(buildFtsQuery("-*():^"), null);
});
test("buildFtsQuery caps token count", () => {
  const q = buildFtsQuery(Array.from({ length: 200 }, (_, i) => `token${i}`).join(" "));
  assert.ok(q.split(" OR ").length <= 32, "expected at most 32 terms");
});
test("buildFtsQuery drops runs below the trigram minimum", () => {
  // Two characters can never match a trigram index, so they are left to LIKE.
  assert.equal(buildFtsQuery("資料"), null);
  assert.equal(buildFtsQuery("go"), null);
  assert.equal(buildFtsQuery("資料 go"), null);
  assert.equal(buildFtsQuery("資料庫 go"), '"資料庫"');
});
test("formatContextBlock returns null when there is nothing to inject", () => {
  assert.equal(formatContextBlock({ transcripts: [], facts: [] }), null);
  assert.equal(formatContextBlock({}), null);
});
test("formatContextBlock renders facts and snippets", () => {
  const block = formatContextBlock({
    facts: [{ kind: "decision", key: "db", value: "use node:sqlite" }],
    transcripts: [{ ts: "2026-10-03T00:00:00.000Z", role: "user", snip: "【片段】" }],
  });
  assert.match(block, /Deterministic Memory/);
  assert.match(block, /\[decision\] db: use node:sqlite/);
  assert.match(block, /【片段】/);
});
test("an injected block is stripped back out when the message is captured", () => {
  const block = formatContextBlock({
    facts: [{ kind: "decision", key: "db", value: "use node:sqlite" }],
    transcripts: [{ ts: "2026-10-03T00:00:00.000Z", role: "user", snip: "【舊片段】" }],
  });
  // Reproduce what the server persists: the hook's output plus the real prompt.
  const persisted = `${block}\n---\n\n真正的問題`;

  const result = extractMessage({
    id: "msg_9",
    type: "user",
    time: { created: 1700000000000 },
    text: persisted,
  });
  assert.equal(result.text, "真正的問題", "only the user's own words are stored");
});
test("stripInjectedBlock removes the block from a quote-wrapped CLI prompt", () => {
  // Measured on a live CLI session: `opencode run` hands the hook text already
  // wrapped in literal double quotes, and the block is prepended OUTSIDE them.
  // A block check that assumed the quotes came first never fired.
  const block = formatContextBlock({
    facts: [{ kind: "decision", key: "db", value: "use node:sqlite" }],
    transcripts: [{ ts: "2026-10-03T00:00:00.000Z", role: "user", snip: "【舊片段】" }],
  });
  const persisted = `${block}\n---\n\n"只回覆 OK。"`;

  const result = extractMessage({
    id: "msg_cli",
    type: "user",
    time: { created: 1700000000000 },
    text: persisted,
  });
  assert.equal(result.text, "只回覆 OK。", "the block and the server's quotes are both gone");
  assert.ok(!result.text.includes("Deterministic Memory"), "no residue of the block");
});
test("stripInjectedBlock keeps quotes the user typed when no block was injected", () => {
  // Without a block there is no way to tell the server's wrapper from the user's
  // own quoting, so the text is left exactly as it arrived.
  const typed = '"整句都用引號包起來"';
  assert.equal(stripInjectedBlock(typed), typed);
  assert.equal(stripInjectedBlock(`"未配對`), `"未配對`);
  assert.equal(stripInjectedBlock(`"`), `"`);
});
test("stripInjectedBlock leaves ordinary text untouched", () => {
  assert.equal(stripInjectedBlock("hello"), "hello");
  assert.equal(stripInjectedBlock(""), "");
  assert.equal(stripInjectedBlock("text with\n---\ninside"), "text with\n---\ninside");
  assert.equal(stripInjectedBlock(null), null);
  // A quoted prompt with no block keeps the quote: this function only closes a
  // pair it opened itself.
  assert.equal(stripInjectedBlock(`"只是引號包住的文字"`), `"只是引號包住的文字"`);
});
test("a recalled snippet containing a markdown rule cannot truncate the block", () => {
  // The block's end is found at the first `\n---\n`, and `---` is everywhere in
  // agent output (READMEs, diffs, front-matter). If a snippet carried one, the
  // strip would cut there and the user's real prompt would be discarded with it.
  const block = formatContextBlock({
    facts: [],
    transcripts: [
      { ts: "2026-10-03T00:00:00.000Z", role: "assistant", snip: "決定: 採用 node:sqlite\n\n---\n\n後續說明文字" },
    ],
  });
  assert.ok(!block.includes("\n---\n"), "no line inside the block can look like the terminator");
  assert.match(block, /- 2026-10-03T00:00:00 \[assistant\] 決定: 採用 node:sqlite --- 後續說明文字/);

  const result = extractMessage({
    id: "msg_rule",
    type: "user",
    time: { created: 1700000000000 },
    text: `${block}\n---\n\n"只回覆 OK。"`,
  });
  assert.equal(result.text, "只回覆 OK。", "the user's own prompt survives a hostile snippet");
});
test("a fact value cannot inject extra bullets into the block", () => {
  const block = formatContextBlock({
    facts: [{ kind: "decision", key: "k\n1", value: "v\n- fake bullet" }],
    transcripts: [],
  });
  const body = block.split("\n").filter((l) => l.startsWith("- ["));
  assert.equal(body.length, 1, "one bullet per fact, whatever the value contained");
  assert.ok(!body[0].includes("\n"));
  assert.match(body[0], /- \[decision\] k 1: v - fake bullet/);
});
