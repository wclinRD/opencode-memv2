/**
 * detmem — Deterministic Memory for OpenCode V2.
 *
 * Zero LLM. Captures the raw session transcript into SQLite (FTS5), extracts
 * facts with fixed rules, and injects the most relevant memories ahead of each
 * prompt.
 *
 * Every API below was ported from the V1 revision, which was silently inert.
 * Two categories of change were needed, and both were established by measuring
 * a live v2.0.20 server rather than by reading the SDK types:
 *
 *   Documented-but-wrong API surface
 *     - ctx.config                            -> ctx.options
 *     - ctx.event.subscribe(callback)         -> an AsyncIterable to `for await`
 *     - ctx.tool.register                     -> ctx.tool.transform
 *     - session events carry `.properties`    -> they carry `.data`
 *     - session.idle is a real event          -> it is never emitted
 *
 *   Shape of the data itself
 *     - ctx.session.context() returns a FLAT array of messages, not {info, parts}
 *     - the role is `entry.type`, not `entry.info.role`
 *     - user prose is on `entry.text`, assistant prose on `entry.content[].text`
 *     - `time.created` is epoch milliseconds, not an ISO string
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  buildFtsQuery,
  buildLikeNeedle,
  extractMessage,
  formatContextBlock,
  ruleExtractFacts,
} from "./lib/extract.js";
import {
  DEFAULT_DB_PATH,
  closeAll,
  listFacts,
  searchMemory,
  stats,
  storeFacts,
  storeMessage,
} from "./lib/sqlite.js";

/**
 * Events that mean "new transcript content is worth persisting".
 *
 * `session.idle` is declared in the SDK types but is never actually emitted by
 * OpenCode v2 — measured over a live session, it fired zero times while
 * `session.step.ended` fired on every step. The step boundary is therefore the
 * real signal. `session.idle` is kept because it costs nothing and may be
 * emitted by other code paths.
 */
const CAPTURE_EVENTS = new Set(["session.step.ended", "session.compacted", "session.idle"]);

/**
 * Coerce a model-supplied tool argument into a usable positive integer.
 *
 * SQLite binds `null` and `1.5` as-is and rejects them with "datatype mismatch",
 * which the user would see as a failed tool call rather than a clamped result.
 */
function intArg(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), 200);
}

/**
 * Pull the session ID out of an event.
 *
 * The published SDK types declare `{ type, properties }`, but the v2.0.20
 * runtime actually delivers `{ id, created, type, durable, location, data }` —
 * reading `event.properties` yields undefined and silently disables capture.
 * `data` is checked first, `properties` second so a future version that matches
 * the docs still works, and `durable.aggregateID` carries the same session ID.
 */
function sessionIdFromEvent(event) {
  return (
    event?.data?.sessionID ||
    event?.properties?.sessionID ||
    event?.durable?.aggregateID ||
    null
  );
}

const NAMESPACE = "detmem";
/** Collapse the many step boundaries inside one agentic turn into a single read. */
const CAPTURE_DEBOUNCE_MS = 5000;

/**
 * Plugin console output never reaches ~/.local/share/opencode/log, so an
 * opt-in file log is the only way to observe what the hooks are doing.
 * Enable with the `debug` plugin option.
 */
function makeDebug(enabled, file) {
  if (!enabled) return () => {};
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return () => {};
  }
  return (msg) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* logging must never break the plugin */
    }
  };
}

export default {
  id: "detmem",
  name: "Deterministic Memory",

  async setup(ctx) {
    const dbPath = ctx.options?.dbPath || DEFAULT_DB_PATH;
    const projectDir = ctx.location?.project?.canonical || ctx.location?.directory || null;
    const debug = makeDebug(
      ctx.options?.debug === true,
      ctx.options?.debugFile || path.join(path.dirname(dbPath), "detmem.log"),
    );

    // Touch the DB once up front so schema problems surface at load time
    // instead of silently on the first prompt.
    stats(dbPath);

    const titleBySession = new Map();
    const lastCapture = new Map();

    const capture = async (sessionId) => {
      if (!sessionId) return;
      const now = Date.now();
      const previous = lastCapture.get(sessionId) || 0;
      if (now - previous < CAPTURE_DEBOUNCE_MS) return;
      lastCapture.set(sessionId, now);
      // Drop the bookkeeping for sessions that have gone quiet, so neither map
      // grows one entry per session for the lifetime of the process.
      if (lastCapture.size > 500) {
        for (const [key, at] of lastCapture) if (now - at > 10 * 60 * 1000) lastCapture.delete(key);
        for (const key of titleBySession.keys()) {
          if (now - (lastCapture.get(key) || 0) > 10 * 60 * 1000) titleBySession.delete(key);
        }
      }

      let entries;
      try {
        const session = await ctx.session.get({ sessionID: sessionId });
        if (session?.title) titleBySession.set(sessionId, session.title);
        entries = await ctx.session.context({ sessionID: sessionId });
        debug(`capture ${sessionId}: ${entries?.length ?? 0} entries`);
      } catch (err) {
        debug(`capture ${sessionId} FAILED: ${String(err)}`);
        return;
      }

      let stored = 0;
      let facts = [];
      for (const entry of entries || []) {
        const message = extractMessage(entry);
        if (!message.text) continue;
        const result = storeMessage(dbPath, {
          messageId: message.messageId,
          sessionId,
          title: titleBySession.get(sessionId) || null,
          ts: message.ts,
          role: message.role,
          content: message.text,
          tool: message.tool,
          synthetic: message.synthetic,
          projectDir,
        });
        if (result.stored) {
          stored++;
          facts.push(...ruleExtractFacts(result.text));
        }
      }

      if (facts.length) {
        try {
          storeFacts(dbPath, facts, { scope: "project", projectDir, sessionId });
        } catch (err) {
          debug(`facts FAILED: ${String(err)}`);
        }
      }
      debug(`capture ${sessionId}: stored ${stored}, facts ${facts.length}`);
    };

    // --- Events -------------------------------------------------------------
    // V2 subscribe() returns an AsyncIterable; it must be consumed, not called.
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          // Only capture-relevant events are logged: the stream carries hundreds
          // of token-delta events per turn, which would swamp the log.
          if (!CAPTURE_EVENTS.has(event?.type)) continue;
          const id = sessionIdFromEvent(event);
          debug(`capture event type=${event.type} id=${id}`);
          if (!id) continue;
          // Per-event, not around the whole loop: a single failed capture (a locked
          // database, a renamed project directory) must not end the subscription,
          // which would silently stop all capture for the rest of the process.
          try {
            await capture(id);
          } catch (err) {
            debug(`capture ${id} threw: ${String(err)}`);
          }
        }
        debug("event stream closed");
      } catch (err) {
        debug(`event stream error: ${String(err)}`);
      }
    })();

    // --- Prompt hook --------------------------------------------------------
    // Mutate event.prompt.text in place; returning a modified copy does nothing.
    await ctx.session.hook("prompt", (event) => {
      try {
        const original = event?.prompt?.text;
        debug(`prompt hook fired len=${typeof original === "string" ? original.length : "n/a"}`);
        if (typeof original !== "string" || !original.trim()) return;
        const query = original.slice(0, 160);
        const relevant = searchMemory(dbPath, query, 8, buildFtsQuery(query), buildLikeNeedle(query));
        const block = formatContextBlock(relevant);
        if (!block) return;
        if (original.startsWith(block)) return;
        event.prompt.text = `${block}\n---\n\n${original}`;
        debug(`prompt hook injected ${relevant.transcripts.length} snippet(s)`);
      } catch (err) {
        debug(`prompt hook FAILED: ${String(err)}`);
      }
    });

    // --- Tools --------------------------------------------------------------
    // Tool arguments come from a language model, so `limit` can arrive as null,
    // a float or a string. SQLite binds those as-is and rejects them with
    // "datatype mismatch", which would surface to the user as a failed tool call
    // instead of a clamped result. Every value is coerced here, once.
    // Names are prefixed explicitly rather than through an `editor.namespace()`
    // call: that method is absent from every published SDK type, and measuring
    // the live server showed it silently had no effect — the tools were exposed
    // as bare `search` / `stats`, which would shadow same-named built-ins.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: `${NAMESPACE}_search`,
        description: "Full-text and fact search over captured session memory.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text to search for." },
            limit: { type: "number", description: "Maximum results per source.", default: 8 },
          },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async ({ query, limit }) => {
          const relevant = searchMemory(dbPath, query, intArg(limit, 8), buildFtsQuery(query), buildLikeNeedle(query));
          const empty = relevant.transcripts.length === 0 && relevant.facts.length === 0;
          return { content: empty ? "No matching memory." : JSON.stringify(relevant, null, 2) };
        },
      });

      editor.add({
        name: `${NAMESPACE}_list_facts`,
        description: "List rule-extracted facts (decisions, todos, preferences, conventions).",
        input: {
          type: "object",
          properties: {
            kind: { type: "string", description: "decision | todo | preference | convention" },
            limit: { type: "number", description: "Maximum rows.", default: 20 },
          },
          additionalProperties: false,
        },
        execute: async ({ kind, limit }) => {
          const rows = listFacts(dbPath, { kind: kind || null, limit: intArg(limit, 20) });
          return { content: rows.length ? JSON.stringify(rows, null, 2) : "No facts stored yet." };
        },
      });

      editor.add({
        name: `${NAMESPACE}_stats`,
        description: "Memory store statistics, including FTS index consistency.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: JSON.stringify(stats(dbPath), null, 2) }),
      });
    });

    debug(`setup complete db=${dbPath} project=${projectDir}`);

    return () => {
      controller.abort();
      // Release the SQLite handle; the schema is re-created on next setup.
      closeAll();
      debug("unloaded");
    };
  },
};
