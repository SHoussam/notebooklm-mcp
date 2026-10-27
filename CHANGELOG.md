# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-10-27

Revived & upgraded release in `SHoussam/notebooklm-mcp` adding full NotebookLM
Studio artifacts, local file/PDF & YouTube uploads, remote notebook creation &
discovery, Antigravity plugin packaging, and critical Windows + multi-session
HTTP fixes.

### Added

- **Zero-GUI session cookie & token authentication**:
  - `set_auth_cookies` — imports Google authentication cookies or session tokens directly
    without needing a browser window. Accepts raw `Cookie:` header strings from DevTools Network
    tab, Cookie-Editor JSON arrays, or key-value token maps (`SID`, `HSID`, `SSID`, `OSID`,
    `__Secure-1PSID`, `__Secure-3PSID`).
  - `npm run auth:cookies "<string>"` / `npm run auth:token` CLI entrypoints.
  - Replaced hardcoded 24-hour file age invalidation with real cookie expiration date verification.
- **Remote notebook creation & discovery**:
  - `create_notebook` — creates a brand-new notebook on `notebooklm.google.com`,
    sets its title, and automatically registers + activates it in the local library.
  - `discover_notebooks` — scans the signed-in Google account's NotebookLM home
    dashboard and returns existing notebooks' titles, UUIDs, and URLs.
- **Expanded source ingestion & inspection**:
  - `add_source` widened to `type: "url" | "youtube" | "text" | "file"` — supports
    uploading local `.pdf`, `.md`, `.txt`, `.docx`, audio, and image files via
    `<input type="file">` / native `filechooser` fallback with pre-flight path validation,
    plus dedicated YouTube transcript indexing.
  - `list_sources` — enumerates all sources currently loaded in a notebook's
    Sources sidebar (`count` + ordered `sources[]`).
- **Unified Studio Artifacts engine (`src/notebooklm/studio.ts`)**:
  - `generate_studio_artifact` — triggers any of the 11 NotebookLM Studio outputs:
    `audio`, `video`, `mindmap`, `slide_deck`, `infographic`, `flashcards`,
    `quiz`, `briefing_doc`, `study_guide`, `faq`, and `timeline` (supports both
    direct Studio chips and nested Reports dialogs, plus `custom_prompt`).
  - `get_studio_status` — lists all tiles in the Studio panel with 1-based index,
    title, icon, and `ready` vs `in_progress` status across 8 UI locales.
  - `export_studio_artifact` — downloads binary media (Audio, Video, Slides,
    Infographic, Mind Map) or extracts Markdown (`.md`) for Reports, Flashcards,
    and Quizzes into `destination_dir`.
- **Google Antigravity Plugin bundle (`antigravity-plugin/`)**:
  - Ready-to-install `plugin.json`, `mcp_config.json`, and `skills/notebooklm/SKILL.md`.
- **Automated test suite (`tests/server-and-config.test.ts`)**:
  - Covers `AsyncLocalStorage` concurrent config isolation, multi-session
    Streamable-HTTP clients, 26-tool profile filtering, selector ordering, and
    file upload pre-validation.

### Fixed

- **Windows `npm install` / `npm run build` crash**: replaced Unix-only
  `chmod +x dist/index.js` in `postbuild` with cross-platform Node `fs.chmodSync`.
- **Streamable-HTTP multi-session crash**: `NotebookLMMCPServer` now instantiates
  a dedicated MCP protocol `Server` per transport session (`createProtocolServer()`),
  fixing `Already connected to a transport` when a second HTTP client connects.
- **Concurrent `CONFIG` mutation race**: replaced `Object.assign(CONFIG, ...)`
  in tool handlers with `AsyncLocalStorage`-backed `runWithConfig(...)`, and wired
  `browser_options.timeout_ms` to update `answerTimeoutMs` as well as `browserTimeout`.
- **Windows Chrome profile `EBUSY` locks during `setup_auth` & `cleanup_data`**:
  active sessions and shared persistent contexts are now closed before touching
  `chrome_profile` on disk, without killing the background idle-session reaper timer.
- **2026 NotebookLM DOM selectors**: fixed `sourceTypeUrl` ordering so URL sources
  no longer click `youtube-icon` first, wired `Selectors.chat.queryInput` into
  `BrowserSession` with empty-notebook modal Escape recovery, and replaced the
  hardcoded `Europe/Berlin` browser timezone with dynamic system timezone detection.

## [2.0.0] - 2026-04-30

Major release that closes the issue backlog and replaces the brittle parts of
the v1.x extraction stack with a single source of truth. v1 is no longer
supported.

### Added

- **Streamable-HTTP transport** (`--transport http --port 3000`) using the
  MCP SDK's `StreamableHTTPServerTransport`. Supports the spec's session
  header model so multiple clients can share one server. Closes #4 / #7.
- **`add_source` tool** for programmatic source ingestion (URL or pasted text,
  with auto-confirmed insertion and source-count verification). Closes #25.
- **Audio Overview tools**: `generate_audio` + `download_audio`. Audio is the
  most-asked Studio output; Video / Infographic / Slides are tracked for a
  follow-up. Closes #11 (audio scope).
- **Citations on `ask_question`**: new `source_format` argument (`none`,
  `inline`, `footnotes`, `json`) populates a structured `sources[]` field
  by reading the DOM citation panel after the answer settles. Closes #20.
- **Multi-account support** via `--account <name>` / `NOTEBOOKLM_ACCOUNT`.
  Each account gets an isolated Chrome profile under
  `~/.local/share/notebooklm-mcp/accounts/<name>/`. No credential storage —
  authentication is still handled by Chrome's persistent profile. Closes #2.
- **Bundled-Chromium fallback** (`BROWSER_CHANNEL=chromium` /
  `NOTEBOOKLM_BROWSER_CHANNEL=chromium`). Used automatically when system
  Chrome refuses to launch. Closes #13 (macOS Tahoe), #19 (Windows exit 21).
- **`ANSWER_TIMEOUT_MS`** env var + `browser_options.timeout_ms` parameter
  to override the answer wait. Default raised to 600 s. Closes #14, #27.
- **Provenance envelope** on `ask_question` results: `_provenance` field +
  AI-generated marker prefix (`NOTEBOOKLM_AI_MARKER=false` to opt out).
  Closes #42.

### Changed

- **Streaming-stability answer detection** replaces the broken
  `div.thinking-message` poll. Answers settle when the text is identical
  across N consecutive 750 ms polls. Robust against the 2026 NotebookLM UI
  changes that broke v1.x. Closes #43.
- **`FOLLOW_UP_REMINDER` is opt-in** via `NOTEBOOKLM_FOLLOW_UP_REMINDER=true`.
  The previous default tripped prompt-injection guards on safety-trained
  host agents. Closes #28.
- **Selector registry** (`src/notebooklm/selectors.ts`) is now the single
  source of truth for every CSS / aria selector targeting NotebookLM. UI
  changes from Google now require touching exactly one file.
- **Browser-launch lifecycle** moved into a dedicated module with profile
  strategy fallback (`auto` → isolated profile when the base profile is
  locked) and aggressive shutdown watchdog. Closes #29.
- **Watchdog poll loop**: bounded poll count + Node-side sleep fallback +
  periodic `page.evaluate(() => true)` health check. Defuses zombie tabs
  that previously turned the answer wait into a 100 % CPU spin. Closes #16.
- **Resource error message** for unknown URIs now lists the supported set
  (`notebooklm://library`, `notebooklm://library/{id}`, `notebooklm://metadata`).
  Closes #15.
- **Library metadata accessors** in `src/library/metadata.ts` defend against
  notebooks loaded from disk that omit `topics`/`use_cases`/`content_types`.
  Replaces the bare `.join()` / `.map()` calls that crashed
  `buildAskQuestionDescription`. Closes #33.

### Tooling

- ESLint flat config + Prettier added with `npm run lint`, `npm run format`,
  `npm run check`. Build is now type-safe with no `any` casts and DOM types
  enabled for in-page evaluations.
- TypeScript `lib` widened to `["ES2022", "DOM", "DOM.Iterable"]`.
- New tools registered in MCP profile: `add_source`, `generate_audio`,
  `download_audio` (full profile only by default).

### Removed

- Hard-coded `120 000 ms` answer timeout in `BrowserSession.ask`.
- Unused `ServerState` interface and the dead `as any` chain across
  resource handlers, browser session, shared-context manager, and the
  config env-override path.
- Reliance on `div.thinking-message` for answer completion.

### Migration Notes

- v1 callers that depended on the old answer prefix should set
  `NOTEBOOKLM_AI_MARKER=false` if they want the unprefixed answer back.
- v1 callers that depended on the appended follow-up reminder must opt in
  via `NOTEBOOKLM_FOLLOW_UP_REMINDER=true`.
- The default answer timeout grew from 120 s to 600 s. Lower it explicitly
  via `ANSWER_TIMEOUT_MS` if you relied on the 2-minute ceiling for
  fail-fast behaviour.

## [1.2.0] - 2025-11-21

### Added

- **Tool Profiles System** - Reduce token usage by loading only the tools you need
  - Three profiles: `minimal` (5 tools), `standard` (10 tools), `full` (16 tools)
  - Persistent configuration via `~/.config/notebooklm-mcp/settings.json`
  - Environment variable overrides: `NOTEBOOKLM_PROFILE`, `NOTEBOOKLM_DISABLED_TOOLS`

- **CLI Configuration Commands** - Easy profile management without editing files
  - `npx notebooklm-mcp config get` - Show current configuration
  - `npx notebooklm-mcp config set profile <name>` - Set profile (minimal/standard/full)
  - `npx notebooklm-mcp config set disabled-tools <list>` - Disable specific tools
  - `npx notebooklm-mcp config reset` - Reset to defaults

### Changed

- **Modularized Codebase** - Improved maintainability and code organization
  - Split monolithic `src/tools/index.ts` into `definitions.ts` and `handlers.ts`
  - Extracted resource handling into dedicated `ResourceHandlers` class
  - Cleaner separation of concerns throughout the codebase

### Fixed

- **LibreChat Compatibility** - Fixed "Server does not support completions" error
  - Added `prompts: {}` and `logging: {}` to server capabilities
  - Resolves GitHub Issue #3 for LibreChat integration

- **Thinking Message Detection** - Fixed incomplete answers showing placeholder text
  - Now waits for `div.thinking-message` element to disappear before reading answer
  - Removed unreliable text-based placeholder detection (`PLACEHOLDER_SNIPPETS`)
  - Answers like "Reviewing the content..." or "Looking for answers..." no longer returned prematurely
  - Works reliably across all languages and NotebookLM UI changes

## [1.1.2] - 2025-10-19

### Changed

- **README Documentation** - Added Claude Code Skill reference
  - New badge linking to [notebooklm-skill](https://github.com/PleasePrompto/notebooklm-skill) repository
  - Added prominent callout section explaining Claude Code Skill availability
  - Clarified differences between MCP server and Skill implementations
  - Added navigation link to Skill repository in top menu
  - Both implementations use the same browser automation technology

## [1.1.1] - 2025-10-18

### Fixed

- **Binary executable permissions** - Fixed "Permission denied" error when running via npx
  - Added `postbuild` script that automatically runs `chmod +x dist/index.js`
  - Ensures binary has executable permissions after compilation
  - Fixes installation issue where users couldn't run the MCP server

### Repository

- **Added package-lock.json** - Committed lockfile to repository for reproducible builds
  - Ensures consistent dependency versions across all environments
  - Improves contributor experience with identical development setup
  - Enables `npm ci` for faster, reliable installations in CI/CD
  - Follows npm best practices for library development (2025)

## [1.1.0] - 2025-10-18

### Added

- **Deep Cleanup Tool** - Comprehensive system cleanup for fresh NotebookLM MCP installations
  - Scans entire system for ALL NotebookLM files (installation data, caches, logs, temp files)
  - Finds hidden files in NPM cache, Claude CLI logs, editor logs, system trash, temp backups
  - Shows categorized preview before deletion with exact file list and sizes
  - Safe by design: Always requires explicit confirmation after preview
  - Cross-platform support: Linux, Windows, macOS
  - Enhanced legacy path detection for old config.json files
  - New dependency: globby@^14.0.0 for advanced file pattern matching
- CHANGELOG.md for version tracking
- Changelog badge and link in README.md

### Changed

- **Configuration System Simplified** - No config files needed anymore!
  - `config.json` completely removed - works out of the box with sensible defaults
  - Settings passed as tool parameters (`browser_options`) or environment variables
  - Claude can now control ALL browser settings via tool parameters
  - `saveUserConfig()` and `loadUserConfig()` functions removed
- **Unified Data Paths** - Consolidated from `notebooklm-mcp-nodejs` to `notebooklm-mcp`
  - Linux: `~/.local/share/notebooklm-mcp/` (was: `notebooklm-mcp-nodejs`)
  - macOS: `~/Library/Application Support/notebooklm-mcp/`
  - Windows: `%LOCALAPPDATA%\notebooklm-mcp\`
  - Old paths automatically detected by cleanup tool
- **Advanced Browser Options** - New `browser_options` parameter for browser-based tools
  - Control visibility, typing speed, stealth mode, timeouts, viewport size
  - Stealth settings: Random delays, human typing, mouse movements
  - Typing speed: Configurable WPM range (default: 160-240 WPM)
  - Delays: Configurable min/max delays (default: 100-400ms)
  - Viewport: Configurable size (default: 1024x768, changed from 1920x1080)
  - All settings optional with sensible defaults
- **Default Viewport Size** - Changed from 1920x1080 to 1024x768
  - More reasonable default for most use cases
  - Can be overridden via `browser_options.viewport` parameter
- Config directory (`~/.config/notebooklm-mcp/`) no longer created (not needed)
- Improved logging for sessionStorage (NotebookLM does not use sessionStorage)
- README.md updated to reflect config-less architecture

### Fixed

- **Critical: envPaths() default suffix bug** - `env-paths` library appends `-nodejs` suffix by default
  - All paths were incorrectly created with `-nodejs` suffix
  - Fix: Explicitly pass `{suffix: ""}` to disable default behavior
  - Affects: `config.ts` and `cleanup-manager.ts`
  - Result: Correct paths now used (`notebooklm-mcp` instead of `notebooklm-mcp-nodejs`)
- Enhanced cleanup tool to detect all legacy paths including manual installations
  - Added `getManualLegacyPaths()` method for comprehensive legacy file detection
  - Finds old config.json files across all platforms
  - Cross-platform legacy path detection (Linux XDG dirs, macOS Library, Windows AppData)
- **Library Preservation Option** - cleanup_data can now preserve library.json
  - New parameter: `preserve_library` (default: false)
  - When true: Deletes everything (browser data, caches, logs) EXCEPT library.json
  - Perfect for clean reinstalls without losing notebook configurations
- **Improved Auth Troubleshooting** - Better guidance for authentication issues
  - New `AuthenticationError` class with cleanup suggestions
  - Tool descriptions updated with troubleshooting workflows
  - `get_health` now returns `troubleshooting_tip` when not authenticated
  - Clear workflow: Close Chrome → cleanup_data(preserve_library=true) → setup_auth/re_auth
  - Critical warnings about closing Chrome instances before cleanup
- **Critical: Browser visibility (show_browser) not working** - Fixed headless mode switching
  - **Root cause**: `overrideHeadless` parameter was not passed from `handleAskQuestion` to `SessionManager`
  - **Impact**: `show_browser=true` and `browser_options.show=true` were ignored, browser stayed headless
  - **Solution**:
    - `handleAskQuestion` now calculates and passes `overrideHeadless` parameter correctly
    - `SharedContextManager.getOrCreateContext()` checks for headless mode changes before reusing context
    - `needsHeadlessModeChange()` now checks CONFIG.headless when no override parameter provided
  - **Session behavior**: When browser mode changes (headless ↔ visible):
    - Existing session is automatically closed and recreated with same session ID
    - Browser context is recreated with new visibility mode
    - Chat history is reset (message_count returns to 0)
    - This is necessary because NotebookLM chat state is not persistent across browser restarts
  - **Files changed**: `src/tools/index.ts`, `src/session/shared-context-manager.ts`

### Removed

- Empty postinstall scripts (cleaner codebase)
  - Deleted: `src/postinstall.ts`, `dist/postinstall.js`, type definitions
  - Removed: `postinstall` npm script from package.json
  - Follows DRY & KISS principles

## [1.0.5] - 2025-10-17

### Changed

- Documentation improvements
- Updated README installation instructions

## [1.0.4] - 2025-10-17

### Changed

- Enhanced usage examples in documentation
- Fixed formatting in usage guide

## [1.0.3] - 2025-10-16

### Changed

- Improved troubleshooting guide
- Added common issues and solutions

## [1.0.2] - 2025-10-16

### Fixed

- Fixed typos in documentation
- Clarified authentication flow

## [1.0.1] - 2025-10-16

### Changed

- Enhanced README with better examples
- Added more detailed setup instructions

## [1.0.0] - 2025-10-16

### Added

- Initial release
- NotebookLM integration via Model Context Protocol (MCP)
- Session-based conversations with Gemini 2.5
- Source-grounded answers from notebook documents
- Notebook library management system
- Google authentication with persistent browser sessions
- 16 MCP tools for comprehensive NotebookLM interaction
- Support for Claude Code, Codex, Cursor, and other MCP clients
- TypeScript implementation with full type safety
- Playwright browser automation with stealth mode
