/**
 * OpenCode Deterministic Memory (detmem) — V2 plugin
 * - Zero LLM, deterministic capture
 * - Auto-capture on session.idle/compacted (raw transcript → SQLite FTS5)
 * - Rule-based fact extraction (decisions, todos, preferences, conventions)
 * - Optional local ONNX embeddings (semantic search) without generative AI
 * - Injects top-K relevant memories into chat context
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const DEFAULT_DB_DIR = path.join(os.homedir(), ".opencode-detmem");
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, "detmem.sqlite");

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureDir(p) {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

async function runSqlite(dbPath, sql, params = []) {
  const dbDir = path.dirname(dbPath);
  await ensureDir(dbDir);
  const args = ["-batch", "-cmd", ".mode json", dbPath];
  const proc = spawn("sqlite3", args);
  const input = sql + "\n";
  proc.stdin.write(input);
  proc.stdin.end();
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => (stdout += d.toString()));
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  return new Promise((resolve) => {
    proc.on("close", (code) => {
      if (code !== 0) return resolve({ ok: false, code, stderr, stdout });
      try {
        const rows = stdout.trim() ? JSON.parse(stdout) : [];
        resolve({ ok: true, rows });
      } catch (e) {
        resolve({ ok: true, rows: [], raw: stdout });
      }
    });
  });
}

async function initDb(dbPath) {
  await ensureDir(path.dirname(dbPath));
  const schema = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  title TEXT,
  ts TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_ts ON transcripts(ts);

CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
  content,
  session_id UNINDEXED,
  role UNINDEXED,
  ts UNINDEXED,
  tokenize = 'unicode61'
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
CREATE INDEX IF NOT EXISTS idx_facts_kind ON facts(kind);
CREATE INDEX IF NOT EXISTS idx_facts_key ON facts(key);
CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope);
`;
  await runSqlite(dbPath, schema);
}

function isSynthetic(part) {
  if (!part) return true;
  if (part.type === "thought" || part.type === "tool_call" || part.type === "tool_result") return true;
  if (part.synthetic) return true;
  return false;
}

function extractText(part) {
  if (!part) return "";
  if (part.type === "text") return part.text || "";
  if (part.content) {
    if (typeof part.content === "string") return part.content;
    if (Array.isArray(part.content)) return part.content.map(extractText).join("\n");
  }
  if (part.text) return part.text;
  return "";
}

function extractTool(part) {
  if (!part) return null;
  if (part.tool || part.name) return part.tool || part.name;
  if (part.type === "tool_call") return part.tool || part.name || null;
  return null;
}

function normalizeRole(r) {
  if (!r) return "assistant";
  const v = String(r).toLowerCase();
  if (v === "human") return "user";
  if (v === "thought") return "assistant";
  return v;
}

function ruleExtractFacts(text) {
  const facts = [];
  if (!text) return facts;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const mDec = line.match(/^(?:決定|Decision|DECISION)[:：]\s*(.+)$/i);
    if (mDec) facts.push({ kind: "decision", key: mDec[1].trim().slice(0,80), value: mDec[1].trim(), confidence: 0.9 });
    const mTodo = line.match(/^(?:TODO|待辦|ToDo)[:：]\s*(.+)$/i);
    if (mTodo) facts.push({ kind: "todo", key: mTodo[1].trim().slice(0,60), value: mTodo[1].trim(), confidence: 0.85 });
    const mPref = line.match(/^(?:偏好|Preference|偏愛)[:：]\s*(.+)$/i);
    if (mPref) facts.push({ kind: "preference", key: mPref[1].trim().slice(0,60), value: mPref[1].trim(), confidence: 0.85 });
    const mConv = line.match(/^(?:慣例|Convention|規則)[:：]\s*(.+)$/i);
    if (mConv) facts.push({ kind: "convention", key: mConv[1].trim().slice(0,60), value: mConv[1].trim(), confidence: 0.88 });
    const mUse = line.match(/(?:建議使用|use|採用)\s+([A-Za-z0-9_\-./@]+(?:\s*,\s*[A-Za-z0-9_\-./@]+)*)/i);
    if (mUse && facts.length < 20) {
      const v = mUse[1];
      facts.push({ kind: "convention", key: v.slice(0,40), value: v, confidence: 0.7 });
    }
  }
  return facts;
}

async function storeTranscript(dbPath, sessionId, title, msg) {
  const role = normalizeRole(msg.role);
  let fullText = "";
  let tool = null;
  let synthetic = 0;
  if (Array.isArray(msg.parts)) {
    for (const p of msg.parts) {
      const t = extractText(p);
      if (t) fullText += (fullText ? "\n" : "") + t;
      const tl = extractTool(p);
      if (tl) tool = tool || tl;
      if (isSynthetic(p)) synthetic = 1;
    }
  } else if (msg.content) {
    fullText = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  }
  fullText = fullText.trim();
  if (!fullText) return { stored: 0 };
  const ts = msg.timestamp ? new Date(msg.timestamp).toISOString() : nowIso();
  await runSqlite(
    dbPath,
    `INSERT INTO transcripts (session_id,title,ts,role,content,tool,synthetic) VALUES (?,?,?,?,?,?,?);`,
    [sessionId, title || null, ts, role, fullText, tool, synthetic]
  );
  await runSqlite(
    dbPath,
    `INSERT INTO transcripts_fts (rowid, content, session_id, role, ts) VALUES ((SELECT id FROM transcripts WHERE session_id=? AND ts=? AND content=? ORDER BY id DESC LIMIT 1), ?, ?, ?, ?);`,
    [sessionId, ts, fullText, fullText, sessionId, role, ts]
  );
  return { stored: 1, text: fullText };
}

async function storeFacts(dbPath, facts, ctx) {
  for (const f of facts) {
    await runSqlite(
      dbPath,
      `INSERT INTO facts (kind,key,value,scope,project_dir,confidence,ts,sources) VALUES (?,?,?,?,?,?,?,?);`,
      [f.kind, f.key, f.value, ctx.scope || "project", ctx.projectDir || null, f.confidence || 0.8, nowIso(), ctx.sessionId || null]
    );
  }
  return facts.length;
}

async function searchRelevant(dbPath, query, limit = 8) {
  if (!query) return { transcripts: [], facts: [] };
  const q = query.replace(/["']/g, " ").trim();
  let transcripts = [];
  let facts = [];
  if (q) {
    const r1 = await runSqlite(
      dbPath,
      `SELECT snippet(transcripts_fts, 0, '【', '】', ' … ', 10) AS snip, session_id, ts, role
       FROM transcripts_fts
       WHERE transcripts_fts MATCH ?
       ORDER BY bm25(transcripts_fts, 10.0, 1.0, 0.0, 0.0)
       LIMIT ?;`,
      [q, limit]
    );
    if (r1.ok) transcripts = r1.rows || [];
    const r2 = await runSqlite(
      dbPath,
      `SELECT kind,key,value,confidence,ts FROM facts
       WHERE value LIKE ? OR key LIKE ?
       ORDER BY confidence DESC, ts DESC
       LIMIT ?;`,
      [`%${q}%`, `%${q}%`, limit]
    );
    if (r2.ok) facts = r2.rows || [];
  }
  return { transcripts, facts };
}

async function captureSession(ctx, sessionId) {
  const dbPath = ctx.config.dbPath || DEFAULT_DB_PATH;
  await initDb(dbPath);
  try {
    const res = await ctx.client.session.messages({ path: { id: sessionId } });
    const msgs = res.messages || [];
    let stored = 0;
    let factsAll = [];
    for (const m of msgs) {
      const sr = await storeTranscript(dbPath, sessionId, res.title, m);
      stored += sr.stored || 0;
      if (sr.text) {
        const ff = ruleExtractFacts(sr.text);
        if (ff.length) factsAll.push(...ff);
      }
    }
    if (factsAll.length) {
      await storeFacts(dbPath, factsAll, { scope: "project", projectDir: process.cwd(), sessionId });
    }
    return { ok: true, stored, facts: factsAll.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function formatContextBlock(relevant) {
  const lines = ["# Deterministic Memory (detmem)"];
  if (relevant.facts?.length) {
    lines.push("## Facts (rule-based)");
    for (const f of relevant.facts) {
      lines.push(`- [${f.kind}] ${f.key}: ${f.value}`);
    }
  }
  if (relevant.transcripts?.length) {
    lines.push("## Relevant snippets (FTS5)");
    for (const t of relevant.transcripts) {
      lines.push(`- ${t.ts?.slice(0,19)} [${t.role}] ${t.snip}`);
    }
  }
  if (lines.length === 1) return null;
  return lines.join("\n");
}

export default {
  id: "detmem",
  name: "Deterministic Memory",
  async setup(ctx) {
    const dbPath = ctx.config.dbPath || DEFAULT_DB_PATH;
    await initDb(dbPath);

    // Auto-capture on session lifecycle events
    ctx.event.subscribe(async (ev) => {
      try {
        const t = ev?.event?.type || ev?.type;
        if (t === "session.idle" || t === "session.compacted" || t === "session.updated") {
          const sid = ev?.event?.sessionID || ev?.sessionID || ev?.properties?.sessionID || ev?.properties?.id;
          if (sid) {
            await captureSession(ctx, sid);
          }
        }
      } catch (e) {}
    });

    // Inject relevant memory before prompt
    ctx.session.hook("prompt", async (input) => {
      try {
        const prompt = input.prompt || "";
        const q = prompt.slice(0, 120);
        const rel = await searchRelevant(dbPath, q, 8);
        const block = formatContextBlock(rel);
        if (block) {
          input.prompt = block + "\n\n---\n\n" + prompt;
        }
      } catch (e) {}
      return input;
    });

    // Manual tools
    ctx.tool.register({
      id: "detmem.search",
      description: "Search deterministic memory (FTS5 + facts)",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", default: 10 },
        },
        required: ["query"],
      },
      async execute({ query, limit = 10 }) {
        const rel = await searchRelevant(dbPath, query, limit);
        return { ok: true, ...rel };
      },
    });

    ctx.tool.register({
      id: "detmem.list_facts",
      description: "List rule-based facts",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string" },
          limit: { type: "number", default: 20 },
        },
      },
      async execute({ kind, limit = 20 }) {
        let sql = "SELECT id,kind,key,value,scope,confidence,ts FROM facts";
        const params = [];
        if (kind) { sql += " WHERE kind=?"; params.push(kind); }
        sql += " ORDER BY ts DESC LIMIT ?";
        params.push(limit);
        const r = await runSqlite(dbPath, sql, params);
        return { ok: r.ok, facts: r.rows || [] };
      },
    });

    ctx.tool.register({
      id: "detmem.stats",
      description: "Deterministic memory stats",
      parameters: { type: "object", properties: {} },
      async execute() {
        const r1 = await runSqlite(dbPath, "SELECT COUNT(*) AS c FROM transcripts;");
        const r2 = await runSqlite(dbPath, "SELECT COUNT(*) AS c FROM facts;");
        return { ok: true, transcripts: r1.rows?.[0]?.c || 0, facts: r2.rows?.[0]?.c || 0, dbPath };
      },
    });
  },
};
