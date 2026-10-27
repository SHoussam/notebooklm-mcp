#!/usr/bin/env node

/**
 * NotebookLM MCP Server (v2.1.0)
 *
 * MCP Server for Google NotebookLM — research, source ingestion (URL, YouTube,
 * raw text, PDF/files), remote notebook creation & discovery, citation-grounded
 * Q&A, Audio Overviews, and full Studio Artifacts (Video, Mind Map, Slide Deck,
 * Infographic, Flashcards, Quiz, Briefing Doc, Study Guide, FAQ, Timeline).
 *
 * Transports:
 *   - stdio (default): `node dist/index.js`
 *   - Streamable HTTP (multi-session): `node dist/index.js --transport http --port 3000`
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { AuthManager } from "./auth/auth-manager.js";
import { applyAccountToConfig, getRequestedAccount } from "./auth/account-switcher.js";
import { SessionManager } from "./session/session-manager.js";
import { NotebookLibrary } from "./library/notebook-library.js";
import { ToolHandlers, buildToolDefinitions } from "./tools/index.js";
import { ResourceHandlers } from "./resources/resource-handlers.js";
import { SettingsManager } from "./utils/settings-manager.js";
import { CliHandler } from "./utils/cli-handler.js";
import { CONFIG, ensureDirectories, type BrowserOptions } from "./config.js";
import { startHttpTransport, type HttpTransportHandle } from "./transport/http.js";
import type { SourceType } from "./notebooklm/sources.js";
import type { StudioArtifactType } from "./notebooklm/studio.js";
import { log } from "./utils/logger.js";

export const SERVER_VERSION = "2.1.0";

/**
 * Server-level instructions consumed by MCP clients during initialization.
 */
export const SERVER_INSTRUCTIONS = `# notebooklm-mcp v2.1.0 — research & Studio automation with Google NotebookLM

This server lets an AI agent run an end-to-end session-based research workflow
against Google NotebookLM: create or discover notebooks, upload local files
(PDF/MD/TXT/DOCX/audio), YouTube videos, URLs, or text snippets, run multi-turn
citation-grounded Q&A, and generate/export Studio artifacts.

## First-run flow

1. \`get_health\` → if \`authenticated=false\`, run \`setup_auth\` (opens a
   visible browser window — sign in to Google once and cookies persist).
2. Either:
   - \`create_notebook\` to create a brand-new NotebookLM notebook and make it active,
   - \`discover_notebooks\` to scan existing notebooks on the signed-in Google account, or
   - \`add_notebook\` to register a NotebookLM URL into the local library.
3. Populate with \`add_source\` (\`url\`, \`youtube\`, \`text\`, or \`file\`), inspect
   loaded sources via \`list_sources\`, and query with \`ask_question\` (pass
   \`source_format: "inline" | "footnotes" | "json"\` when structured citations are needed).

## Session ID & Notebook ID flows

- \`list_notebooks\` / \`search_notebooks\` / \`get_notebook\` / \`create_notebook\`
  return notebook entries with \`id\`. Pass \`notebook_id\` (or \`select_notebook\`
  once) to target that notebook across \`ask_question\`, \`add_source\`,
  \`list_sources\`, audio, and Studio tools.
- \`ask_question\` returns \`session_id\`. Reuse \`session_id\` on follow-up
  calls to preserve multi-turn conversational context and avoid reloading the tab.

## Source ingestion (\`add_source\` & \`list_sources\`)

Call \`add_source\` once per source:
- \`type: "file"\` — absolute path to a local \`.pdf\`, \`.md\`, \`.txt\`, \`.docx\`, audio, or image file
- \`type: "youtube"\` — YouTube video URL (transcripts/captions indexed)
- \`type: "url"\` — web page URL
- \`type: "text"\` — raw copied text (with optional \`title\`)

## Studio Artifacts & Audio Overview (async chain)

\`generate_studio_artifact\` supports 11 Studio outputs:
\`audio\`, \`video\`, \`mindmap\`, \`slide_deck\`, \`infographic\`, \`flashcards\`,
\`quiz\`, \`briefing_doc\`, \`study_guide\`, \`faq\`, and \`timeline\`.

1. Call \`generate_studio_artifact\` (non-blocking by default; returns \`started\`).
2. Poll \`get_studio_status\` until the artifact's status is \`ready\`.
3. Call \`export_studio_artifact\` with an absolute \`destination_dir\` to download
   binary media (Audio, Video, Slides, Infographic, Mind Map) or save extracted
   Markdown (\`.md\`) for Reports, Flashcards, and Quizzes.

(Dedicated \`generate_audio\` → \`get_audio_status\` → \`download_audio\` tools
remain available for backwards compatibility.)

## Constraints

- Free Google accounts: ~50 NotebookLM queries/day, 100 notebooks, 50 sources/notebook
  (5× higher on Google AI Pro/Ultra). Use \`re_auth\` or \`--account <name>\` to switch accounts.
- Idle browser sessions auto-close after \`get_health.session_timeout\` seconds (~15 min).
`;

function extractProgressToken(
  args: Record<string, unknown> | undefined
): string | number | undefined {
  if (!args || typeof args !== "object") return undefined;
  const meta = (args as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const token = (meta as { progressToken?: unknown }).progressToken;
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}

export interface NotebookLMMCPServerOptions {
  /** Register process SIGINT/SIGTERM/uncaught handlers. Default: true (set false in tests). */
  registerSignalHandlers?: boolean;
}

/**
 * Main MCP Server Coordinator.
 *
 * Owns shared domain state (`AuthManager`, `SessionManager`, `NotebookLibrary`,
 * `SettingsManager`) and constructs one MCP `Server` protocol instance per
 * transport connection so multi-client Streamable-HTTP works without colliding
 * on a single `Server.connect()` call.
 */
export class NotebookLMMCPServer {
  private protocolServers = new Set<Server>();
  private httpHandle: HttpTransportHandle | null = null;
  private authManager: AuthManager;
  private sessionManager: SessionManager;
  private library: NotebookLibrary;
  private toolHandlers: ToolHandlers;
  private resourceHandlers: ResourceHandlers;
  private settingsManager: SettingsManager;

  constructor(options: NotebookLMMCPServerOptions = {}) {
    this.authManager = new AuthManager();
    this.sessionManager = new SessionManager(this.authManager);
    this.library = new NotebookLibrary();
    this.settingsManager = new SettingsManager();

    this.toolHandlers = new ToolHandlers(this.sessionManager, this.authManager, this.library);
    this.resourceHandlers = new ResourceHandlers(this.library);

    if (options.registerSignalHandlers !== false) {
      this.setupShutdownHandlers();
    }

    const activeSettings = this.settingsManager.getEffectiveSettings();
    const initialTools = this.getFilteredTools();
    log.info("🚀 NotebookLM MCP Server initialized");
    log.info(`  Version: ${SERVER_VERSION}`);
    log.info(`  Node: ${process.version}`);
    log.info(`  Platform: ${process.platform}`);
    log.info(`  Profile: ${activeSettings.profile} (${initialTools.length} tools active)`);
  }

  /**
   * Build the active tool list dynamically (reflects active notebook updates & profile filter).
   */
  public getFilteredTools(): Tool[] {
    const allTools = buildToolDefinitions(this.library) as Tool[];
    return this.settingsManager.filterTools(allTools);
  }

  /**
   * Create a fresh MCP protocol `Server` instance wired to shared handlers.
   * Safe to invoke once for stdio or once per incoming HTTP session.
   */
  public createProtocolServer(): Server {
    const protocolServer = new Server(
      {
        name: "notebooklm-mcp",
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          resourceTemplates: {},
          prompts: {},
          completions: {},
          logging: {},
        },
        instructions: SERVER_INSTRUCTIONS,
      }
    );

    this.setupHandlers(protocolServer);
    this.protocolServers.add(protocolServer);
    return protocolServer;
  }

  /**
   * Wire MCP request handlers onto a protocol `Server` instance.
   */
  private setupHandlers(protocolServer: Server): void {
    this.resourceHandlers.registerHandlers(protocolServer);

    protocolServer.setRequestHandler(ListToolsRequestSchema, async () => {
      log.info("📋 [MCP] list_tools request received");
      return {
        tools: this.getFilteredTools(),
      };
    });

    protocolServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const progressToken = extractProgressToken(args);

      log.info(`🔧 [MCP] Tool call: ${name}`);
      if (progressToken) {
        log.info(`  📊 Progress token: ${progressToken}`);
      }

      const sendProgress = async (message: string, progress?: number, total?: number) => {
        if (progressToken) {
          await protocolServer.notification({
            method: "notifications/progress",
            params: {
              progressToken,
              message,
              ...(progress !== undefined && { progress }),
              ...(total !== undefined && { total }),
            },
          });
          log.dim(`  📊 Progress: ${message}`);
        }
      };

      try {
        let result;

        switch (name) {
          case "ask_question":
            result = await this.toolHandlers.handleAskQuestion(
              args as {
                question: string;
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
                show_browser?: boolean;
                browser_options?: BrowserOptions;
                source_format?: "none" | "inline" | "footnotes" | "json";
              },
              sendProgress
            );
            break;

          case "create_notebook":
            result = await this.toolHandlers.handleCreateNotebook(
              args as {
                title: string;
                description?: string;
                topics?: string[];
                add_to_library?: boolean;
                show_browser?: boolean;
              }
            );
            break;

          case "discover_notebooks":
            result = await this.toolHandlers.handleDiscoverNotebooks(
              (args ?? {}) as { show_browser?: boolean }
            );
            break;

          case "add_notebook":
            result = await this.toolHandlers.handleAddNotebook(
              args as {
                url: string;
                name: string;
                description: string;
                topics: string[];
                content_types?: string[];
                use_cases?: string[];
                tags?: string[];
              }
            );
            break;

          case "list_notebooks":
            result = await this.toolHandlers.handleListNotebooks();
            break;

          case "get_notebook":
            result = await this.toolHandlers.handleGetNotebook(args as { id: string });
            break;

          case "select_notebook":
            result = await this.toolHandlers.handleSelectNotebook(args as { id: string });
            break;

          case "update_notebook":
            result = await this.toolHandlers.handleUpdateNotebook(
              args as {
                id: string;
                name?: string;
                description?: string;
                topics?: string[];
                content_types?: string[];
                use_cases?: string[];
                tags?: string[];
                url?: string;
              }
            );
            break;

          case "remove_notebook":
            result = await this.toolHandlers.handleRemoveNotebook(args as { id: string });
            break;

          case "search_notebooks":
            result = await this.toolHandlers.handleSearchNotebooks(args as { query: string });
            break;

          case "get_library_stats":
            result = await this.toolHandlers.handleGetLibraryStats();
            break;

          case "list_sessions":
            result = await this.toolHandlers.handleListSessions();
            break;

          case "close_session":
            result = await this.toolHandlers.handleCloseSession(args as { session_id: string });
            break;

          case "reset_session":
            result = await this.toolHandlers.handleResetSession(args as { session_id: string });
            break;

          case "get_health":
            result = await this.toolHandlers.handleGetHealth();
            break;

          case "setup_auth":
            result = await this.toolHandlers.handleSetupAuth(
              (args ?? {}) as { show_browser?: boolean; browser_options?: BrowserOptions },
              sendProgress
            );
            break;

          case "re_auth":
            result = await this.toolHandlers.handleReAuth(
              (args ?? {}) as { show_browser?: boolean; browser_options?: BrowserOptions },
              sendProgress
            );
            break;

          case "set_auth_cookies":
            result = await this.toolHandlers.handleSetAuthCookies(
              (args ?? {}) as { cookies?: string; raw_cookie_header?: string; token?: string }
            );
            break;

          case "cleanup_data":
            result = await this.toolHandlers.handleCleanupData(
              args as { confirm: boolean; preserve_library?: boolean }
            );
            break;

          case "add_source":
            result = await this.toolHandlers.handleAddSource(
              args as {
                type: SourceType;
                content: string;
                title?: string;
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
                show_browser?: boolean;
              }
            );
            break;

          case "list_sources":
            result = await this.toolHandlers.handleListSources(
              (args ?? {}) as {
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
                show_browser?: boolean;
              }
            );
            break;

          case "generate_audio":
            result = await this.toolHandlers.handleGenerateAudio(
              (args ?? {}) as {
                custom_prompt?: string;
                timeout_ms?: number;
                wait_for_completion?: boolean;
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
                show_browser?: boolean;
              }
            );
            break;

          case "get_audio_status":
            result = await this.toolHandlers.handleGetAudioStatus(
              (args ?? {}) as {
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
                show_browser?: boolean;
              }
            );
            break;

          case "download_audio":
            result = await this.toolHandlers.handleDownloadAudio(
              args as {
                destination_dir: string;
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
                show_browser?: boolean;
              }
            );
            break;

          case "generate_studio_artifact":
            result = await this.toolHandlers.handleGenerateStudioArtifact(
              args as {
                artifact_type: StudioArtifactType;
                custom_prompt?: string;
                wait_for_completion?: boolean;
                timeout_ms?: number;
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
                show_browser?: boolean;
              }
            );
            break;

          case "get_studio_status":
            result = await this.toolHandlers.handleGetStudioStatus(
              (args ?? {}) as {
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
                show_browser?: boolean;
              }
            );
            break;

          case "export_studio_artifact":
            result = await this.toolHandlers.handleExportStudioArtifact(
              args as {
                destination_dir: string;
                artifact_index?: number;
                title_filter?: string;
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
                show_browser?: boolean;
              }
            );
            break;

          default:
            log.error(`❌ [MCP] Unknown tool: ${name}`);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      success: false,
                      error: `Unknown tool: ${name}`,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error(`❌ [MCP] Tool execution error: ${errorMessage}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: errorMessage,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    });
  }

  /**
   * Programmatic shutdown (closes browser sessions, HTTP listener, and all MCP protocol instances).
   */
  public async stop(): Promise<void> {
    await this.toolHandlers.cleanup();
    if (this.httpHandle) {
      await this.httpHandle.close().catch(() => undefined);
      this.httpHandle = null;
    }
    for (const srv of Array.from(this.protocolServers)) {
      await srv.close().catch(() => undefined);
      this.protocolServers.delete(srv);
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    let shuttingDown = false;

    const shutdown = async (signal: string) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;

      log.info(`\n🛑 Received ${signal}, shutting down gracefully...`);

      const watchdog = setTimeout(() => {
        log.error("⏱️  Shutdown stalled — forcing exit (issue #29 watchdog)");
        process.exit(1);
      }, 5_000);
      watchdog.unref();

      try {
        await this.stop();
        log.success("✅ Shutdown complete");
        clearTimeout(watchdog);
        process.exit(0);
      } catch (error) {
        log.error(`❌ Error during shutdown: ${error}`);
        clearTimeout(watchdog);
        process.exit(1);
      }
    };

    const requestShutdown = (signal: string) => {
      void shutdown(signal);
    };

    process.on("SIGINT", () => requestShutdown("SIGINT"));
    process.on("SIGTERM", () => requestShutdown("SIGTERM"));

    process.on("uncaughtException", (error) => {
      log.error(`💥 Uncaught exception: ${error}`);
      log.error(error.stack || "");
      requestShutdown("uncaughtException");
    });

    process.on("unhandledRejection", (reason, promise) => {
      log.error(`💥 Unhandled rejection at: ${promise}`);
      log.error(`Reason: ${reason}`);
      requestShutdown("unhandledRejection");
    });
  }

  /**
   * Start the MCP server using stdio (default) or HTTP transport (issue #4).
   */
  async start(options: TransportOptions = { kind: "stdio" }): Promise<HttpTransportHandle | null> {
    log.info("🎯 Starting NotebookLM MCP Server...");
    log.info("");
    log.info("📝 Configuration:");
    log.info(`  Config Dir: ${CONFIG.configDir}`);
    log.info(`  Data Dir: ${CONFIG.dataDir}`);
    log.info(`  Headless: ${CONFIG.headless}`);
    log.info(`  Locale / TZ: ${CONFIG.locale} / ${CONFIG.timezoneId}`);
    log.info(`  Max Sessions: ${CONFIG.maxSessions}`);
    log.info(`  Session Timeout: ${CONFIG.sessionTimeout}s`);
    log.info(`  Stealth: ${CONFIG.stealthEnabled}`);
    log.info(`  Transport: ${options.kind}`);
    log.info("");

    if (options.kind === "http") {
      this.httpHandle = await startHttpTransport({
        port: options.port,
        host: options.host,
        connect: async (transport) => {
          const protocolServer = this.createProtocolServer();
          const prevClose = transport.onclose;
          transport.onclose = () => {
            prevClose?.();
            this.protocolServers.delete(protocolServer);
          };
          await protocolServer.connect(transport);
        },
      });
      log.success("✅ MCP Server connected via Streamable HTTP (multi-session enabled)");
    } else {
      const transport = new StdioServerTransport();
      const protocolServer = this.createProtocolServer();
      await protocolServer.connect(transport);
      log.success("✅ MCP Server connected via stdio");
    }

    const activeTools = this.getFilteredTools();
    log.success(`🎉 Ready to receive MCP requests (${activeTools.length} tools)!`);
    log.info("");
    log.info("💡 Available tools:");
    for (const tool of activeTools) {
      const desc = tool.description ? tool.description.split("\n")[0] : "No description";
      log.info(`  - ${tool.name}: ${desc.substring(0, 80)}...`);
    }
    log.info("");

    return this.httpHandle;
  }
}

export type TransportOptions = { kind: "stdio" } | { kind: "http"; port: number; host?: string };

export function parseTransportOptions(argv: readonly string[]): TransportOptions {
  let kind: "stdio" | "http" = "stdio";
  let port = 3000;
  let host: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--transport") {
      const next = argv[i + 1];
      if (next === "http" || next === "stdio") {
        kind = next;
        i++;
      }
    } else if (arg.startsWith("--transport=")) {
      const value = arg.slice("--transport=".length);
      if (value === "http" || value === "stdio") kind = value;
    } else if (arg === "--port") {
      const next = argv[i + 1];
      const parsed = next ? Number.parseInt(next, 10) : Number.NaN;
      if (Number.isFinite(parsed)) {
        port = parsed;
        i++;
      }
    } else if (arg.startsWith("--port=")) {
      const parsed = Number.parseInt(arg.slice("--port=".length), 10);
      if (Number.isFinite(parsed)) port = parsed;
    } else if (arg === "--host") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        host = next;
        i++;
      }
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    }
  }

  const envTransport = process.env.NOTEBOOKLM_TRANSPORT;
  if (envTransport === "http" || envTransport === "stdio") kind = envTransport;
  const envPort = process.env.NOTEBOOKLM_PORT;
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10);
    if (Number.isFinite(parsed)) port = parsed;
  }
  const envHost = process.env.NOTEBOOKLM_HOST;
  if (envHost) host = envHost;

  if (kind === "http") return { kind, port, host };
  return { kind: "stdio" };
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  }
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  if (args.length > 0 && args[0] === "auth") {
    const authManager = new AuthManager();
    console.error("🌐 Opening browser for interactive Google login...");
    const ok = await authManager.performSetup(async (msg) => {
      console.error(`[AUTH] ${msg}`);
    }, true);
    if (ok) {
      console.error("✅ Authenticated successfully! Saved to persistent profile.");
      process.exit(0);
    } else {
      console.error("❌ Authentication failed or cancelled.");
      process.exit(1);
    }
  }

  if (
    args.length > 0 &&
    (args[0] === "auth:cookies" || args[0] === "token" || args[0] === "auth:token")
  ) {
    const rawCookies = args.slice(1).join(" ");
    if (!rawCookies) {
      console.error('❌ Please provide cookie string or JSON: npm run auth:cookies "<cookies>"');
      process.exit(1);
    }
    const authManager = new AuthManager();
    const res = await authManager.importCookies(rawCookies);
    if (res.success) {
      console.error(`✅ Successfully imported ${res.importedCount} cookies!`);
      console.error(`🔑 Critical cookies: ${res.criticalFound.join(", ") || "none"}`);
      process.exit(0);
    } else {
      console.error(`❌ Failed to import cookies: ${res.error || res.message}`);
      process.exit(1);
    }
  }

  if (args.length > 0 && args[0] === "config") {
    const cli = new CliHandler();
    await cli.handleCommand(args);
    process.exit(0);
  }

  const account = getRequestedAccount();
  if (account) {
    applyAccountToConfig(CONFIG, account);
    ensureDirectories();
    log.info(`👤 Account profile active: ${account}`);
  }

  console.error("╔══════════════════════════════════════════════════════════╗");
  console.error("║                                                          ║");
  console.error("║           NotebookLM MCP Server v2.1.0                   ║");
  console.error("║                                                          ║");
  console.error("║   Research & Studio Automation with Google NotebookLM    ║");
  console.error("║                                                          ║");
  console.error("╚══════════════════════════════════════════════════════════╝");
  console.error("");

  try {
    const transportOptions = parseTransportOptions(args);
    const server = new NotebookLMMCPServer();
    await server.start(transportOptions);
  } catch (error) {
    log.error(`💥 Fatal error starting server: ${error}`);
    if (error instanceof Error) {
      log.error(error.stack || "");
    }
    process.exit(1);
  }
}

if (isDirectExecution()) {
  void main();
}
