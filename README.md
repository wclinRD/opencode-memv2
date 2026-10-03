# OpenCode Deterministic Memory (detmem) v2

一個 **OpenCode V2 專用**、**完全不需要 LLM（Zero LLM）** 的決定性記憶插件。

> 精準對應需求：自動捕捲 Session Transcript（決定性儲存）＋ 規則式 Facts 抽取（專案慣例/決策/TODO），提供 FTS5 全文檢索與自動 Context 注入。

## 核心特色

- **Zero LLM / 決定性（Deterministic）** — 完全不呼叫任何 AI Provider、不消耗 Token、不依賴模型載入狀態，零延遲、完全離線。
- **自動 Capture（Session Transcript）** — 訂閱 OpenCode V2 事件（`session.idle`、`session.compacted`、`session.updated`），自動讀取整個 Session 訊息並寫入 SQLite + FTS5。
- **原始 Transcript 決定性儲存** — 儲存原始對話內容（過濾 `thought/tool_call/tool_result` synthetic 部分），可追溯「我之前做過什麼、當時選了什麼」。
- **規則式 Facts 抽取** — 純正則式自動萃取 `決定`、`Decision`、`TODO`、`待辦`、`偏好`、`Preference`、`慣例`、`Convention`、`建議使用 ...` 等結構化事實。
- **FTS5 全文檢索（BM25）** — 使用 SQLite FTS5 搭配 `bm25()` 排序，支援繁體中文關鍵字檢索，無需向量模型也有良好檢索體驗。
- **自動 Context 注入** — `session.hook("prompt")` 在每次使用者 Prompt 前，自動根據 Prompt 前 120 字搜尋最相關的 Snippets 與 Facts，僅注入 Top-K，避免上下文膨脹。
- **事件溯源 + 專案慣例** — 同時滿足「跨 Session 找回過去的決策」（事件溯源）與「自動帶入專案慣例/偏好」（結構化 Facts）。

## 與 opencode-mem 對比

| 面向 | opencode-mem（tickernelz） | detmem（本插件） |
|---|---|---|
| **自動 Capture** | 需要 LLM（auto-capture 要求 AI Provider） | **完全不需要 LLM**（決定性事件驅動） |
| **巢狀 Session 403（Free Tier）** | 容易觸發（plugin 內部合成 session） | **不會觸發**（不建立巢狀 LLM session，只讀取現有訊息） |
| **延遲/穩定性** | 依賴模型回應（可能 10s–90s 逾時） | **即時/零延遲**（僅 DB 寫入） |
| **離線可用** | 部分路徑需網路或本機模型常駐 | **完全離線** |
| **儲存方式** | Turso/libSQL + 向量 | **SQLite + FTS5（純檔案、本機）** |
| **結構化抽取** | LLM 摘要（非決定性） | **規則式 Facts（決定性、可預測）** |
| **Context 注入** | 由 plugin 決定時機 | **`prompt` hook 自動注入**（可控、精準） |

## 系統需求

- OpenCode **v2.0.x**（已在 v2.0.20 驗證）
- Node.js >= 22.6.0（OpenCode V2 環境已滿足）
- `sqlite3` CLI（macOS 預設已安裝 `/usr/bin/sqlite3` 或 `sqlite3` 在 PATH）

## 安裝方式（給 LLM/AI 助理）

最簡單、最穩定的安裝方式是**直接從 GitHub 複製整個資料夾到 OpenCode plugins 目錄**。

### 方式 1：Git Clone（推薦，支援未來更新）

```bash
mkdir -p ~/.config/opencode/plugins
git clone https://github.com/wclinRD/opencode-memv2.git ~/.config/opencode/plugins/detmem
opencode service restart
```

### 方式 2：curl + tar（無需 git）

```bash
mkdir -p ~/.config/opencode/plugins/detmem
curl -L https://github.com/wclinRD/opencode-memv2/archive/refs/heads/main.tar.gz | tar -xz -C /tmp
cp -R /tmp/opencode-memv2-main/detmem/* ~/.config/opencode/plugins/detmem/
rm -rf /tmp/opencode-memv2-main
opencode service restart
```

### 方式 3：單一檔案安裝（最精簡）

```bash
mkdir -p ~/.config/opencode/plugins/detmem
curl -L https://raw.githubusercontent.com/wclinRD/opencode-memv2/main/index.js -o ~/.config/opencode/plugins/detmem/index.js
opencode service restart
```

### 方式 4：手動複製（本地開發）

如果你已經下載此 repo 到本機：

```bash
cp -R /path/to/opencode-memv2/detmem ~/.config/opencode/plugins/
opencode service restart
```

**安裝後確認**：

```bash
opencode plugin list | grep detmem
```

應該顯示：

```text
detmem  local  /Users/wclin/.config/opencode/plugins/detmem/index.js
```

> OpenCode V2 會自動掃描 `~/.config/opencode/plugins/` 底下的 `.js` 檔案與子資料夾，載入後即自動生效。

## 設定

預設即可運作，無需額外設定。資料庫預設位置：

```text
~/.opencode-detmem/detmem.sqlite
```

如需自訂資料庫路徑，可在 `~/.config/opencode/opencode.jsonc` 加入：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "id": "detmem",
      "options": {
        "dbPath": "/Users/wclin/.opencode-detmem/detmem.sqlite"
      }
    }
  ]
}
```

## 啟用插件

1. 複製插件到正確路徑
2. 重新啟動 OpenCode 背景 Service

```bash
opencode service restart
```

3. 確認插件已載入

```bash
opencode plugin list
```

應該出現：

```text
detmem  local  /Users/wclin/.config/opencode/plugins/detmem/index.js
```

4. 重新啟動 OpenCode TUI（`Ctrl+Q` 或重新開啟終端機）

## 自動運作機制

插件啟用後會**自動**運作，不需要任何手動操作。

| 事件 | 行為 |
|---|---|
| `session.idle` | Session 閒置時自動捕捲整個 Transcript → 寫入 SQLite + FTS5 → 執行規則式 Facts 抽取 |
| `session.compacted` | Compaction 時補抓，避免遺漏 |
| `session.updated` | Fallback 保險觸發 |
| 使用者送出 Prompt 前 | `prompt` hook 自動搜尋相關記憶（FTS5 + Facts），注入至 Prompt 最前方（`# Deterministic Memory (detmem)` 區塊） |

## 可用工具（Agent Tools）

插件註冊了 3 個 Tool，可在對話中直接呼叫：

| Tool | 參數 | 說明 |
|---|---|---|
| `detmem.search` | `{ query: string, limit?: number }` | 搜尋決定性記憶。回傳 `transcripts`（含 FTS5 snippet `【...】`）與 `facts`（規則式事實）。 |
| `detmem.list_facts` | `{ kind?: "decision" \| "todo" \| "preference" \| "convention", limit?: number }` | 列出規則式 Facts。可依 `kind` 篩選，按時間倒序。 |
| `detmem.stats` | `{}` | 顯示統計：`transcripts`、`facts` 筆數、`dbPath`。 |

### 使用範例

```text
# 搜尋過去相關討論
呼叫 detmem.search，query="TypeScript Vite"

# 列出所有 TODO
呼叫 detmem.list_facts，kind="todo"

# 檢查統計
呼叫 detmem.stats
```

## 規則式 Facts 抽取（Patterns）

以下正則模式會自動被偵測並存入 `facts` 表（`kind` 對應如下）：

| 偵測模式 | kind | confidence |
|---|---|---|
| `^(決定|Decision|DECISION)[:：]\s*(.+)$` | `decision` | 0.90 |
| `^(TODO|待辦|ToDo)[:：]\s*(.+)$` | `todo` | 0.85 |
| `^(偏好|Preference|偏愛)[:：]\s*(.+)$` | `preference` | 0.85 |
| `^(慣例|Convention|規則)[:：]\s*(.+)$` | `convention` | 0.88 |
| `(?:建議使用|use|採用)\s+([A-Za-z0-9_\-./@]+(?:\s*,\s*[A-Za-z0-9_\-./@]+)*)` | `convention` | 0.70 |

> 這些是純規則、決定性，不會有幻覺（Hallucination）。你也可以直接在對話中用這些標籤讓它自動結構化記錄。

## 資料庫結構

```sql
-- 原始 Transcript
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

-- FTS5 全文檢索（BM25）
CREATE VIRTUAL TABLE transcripts_fts USING fts5(
  content,
  session_id UNINDEXED,
  role UNINDEXED,
  ts UNINDEXED,
  tokenize = 'unicode61'
);

-- 規則式 Facts
CREATE TABLE facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,        -- decision/todo/preference/convention
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project',
  project_dir TEXT,
  confidence REAL NOT NULL DEFAULT 0.8,
  ts TEXT NOT NULL,
  sources TEXT
);
```

使用 `WAL`（Write-Ahead Logging）模式，效能與穩定性較好。

## 驗證步驟

### 1. 確認 Plugin 載入

```bash
opencode plugin list | grep detmem
```

### 2. 產生測試對話

開啟 `opencode`，輸入：

```text
決定：這個專案先用 TypeScript + Vite
TODO：明天補寫單元測試
慣例：API 請求統一放在 services/ 資料夾
建議使用 zod 做 schema 驗證
```

等待 30–60 秒讓 Session 進入 `idle`（自動觸發 Capture）。

### 3. 檢查統計

在對話中呼叫：

```text
呼叫 detmem.stats
```

或直接使用 Tool：應該看到 `transcripts > 0`、`facts > 0`。

### 4. 測試搜尋

```text
呼叫 detmem.search，query="Vite"
呼叫 detmem.search，query="zod"
呼叫 detmem.search，query="services"
```

應回傳包含 `【...】` FTS Snippet 的結果。

### 5. 測試 Context 自動注入

開新 Session，輸入：

```text
這個專案要用什麼打包工具？
```

觀察第一段回應前是否自動帶入 `# Deterministic Memory (detmem)` 區塊（包含相關 Facts 與 Snippets）。有帶入即代表 `prompt` hook 自動注入正常運作。

## 安全性與隱私

- **完全本機**：所有資料只存在 `~/.opencode-detmem/detmem.sqlite`，不會傳送到任何外部服務。
- **決定性過濾**：預設過濾 `thought`、`tool_call`、`tool_result`、`synthetic` 訊息，只儲存可讀對話，避免汙染記憶庫。
- **零追蹤**：無 Telemetry、無 Analytics、無外部請求。

## 疑難排解

| 問題 | 解法 |
|---|---|
| `sqlite3: command not found` | 安裝 SQLite CLI（`brew install sqlite3` 或系統已預裝 macOS 一般都有）。 |
| Plugin 沒出現在 `plugin list` | 檢查路徑 `~/.config/opencode/plugins/detmem/index.js` 是否存在，執行 `opencode service restart` 後再確認。 |
| Capture 沒有觸發（transcripts 為 0） | OpenCode 需進入 `session.idle` 才會觸發。可多做幾輪對話後靜置 30–60 秒，或手動呼叫 `detmem.stats` 等待片刻再檢查。 |
| Context 沒有自動注入 | 僅在**使用者 Prompt** 送出前觸發（`prompt` hook）。Agent 自主思考的內部步驟不會觸發。確認是在新 Session 且輸入使用者問題時測試。 |

## 授權

MIT License

## 版本

v2.0.0 — 專為 OpenCode V2 設計，Zero LLM、自動 Capture、FTS5 + 規則式 Facts。