/**
 * MCP Tool Handlers (v2.1.0)
 *
 * Implements the logic for all 26 MCP tools with request-scoped `runWithConfig`
 * isolation (`AsyncLocalStorage`), Windows profile-lock safety during auth/cleanup,
 * remote notebook creation & discovery, local file & YouTube uploads, source
 * listing, and unified Studio artifacts.
 */

import type { SessionManager } from "../session/session-manager.js";
import type { AuthManager } from "../auth/auth-manager.js";
import type { NotebookLibrary } from "../library/notebook-library.js";
import type {
  AddNotebookInput,
  LibraryStats,
  NotebookEntry,
  UpdateNotebookInput,
} from "../library/types.js";
import type { AddSourceResult, ListSourcesResult, SourceType } from "../notebooklm/sources.js";
import type { AudioGenerationResult, DownloadAudioResult } from "../notebooklm/audio.js";
import {
  createRemoteNotebook,
  discoverRemoteNotebooks,
  type CreateNotebookResult,
  type DiscoverNotebooksResult,
} from "../notebooklm/notebooks.js";
import type {
  ExportStudioArtifactResult,
  GenerateStudioArtifactResult,
  StudioArtifactType,
  StudioStatusResult,
} from "../notebooklm/studio.js";
import { CONFIG, applyBrowserOptions, runWithConfig, type BrowserOptions } from "../config.js";
import { log } from "../utils/logger.js";
import type { AskQuestionResult, ToolResult, ProgressCallback } from "../types.js";
import { RateLimitError } from "../errors.js";
import { CleanupManager } from "../utils/cleanup-manager.js";
import { applyAiMarker, PROVENANCE } from "../utils/disclaimer.js";

/**
 * Follow-up reminder appended to ask_question answers when explicitly enabled.
 * Off by default in v2 (issue #28) — the imperative phrasing reads like
 * adversarial prompt injection to safety-trained host agents and creates
 * noisy false positives. Opt back in via `NOTEBOOKLM_FOLLOW_UP_REMINDER=true`.
 */
const FOLLOW_UP_REMINDER =
  "\n\nIs that all you need to know? You can always ask another question using the same session ID. Before you reply to the user, review their original request and this answer; if anything is still unclear or missing, ask another question first.";

function followUpReminderEnabled(): boolean {
  const raw = process.env.NOTEBOOKLM_FOLLOW_UP_REMINDER;
  if (raw === undefined) return false;
  const lower = raw.trim().toLowerCase();
  return lower === "true" || lower === "1" || lower === "yes";
}

/**
 * Compute `overrideHeadless` parameter (`true` = show browser window) for SessionManager.
 */
function computeShowBrowserOverride(
  showBrowser?: boolean,
  browserOptions?: BrowserOptions
): boolean | undefined {
  if (showBrowser !== undefined) return showBrowser;
  if (browserOptions?.show !== undefined) return browserOptions.show;
  if (browserOptions?.headless !== undefined) return !browserOptions.headless;
  return undefined;
}

/**
 * MCP Tool Handlers
 */
export class ToolHandlers {
  private sessionManager: SessionManager;
  private authManager: AuthManager;
  private library: NotebookLibrary;

  constructor(sessionManager: SessionManager, authManager: AuthManager, library: NotebookLibrary) {
    this.sessionManager = sessionManager;
    this.authManager = authManager;
    this.library = library;
  }

  /**
   * Handle ask_question tool
   */
  async handleAskQuestion(
    args: {
      question: string;
      session_id?: string;
      notebook_id?: string;
      notebook_url?: string;
      show_browser?: boolean;
      browser_options?: BrowserOptions;
      source_format?: "none" | "inline" | "footnotes" | "json";
    },
    sendProgress?: ProgressCallback
  ): Promise<ToolResult<AskQuestionResult>> {
    const {
      question,
      session_id,
      notebook_id,
      notebook_url,
      show_browser,
      browser_options,
      source_format = "none",
    } = args;

    log.info(`🔧 [TOOL] ask_question called`);
    log.info(`  Question: "${question.substring(0, 100)}"...`);
    if (session_id) {
      log.info(`  Session ID: ${session_id}`);
    }
    if (notebook_id) {
      log.info(`  Notebook ID: ${notebook_id}`);
    }
    if (notebook_url) {
      log.info(`  Notebook URL: ${notebook_url}`);
    }

    try {
      let resolvedNotebookUrl = notebook_url;

      if (!resolvedNotebookUrl && notebook_id) {
        const notebook = this.library.incrementUseCount(notebook_id);
        if (!notebook) {
          throw new Error(`Notebook not found in library: ${notebook_id}`);
        }

        resolvedNotebookUrl = notebook.url;
        log.info(`  Resolved notebook: ${notebook.name}`);
      } else if (!resolvedNotebookUrl) {
        const active = this.library.getActiveNotebook();
        if (active) {
          const notebook = this.library.incrementUseCount(active.id);
          if (!notebook) {
            throw new Error(`Active notebook not found: ${active.id}`);
          }
          resolvedNotebookUrl = notebook.url;
          log.info(`  Using active notebook: ${notebook.name}`);
        }
      }

      await sendProgress?.("Getting or creating browser session...", 1, 5);

      const scopedConfig = applyBrowserOptions(browser_options, show_browser);
      const overrideHeadless = computeShowBrowserOverride(show_browser, browser_options);

      return await runWithConfig(scopedConfig, async () => {
        const session = await this.sessionManager.getOrCreateSession(
          session_id,
          resolvedNotebookUrl,
          overrideHeadless
        );

        await sendProgress?.("Asking question to NotebookLM...", 2, 5);

        const rawAnswer = await session.ask(question, sendProgress);

        // Extract citations from the same page session before any other call
        // disturbs the source panel (issue #20).
        const citationResult = await session.extractCitations(rawAnswer, source_format);
        const baseAnswer = citationResult.formattedAnswer;

        const trimmed = baseAnswer.trimEnd();
        const withReminder = followUpReminderEnabled()
          ? `${trimmed}${FOLLOW_UP_REMINDER}`
          : trimmed;
        const answer = applyAiMarker(withReminder);

        const sessionInfo = session.getInfo();

        const result: AskQuestionResult = {
          status: "success",
          question,
          answer,
          session_id: session.sessionId,
          notebook_url: session.notebookUrl,
          session_info: {
            age_seconds: sessionInfo.age_seconds,
            message_count: sessionInfo.message_count,
            last_activity: sessionInfo.last_activity,
          },
          _provenance: PROVENANCE,
          source_format,
          ...(citationResult.citations.length > 0 && { sources: citationResult.citations }),
        };

        await sendProgress?.("Question answered successfully!", 5, 5);

        log.success(`✅ [TOOL] ask_question completed successfully`);
        return {
          success: true,
          data: result,
        };
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (error instanceof RateLimitError || errorMessage.toLowerCase().includes("rate limit")) {
        log.error(`🚫 [TOOL] Rate limit detected`);
        return {
          success: false,
          error:
            "NotebookLM rate limit reached (50 queries/day for free accounts).\n\n" +
            "You can:\n" +
            "1. Use the 're_auth' tool to login with a different Google account\n" +
            "2. Wait until tomorrow for the quota to reset\n" +
            "3. Upgrade to Google AI Pro/Ultra for 5x higher limits\n\n" +
            `Original error: ${errorMessage}`,
        };
      }

      log.error(`❌ [TOOL] ask_question failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle list_sessions tool
   */
  async handleListSessions(): Promise<
    ToolResult<{
      active_sessions: number;
      max_sessions: number;
      session_timeout: number;
      oldest_session_seconds: number;
      total_messages: number;
      sessions: Array<{
        id: string;
        created_at: number;
        last_activity: number;
        age_seconds: number;
        inactive_seconds: number;
        message_count: number;
        notebook_url: string;
      }>;
    }>
  > {
    log.info(`🔧 [TOOL] list_sessions called`);

    try {
      const stats = this.sessionManager.getStats();
      const sessions = this.sessionManager.getAllSessionsInfo();

      const result = {
        active_sessions: stats.active_sessions,
        max_sessions: stats.max_sessions,
        session_timeout: stats.session_timeout,
        oldest_session_seconds: stats.oldest_session_seconds,
        total_messages: stats.total_messages,
        sessions: sessions.map((info) => ({
          id: info.id,
          created_at: info.created_at,
          last_activity: info.last_activity,
          age_seconds: info.age_seconds,
          inactive_seconds: info.inactive_seconds,
          message_count: info.message_count,
          notebook_url: info.notebook_url,
        })),
      };

      log.success(`✅ [TOOL] list_sessions completed (${result.active_sessions} sessions)`);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] list_sessions failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle close_session tool
   */
  async handleCloseSession(args: {
    session_id: string;
  }): Promise<ToolResult<{ status: string; message: string; session_id: string }>> {
    const { session_id } = args;

    log.info(`🔧 [TOOL] close_session called`);
    log.info(`  Session ID: ${session_id}`);

    try {
      const closed = await this.sessionManager.closeSession(session_id);

      if (closed) {
        log.success(`✅ [TOOL] close_session completed`);
        return {
          success: true,
          data: {
            status: "success",
            message: `Session ${session_id} closed successfully`,
            session_id,
          },
        };
      } else {
        log.warning(`⚠️  [TOOL] Session ${session_id} not found`);
        return {
          success: false,
          error: `Session ${session_id} not found`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] close_session failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle reset_session tool
   */
  async handleResetSession(args: {
    session_id: string;
  }): Promise<ToolResult<{ status: string; message: string; session_id: string }>> {
    const { session_id } = args;

    log.info(`🔧 [TOOL] reset_session called`);
    log.info(`  Session ID: ${session_id}`);

    try {
      const session = this.sessionManager.getSession(session_id);

      if (!session) {
        log.warning(`⚠️  [TOOL] Session ${session_id} not found`);
        return {
          success: false,
          error: `Session ${session_id} not found`,
        };
      }

      await session.reset();

      log.success(`✅ [TOOL] reset_session completed`);
      return {
        success: true,
        data: {
          status: "success",
          message: `Session ${session_id} reset successfully`,
          session_id,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] reset_session failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_health tool
   */
  async handleGetHealth(): Promise<
    ToolResult<{
      status: string;
      authenticated: boolean;
      notebook_url: string;
      active_notebook_id: string | null;
      active_notebook_name: string | null;
      total_notebooks: number;
      active_sessions: number;
      max_sessions: number;
      session_timeout: number;
      total_messages: number;
      headless: boolean;
      auto_login_enabled: boolean;
      stealth_enabled: boolean;
      troubleshooting_tip?: string;
    }>
  > {
    log.info(`🔧 [TOOL] get_health called`);

    try {
      const statePath = await this.authManager.getValidStatePath();
      const authenticated = statePath !== null;
      const stats = this.sessionManager.getStats();
      const active = this.library.getActiveNotebook();
      const notebookUrl = active?.url || CONFIG.notebookUrl || "not configured";

      const result = {
        status: "ok",
        authenticated,
        notebook_url: notebookUrl,
        active_notebook_id: active?.id ?? null,
        active_notebook_name: active?.name ?? null,
        total_notebooks: this.library.getStats().total_notebooks,
        active_sessions: stats.active_sessions,
        max_sessions: stats.max_sessions,
        session_timeout: stats.session_timeout,
        total_messages: stats.total_messages,
        headless: CONFIG.headless,
        auto_login_enabled: CONFIG.autoLoginEnabled,
        stealth_enabled: CONFIG.stealthEnabled,
        ...(!authenticated && {
          troubleshooting_tip:
            "For fresh start with clean browser session: Close all Chrome instances → " +
            "cleanup_data(confirm=true, preserve_library=true) → setup_auth",
        }),
      };

      log.success(`✅ [TOOL] get_health completed`);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_health failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle setup_auth tool
   *
   * Closes any open persistent sessions first (avoiding Windows Chrome profile
   * file locks), then opens a visible browser window for manual Google login.
   */
  async handleSetupAuth(
    args: {
      show_browser?: boolean;
      browser_options?: BrowserOptions;
    },
    sendProgress?: ProgressCallback
  ): Promise<
    ToolResult<{
      status: string;
      message: string;
      authenticated: boolean;
      duration_seconds?: number;
    }>
  > {
    const { show_browser, browser_options } = args;

    await sendProgress?.("Initializing authentication setup...", 0, 10);

    log.info(`🔧 [TOOL] setup_auth called`);
    if (show_browser !== undefined) {
      log.info(`  Show browser: ${show_browser}`);
    }

    const startTime = Date.now();
    const scopedConfig = applyBrowserOptions(browser_options, show_browser);
    const overrideHeadless = computeShowBrowserOverride(show_browser, browser_options);

    return await runWithConfig(scopedConfig, async () => {
      try {
        await sendProgress?.("Closing any active browser sessions...", 1, 10);
        await this.sessionManager.closeAllSessions();

        log.info(`  🌐 Opening browser for interactive login...`);
        await sendProgress?.("Opening browser window...", 2, 10);

        const success = await this.authManager.performSetup(sendProgress, overrideHeadless);
        const durationSeconds = (Date.now() - startTime) / 1000;

        if (success) {
          await sendProgress?.("Authentication saved successfully!", 10, 10);
          log.success(`✅ [TOOL] setup_auth completed (${durationSeconds.toFixed(1)}s)`);
          return {
            success: true,
            data: {
              status: "authenticated",
              message: "Successfully authenticated and saved browser state",
              authenticated: true,
              duration_seconds: durationSeconds,
            },
          };
        } else {
          log.error(`❌ [TOOL] setup_auth failed (${durationSeconds.toFixed(1)}s)`);
          return {
            success: false,
            error: "Authentication failed or was cancelled",
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const durationSeconds = (Date.now() - startTime) / 1000;
        log.error(`❌ [TOOL] setup_auth failed: ${errorMessage} (${durationSeconds.toFixed(1)}s)`);
        return {
          success: false,
          error: errorMessage,
        };
      }
    });
  }

  /**
   * Handle re_auth tool
   */
  async handleReAuth(
    args: {
      show_browser?: boolean;
      browser_options?: BrowserOptions;
    },
    sendProgress?: ProgressCallback
  ): Promise<
    ToolResult<{
      status: string;
      message: string;
      authenticated: boolean;
      duration_seconds?: number;
    }>
  > {
    const { show_browser, browser_options } = args;

    await sendProgress?.("Preparing re-authentication...", 0, 12);
    log.info(`🔧 [TOOL] re_auth called`);
    if (show_browser !== undefined) {
      log.info(`  Show browser: ${show_browser}`);
    }

    const startTime = Date.now();
    const scopedConfig = applyBrowserOptions(browser_options, show_browser);
    const overrideHeadless = computeShowBrowserOverride(show_browser, browser_options);

    return await runWithConfig(scopedConfig, async () => {
      try {
        await sendProgress?.("Closing all active sessions...", 1, 12);
        log.info("  🛑 Closing all sessions...");
        await this.sessionManager.closeAllSessions();
        log.success("  ✅ All sessions closed");

        await sendProgress?.("Clearing authentication data...", 2, 12);
        log.info("  🗑️  Clearing all auth data...");
        await this.authManager.clearAllAuthData();
        log.success("  ✅ Auth data cleared");

        await sendProgress?.("Starting fresh authentication...", 3, 12);
        log.info("  🌐 Starting fresh authentication setup...");
        const success = await this.authManager.performSetup(sendProgress, overrideHeadless);

        const durationSeconds = (Date.now() - startTime) / 1000;

        if (success) {
          await sendProgress?.("Re-authentication complete!", 12, 12);
          log.success(`✅ [TOOL] re_auth completed (${durationSeconds.toFixed(1)}s)`);
          return {
            success: true,
            data: {
              status: "authenticated",
              message:
                "Successfully re-authenticated with new account. All previous sessions have been closed.",
              authenticated: true,
              duration_seconds: durationSeconds,
            },
          };
        } else {
          log.error(`❌ [TOOL] re_auth failed (${durationSeconds.toFixed(1)}s)`);
          return {
            success: false,
            error: "Re-authentication failed or was cancelled",
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const durationSeconds = (Date.now() - startTime) / 1000;
        log.error(`❌ [TOOL] re_auth failed: ${errorMessage} (${durationSeconds.toFixed(1)}s)`);
        return {
          success: false,
          error: errorMessage,
        };
      }
    });
  }

  /**
   * Handle set_auth_cookies tool (v2.1.0)
   * Import Google cookies or session tokens directly without opening a browser.
   */
  async handleSetAuthCookies(args: {
    cookies?: string;
    raw_cookie_header?: string;
    token?: string;
  }): Promise<
    ToolResult<{
      status: string;
      message: string;
      authenticated: boolean;
      imported_count: number;
      critical_cookies_found: string[];
    }>
  > {
    const rawInput = args.cookies || args.raw_cookie_header || args.token || "";
    if (!rawInput) {
      return {
        success: false,
        error:
          "Missing required 'cookies' argument. Provide a raw Cookie header string, exported JSON cookie array, or tokens.",
      };
    }

    log.info(`🔑 [TOOL] set_auth_cookies called`);
    const res = await this.authManager.importCookies(rawInput);
    if (!res.success) {
      log.error(`❌ [TOOL] set_auth_cookies failed: ${res.error || res.message}`);
      return {
        success: false,
        error: res.error || res.message,
      };
    }

    log.success(`✅ [TOOL] set_auth_cookies successfully imported ${res.importedCount} cookies`);
    return {
      success: true,
      data: {
        status: "authenticated",
        message: res.message,
        authenticated: true,
        imported_count: res.importedCount,
        critical_cookies_found: res.criticalFound,
      },
    };
  }

  /**
   * Handle create_notebook tool (v2.1.0)
   *
   * Creates a new notebook on `https://notebooklm.google.com/` and optionally
   * adds + selects it in the local library.
   */
  async handleCreateNotebook(args: {
    title: string;
    description?: string;
    topics?: string[];
    add_to_library?: boolean;
    show_browser?: boolean;
  }): Promise<
    ToolResult<{
      created: CreateNotebookResult;
      notebook?: NotebookEntry;
    }>
  > {
    log.info(`🔧 [TOOL] create_notebook called (title="${args.title}")`);
    const scopedConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = computeShowBrowserOverride(args.show_browser);

    return await runWithConfig(scopedConfig, async () => {
      try {
        const context = await this.sessionManager.getSharedContext(overrideHeadless);
        const created = await createRemoteNotebook(context, { title: args.title });
        if (!created.success || !created.url) {
          return {
            success: false,
            error: created.message || "Failed to create remote NotebookLM notebook",
            data: { created },
          };
        }

        let libraryEntry: NotebookEntry | undefined;
        if (args.add_to_library !== false) {
          libraryEntry = this.library.addNotebook({
            url: created.url,
            name: args.title,
            description:
              args.description?.trim() || `Notebook created via NotebookLM MCP (${args.title})`,
            topics: args.topics && args.topics.length > 0 ? args.topics : ["general"],
          });
          this.library.selectNotebook(libraryEntry.id);
        }

        return {
          success: true,
          data: {
            created,
            ...(libraryEntry && { notebook: libraryEntry }),
          },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] create_notebook failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Handle discover_notebooks tool (v2.1.0)
   */
  async handleDiscoverNotebooks(args: {
    show_browser?: boolean;
  }): Promise<ToolResult<DiscoverNotebooksResult>> {
    log.info(`🔧 [TOOL] discover_notebooks called`);
    const scopedConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = computeShowBrowserOverride(args.show_browser);

    return await runWithConfig(scopedConfig, async () => {
      try {
        const context = await this.sessionManager.getSharedContext(overrideHeadless);
        const result = await discoverRemoteNotebooks(context);
        if (!result.success) {
          return {
            success: false,
            error: result.message || "Failed to discover remote notebooks",
            data: result,
          };
        }
        return { success: true, data: result };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] discover_notebooks failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Handle add_notebook tool
   */
  async handleAddNotebook(
    args: AddNotebookInput
  ): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] add_notebook called`);
    log.info(`  Name: ${args.name}`);

    try {
      const notebook = this.library.addNotebook(args);
      log.success(`✅ [TOOL] add_notebook completed: ${notebook.id}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] add_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle list_notebooks tool
   */
  async handleListNotebooks(): Promise<ToolResult<{ notebooks: NotebookEntry[] }>> {
    log.info(`🔧 [TOOL] list_notebooks called`);

    try {
      const notebooks = this.library.listNotebooks();
      log.success(`✅ [TOOL] list_notebooks completed (${notebooks.length} notebooks)`);
      return {
        success: true,
        data: { notebooks },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] list_notebooks failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_notebook tool
   */
  async handleGetNotebook(args: { id: string }): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] get_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.getNotebook(args.id);
      if (!notebook) {
        log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
        return {
          success: false,
          error: `Notebook not found: ${args.id}`,
        };
      }

      log.success(`✅ [TOOL] get_notebook completed: ${notebook.name}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle select_notebook tool
   */
  async handleSelectNotebook(args: {
    id: string;
  }): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] select_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.selectNotebook(args.id);
      log.success(`✅ [TOOL] select_notebook completed: ${notebook.name}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] select_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle update_notebook tool
   */
  async handleUpdateNotebook(
    args: UpdateNotebookInput
  ): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] update_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.updateNotebook(args);
      log.success(`✅ [TOOL] update_notebook completed: ${notebook.name}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] update_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle remove_notebook tool
   */
  async handleRemoveNotebook(args: {
    id: string;
  }): Promise<ToolResult<{ removed: boolean; closed_sessions: number }>> {
    log.info(`🔧 [TOOL] remove_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.getNotebook(args.id);
      if (!notebook) {
        log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
        return {
          success: false,
          error: `Notebook not found: ${args.id}`,
        };
      }

      const removed = this.library.removeNotebook(args.id);
      if (removed) {
        const closedSessions = await this.sessionManager.closeSessionsForNotebook(notebook.url);
        log.success(`✅ [TOOL] remove_notebook completed`);
        return {
          success: true,
          data: { removed: true, closed_sessions: closedSessions },
        };
      } else {
        log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
        return {
          success: false,
          error: `Notebook not found: ${args.id}`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] remove_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle search_notebooks tool
   */
  async handleSearchNotebooks(args: {
    query: string;
  }): Promise<ToolResult<{ notebooks: NotebookEntry[] }>> {
    log.info(`🔧 [TOOL] search_notebooks called`);
    log.info(`  Query: "${args.query}"`);

    try {
      const notebooks = this.library.searchNotebooks(args.query);
      log.success(`✅ [TOOL] search_notebooks completed (${notebooks.length} results)`);
      return {
        success: true,
        data: { notebooks },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] search_notebooks failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_library_stats tool
   */
  async handleGetLibraryStats(): Promise<ToolResult<LibraryStats>> {
    log.info(`🔧 [TOOL] get_library_stats called`);

    try {
      const stats = this.library.getStats();
      log.success(`✅ [TOOL] get_library_stats completed`);
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_library_stats failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle cleanup_data tool
   */
  async handleCleanupData(args: { confirm: boolean; preserve_library?: boolean }): Promise<
    ToolResult<{
      status: string;
      mode: string;
      preview?: {
        categories: Array<{
          name: string;
          description: string;
          paths: string[];
          totalBytes: number;
          optional: boolean;
        }>;
        totalPaths: number;
        totalSizeBytes: number;
      };
      result?: {
        deletedPaths: string[];
        failedPaths: string[];
        totalSizeBytes: number;
        categorySummary: Record<string, { count: number; bytes: number }>;
      };
    }>
  > {
    const { confirm, preserve_library = false } = args;

    log.info(`🔧 [TOOL] cleanup_data called`);
    log.info(`  Confirm: ${confirm}`);
    log.info(`  Preserve Library: ${preserve_library}`);

    const cleanupManager = new CleanupManager();

    try {
      const mode = "deep";

      if (!confirm) {
        log.info(`  📋 Generating cleanup preview (mode: ${mode})...`);

        const preview = await cleanupManager.getCleanupPaths(mode, preserve_library);
        const platformInfo = cleanupManager.getPlatformInfo();

        log.info(
          `  Found ${preview.totalPaths.length} items (${cleanupManager.formatBytes(preview.totalSizeBytes)})`
        );
        log.info(`  Platform: ${platformInfo.platform}`);

        return {
          success: true,
          data: {
            status: "preview",
            mode,
            preview: {
              categories: preview.categories,
              totalPaths: preview.totalPaths.length,
              totalSizeBytes: preview.totalSizeBytes,
            },
          },
        };
      } else {
        log.info(`  🗑️  Closing sessions and performing cleanup (mode: ${mode})...`);
        await this.sessionManager.closeAllSessions();

        const result = await cleanupManager.performCleanup(mode, preserve_library);

        if (result.success) {
          log.success(
            `✅ [TOOL] cleanup_data completed - deleted ${result.deletedPaths.length} items`
          );
        } else {
          log.warning(`⚠️  [TOOL] cleanup_data completed with ${result.failedPaths.length} errors`);
        }

        return {
          success: result.success,
          data: {
            status: result.success ? "completed" : "partial",
            mode,
            result: {
              deletedPaths: result.deletedPaths,
              failedPaths: result.failedPaths,
              totalSizeBytes: result.totalSizeBytes,
              categorySummary: result.categorySummary,
            },
          },
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] cleanup_data failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Resolve a notebook URL the same way `handleAskQuestion` does. Used by
   * source, audio, and Studio tools so we don't duplicate lookup logic.
   */
  private async resolveNotebookUrl(
    notebookId?: string,
    notebookUrl?: string
  ): Promise<string | undefined> {
    if (notebookUrl) return notebookUrl;
    if (notebookId) {
      const nb = this.library.getNotebook(notebookId);
      if (!nb) throw new Error(`Notebook not found in library: ${notebookId}`);
      return nb.url;
    }
    const active = this.library.getActiveNotebook();
    return active?.url;
  }

  /**
   * Handle add_source tool (`url`, `youtube`, `text`, or `file`).
   */
  async handleAddSource(args: {
    type: SourceType;
    content: string;
    title?: string;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: AddSourceResult }>> {
    log.info(`🔧 [TOOL] add_source called (type=${args.type})`);
    const scopedConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = computeShowBrowserOverride(args.show_browser);

    return await runWithConfig(scopedConfig, async () => {
      try {
        const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless
        );
        const result = await session.addSource({
          type: args.type,
          content: args.content,
          title: args.title,
        });
        return {
          success: result.success,
          ...(result.success ? {} : { error: result.message }),
          data: { result },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] add_source failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Handle list_sources tool (v2.1.0).
   */
  async handleListSources(args: {
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<ListSourcesResult>> {
    log.info(`🔧 [TOOL] list_sources called`);
    const scopedConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = computeShowBrowserOverride(args.show_browser);

    return await runWithConfig(scopedConfig, async () => {
      try {
        const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless
        );
        const result = await session.listSources();
        return {
          success: true,
          data: result,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] list_sources failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Handle generate_audio tool (issue #11).
   */
  async handleGenerateAudio(args: {
    custom_prompt?: string;
    timeout_ms?: number;
    wait_for_completion?: boolean;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: AudioGenerationResult }>> {
    log.info(`🔧 [TOOL] generate_audio called`);
    const scopedConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = computeShowBrowserOverride(args.show_browser);

    return await runWithConfig(scopedConfig, async () => {
      try {
        const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless
        );
        const result = await session.generateAudio({
          customPrompt: args.custom_prompt,
          timeoutMs: args.timeout_ms,
          waitForCompletion: args.wait_for_completion ?? false,
        });
        const ok =
          result.status === "ready" ||
          result.status === "started" ||
          result.status === "in_progress";
        return {
          success: ok,
          ...(ok ? {} : { error: result.message }),
          data: { result },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] generate_audio failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Handle get_audio_status tool — non-blocking poll for Audio Overview state.
   */
  async handleGetAudioStatus(args: {
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: AudioGenerationResult }>> {
    log.info(`🔧 [TOOL] get_audio_status called`);
    const scopedConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = computeShowBrowserOverride(args.show_browser);

    return await runWithConfig(scopedConfig, async () => {
      try {
        const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless
        );
        const result = await session.getAudioStatus();
        return { success: true, data: { result } };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] get_audio_status failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Handle download_audio tool (issue #11).
   */
  async handleDownloadAudio(args: {
    destination_dir: string;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: DownloadAudioResult }>> {
    log.info(`🔧 [TOOL] download_audio called`);
    const scopedConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = computeShowBrowserOverride(args.show_browser);

    return await runWithConfig(scopedConfig, async () => {
      try {
        const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless
        );
        const result = await session.downloadAudio(args.destination_dir);
        return {
          success: result.success,
          ...(result.success ? {} : { error: result.message }),
          data: { result },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] download_audio failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Handle generate_studio_artifact tool (v2.1.0).
   */
  async handleGenerateStudioArtifact(args: {
    artifact_type: StudioArtifactType;
    custom_prompt?: string;
    wait_for_completion?: boolean;
    timeout_ms?: number;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: GenerateStudioArtifactResult }>> {
    log.info(`🔧 [TOOL] generate_studio_artifact called (type=${args.artifact_type})`);
    const scopedConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = computeShowBrowserOverride(args.show_browser);

    return await runWithConfig(scopedConfig, async () => {
      try {
        const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless
        );
        const result = await session.generateStudioArtifact({
          artifactType: args.artifact_type,
          customPrompt: args.custom_prompt,
          waitForCompletion: args.wait_for_completion ?? false,
          timeoutMs: args.timeout_ms,
        });
        const ok =
          result.status === "ready" ||
          result.status === "started" ||
          result.status === "in_progress";
        return {
          success: ok,
          ...(ok ? {} : { error: result.message }),
          data: { result },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] generate_studio_artifact failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Handle get_studio_status tool (v2.1.0).
   */
  async handleGetStudioStatus(args: {
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<StudioStatusResult>> {
    log.info(`🔧 [TOOL] get_studio_status called`);
    const scopedConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = computeShowBrowserOverride(args.show_browser);

    return await runWithConfig(scopedConfig, async () => {
      try {
        const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless
        );
        const result = await session.getStudioStatus();
        const ok = result.status === "ok";
        return {
          success: ok,
          ...(ok ? {} : { error: result.message }),
          data: result,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] get_studio_status failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Handle export_studio_artifact tool (v2.1.0).
   */
  async handleExportStudioArtifact(args: {
    destination_dir: string;
    artifact_index?: number;
    title_filter?: string;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: ExportStudioArtifactResult }>> {
    log.info(`🔧 [TOOL] export_studio_artifact called`);
    const scopedConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = computeShowBrowserOverride(args.show_browser);

    return await runWithConfig(scopedConfig, async () => {
      try {
        const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless
        );
        const result = await session.exportStudioArtifact({
          destinationDir: args.destination_dir,
          artifactIndex: args.artifact_index,
          titleFilter: args.title_filter,
        });
        return {
          success: result.success,
          ...(result.success ? {} : { error: result.message }),
          data: { result },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] export_studio_artifact failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Cleanup all resources (called on server shutdown)
   */
  async cleanup(): Promise<void> {
    log.info(`🧹 Cleaning up tool handlers...`);
    await this.sessionManager.closeAllSessions(true);
    log.success(`✅ Tool handlers cleanup complete`);
  }
}
