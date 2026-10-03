import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFtsQuery,
  extractMessage,
  formatContextBlock,
  looksLikeTech,
  normalizeRole,
  ruleExtractFacts,
  stripInjectedBlock,
  MAX_TEXT_CHARS,
} from "../lib/extract.js";

// Fixtures use the shape actually returned by ctx.session.context() on
// OpenCode v2.0.20, captured live rather than read from the (stale) SDK types:
//   { id, time:{created}, text, files, type:"user" }
//   { id, time, type:"assistant", content:[{type:"text",text}], ... }
//   { id, time, type:"idle", outcome }
function assistant(content, extra = {}) {
  return { id: "msg_1", type: "assistant", time: { created: 1700000000000 }, content, ...extra };
}

test("extractMessage pulls prose out of an assistant message", () => {
  const result = extractMessage(assistant([{ type: "text", text: "hello world" }]));
  assert.equal(result.text, "hello world");
  assert.equal(result.role, "assistant");
  assert.equal(result.messageId, "msg_1");
  assert.equal(result.ts, new Date(1700000000000).toISOString());
});
test("extractMessage reads user prose from .text", () => {
  const result = extractMessage({
    id: "msg_0",
    type: "user",
    time: { created: 1700000000000 },
    text: "決定: 使用 trigram tokenizer",
    files: [],
  });
  assert.equal(result.text, "決定: 使用 trigram tokenizer");
  assert.equal(result.role, "user");
});
test("extractMessage joins multiple content items and records the tool name", () => {
  const result = extractMessage(
    assistant([
      { type: "text", text: "first" },
      { type: "tool", tool: "bash", callID: "c1", state: {} },
      { type: "text", text: "second" },
    ]),
  );
  assert.equal(result.text, "first\nsecond");
  assert.equal(result.tool, "bash");
});
test("extractMessage yields no prose for the idle marker entry", () => {
  const result = extractMessage({
    id: "msg_2",
    type: "idle",
    time: { created: 1700000000000 },
    outcome: "succeeded",
  });
  assert.equal(result.text, "", "the idle marker must not be stored");
  assert.equal(result.role, "system");
});
test("extractMessage flags synthetic messages", () => {
  const result = extractMessage(
    assistant([{ type: "text", text: "auto" }], { synthetic: true }),
  );
  assert.equal(result.synthetic, true);
});
test("extractMessage caps oversized text", () => {
  const result = extractMessage(assistant([{ type: "text", text: "x".repeat(MAX_TEXT_CHARS + 5000) }]));
  assert.equal(result.text.length, MAX_TEXT_CHARS);
});
test("extractMessage tolerates malformed entries", () => {
  assert.equal(extractMessage(undefined).text, "");
  assert.equal(extractMessage({}).text, "");
  assert.equal(extractMessage({}).messageId, null);
  assert.equal(extractMessage(assistant("not an array")).text, "");
});
test("normalizeRole maps entry types", () => {
  assert.equal(normalizeRole("user"), "user");
  assert.equal(normalizeRole("human"), "user");
  assert.equal(normalizeRole("assistant"), "assistant");
  assert.equal(normalizeRole("idle"), "system");
  assert.equal(normalizeRole(undefined), "assistant");
});
test("ruleExtractFacts recognises Chinese and English markers", () => {
  const facts = ruleExtractFacts(
    [
      "決定: 使用 node:sqlite 而非 spawn",
      "TODO: 補上 FTS5 遷移測試",
      "偏好: 偏好繁體中文",
      "慣例: 每次改動都要 commit",
      "Decision: ship on Friday",
    ].join("\n"),
  );
  const byKind = (k) => facts.filter((f) => f.kind === k);
  assert.equal(byKind("decision").length, 2);
  assert.equal(byKind("todo").length, 1);
  assert.equal(byKind("preference").length, 1);
  assert.equal(byKind("convention").length, 1);
  assert.ok(byKind("decision")[0].value.includes("node:sqlite"));
  assert.ok(byKind("decision")[0].confidence > byKind("todo")[0].confidence);
});
test("ruleExtractFacts returns empty for empty or unmarked text", () => {
  assert.deepEqual(ruleExtractFacts(""), []);
  assert.deepEqual(ruleExtractFacts("just some prose"), []);
});
test("ruleExtractFacts survives the quoting OpenCode applies to CLI prompts", () => {
  // `opencode run` stores the submitted prompt wrapped in literal double quotes,
  // so a captured user message looks like this rather than a bare marker line.
  const stored = ['# Deterministic Memory (detmem)', "", "---", "", '"決定: abc123 採用 trigram', '只回覆 OK。"'].join("\n");
  const facts = ruleExtractFacts(stored);
  const decision = facts.find((f) => f.kind === "decision");
  assert.ok(decision, "the quoted line must still be recognised");
  assert.equal(decision.value, "abc123 採用 trigram", "the wrapping quote is not part of the value");
});
test("ruleExtractFacts ignores lines that only look like markers", () => {
  const facts = ruleExtractFacts(["# 決定:這是標題", "- [decision] 決定: 引用", "「偏好: 引言」"].join("\n"));
  assert.deepEqual(facts, [], "headers and bullet prefixes must not fabricate facts");
});
test("looksLikeTech separates technology names from prose", () => {
  for (const tech of ["node:sqlite", "@opencode-ai/plugin", "build_release.sh", "DatabaseSync", "FTS5"]) {
    assert.ok(looksLikeTech(tech), `${tech} should count as a technology`);
  }
  for (const prose of ["the", "a", "trigram", "bun", "node", ""]) {
    assert.ok(!looksLikeTech(prose), `${prose || "(empty)"} is prose, not a technology`);
  }
  assert.ok(looksLikeTech("採用"), "CJK markers still pass");
});
test("ruleExtractFacts does not turn English prose into conventions", () => {
  // The `use` marker is unanchored, so it fires on any sentence containing the
  // word "use" — previously it stored `convention: the` on every such line.
  const facts = ruleExtractFacts(
    ["We use the file system here.", "You may use a database, or use the API.", "決定: 採用 node:sqlite"].join("\n"),
  );
  const conventions = facts.filter((f) => f.kind === "convention");
  assert.deepEqual(
    conventions.map((f) => f.key),
    ["node:sqlite"],
    "only the real technology reference should survive",
  );
});
test("ruleExtractFacts collapses a fact matched by several rules", () => {
  const facts = ruleExtractFacts(["TODO: 決定: 同一件事", "TODO: 決定: 同一件事"].join("\n"));
  assert.equal(facts.length, 1);
  assert.equal(facts[0].kind, "todo", "the first matching rule wins");
});
test("ruleExtractFacts tidies the key as well as the value", () => {
  // The identity index compares raw keys, so a leftover backtick used to file
  // `` `ChatViewModel` `` and `ChatViewModel` as two unrelated facts.
  const ticked = ruleExtractFacts("慣例: `node:sqlite`");
  const plain = ruleExtractFacts("慣例: node:sqlite");
  assert.equal(ticked[0].key, "node:sqlite", "the wrapping backtick is not part of the key");
  assert.equal(ticked[0].key, plain[0].key, "quoting must not fork one fact into two");
  assert.equal(ticked[0].value, plain[0].value);
});
