/**
 * Configuration for NotebookLM MCP Server
 *
 * Config Priority (highest to lowest):
 * 1. Per-Request Tool Parameters (isolated via AsyncLocalStorage — concurrency-safe)
 * 2. Environment Variables (optional, for advanced users)
 * 3. Hardcoded Defaults (works out of the box!)
 */

import { AsyncLocalStorage } from "node:async_hooks";
import envPaths from "env-paths";
import fs from "fs";
import path from "path";

// Cross-platform data paths (unified without -nodejs suffix)
// Linux: ~/.local/share/notebooklm-mcp/
// macOS: ~/Library/Application Support/notebooklm-mcp/
// Windows: %APPDATA%\notebooklm-mcp\
// IMPORTANT: Pass empty string suffix to disable envPaths' default '-nodejs' suffix!
const paths = envPaths("notebooklm-mcp", { suffix: "" });

/**
 * Google NotebookLM Auth URL (used by setup_auth)
 * This is the base Google login URL that redirects to NotebookLM
 */
export const NOTEBOOKLM_AUTH_URL =
  "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fnotebooklm.google.com%2F&flowName=GlifWebSignIn&flowEntry=ServiceLogin";

export const NOTEBOOKLM_HOME_URL = "https://notebooklm.google.com/";

export interface Config {
  // NotebookLM - optional, used for legacy default notebook
  notebookUrl: string;

  // Browser Settings
  headless: boolean;
  browserTimeout: number;
  /**
   * Hard ceiling on the wait for a NotebookLM answer (issue #14 + #27).
   * Long-form queries on notebooks with many sources legitimately exceed
   * 2 min. Overridable via `ANSWER_TIMEOUT_MS` env or per-call via
   * `browser_options.timeout_ms`.
   */
  answerTimeoutMs: number;
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;

  // Session Management
  maxSessions: number;
  sessionTimeout: number; // in seconds

  // Authentication
  autoLoginEnabled: boolean;
  loginEmail: string;
  loginPassword: string;
  autoLoginTimeoutMs: number;

  // Stealth Settings
  stealthEnabled: boolean;
  stealthRandomDelays: boolean;
  stealthHumanTyping: boolean;
  stealthMouseMovements: boolean;
  typingWpmMin: number;
  typingWpmMax: number;
  minDelayMs: number;
  maxDelayMs: number;

  // Paths
  configDir: string;
  dataDir: string;
  browserStateDir: string;
  chromeProfileDir: string;
  chromeInstancesDir: string;

  // Library Configuration (optional, for default notebook metadata)
  notebookDescription: string;
  notebookTopics: string[];
  notebookContentTypes: string[];
  notebookUseCases: string[];

  // Multi-instance profile strategy
  profileStrategy: "auto" | "single" | "isolated";
  cloneProfileOnIsolated: boolean;
  cleanupInstancesOnStartup: boolean;
  cleanupInstancesOnShutdown: boolean;
  instanceProfileTtlHours: number;
  instanceProfileMaxCount: number;
}

function detectSystemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Default Configuration (works out of the box!)
 */
const DEFAULTS: Config = {
  // NotebookLM
  notebookUrl: "",

  // Browser Settings
  headless: true,
  browserTimeout: 30000,
  answerTimeoutMs: 600000, // 10 minutes — was hardcoded 120 s (issue #14)
  // CRITICAL: NotebookLM switches to a tab-based mobile layout below
  // ~1280px. The Studio panel is then offscreen on a non-active tab and
  // selectors that rely on `isVisible()` falsely report "not started".
  // Use a desktop-class viewport so the three-pane layout always renders.
  viewport: { width: 1920, height: 1080 },
  locale: "en-US",
  timezoneId: detectSystemTimezone(),

  // Session Management
  maxSessions: 10,
  sessionTimeout: 900, // 15 minutes

  // Authentication
  autoLoginEnabled: false,
  loginEmail: "",
  loginPassword: "",
  autoLoginTimeoutMs: 120000, // 2 minutes

  // Stealth Settings
  stealthEnabled: true,
  stealthRandomDelays: true,
  stealthHumanTyping: true,
  stealthMouseMovements: true,
  typingWpmMin: 160,
  typingWpmMax: 240,
  minDelayMs: 100,
  maxDelayMs: 400,

  // Paths (cross-platform via env-paths)
  configDir: paths.config,
  dataDir: paths.data,
  browserStateDir: path.join(paths.data, "browser_state"),
  chromeProfileDir: path.join(paths.data, "chrome_profile"),
  chromeInstancesDir: path.join(paths.data, "chrome_profile_instances"),

  // Library Configuration
  notebookDescription: "General knowledge base",
  notebookTopics: ["General topics"],
  notebookContentTypes: ["documentation", "examples"],
  notebookUseCases: ["General research"],

  // Multi-instance strategy
  profileStrategy: "auto",
  cloneProfileOnIsolated: false,
  cleanupInstancesOnStartup: true,
  cleanupInstancesOnShutdown: true,
  instanceProfileTtlHours: 72,
  instanceProfileMaxCount: 20,
};

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "1") return true;
  if (lower === "false" || lower === "0") return false;
  return defaultValue;
}

function parseInteger(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function parseArray(value: string | undefined, defaultValue: string[]): string[] {
  if (!value) return defaultValue;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseProfileStrategy(
  value: string | undefined,
  fallback: Config["profileStrategy"]
): Config["profileStrategy"] {
  if (value === "auto" || value === "single" || value === "isolated") return value;
  return fallback;
}

function applyEnvOverrides(config: Config): Config {
  return {
    ...config,
    notebookUrl: process.env.NOTEBOOK_URL || config.notebookUrl,
    headless: parseBoolean(process.env.HEADLESS, config.headless),
    browserTimeout: parseInteger(process.env.BROWSER_TIMEOUT, config.browserTimeout),
    answerTimeoutMs: parseInteger(process.env.ANSWER_TIMEOUT_MS, config.answerTimeoutMs),
    locale: process.env.BROWSER_LOCALE || config.locale,
    timezoneId: process.env.BROWSER_TIMEZONE || config.timezoneId,
    maxSessions: parseInteger(process.env.MAX_SESSIONS, config.maxSessions),
    sessionTimeout: parseInteger(process.env.SESSION_TIMEOUT, config.sessionTimeout),
    autoLoginEnabled: parseBoolean(process.env.AUTO_LOGIN_ENABLED, config.autoLoginEnabled),
    loginEmail: process.env.LOGIN_EMAIL || config.loginEmail,
    loginPassword: process.env.LOGIN_PASSWORD || config.loginPassword,
    autoLoginTimeoutMs: parseInteger(process.env.AUTO_LOGIN_TIMEOUT_MS, config.autoLoginTimeoutMs),
    stealthEnabled: parseBoolean(process.env.STEALTH_ENABLED, config.stealthEnabled),
    stealthRandomDelays: parseBoolean(
      process.env.STEALTH_RANDOM_DELAYS,
      config.stealthRandomDelays
    ),
    stealthHumanTyping: parseBoolean(process.env.STEALTH_HUMAN_TYPING, config.stealthHumanTyping),
    stealthMouseMovements: parseBoolean(
      process.env.STEALTH_MOUSE_MOVEMENTS,
      config.stealthMouseMovements
    ),
    typingWpmMin: parseInteger(process.env.TYPING_WPM_MIN, config.typingWpmMin),
    typingWpmMax: parseInteger(process.env.TYPING_WPM_MAX, config.typingWpmMax),
    minDelayMs: parseInteger(process.env.MIN_DELAY_MS, config.minDelayMs),
    maxDelayMs: parseInteger(process.env.MAX_DELAY_MS, config.maxDelayMs),
    notebookDescription: process.env.NOTEBOOK_DESCRIPTION || config.notebookDescription,
    notebookTopics: parseArray(process.env.NOTEBOOK_TOPICS, config.notebookTopics),
    notebookContentTypes: parseArray(
      process.env.NOTEBOOK_CONTENT_TYPES,
      config.notebookContentTypes
    ),
    notebookUseCases: parseArray(process.env.NOTEBOOK_USE_CASES, config.notebookUseCases),
    profileStrategy: parseProfileStrategy(
      process.env.NOTEBOOK_PROFILE_STRATEGY,
      config.profileStrategy
    ),
    cloneProfileOnIsolated: parseBoolean(
      process.env.NOTEBOOK_CLONE_PROFILE,
      config.cloneProfileOnIsolated
    ),
    cleanupInstancesOnStartup: parseBoolean(
      process.env.NOTEBOOK_CLEANUP_ON_STARTUP,
      config.cleanupInstancesOnStartup
    ),
    cleanupInstancesOnShutdown: parseBoolean(
      process.env.NOTEBOOK_CLEANUP_ON_SHUTDOWN,
      config.cleanupInstancesOnShutdown
    ),
    instanceProfileTtlHours: parseInteger(
      process.env.NOTEBOOK_INSTANCE_TTL_HOURS,
      config.instanceProfileTtlHours
    ),
    instanceProfileMaxCount: parseInteger(
      process.env.NOTEBOOK_INSTANCE_MAX_COUNT,
      config.instanceProfileMaxCount
    ),
  };
}

const BASE_CONFIG: Config = applyEnvOverrides(DEFAULTS);
const configStorage = new AsyncLocalStorage<Config>();

/**
 * Concurrency-safe configuration proxy:
 * - Reads from the active AsyncLocalStorage store when inside `runWithConfig(...)`
 * - Falls back to `BASE_CONFIG` otherwise
 * - Startup mutations (e.g., `applyAccountToConfig`) update `BASE_CONFIG`
 */
export const CONFIG: Config = new Proxy(BASE_CONFIG, {
  get(target, prop, receiver) {
    const active = configStorage.getStore();
    if (active && prop in active) {
      return Reflect.get(active, prop, active);
    }
    return Reflect.get(target, prop, receiver);
  },
  set(target, prop, value, receiver) {
    const active = configStorage.getStore();
    if (active) {
      return Reflect.set(active, prop, value, active);
    }
    return Reflect.set(target, prop, value, receiver);
  },
  ownKeys(target) {
    const active = configStorage.getStore();
    return Reflect.ownKeys(active ?? target);
  },
  getOwnPropertyDescriptor(target, prop) {
    const active = configStorage.getStore();
    return Reflect.getOwnPropertyDescriptor(active ?? target, prop);
  },
});

/**
 * Execute an async operation with request-scoped configuration overrides.
 * Concurrent calls never overwrite each other's settings.
 */
export function runWithConfig<T>(overrideConfig: Config, fn: () => Promise<T>): Promise<T> {
  const cloned: Config = {
    ...overrideConfig,
    viewport: { ...overrideConfig.viewport },
    notebookTopics: [...overrideConfig.notebookTopics],
    notebookContentTypes: [...overrideConfig.notebookContentTypes],
    notebookUseCases: [...overrideConfig.notebookUseCases],
  };
  return configStorage.run(cloned, fn);
}

/**
 * Snapshot the currently effective configuration as a plain object.
 */
export function snapshotConfig(): Config {
  const src = configStorage.getStore() ?? BASE_CONFIG;
  return {
    ...src,
    viewport: { ...src.viewport },
    notebookTopics: [...src.notebookTopics],
    notebookContentTypes: [...src.notebookContentTypes],
    notebookUseCases: [...src.notebookUseCases],
  };
}

/**
 * Ensure all required directories exist
 */
export function ensureDirectories(): void {
  const dirs = [
    CONFIG.dataDir,
    CONFIG.browserStateDir,
    CONFIG.chromeProfileDir,
    CONFIG.chromeInstancesDir,
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Browser options that can be passed via tool parameters
 */
export interface BrowserOptions {
  show?: boolean;
  headless?: boolean;
  timeout_ms?: number;
  stealth?: {
    enabled?: boolean;
    random_delays?: boolean;
    human_typing?: boolean;
    mouse_movements?: boolean;
    typing_wpm_min?: number;
    typing_wpm_max?: number;
    delay_min_ms?: number;
    delay_max_ms?: number;
  };
  viewport?: {
    width?: number;
    height?: number;
  };
}

/**
 * Apply browser options to CONFIG (returns a new Config snapshot without mutating BASE_CONFIG)
 */
export function applyBrowserOptions(options?: BrowserOptions, legacyShowBrowser?: boolean): Config {
  const config = snapshotConfig();

  if (legacyShowBrowser !== undefined) {
    config.headless = !legacyShowBrowser;
  }

  if (options) {
    if (options.show !== undefined) {
      config.headless = !options.show;
    }
    if (options.headless !== undefined) {
      config.headless = options.headless;
    }
    if (options.timeout_ms !== undefined) {
      config.browserTimeout = options.timeout_ms;
      config.answerTimeoutMs = options.timeout_ms;
    }
    if (options.stealth) {
      const s = options.stealth;
      if (s.enabled !== undefined) config.stealthEnabled = s.enabled;
      if (s.random_delays !== undefined) config.stealthRandomDelays = s.random_delays;
      if (s.human_typing !== undefined) config.stealthHumanTyping = s.human_typing;
      if (s.mouse_movements !== undefined) config.stealthMouseMovements = s.mouse_movements;
      if (s.typing_wpm_min !== undefined) config.typingWpmMin = s.typing_wpm_min;
      if (s.typing_wpm_max !== undefined) config.typingWpmMax = s.typing_wpm_max;
      if (s.delay_min_ms !== undefined) config.minDelayMs = s.delay_min_ms;
      if (s.delay_max_ms !== undefined) config.maxDelayMs = s.delay_max_ms;
    }
    if (options.viewport) {
      config.viewport = {
        width: options.viewport.width ?? config.viewport.width,
        height: options.viewport.height ?? config.viewport.height,
      };
    }
  }

  return config;
}

ensureDirectories();
