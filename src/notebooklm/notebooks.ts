/**
 * NotebookLM remote notebook creation & account dashboard discovery.
 *
 * Lets an agent programmatically create a brand-new NotebookLM notebook on
 * `notebooklm.google.com` or discover notebooks already on the user's Google
 * account without requiring manual copy-pasting of URLs.
 */

import type { BrowserContext } from "patchright";
import { CONFIG, NOTEBOOKLM_HOME_URL } from "../config.js";
import { Selectors, joinAlt } from "./selectors.js";
import { safeSleep } from "../browser/watchdog.js";
import { log } from "../utils/logger.js";

export interface CreateNotebookOptions {
  /** Optional title to assign to the newly created notebook. */
  title?: string;
}

export interface CreateNotebookResult {
  success: boolean;
  url?: string;
  notebookUuid?: string;
  title?: string;
  message?: string;
}

export interface RemoteNotebookSummary {
  title: string;
  url?: string;
  notebookUuid?: string;
  sourceCountText?: string;
}

export interface DiscoverNotebooksResult {
  success: boolean;
  count: number;
  notebooks: RemoteNotebookSummary[];
  message?: string;
}

/**
 * Create a brand-new notebook on `https://notebooklm.google.com/` using the
 * shared persistent BrowserContext.
 */
export async function createRemoteNotebook(
  context: BrowserContext,
  options: CreateNotebookOptions = {}
): Promise<CreateNotebookResult> {
  const page = await context.newPage();
  try {
    log.info(`📓 Navigating to ${NOTEBOOKLM_HOME_URL} to create a new notebook...`);
    await page.goto(NOTEBOOKLM_HOME_URL, {
      waitUntil: "domcontentloaded",
      timeout: CONFIG.browserTimeout,
    });
    await safeSleep(page, 2_000);

    if (page.url().includes("accounts.google.com")) {
      return {
        success: false,
        message: "Google session is not authenticated. Run `setup_auth` (or `re_auth`) first.",
      };
    }

    // Click the "New notebook" / "Create new" button on the home dashboard
    let clicked = false;
    for (const sel of Selectors.notebooks.createButton) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await btn.click();
        clicked = true;
        log.info(`  ✅ Clicked create-notebook button (${sel})`);
        break;
      }
    }

    if (!clicked) {
      const combined = page.locator(joinAlt(Selectors.notebooks.createButton)).first();
      if (await combined.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await combined.click();
        clicked = true;
      }
    }

    if (!clicked) {
      return {
        success: false,
        message:
          "Could not find the 'Create new' / 'New notebook' button on notebooklm.google.com. " +
          "Ensure your account has completed NotebookLM onboarding.",
      };
    }

    // Wait for URL to transition to /notebook/<uuid>
    const deadline = Date.now() + 20_000;
    let notebookUrl = "";
    let notebookUuid = "";
    while (Date.now() < deadline) {
      const current = page.url();
      const match = current.match(/https:\/\/notebooklm\.google\.com\/notebook\/([a-f0-9-]+)/i);
      if (match) {
        notebookUrl = `https://notebooklm.google.com/notebook/${match[1]}`;
        notebookUuid = match[1];
        break;
      }
      await safeSleep(page, 400);
    }

    if (!notebookUrl) {
      return {
        success: false,
        message: `Clicked create button, but URL did not navigate to /notebook/<uuid> (current URL: ${page.url()}).`,
      };
    }

    await safeSleep(page, 1_200);

    // Dismiss the auto-opened "Add sources" modal so we can set the title cleanly
    await page.keyboard.press("Escape").catch(() => undefined);
    await safeSleep(page, 400);

    const appliedTitle = options.title?.trim();
    if (appliedTitle) {
      let renamed = false;
      for (const titleSel of Selectors.notebooks.titleInput) {
        const input = page.locator(titleSel).first();
        if (await input.isVisible({ timeout: 1_500 }).catch(() => false)) {
          await input.click().catch(() => undefined);
          await input.fill(appliedTitle);
          await page.keyboard.press("Enter").catch(() => undefined);
          await safeSleep(page, 500);
          renamed = true;
          log.success(`  ✅ Set notebook title to "${appliedTitle}"`);
          break;
        }
      }
      if (!renamed) {
        log.warning(`  ⚠️  Could not locate notebook title input; kept default title.`);
      }
    }

    log.success(`✅ Created NotebookLM notebook: ${notebookUrl}`);
    return {
      success: true,
      url: notebookUrl,
      notebookUuid,
      title: appliedTitle || "Untitled notebook",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`❌ createRemoteNotebook failed: ${msg}`);
    return { success: false, message: msg };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Discover existing notebooks listed on the user's `notebooklm.google.com`
 * dashboard.
 */
export async function discoverRemoteNotebooks(
  context: BrowserContext
): Promise<DiscoverNotebooksResult> {
  const page = await context.newPage();
  try {
    log.info(`🔍 Scanning ${NOTEBOOKLM_HOME_URL} for existing notebooks...`);
    await page.goto(NOTEBOOKLM_HOME_URL, {
      waitUntil: "domcontentloaded",
      timeout: CONFIG.browserTimeout,
    });
    await safeSleep(page, 2_500);

    if (page.url().includes("accounts.google.com")) {
      return {
        success: false,
        count: 0,
        notebooks: [],
        message: "Google session is not authenticated. Run `setup_auth` (or `re_auth`) first.",
      };
    }

    // Wait briefly for project cards or links to hydrate
    await page
      .locator(Selectors.notebooks.projectCard)
      .first()
      .waitFor({ state: "visible", timeout: 8_000 })
      .catch(() => undefined);

    const discovered = (await page.evaluate(`
      (() => {
        const results = [];
        const seen = new Set();

        // 1. Anchor links with /notebook/<uuid>
        document.querySelectorAll('a[href*="/notebook/"]').forEach((a) => {
          const href = a.getAttribute('href') || '';
          const m = href.match(/notebook\\/([a-f0-9-]+)/i);
          const uuid = m ? m[1] : undefined;
          const key = uuid || href;
          if (!key || seen.has(key)) return;
          seen.add(key);
          const raw = (a.innerText || a.getAttribute('aria-label') || '').trim();
          const lines = raw.split('\\n').map((s) => s.trim()).filter(Boolean);
          const title = lines[0] || 'Untitled notebook';
          const sourceLine = lines.find((l) => /\\d+\\s*(source|quell|fuent|font|bron|ソース)/i.test(l));
          results.push({
            title,
            url: uuid ? 'https://notebooklm.google.com/notebook/' + uuid : href,
            notebookUuid: uuid,
            sourceCountText: sourceLine,
          });
        });

        // 2. Angular project-button / project cards (when rendered without <a>)
        document.querySelectorAll('project-button, mat-card.project-button-card, button[aria-labelledby*="project-"]').forEach((card) => {
          const idAttr = card.getAttribute('id') || card.getAttribute('aria-labelledby') || '';
          const uuidMatch = idAttr.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
          const uuid = uuidMatch ? uuidMatch[1] : undefined;
          if (uuid && seen.has(uuid)) return;

          const titleEl = card.querySelector('.project-button-title, .title, h3, h2');
          const raw = (titleEl ? titleEl.textContent : card.textContent) || '';
          const lines = raw
            .split('\\n')
            .map((s) => s.trim())
            .filter((s) => s && s !== 'more_vert' && s !== 'add');
          const title = lines[0];
          if (!title) return;
          if (/^(create new|new notebook|neues notizbuch|créer)$/i.test(title)) return;

          const dedupeKey = uuid || ('title:' + title);
          if (seen.has(dedupeKey)) return;
          seen.add(dedupeKey);

          const sourceLine = lines.find((l) => /\\d+\\s*(source|quell|fuent|font|bron|ソース)/i.test(l));
          results.push({
            title,
            ...(uuid && {
              url: 'https://notebooklm.google.com/notebook/' + uuid,
              notebookUuid: uuid,
            }),
            ...(sourceLine && { sourceCountText: sourceLine }),
          });
        });

        return results;
      })()
    `)) as RemoteNotebookSummary[];

    return {
      success: true,
      count: discovered.length,
      notebooks: discovered,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`❌ discoverRemoteNotebooks failed: ${msg}`);
    return {
      success: false,
      count: 0,
      notebooks: [],
      message: msg,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}
