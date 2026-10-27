import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Page } from "patchright";

import {
  CONFIG,
  applyBrowserOptions,
  ensureDirectories,
  runWithConfig,
  snapshotConfig,
} from "../src/config.js";
import { AuthManager } from "../src/auth/auth-manager.js";
import { NotebookLMMCPServer, SERVER_VERSION, parseTransportOptions } from "../src/index.js";
import { NotebookLibrary } from "../src/library/notebook-library.js";
import { Selectors } from "../src/notebooklm/selectors.js";
import { addSource } from "../src/notebooklm/sources.js";
import { buildToolDefinitions } from "../src/tools/definitions.js";
import { SettingsManager } from "../src/utils/settings-manager.js";

describe("notebooklm-mcp v2.1.0 core & transport suite", () => {
  let tmpRoot = "";
  const savedConfig = snapshotConfig();

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "notebooklm-mcp-test-"));
    CONFIG.configDir = path.join(tmpRoot, "config");
    CONFIG.dataDir = path.join(tmpRoot, "data");
    CONFIG.browserStateDir = path.join(tmpRoot, "data", "browser_state");
    CONFIG.chromeProfileDir = path.join(tmpRoot, "data", "chrome_profile");
    CONFIG.chromeInstancesDir = path.join(tmpRoot, "data", "chrome_profile_instances");
    ensureDirectories();
  });

  after(() => {
    Object.assign(CONFIG, savedConfig);
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("isolates concurrent per-request CONFIG overrides via AsyncLocalStorage", async () => {
    const defaultTimeout = CONFIG.browserTimeout;
    const defaultAnswerTimeout = CONFIG.answerTimeoutMs;
    const defaultHeadless = CONFIG.headless;

    const cfgA = applyBrowserOptions({ timeout_ms: 17_500, show: true });
    const cfgB = applyBrowserOptions({ timeout_ms: 92_000, headless: true });

    const [observedA, observedB] = await Promise.all([
      runWithConfig(cfgA, async () => {
        await new Promise((r) => setTimeout(r, 30));
        return {
          browserTimeout: CONFIG.browserTimeout,
          answerTimeoutMs: CONFIG.answerTimeoutMs,
          headless: CONFIG.headless,
        };
      }),
      runWithConfig(cfgB, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return {
          browserTimeout: CONFIG.browserTimeout,
          answerTimeoutMs: CONFIG.answerTimeoutMs,
          headless: CONFIG.headless,
        };
      }),
    ]);

    assert.deepEqual(observedA, {
      browserTimeout: 17_500,
      answerTimeoutMs: 17_500,
      headless: false,
    });
    assert.deepEqual(observedB, {
      browserTimeout: 92_000,
      answerTimeoutMs: 92_000,
      headless: true,
    });

    // Base CONFIG outside runWithConfig remains untouched
    assert.equal(CONFIG.browserTimeout, defaultTimeout);
    assert.equal(CONFIG.answerTimeoutMs, defaultAnswerTimeout);
    assert.equal(CONFIG.headless, defaultHeadless);
  });

  it("exposes all 27 v2.1.0 tools in full profile and filters profiles accurately", () => {
    const prevProfile = process.env.NOTEBOOKLM_PROFILE;
    try {
      const library = new NotebookLibrary();
      const allTools = buildToolDefinitions(library);
      assert.equal(allTools.length, 27);

      const expectedNewTools = [
        "create_notebook",
        "discover_notebooks",
        "list_sources",
        "set_auth_cookies",
        "generate_studio_artifact",
        "get_studio_status",
        "export_studio_artifact",
      ];
      const names = new Set(allTools.map((t) => t.name));
      for (const expected of expectedNewTools) {
        assert.ok(names.has(expected), `Expected tool ${expected} in tool definitions`);
      }

      process.env.NOTEBOOKLM_PROFILE = "minimal";
      const minimalSettings = new SettingsManager();
      const minimalTools = minimalSettings.filterTools(allTools);
      assert.deepEqual(minimalTools.map((t) => t.name).sort(), [
        "ask_question",
        "get_health",
        "get_notebook",
        "list_notebooks",
        "select_notebook",
      ]);

      process.env.NOTEBOOKLM_PROFILE = "standard";
      const standardSettings = new SettingsManager();
      const standardNames = new Set(standardSettings.filterTools(allTools).map((t) => t.name));
      assert.ok(standardNames.has("create_notebook"));
      assert.ok(standardNames.has("discover_notebooks"));
      assert.ok(standardNames.has("add_source"));
      assert.ok(standardNames.has("list_sources"));
      assert.ok(standardNames.has("set_auth_cookies"));

      process.env.NOTEBOOKLM_PROFILE = "full";
      const fullSettings = new SettingsManager();
      assert.equal(fullSettings.filterTools(allTools).length, 27);
    } finally {
      if (prevProfile === undefined) {
        delete process.env.NOTEBOOKLM_PROFILE;
      } else {
        process.env.NOTEBOOKLM_PROFILE = prevProfile;
      }
    }
  });

  it("imports raw and JSON Google auth cookies and validates state without browser", async () => {
    const authManager = new AuthManager();

    // 1. Raw header string import
    const rawHeader = "Cookie: SID=test_sid_value; HSID=test_hsid_value; SSID=test_ssid_value; OSID=test_osid_value; __Secure-1PSID=test_1psid";
    const resultRaw = await authManager.importCookies(rawHeader);
    assert.equal(resultRaw.success, true);
    assert.equal(resultRaw.importedCount, 6); // 5 cookies + 1 duplicate for OSID on notebooklm.google.com
    assert.ok(resultRaw.criticalFound.includes("SID"));
    assert.ok(resultRaw.criticalFound.includes("HSID"));
    assert.ok(resultRaw.criticalFound.includes("OSID"));

    const validStatePath = await authManager.getValidStatePath();
    assert.ok(validStatePath, "Saved state path must be valid and unexpired");

    // 2. Cookie-Editor JSON array import
    const jsonCookies = JSON.stringify([
      { name: "SID", value: "json_sid", domain: ".google.com", path: "/", expirationDate: Math.floor(Date.now() / 1000) + 10000 },
      { name: "SSID", value: "json_ssid", domain: ".google.com", path: "/" },
      { name: "__Secure-3PSID", value: "json_3psid", domain: ".google.com", path: "/" }
    ]);
    const resultJson = await authManager.importCookies(jsonCookies);
    assert.equal(resultJson.success, true);
    assert.equal(resultJson.importedCount, 3);
    assert.ok(resultJson.criticalFound.includes("SID"));
    assert.ok(resultJson.criticalFound.includes("__Secure-3PSID"));

    // Clean up state file so subsequent test assertions expect fresh unauthenticated state
    if (fs.existsSync(validStatePath)) {
      fs.unlinkSync(validStatePath);
    }
  });

  it("prioritizes website/link selectors over youtube for URL sources and registers all 11 Studio triggers", () => {
    assert.ok(
      !Selectors.sources.sourceTypeUrl[0].toLowerCase().includes("youtube"),
      "First URL source selector must not click the YouTube chip"
    );
    assert.ok(
      Selectors.sources.sourceTypeYoutube[0].toLowerCase().includes("youtube"),
      "First YouTube source selector must target YouTube"
    );

    const studioArrays = [
      Selectors.studio.audioOverviewButton,
      Selectors.studio.videoOverviewButton,
      Selectors.studio.mindMapButton,
      Selectors.studio.slideDeckButton,
      Selectors.studio.infographicButton,
      Selectors.studio.flashcardsButton,
      Selectors.studio.quizButton,
      Selectors.studio.briefingDocButton,
      Selectors.studio.studyGuideButton,
      Selectors.studio.faqButton,
      Selectors.studio.timelineButton,
    ];
    for (const arr of studioArrays) {
      assert.ok(arr.length >= 2);
    }
  });

  it("pre-validates local file existence and regular-file type in addSource(type='file')", async () => {
    const fakePage = {
      url: () => "https://notebooklm.google.com/notebook/00000000-0000-0000-0000-000000000001",
    } as unknown as Page;

    const missingPath = path.join(tmpRoot, "does-not-exist.pdf");
    const missingRes = await addSource(fakePage, {
      type: "file",
      content: missingPath,
    });
    assert.equal(missingRes.success, false);
    assert.match(missingRes.message ?? "", /does not exist/i);

    const dirRes = await addSource(fakePage, {
      type: "file",
      content: tmpRoot,
    });
    assert.equal(dirRes.success, false);
    assert.match(dirRes.message ?? "", /not a regular file/i);
  });

  it("parses CLI transport flags cleanly", () => {
    assert.deepEqual(parseTransportOptions([]), { kind: "stdio" });
    assert.deepEqual(
      parseTransportOptions(["--transport", "http", "--port", "4123", "--host", "0.0.0.0"]),
      { kind: "http", port: 4123, host: "0.0.0.0" }
    );
  });

  it("supports concurrent multi-session Streamable-HTTP MCP clients without collision", async () => {
    const prevProfile = process.env.NOTEBOOKLM_PROFILE;
    process.env.NOTEBOOKLM_PROFILE = "full";

    const mcpCoordinator = new NotebookLMMCPServer({ registerSignalHandlers: false });
    const handle = await mcpCoordinator.start({
      kind: "http",
      port: 0,
      host: "127.0.0.1",
    });
    assert.ok(handle, "Expected HttpTransportHandle for HTTP transport");

    const client1 = new Client({ name: "test-client-1", version: "1.0.0" });
    const client2 = new Client({ name: "test-client-2", version: "1.0.0" });

    try {
      const addr = handle.server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      // 1. Healthz check before any sessions connect
      const healthBefore = await fetch(`${baseUrl}/healthz`).then((r) => r.json());
      assert.equal((healthBefore as { status: string }).status, "ok");
      assert.equal((healthBefore as { version: string }).version, SERVER_VERSION);

      // 2. Connect TWO independent MCP HTTP clients simultaneously (regression test for v2.0.0 crash)
      const transport1 = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      const transport2 = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));

      await Promise.all([client1.connect(transport1), client2.connect(transport2)]);

      assert.ok(transport1.sessionId, "Client 1 should receive an Mcp-Session-Id");
      assert.ok(transport2.sessionId, "Client 2 should receive an Mcp-Session-Id");
      assert.notEqual(
        transport1.sessionId,
        transport2.sessionId,
        "Concurrent sessions must have distinct session IDs"
      );

      const healthDuring = (await fetch(`${baseUrl}/healthz`).then((r) => r.json())) as {
        activeSessions: number;
      };
      assert.equal(healthDuring.activeSessions, 2);

      // 3. Concurrent tool listing + tool invocation across both clients
      const [toolsResp1, healthToolResp2] = await Promise.all([
        client1.listTools(),
        client2.callTool({ name: "get_health", arguments: {} }),
      ]);

      assert.equal(toolsResp1.tools.length, 27);

      const contentArr = healthToolResp2.content as Array<{ type: string; text: string }>;
      const parsedHealth = JSON.parse(contentArr[0].text) as {
        success: boolean;
        data: { status: string; authenticated: boolean };
      };
      assert.equal(parsedHealth.success, true);
      assert.equal(parsedHealth.data.status, "ok");
      assert.equal(parsedHealth.data.authenticated, false);

      // 4. Add a notebook via Client 1 and verify Client 2 sees updated dynamic ask_question description
      await client1.callTool({
        name: "add_notebook",
        arguments: {
          url: "https://notebooklm.google.com/notebook/11111111-2222-3333-4444-555555555555",
          name: "Quantum Computing Notes",
          description: "Research papers on topological qubits",
          topics: ["quantum", "qubits"],
        },
      });

      const toolsResp2 = await client2.listTools();
      const askTool = toolsResp2.tools.find((t) => t.name === "ask_question");
      assert.ok(askTool?.description?.includes("Quantum Computing Notes"));

      await transport1.terminateSession().catch(() => undefined);
      await transport2.terminateSession().catch(() => undefined);
    } finally {
      await client1.close().catch(() => undefined);
      await client2.close().catch(() => undefined);
      await mcpCoordinator.stop();
      if (prevProfile === undefined) {
        delete process.env.NOTEBOOKLM_PROFILE;
      } else {
        process.env.NOTEBOOKLM_PROFILE = prevProfile;
      }
    }
  });
});
