# NotebookLM MCP Server (v2.1.0)

[![Version](https://img.shields.io/badge/version-2.1.0-purple.svg)](./CHANGELOG.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20Streamable--HTTP-green.svg)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Revived & upgraded fork ([`SHoussam/notebooklm-mcp`](https://github.com/SHoussam/notebooklm-mcp)) of the Google NotebookLM MCP server. Drives a real Chrome/Chromium browser via **Patchright** (stealth + persistent profile fingerprint) so AI coding agents (**Google Antigravity**, **Claude Code**, **Cursor**, **Codex**, HTTP workflows) can create/discover notebooks, upload **PDFs/files**, **YouTube videos**, **URLs**, and **text**, run multi-turn citation-grounded Q&A, and generate/export **all 11 NotebookLM Studio artifacts** (Audio, Video, Mind Map, Slide Deck, Infographic, Flashcards, Quiz, Briefing Doc, Study Guide, FAQ, Timeline).

- [What's New in v2.1.0](#whats-new-in-v210)
- [Requirements & Platform Support](#requirements--platform-support)
- [Install & Build](#install--build)
- [Connect to Google Antigravity](#connect-to-google-antigravity)
- [Connect to Claude Code, Cursor & Codex](#connect-to-claude-code-cursor--codex)
- [Authentication (`setup_auth`)](#authentication)
- [Transports (`stdio` & Multi-Session HTTP)](#transports)
- [Tools (26 Total)](#tools)
- [Tool Profiles](#tool-profiles)
- [Citations & Provenance](#citations--provenance)
- [Configuration Reference](#configuration-reference)
- [Development & Testing](#development--testing)

---

## What's New in v2.1.0

- **Remote Notebook Creation & Discovery**: `create_notebook` creates and titles a new notebook on `notebooklm.google.com` and registers it locally; `discover_notebooks` scans existing notebooks on your Google account.
- **PDF/File & YouTube Uploads + Source Listing**: `add_source` now supports `type="file"` (`.pdf`, `.md`, `.txt`, `.docx`, audio, images), `type="youtube"`, `type="url"`, and `type="text"`, paired with `list_sources`.
- **Full Studio Artifacts Suite**: `generate_studio_artifact`, `get_studio_status`, and `export_studio_artifact` unlock Video Overviews, Mind Maps, Slide Decks, Infographics, Flashcards, Quizzes, Briefing Docs, Study Guides, FAQs, and Timelines alongside Audio Overviews.
- **Native Windows + Multi-Session HTTP Fixes**:
  - Cross-platform Node `postbuild` (replaces Unix-only `chmod +x`).
  - Per-session `Server` factory so multiple Streamable-HTTP clients connect concurrently without `Already connected to a transport` errors.
  - Concurrency-safe `AsyncLocalStorage` per-request `CONFIG` scoping (`runWithConfig`), dynamic system timezone detection, and Windows Chrome profile lock protection during `setup_auth` / `cleanup_data`.
- **Antigravity Plugin Bundle**: Ships ready-to-enable plugin & skill files in [`antigravity-plugin/`](./antigravity-plugin).

---

## Requirements & Platform Support

- **Node.js** ≥ 18 (tested up to Node 26 on Windows 11).
- **Google Chrome** (stable channel) preferred; automatically falls back to bundled Patchright Chromium (`BROWSER_CHANNEL=chromium` to force).
- **Windows / macOS / Linux / WSL2**.

---

## Install & Build

```bash
git clone https://github.com/SHoussam/notebooklm-mcp.git
cd notebooklm-mcp
npm install
npm run check
npm test
```

`npm install` automatically compiles `dist/index.js` via `prepare`.

---

## Connect to Google Antigravity

### Option A — Antigravity Plugin + Skill Bundle (Recommended)

Copy [`antigravity-plugin/`](./antigravity-plugin) to `~/.gemini/config/plugins/notebooklm-plugin` (on Windows: `C:\Users\<you>\.gemini\config\plugins\notebooklm-plugin`), update the `dist/index.js` path in `mcp_config.json`, and enable `"notebooklm-plugin": { "enabled": true }` in `~/.gemini/config/config.json`.

### Option B — Direct `mcp_config.json` Entry

Add to `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "node",
      "args": ["C:/Users/<you>/.gemini/antigravity/scratch/notebooklm-mcp/dist/index.js"],
      "env": {
        "NOTEBOOKLM_PROFILE": "full"
      }
    }
  }
}
```

---

## Connect to Claude Code, Cursor & Codex

### Claude Code

```bash
claude mcp add notebooklm -- node /absolute/path/to/notebooklm-mcp/dist/index.js
```

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "node",
      "args": ["/absolute/path/to/notebooklm-mcp/dist/index.js"]
    }
  }
}
```

### Codex CLI

```bash
codex mcp add notebooklm node /absolute/path/to/notebooklm-mcp/dist/index.js
```

---

## Authentication

Authentication can be done either **interactively** via browser login or **instantly via session cookies/tokens** without opening any browser:

### Option 1 — Direct Cookie / Token Import (Fastest & Zero GUI Dependency)

If you are already logged in to Google / NotebookLM in your regular browser (Chrome, Edge, Brave, Firefox):

1. Go to `https://notebooklm.google.com/` in your browser.
2. Press `F12` → **Network** tab → refresh the page → click `notebooklm.google.com`.
3. In **Headers** → scroll to **Request Headers** → right click `Cookie` → **Copy value**.
4. Run in your terminal:
   ```bash
   npm run auth:cookies "<pasted_cookie_string>"
   ```
   *Or* call the `set_auth_cookies` MCP tool directly in your AI assistant:
   ```json
   {
     "cookies": "<pasted_cookie_string_or_json>"
   }
   ```

Accepts raw `Cookie:` header strings, Cookie-Editor JSON exports, or individual Google tokens (`SID`, `HSID`, `SSID`, `OSID`, `__Secure-1PSID`, `__Secure-3PSID`).

### Option 2 — Interactive Browser Setup

`setup_auth` opens a visible Chrome/Chromium window so you log in to Google once; session cookies persist in your per-user profile:

```bash
npm run auth
```

| Platform | Persistent Profile Path                                        |
| -------- | -------------------------------------------------------------- |
| Windows  | `%APPDATA%\notebooklm-mcp\chrome_profile\`                     |
| macOS    | `~/Library/Application Support/notebooklm-mcp/chrome_profile/` |
| Linux    | `~/.local/share/notebooklm-mcp/chrome_profile/`                |

- `get_health` — verify `authenticated: true/false` and active notebook state.
- `set_auth_cookies` — import session cookies/tokens directly without browser dependency.
- `setup_auth` — interactive Google login (closes any open sessions first to prevent Windows file locks).
- `re_auth` — wipe saved auth state and sign in with another Google account.
- `--account <slug>` / `NOTEBOOKLM_ACCOUNT=<slug>` — isolate multiple Google accounts under `<dataDir>/accounts/<slug>/`.

---

## Transports

### stdio (default)

```bash
node dist/index.js
```

### Multi-Session Streamable-HTTP

```bash
node dist/index.js --transport http --port 3000
```

| Method   | Path       | Purpose                                                |
| -------- | ---------- | ------------------------------------------------------ |
| `POST`   | `/mcp`     | JSON-RPC requests/responses (`Mcp-Session-Id` header)  |
| `GET`    | `/mcp`     | Server-Sent Events stream for active session           |
| `DELETE` | `/mcp`     | Terminate session                                      |
| `GET`    | `/healthz` | Liveness probe (`status`, `version`, `activeSessions`) |

---

## Tools

All **27 tools** are active under the `full` profile:

### Research Q&A (1)

| Tool           | Purpose                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask_question` | Multi-turn grounded Q&A against a notebook with optional DOM citation extraction (`source_format`: `none`, `inline`, `footnotes`, `json`) and `_provenance` metadata. |

### Notebooks & Library (10)

| Tool                 | Purpose                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `create_notebook`    | Create a new notebook on `notebooklm.google.com`, title it, and register/select it locally. |
| `discover_notebooks` | Scan the signed-in Google account's NotebookLM dashboard for existing notebooks.            |
| `add_notebook`       | Register an existing NotebookLM URL in the local library with rich metadata.                |
| `list_notebooks`     | List all notebooks in the local library.                                                    |
| `get_notebook`       | Get full metadata for one notebook by `id`.                                                 |
| `select_notebook`    | Set a notebook as the active default.                                                       |
| `update_notebook`    | Patch notebook metadata (`name`, `description`, `topics`, `tags`, `url`, etc.).             |
| `remove_notebook`    | Remove a notebook from the local library (does not delete it on Google).                    |
| `search_notebooks`   | Search local notebooks by keyword across name, description, topics, and tags.               |
| `get_library_stats`  | Library totals, active notebook, and query usage stats.                                     |

### Sources & Studio Artifacts (8)

| Tool                       | Purpose                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `add_source`               | Ingest `url`, `youtube`, `text`, or local `file` (`.pdf`, `.md`, `.txt`, `.docx`, audio, images) into a notebook.                                            |
| `list_sources`             | List source count and ordered source titles in a notebook's Sources sidebar.                                                                                 |
| `generate_studio_artifact` | Trigger any Studio output: `audio`, `video`, `mindmap`, `slide_deck`, `infographic`, `flashcards`, `quiz`, `briefing_doc`, `study_guide`, `faq`, `timeline`. |
| `get_studio_status`        | Poll all Studio tiles (`index`, `title`, `icon`, `ready` / `in_progress`).                                                                                   |
| `export_studio_artifact`   | Download binary Studio artifacts or extract `.md` Markdown to `destination_dir`.                                                                             |
| `generate_audio`           | Dedicated shortcut for podcast-style Audio Overview generation.                                                                                              |
| `get_audio_status`         | Poll Audio Overview readiness (`ready`, `in_progress`, `not_started`).                                                                                       |
| `download_audio`           | Save completed Audio Overview file to `destination_dir`.                                                                                                     |

### Browser Sessions & System (7)

| Tool            | Purpose                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `list_sessions` | Inspect active browser tabs, message counts, and idle times.             |
| `close_session` | Close a specific session by `session_id`.                                |
| `reset_session` | Reload notebook chat history while keeping `session_id`.                 |
| `get_health`    | Check auth status, active notebook, session pool, and runtime config.    |
| `setup_auth`    | Interactive one-time Google sign-in.                                     |
| `re_auth`       | Clear auth and log in with a different Google account.                   |
| `cleanup_data`  | Preview (`confirm=false`) or execute (`confirm=true`) deep data cleanup. |

---

## Tool Profiles

| Profile              | Included Tools                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimal` (5)        | `ask_question`, `get_health`, `list_notebooks`, `select_notebook`, `get_notebook`                                                                                       |
| `standard` (14)      | `minimal` + `setup_auth`, `list_sessions`, `create_notebook`, `discover_notebooks`, `add_notebook`, `update_notebook`, `search_notebooks`, `add_source`, `list_sources` |
| `full` (26, default) | All 26 tools                                                                                                                                                            |

---

## Citations & Provenance

Pass `source_format` (`"inline"`, `"footnotes"`, or `"json"`) to `ask_question` to extract structured `sources[]` (`{ index, title, excerpt, url? }`) from NotebookLM's citation drawer. Every `ask_question` response includes `_provenance` and an optional inline AI-generated safety marker (`NOTEBOOKLM_AI_MARKER=false` to disable).

---

## Configuration Reference

| Env Var                | Default       | Description                                                                |
| ---------------------- | ------------- | -------------------------------------------------------------------------- |
| `HEADLESS`             | `true`        | Run Chrome headless unless overridden per tool call (`show_browser=true`). |
| `BROWSER_LOCALE`       | `en-US`       | Browser UI locale (`en-US` recommended for selector reliability).          |
| `BROWSER_TIMEZONE`     | _(system TZ)_ | Browser IANA timezone (auto-detected from OS by default).                  |
| `ANSWER_TIMEOUT_MS`    | `600000`      | Max wait (ms) for NotebookLM answer synthesis.                             |
| `BROWSER_TIMEOUT`      | `30000`       | Per-action Playwright timeout (ms).                                        |
| `MAX_SESSIONS`         | `10`          | Max concurrent notebook tabs.                                              |
| `SESSION_TIMEOUT`      | `900`         | Idle session timeout (seconds).                                            |
| `NOTEBOOKLM_TRANSPORT` | `stdio`       | `stdio` or `http`.                                                         |
| `NOTEBOOKLM_PORT`      | `3000`        | Streamable-HTTP port.                                                      |
| `NOTEBOOKLM_HOST`      | `127.0.0.1`   | Streamable-HTTP bind host.                                                 |
| `NOTEBOOKLM_ACCOUNT`   | _(unset)_     | Isolated Google account profile slug.                                      |
| `NOTEBOOKLM_PROFILE`   | `full`        | Active tool profile (`minimal`, `standard`, `full`).                       |
| `BROWSER_CHANNEL`      | `chrome`      | Set `chromium` to force bundled Patchright Chromium.                       |

---

## Development & Testing

```bash
npm run format     # Prettier format src/ and tests/
npm run lint       # ESLint strict check (0 any, type-imports enforced)
npm run build      # TypeScript compile + cross-platform postbuild
npm run check      # format:check + lint + build
npm test           # Node test runner (config isolation, tools, multi-session HTTP)
```

---

## License

MIT. See [LICENSE](./LICENSE).
