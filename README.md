# detmem — Deterministic Memory for OpenCode V2

一個 **Zero LLM** 的 OpenCode V2 記憶插件：自動把每個 session 的對話寫進本機 SQLite（FTS5），
用固定正則抽出「決定 / TODO / 偏好 / 慣例」，並在下一次 prompt 前自動注入最相關的記憶。

不呼叫任何 AI Provider、不消耗 token、離線可用，結果完全可預測。

> 本 README 的每一項行為都在 **OpenCode v2.0.20** 上實測驗證過，不是照著文件推測的。

---

## 快速開始

### 1. 安裝

在 `~/.config/opencode/opencode.jsonc` 的 `plugins` 陣列加一筆（若尚未有 `plugins` 欄位請自行補上）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-memv2",
      "options": {
        "dbPath": "/Users/wclin/.opencode-detmem/detmem.sqlite"
      }
    }
  ]
}
```

`package` 可以是本機路徑（開發用）或 npm 套件名稱。
**不要**把整個資料夾複製到 `~/.config/opencode/plugins/`——V2 只會掃描那個目錄下的 `.js`，
複製進去的 `lib/*.js` 會被當成獨立外掛逐一載入而失敗。用 `plugins` 陣列指定專案根目錄即可。

若從 GitHub 安裝：

```bash
git clone https://github.com/wclinRD/opencode-memv2.git ~/opencode_memv2
```

### 2. 啟用

```bash
opencode service restart
```

確認載入（不應出現 `failed to load plugin`）：

```bash
grep 'msg="loading plugin"' ~/.local/share/opencode/log/opencode.log | tail -3
```

要看 detmem 自己的診斷訊息，得另外開 `options.debug`，因為外掛的 `console.error`
**不會**寫進 `opencode.log`：

```bash
tail -f ~/.opencode-detmem/detmem.log
```

### 3. 確認運作

在對話中輸入帶有結構化標記的內容：

```text
決定：記憶庫改用 node:sqlite
TODO：補上 system test
慣例：每次改動都要 commit
```

接著問 `detmem_stats`，應該會看到 `transcripts > 0`、`facts > 0`。

---

## 需求

| 項目 | 需求 |
|---|---|
| OpenCode | v2.0.x（實測 v2.0.20） |
| Runtime | 內建 `node:sqlite`。Bun >= 1.4（OpenCode 內建的 Bun 已滿足）；若改用 Node 跑測試需 **>= 22.13.0**（`node:sqlite` 在 22.6 時還得加 `--experimental-sqlite`） |
| 額外相依 | **無**。不需要 `sqlite3` CLI、不需要向量資料庫、不需要任何模型 |

---

## 運作機制

| 時機 | 行為 |
|---|---|
| `session.step.ended`（5 秒 debounce） | 讀取 `ctx.session.context({ sessionID })` 全部訊息 → 寫入 `transcripts` + FTS5 → 執行規則式 Facts 抽取 |
| 使用者 prompt 送出前 | `prompt` hook 以 prompt 前 160 字檢索，將 Top-K 事實與片段注入 prompt 最前面 |
| 外掛卸載 | 取消事件訂閱，並關閉 SQLite handle（下次 `getDb` 會自動重開） |

寫入以 `message_id` 唯一索引去重，重複擷取不會產生重複列。

---

## 工具

| 工具 | 參數 | 說明 |
|---|---|---|
| `detmem_search` | `{ query: string, limit?: number }` | 同時回傳 `transcripts`（FTS5 snippet `【…】`）與 `facts` |
| `detmem_list_facts` | `{ kind?: "decision" \| "todo" \| "preference" \| "convention", limit?: number }` | 列出事實，可依 kind 篩選 |
| `detmem_stats` | `{}` | `transcripts` / `fts` / `facts` 筆數、`inSync` 一致性、`dbPath` |

`inSync` 必須為 `true`；為 `false` 代表 FTS 索引與 `transcripts` 對不上。
**重開外掛即可修復**——`migrate` 每次開啟都會用與本表**完全相同**的判準（`ftsDrift()`）
檢查索引，缺漏的鏡射列補回、孤兒列刪除；舊的 `unicode61` 索引則整個重建為 `trigram`。
因為修復與診斷共用同一組判準，`inSync: false` 不可能出現「修不好」的狀態。
寫入端設有 `PRAGMA busy_timeout = 5000`：`setup()` 每個專案目錄各跑一次，多個實例
（或第二個 opencode server）會競爭同一個檔案，這讓寫入最多等 5 秒再報錯。

---

## 選項

| 選項 | 預設 | 說明 |
|---|---|---|
| `dbPath` | `~/.opencode-detmem/detmem.sqlite` | 資料庫位置，父目錄會自動建立 |
| `debug` | `false` | 開啟檔案除錯日誌。**預設關閉**，開著會持續寫檔且不會自動輪替 |
| `debugFile` | `<dbPath 旁邊>/detmem.log` | 除錯日誌路徑 |

> **為什麼需要檔案日誌？** V2 外掛的 `console.error` 不會寫進 `~/.local/share/opencode/log`，
> 除錯時完全看不到輸出。要排查問題時才開 `"debug": true`，看 `detmem.log`，
> 解決後把它關回去——日誌會一直成長。

### 清空記憶

要從零開始（換專案、忘記曾記錄的內容、或除錯後想清掉雜訊），
停掉服務後刪掉整個資料庫即可；外掛下次啟動會自動重建 schema：

```bash
rm -f ~/.opencode-detmem/detmem.sqlite*
rm -f ~/.opencode-detmem/detmem.log
opencode service restart
```

這是**不可逆**的， transcripts 與 facts 一併刪除。

---

## 規則式 Facts 抽取

| 偵測模式 | kind | confidence |
|---|---|---|
| `^(?:決定|Decision|DECISION)[:：]\s*(.+)$` | `decision` | 0.90 |
| `^(?:TODO|待辦|ToDo)[:：]\s*(.+)$`（不分大小寫） | `todo` | 0.85 |
| `^(?:偏好|Preference)[:：]\s*(.+)$`（不分大小寫） | `preference` | 0.85 |
| `^(?:慣例|Convention|規則)[:：]\s*(.+)$`（不分大小寫） | `convention` | 0.88 |
| `(?:建議使用|採用|use)\s+([^\s,;]+)`，且該詞像技術名 | `convention` | 0.70 |

最後一條有兩道關卡：單次抽取最多 20 筆，且該詞必須通過 `looksLikeTech`（含 `.` `:` `_` `-` `/` `@`，
或**含任何大寫字母**——實際判定是 `/[A-Z]/`，所以 `Node`、`Tuesday` 也會通過。
純小寫的英文字被視為散文而排除（`/^[a-z0-9]+$/`，所以 `utf8`、`v2` 也不行）。
中文則只要落在 `U+3400–U+9FFF` 且長度 >= 2 就通過——注音、韓文與 CJK 擴充區不涵蓋在內。
這是必要的：`use` 是文中最常見的英文字，若不加檢查，它會把 `use the` 的 `the`
當成「建議使用的技術」存進資料庫——實測曾因此讓事實表累積 135 筆垃圾。

另外 `opencode run` 送出的 prompt 會被伺服器用**字面雙引號包起來**儲存，
所以行首實際是 `"決定：…` 而非 `決定：…`。抽取前會去除行首行尾的引號與項目符號，
否則所有 CLI 來源的決定都會漏掉。

---

## 中文檢索：為什麼用 trigram

SQLite FTS5 預設的 `unicode61` **完全無法切分中文**——整句話會被當成一個 token，
實測查詢「資料庫」在 `unicode61` 索引下命中 0 筆。

因此索引改用 `trigram`，並在查詢時把中文連續字串展開成重疊的三元組：

```text
buildFtsQuery("資料庫遷移")
  → "資料庫" OR "料庫遷" OR "庫遷移"
```

trigram 無法匹配**少於 3 個字元**的詞，所以另外保留一條 LIKE 備援路徑（取最長的連續字串）。

兩路是**依序串接**、並不重新混排：FTS 結果維持 SQL 內的 bm25 排序，LIKE-only 的結果依 `ts DESC`
接在後面。因此一個很舊的 LIKE 命中不會壓過 FTS 命中——這是刻意的，因為 LIKE 那一路沒辦法為它的
結果算 bm25 分數。`%`、`_`、`\` 在 LIKE 樣式中都會被逸出，否則 `a_c` 會連 `aXc` 一起命中。

FTS5 的語法字元（`"`, `*`, `(`, `-`, `OR` …）在組 query 前一律中性化，
惡意輸入只會退化成「查不到」，不會讓整個查詢丟例外。

---

## 資料庫結構

```sql
CREATE TABLE transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,          -- OpenCode 訊息 ID，唯一索引，去重用
  session_id TEXT NOT NULL,
  title TEXT,
  ts TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0,
  project_dir TEXT
);

CREATE VIRTUAL TABLE transcripts_fts USING fts5(
  content,
  session_id UNINDEXED, role UNINDEXED, ts UNINDEXED,
  tokenize = 'trigram'
);

CREATE TABLE facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,        -- decision / todo / preference / convention
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project',
  project_dir TEXT,
  confidence REAL NOT NULL DEFAULT 0.8,
  ts TEXT NOT NULL,
  sources TEXT
);
```

- WAL 模式，讀寫不互相阻塞。
- `facts` 上有 `(kind, key, scope, COALESCE(project_dir,''))` 唯一索引——是**運算式索引**，因為 SQLite 在唯一索引中視 NULL 為相異，不加 `COALESCE` 會讓每個沒有專案目錄的列都插得進來。事實代表**當前狀態**而非稽核紀錄，
  重複擷取只會更新既有列（最新值勝出），不會無限增生。
- 舊版資料庫會自動升級：補上缺少的欄位、替換 `unicode61` 索引為 `trigram` 並回填。
  索引**只在確定缺失或過期時**才重建，避免每次啟動 OpenCode 都阻塞數秒。

---

## 測試

```bash
npm test          # 55 項單元/整合測試，真實 SQLite，無 mock
npm run test:bun  # 同上，在 Bun（OpenCode 的 runtime）下驗證
npm run test:system
```

`test:system` 是端對端測試：真的啟動 `opencode run` 對話，斷言 prompt 確實被寫入資料庫、
可被檢索、且能抽出 facts。因為需要外掛已安裝且會實際呼叫模型，預設不執行。

> 系統測試斷言的是**含有該次專屬隨機標記的那一列**，而不是「總列數增加」。
> 開發者自己正在被擷取的 session 會不斷寫入同一個資料庫，只看總數會得到假陽性。

---

## OpenCode V2 API 實測筆記

前一版外掛是照著 V1 寫的，載入成功但**完全沒有作用**。以下每一點都是對著 live server 量出來的，
因為 V2 的 SDK 型別宣告與實際 runtime **不一致**（`@opencode-ai/plugin` 套件裡甚至找不到
`session` / `event` / `tool` 這些實際存在的 API）：

| 項目 | V1 / 文件寫的 | V2.0.20 實測 |
|---|---|---|
| 設定來源 | `ctx.config` | `ctx.options` |
| 訂閱事件 | `ctx.event.subscribe(callback)` | 回傳 AsyncIterable，必須 `for await` |
| 事件資料 | `event.properties` | `event.data`（`properties` 是 `undefined`） |
| 取得訊息 | `ctx.client.session.messages()` | `ctx.session.context({ sessionID })` |
| 訊息結構 | `{ info, parts }` | **扁平陣列**，角色在 `entry.type` |
| 使用者文字 | `parts[].text` | `entry.text`（字串） |
| 助理文字 | `parts[].text` | `entry.content[].text` |
| 時間 | ISO 字串 | `entry.time.created`（epoch 毫秒） |
| 對話結束 | `session.idle` | **從不發出**（實測 0 次）；改用 `session.step.ended` |
| 仍會訂閱 | — | `CAPTURE_EVENTS` 仍含 `session.compacted` 與 `session.idle`，只是實測收不到 |
| 註冊工具 | `ctx.tool.register` | `ctx.tool.transform(editor => …)` |
| 工具命名 | `editor.namespace()` | 無效果，工具會以裸名稱曝露 |

最後一項尤其重要：`editor.namespace()` 不在 SDK 型別裡，實測也不會套用前綴，
工具會以 `search`、`stats` 這種通用名稱註冊，可能**覆蓋同名內建工具**。
因此本專案直接用具體前綴命名（`detmem_search` 等）。

`ctx.session.context()` 的回傳陣列裡還包含 `type: "idle"` 的標記項目，用來表示一輪結束；
它沒有文字內容，會被自動略過。

---

## 疑難排解

| 問題 | 處理方式 |
|---|---|
| 沒看到外掛載入 | 確認用的是 `plugins` 陣列而非複製到 `plugins/` 目錄；接著 `opencode service restart` |
| 看不到任何日誌 | 開 `"debug": true`，再看 `~/.opencode-detmem/detmem.log` |
| `transcripts` 一直是 0 | 先確認 `detmem_stats` 能回應（代表外掛有載入）；再看 `detmem.log` 是否有 `capture` 行 |
| 搜尋中文沒結果 | 確認 `inSync` 為 `true`；`false` 時重開外掛會自動補齊或刪除多餘的鏡射列，舊的 `unicode61` 索引也會重建為 `trigram` |
| 事實表出現無意義內容 | 對應到 `decision` / `todo` 等標記行，屬預期行為；`convention` 已過濾英文虛詞 |

---

## 授權

MIT
