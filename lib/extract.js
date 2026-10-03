/**
 * Pure extraction helpers for detmem — side-effect free and unit testable.
 * The shape below was captured live from `ctx.session.context()` on v2.0.20: a
 * FLAT array, not the `{ info, parts }` envelope the SDK types suggest, with
 * user text on `.text` and assistant text on `.content[].text`.
 *   { id, time:{created}, text, files: [], type:"user" }
 *   { id, time, type:"assistant", agent, model, content:[{type:"text",text}], … }
 *   { id, time:{created}, type:"idle", outcome:"succeeded" }
 */

/** Cap stored text per message so one huge tool-ish message cannot bloat the DB. */
export const MAX_TEXT_CHARS = 20000;
const MAX_FTS_TOKENS = 32;
/** Header of the injected block, doubling as the sentinel used to spot it again. */
const CONTEXT_HEADER = "# Deterministic Memory (detmem)";

/**
 * Remove a memory block that was injected into an earlier prompt.
 *
 * The prompt hook prepends the block, and the server persists that modified text as
 * the user message. Capturing it verbatim stores our own output as conversation, and
 * each prompt quotes the previous one — the transcript grew into nested `【【`.
 *
 * Where the server's quotes sit was measured, not guessed: `opencode run` hands the
 * hook text ALREADY wrapped in literal double quotes, and the block goes in OUTSIDE
 * them, so the row is `# Deterministic Memory … \n---\n "<prompt>"`. The pair is
 * therefore unwrapped from the REMAINDER, and only here — with no block injected the
 * quotes are indistinguishable from the user's own.
 *
 * SAFETY COUPLING: finding the end at the first `\n---\n` is only sound because
 * formatContextBlock collapses every entry to one line, so no line in a block can be
 * `---`. Changing one without the other silently discards the user's prompt.
 */
export function stripInjectedBlock(text) {
  if (typeof text !== "string") return text;
  if (!text.startsWith(CONTEXT_HEADER)) return text;

  const end = text.indexOf("\n---\n");
  if (end === -1) return text;
  const rest = text.slice(end + "\n---\n".length).replace(/^\n+/, "");

  return rest.length > 1 && rest.startsWith('"') && rest.endsWith('"')
    ? rest.slice(1, -1)
    : rest;
}

/**
 * Extract the prose and tool name from one session-context entry.
 *
 * Non-conversation entries (notably the `idle` marker appended after each turn)
 * carry no prose and yield empty text, so the caller skips them.
 *
 * @param {object} entry
 * @returns {{ messageId: string|null, role: string, ts: string, text: string,
 *            tool: string|null, synthetic: boolean }}
 */
export function extractMessage(entry) {
  const empty = {
    messageId: null,
    role: "assistant",
    ts: new Date().toISOString(),
    text: "",
    tool: null,
    synthetic: false,
  };
  if (!entry || typeof entry !== "object") return empty;

  const messageId = typeof entry.id === "string" && entry.id ? entry.id : null;
  const created = entry.time && typeof entry.time.created === "number" ? entry.time.created : null;
  const ts = created ? new Date(created).toISOString() : new Date().toISOString();
  const role = normalizeRole(entry.type);
  const base = { messageId, role, ts, text: "", tool: null, synthetic: entry.synthetic === true };

  // User messages carry their prose directly; assistant messages split it across
  // `.content[]`. Reading both keeps this correct if a version uses either shape.
  const chunks = [];
  if (typeof entry.text === "string") chunks.push(entry.text);
  const content = Array.isArray(entry.content) ? entry.content : [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string") chunks.push(item.text);
    if (base.tool === null && typeof item.tool === "string") base.tool = item.tool;
    if (item.synthetic === true) base.synthetic = true;
  }

  base.text = chunks
    .map((t) => t.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TEXT_CHARS);

  return { ...base, text: stripInjectedBlock(base.text) };
}

/** Map entry types onto the two roles that get stored. */
export function normalizeRole(type) {
  const v = String(type || "").toLowerCase();
  if (v === "user" || v === "human") return "user";
  if (v === "idle" || v === "step") return "system";
  return "assistant";
}

/**
 * Strip decoration that wraps a stored line.
 *
 * `opencode run` persists its prompt wrapped in literal double quotes, so the line
 * that should read `決定: X` is stored as `"決定: X`. Without this, fact extraction
 * misses every CLI message — measured live, where the decision only ever matched
 * inside the assistant's reply instead.
 */
function tidyLine(line) {
  return String(line)
    .replace(/^[\s"'“”‘’`*_\-–—>•]+/, "")
    .replace(/[\s"'“”‘’`*]+$/, "")
    .trim();
}

/**
 * Does a captured word name a technology rather than ordinary prose?
 *
 * The `use`/`採用` marker cannot be anchored to a line start, so it fires on any
 * English sentence containing "use" and captured whatever followed — measured live,
 * it filled the store with `convention: the` and `convention: a`.
 *
 * A technology name looks like an identifier: it carries punctuation
 * (`node:sqlite`, `@scope/pkg`) or is camelCase / ALLCAPS (`DatabaseSync`,
 * `FTS5`). Plain lowercase words are prose and are rejected.
 */
export function looksLikeTech(word) {
  const w = String(word).trim();
  if (!w) return false;
  if (/[\u3400-\u9fff]/.test(w)) return w.length >= 2;
  if (/^[a-z0-9]+$/.test(w)) return false; // plain prose word
  return /[.:\-_/@]/.test(w) || /[A-Z]/.test(w);
}

/**
 * Deterministic, rule-based fact extraction. No LLM involved.
 * Recognises Traditional Chinese and English markers.
 * @param {string} text
 * @returns {Array<{kind:string,key:string,value:string,confidence:number}>}
 */
export function ruleExtractFacts(text) {
  const facts = [];
  if (!text) return facts;
  const seen = new Set();
  const push = (kind, rawKey, value, confidence) => {
    // The key is tidied as well as the value: the identity index compares raw
    // keys, so a stray backtick would file `` `ChatViewModel` `` and
    // `ChatViewModel` as two unrelated facts.
    const k = tidyLine(String(rawKey)).slice(0, 80);
    const v = tidyLine(value);
    if (!k || !v) return;
    const id = `${kind}\u0000${k}`;
    if (seen.has(id)) return; // one capture often matches several rules
    seen.add(id);
    facts.push({ kind, key: k, value: v, confidence });
  };

  for (const raw of String(text).split(/\r?\n/)) {
    const line = tidyLine(raw);
    if (!line) continue;

    const mDec = line.match(/^(?:決定|Decision|DECISION)[:：]\s*(.+)$/);
    if (mDec) push("decision", mDec[1], mDec[1], 0.9);

    const mTodo = line.match(/^(?:TODO|待辦|ToDo)[:：]\s*(.+)$/i);
    if (mTodo) push("todo", mTodo[1], mTodo[1], 0.85);

    const mPref = line.match(/^(?:偏好|Preference)[:：]\s*(.+)$/i);
    if (mPref) push("preference", mPref[1], mPref[1], 0.85);

    const mConv = line.match(/^(?:慣例|Convention|規則)[:：]\s*(.+)$/i);
    if (mConv) push("convention", mConv[1], mConv[1], 0.88);

    if (facts.length < 20) {
      const mUse = line.match(/(?:建議使用|採用|use)\s+([^\s,;]+)/i);
      if (mUse && looksLikeTech(mUse[1])) {
        push("convention", mUse[1].slice(0, 40), mUse[1], 0.7);
      }
    }
  }
  return facts;
}

/**
 * Minimum token length for the trigram tokenizer. FTS5 cannot match a trigram
 * query shorter than 3 characters, so shorter Latin fragments are dropped here
 * and picked up by the LIKE fallback in searchMemory instead.
 */
const MIN_FTS_TOKEN = 3;

/** CJK ranges that unicode61 fails to segment. */
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/**
 * Expand one contiguous letter/number run into searchable trigram terms.
 *
 * A CJK run is not a word: "資料庫遷移的進度如何" is a single \p{L}+ match, and
 * the trigram tokenizer would look for that entire phrase. Emitting every
 * overlapping 3-character window (OR-ed) matches the substring instead.
 *
 * Runs below MIN_FTS_TOKEN are dropped for both scripts: the trigram tokenizer
 * cannot match them, so they would only bloat the MATCH expression.
 * buildLikeNeedle covers those cases instead.
 */
function expandRun(run) {
  if (run.length < MIN_FTS_TOKEN) return [];
  if (!CJK.test(run) || run.length === MIN_FTS_TOKEN) return [run];
  const out = [];
  for (let i = 0; i + MIN_FTS_TOKEN <= run.length; i++) out.push(run.slice(i, i + MIN_FTS_TOKEN));
  return out;
}

/**
 * Sanitise arbitrary user text into a safe FTS5 MATCH expression.
 *
 * Two hazards are handled here:
 *
 * 1. Syntax injection. Raw text is unsafe: FTS5 treats `- " * ( ) : ^ AND OR
 *    NOT NEAR` as syntax and throws on malformed input. We keep only
 *    letter/number/underscore runs and quote each one, which makes every term
 *    a literal string with no operator meaning.
 *
 * 2. Tokenisation. The `unicode61` tokenizer does not segment CJK at all — I
 *    measured `"資料庫"` scoring 0 hits against text containing 資料庫 — so the
 *    table uses `trigram`, which substring-matches CJK and Latin alike.
 *
 * Terms are OR-ed and ranked by bm25: recall matters more than precision for a
 * memory lookup, and the snippet gives the model enough context to judge.
 *
 * @param {string} query
 * @returns {string|null} MATCH expression, or null when nothing usable remains
 */
export function buildFtsQuery(query) {
  if (!query || typeof query !== "string") return null;
  const runs = query.match(/[\p{L}\p{N}_]+/gu);
  if (!runs || runs.length === 0) return null;

  const terms = [];
  for (const run of runs) {
    for (const term of expandRun(run)) {
      terms.push(`"${term.replace(/"/g, '""')}"`);
      if (terms.length >= MAX_FTS_TOKENS) return terms.join(" OR ");
    }
  }
  return terms.length ? terms.join(" OR ") : null;
}

/**
 * Pick the needle for the LIKE fallback.
 *
 * The trigram tokenizer cannot match anything shorter than 3 characters, so a
 * two-character CJK query such as "資料" would return nothing at all. LIKE does
 * substring matching, so it can serve those. The longest contiguous run in the
 * query is the most distinctive term available.
 *
 * @param {string} query
 * @returns {string|null}
 */
export function buildLikeNeedle(query) {
  if (!query || typeof query !== "string") return null;
  const runs = query.match(/[\p{L}\p{N}_]+/gu);
  if (!runs || runs.length === 0) return null;
  let best = "";
  for (const run of runs) if (run.length > best.length) best = run;
  return best ? best.slice(0, 40) : null;
}

/**
 * Turn search results into the markdown block injected ahead of a prompt.
 * @returns {string|null} null when there is nothing worth injecting
 */
export function formatContextBlock(relevant) {
  const transcripts = relevant?.transcripts || [];
  const facts = relevant?.facts || [];
  if (transcripts.length === 0 && facts.length === 0) return null;

  // Every entry collapses to ONE line. Load-bearing, not cosmetic: the block ends
  // at the first `\n---\n`, so a snippet carrying a markdown rule (`---` is
  // everywhere in agent output) would end it early and cut the user's real prompt
  // away with it. Collapsing also stops a snippet faking its own bullet.
  const oneLine = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

  const lines = [CONTEXT_HEADER];
  if (facts.length) {
    lines.push("", "## Facts (rule-based)");
    for (const f of facts) lines.push(`- [${oneLine(f.kind)}] ${oneLine(f.key)}: ${oneLine(f.value)}`);
  }
  if (transcripts.length) {
    lines.push("", "## Relevant snippets (FTS5)");
    for (const t of transcripts) {
      const when = typeof t.ts === "string" ? t.ts.slice(0, 19) : "";
      lines.push(`- ${when} [${oneLine(t.role)}] ${oneLine(t.snip)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
