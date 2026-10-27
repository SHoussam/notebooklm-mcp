/**
 * NotebookLM source ingestion & source listing.
 *
 * v2.1.0 supports four source types:
 *   - `url`     — paste a website URL (NotebookLM crawls and indexes it)
 *   - `youtube` — paste a YouTube video URL (NotebookLM indexes captions/transcript)
 *   - `text`    — paste raw text (treated as a copied document)
 *   - `file`    — upload a local file (.pdf, .txt, .md, .docx, .mp3, .wav, .m4a, images)
 *
 * Also exposes `listSources(page)` to enumerate the sources currently loaded
 * in a notebook's left-hand Sources sidebar.
 */

import type { Page } from "patchright";
import fs from "fs";
import path from "path";
import { Selectors, joinAlt } from "./selectors.js";
import { safeSleep, isRecoverable } from "../browser/watchdog.js";
import { log } from "../utils/logger.js";

export type SourceType = "url" | "youtube" | "text" | "file";

export interface AddSourceInput {
  type: SourceType;
  /**
   * - `url`: https://... website URL
   * - `youtube`: https://www.youtube.com/watch?v=... or https://youtu.be/...
   * - `text`: raw text body
   * - `file`: local file path (.pdf, .txt, .md, .docx, audio, image)
   */
  content: string;
  /** Optional title shown in the source list (used for `text` sources). */
  title?: string;
}

export interface AddSourceResult {
  success: boolean;
  type: SourceType;
  sourceCountBefore: number;
  sourceCountAfter: number;
  resolvedFilePath?: string;
  message?: string;
}

export interface NotebookSourceEntry {
  index: number;
  title: string;
}

export interface ListSourcesResult {
  count: number;
  sources: NotebookSourceEntry[];
}

export async function addSource(page: Page, input: AddSourceInput): Promise<AddSourceResult> {
  const initialUrl = page.url();
  const expectedUuid = initialUrl.match(/notebook\/([a-f0-9-]+)/)?.[1];
  log.info(`📄 [add_source] type=${input.type} target_uuid=${expectedUuid ?? "?"}`);

  // Pre-validate local file path before touching the browser
  let resolvedFilePath: string | undefined;
  if (input.type === "file") {
    resolvedFilePath = path.resolve(input.content.trim());
    if (!fs.existsSync(resolvedFilePath)) {
      return {
        success: false,
        type: "file",
        sourceCountBefore: 0,
        sourceCountAfter: 0,
        resolvedFilePath,
        message: `Local file does not exist: ${resolvedFilePath}`,
      };
    }
    const stat = fs.statSync(resolvedFilePath);
    if (!stat.isFile()) {
      return {
        success: false,
        type: "file",
        sourceCountBefore: 0,
        sourceCountAfter: 0,
        resolvedFilePath,
        message: `Path is not a regular file: ${resolvedFilePath}`,
      };
    }
  }

  try {
    const before = await countSources(page);
    log.info(`  📊 source count before add_source: ${before}`);

    // 1. Open the Add-source dialog (or reuse if already open).
    await openAddSourceOverlay(page);

    if (input.type === "file") {
      await uploadLocalFileSource(page, resolvedFilePath!);
    } else {
      // 2. Pick source type (`url`, `youtube`, or `text`).
      await pickSourceType(page, input.type);

      // 3. Fill URL or text content + optional title.
      await fillSourceContent(page, input);

      // 4. Confirm insertion.
      await confirmInsert(page);
    }

    // 5. Wait for the modal to close so sidebar updates can flush.
    await waitForOverlayToClose(page);

    // 6. Guard against NotebookLM's pasted-text redirect quirk.
    if (expectedUuid) {
      const currentUrl = page.url();
      const currentUuid = currentUrl.match(/notebook\/([a-f0-9-]+)/)?.[1];
      if (currentUuid && currentUuid !== expectedUuid) {
        log.error(`  ❌ Notebook redirect: expected ${expectedUuid}, got ${currentUuid}`);
        return {
          success: false,
          type: input.type,
          sourceCountBefore: before,
          sourceCountAfter: before,
          ...(resolvedFilePath && { resolvedFilePath }),
          message:
            `NotebookLM redirected to a different notebook (${currentUuid}) instead of ` +
            `the target (${expectedUuid}). Known quirk for pasted-text uploads.`,
        };
      }
    }

    // 7. Poll source count (up to 120 s for large PDFs / audio / URL crawls).
    const pollTimeoutMs = input.type === "file" ? 120_000 : 90_000;
    const after = await waitForSourceCountIncrease(page, before, pollTimeoutMs);

    if (after > before) {
      log.success(`  ✅ source added (count ${before} → ${after})`);
      return {
        success: true,
        type: input.type,
        sourceCountBefore: before,
        sourceCountAfter: after,
        ...(resolvedFilePath && { resolvedFilePath }),
      };
    }

    const errorText = await readDialogError(page);
    return {
      success: false,
      type: input.type,
      sourceCountBefore: before,
      sourceCountAfter: after,
      ...(resolvedFilePath && { resolvedFilePath }),
      message:
        errorText ||
        `Source dialog completed but the source list did not grow within ${pollTimeoutMs / 1000} s. ` +
          "Either NotebookLM is still indexing a large file or the source was rejected.",
    };
  } catch (err) {
    if (isRecoverable(err)) throw err;
    log.warning(`  ⚠️  add_source failed: ${err}`);
    return {
      success: false,
      type: input.type,
      sourceCountBefore: 0,
      sourceCountAfter: 0,
      ...(resolvedFilePath && { resolvedFilePath }),
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Upload a local file into the open Add-source modal.
 * Tries direct `<input type="file">` binding first, then falls back to
 * intercepting a native `filechooser` event from clicking the upload button.
 */
async function uploadLocalFileSource(page: Page, filePath: string): Promise<void> {
  log.info(`  📤 Uploading local file: ${filePath}`);

  // Path A: Direct <input type="file"> element attached in DOM
  const fileInput = page.locator(Selectors.sources.fileInput).first();
  const attachedCount = await page
    .locator(Selectors.sources.fileInput)
    .count()
    .catch(() => 0);

  if (attachedCount > 0) {
    await fileInput.setInputFiles(filePath);
    log.success("  ✅ File attached via <input type='file'>");
    await safeSleep(page, 600);
    return;
  }

  // Path B: Click the Upload button while awaiting Playwright's filechooser event
  const overlay = page.locator(Selectors.sources.overlayPane).first();
  for (const sel of Selectors.sources.sourceTypeFile) {
    const btn = overlay.locator(sel).first();
    if (await btn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
      await btn.click();
      const chooser = await chooserPromise;
      await chooser.setFiles(filePath);
      log.success(`  ✅ File attached via filechooser (${sel})`);
      await safeSleep(page, 600);
      return;
    }
  }

  throw new Error(
    "Could not locate file upload input or upload button inside the Add-source dialog."
  );
}

/**
 * List all sources currently visible in the notebook's Sources sidebar.
 */
export async function listSources(page: Page): Promise<ListSourcesResult> {
  const totalCount = await countSources(page);
  const sources: NotebookSourceEntry[] = [];

  try {
    const rows = page.locator(Selectors.sources.sourceContainer);
    const rowCount = await rows.count();
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      let title = "";
      for (const titleSel of Selectors.sources.sourceTitle) {
        const sub = row.locator(titleSel).first();
        if ((await sub.count().catch(() => 0)) > 0) {
          const text = (await sub.innerText({ timeout: 500 }).catch(() => "")).trim();
          if (text) {
            title = text;
            break;
          }
        }
      }
      if (!title) {
        const raw = (await row.innerText({ timeout: 500 }).catch(() => "")).trim();
        title =
          raw
            .split("\n")
            .map((l) => l.trim())
            .filter(
              (l) =>
                l &&
                !Selectors.uiControlLabels.has(l) &&
                l !== "check_box" &&
                l !== "check_box_outline_blank"
            )[0] ?? "";
      }
      if (title) {
        sources.push({ index: i + 1, title });
      }
    }
  } catch (err) {
    log.warning(`  ⚠️  listSources partial read error: ${err}`);
  }

  return {
    count: Math.max(totalCount, sources.length),
    sources,
  };
}

export async function countSources(page: Page): Promise<number> {
  let containerCount = 0;
  try {
    containerCount = await page.locator(Selectors.sources.sourceContainer).count();
  } catch {
    /* fall through */
  }

  let headerCount = 0;
  try {
    const headerText = await page
      .locator(Selectors.sources.sourceCountIndicator)
      .first()
      .textContent({ timeout: 500 })
      .catch(() => null);
    const match = headerText?.match(/(\d+)/);
    if (match) headerCount = parseInt(match[1], 10);
  } catch {
    /* ignore */
  }

  return Math.max(containerCount, headerCount);
}

async function openAddSourceOverlay(page: Page): Promise<void> {
  if (await isOverlayVisible(page)) {
    log.info("  ✅ Add-source dialog already open, reusing");
    return;
  }

  try {
    await page.locator(joinAlt(Selectors.sources.addButton)).first().click({ timeout: 5_000 });
    await page
      .locator(Selectors.sources.overlayPane)
      .first()
      .waitFor({ state: "visible", timeout: 8_000 });
    return;
  } catch (err) {
    log.warning(
      `  ⚠️  Add-source button click failed (${err}), trying ?addSource=true URL fallback`
    );
  }

  const url = page.url();
  if (url && /\/notebook\//.test(url) && !url.includes("addSource=true")) {
    const u = new URL(url);
    u.searchParams.set("addSource", "true");
    await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page
      .locator(Selectors.sources.overlayPane)
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    return;
  }

  throw new Error('Could not open the "Add source" dialog');
}

async function isOverlayVisible(page: Page): Promise<boolean> {
  return page
    .locator(Selectors.sources.overlayPane)
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
}

async function pickSourceType(page: Page, type: Exclude<SourceType, "file">): Promise<void> {
  const candidates =
    type === "youtube"
      ? [...Selectors.sources.sourceTypeYoutube, ...Selectors.sources.sourceTypeUrl]
      : type === "url"
        ? Selectors.sources.sourceTypeUrl
        : Selectors.sources.sourceTypeText;

  const overlay = page.locator(Selectors.sources.overlayPane).first();
  for (const sel of candidates) {
    const target = overlay.locator(sel).first();
    if (await target.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await target.click();
      await safeSleep(page, 500);
      return;
    }
  }
}

async function fillSourceContent(page: Page, input: AddSourceInput): Promise<void> {
  const overlay = page.locator(Selectors.sources.overlayPane).first();

  await safeSleep(page, 500);

  const inputCandidates =
    input.type === "url" || input.type === "youtube"
      ? [
          Selectors.sources.overlayInput,
          Selectors.sources.overlayTextarea,
          `${Selectors.sources.overlayPane} textarea:not(.query-box-input):not(.query-box-textarea)`,
        ]
      : [
          Selectors.sources.overlayTextarea,
          Selectors.sources.overlayInput,
          `${Selectors.sources.overlayPane} textarea:not(.query-box-input):not(.query-box-textarea)`,
        ];

  let target = null;
  for (const sel of inputCandidates) {
    const candidate = page.locator(sel).first();
    if (await candidate.isVisible({ timeout: 2_000 }).catch(() => false)) {
      target = candidate;
      break;
    }
  }

  if (!target) {
    throw new Error(
      "Could not find an input field inside the Add-source overlay. " +
        "NotebookLM UI may have changed."
    );
  }

  let body = input.content;
  if (input.title && input.type === "text") {
    let titleInputFound = false;
    const titleSelectors = [
      'input[placeholder*="title" i]',
      'input[placeholder*="name" i]',
      'input[name="title"]',
      `${Selectors.sources.overlayPane} input[type="text"]:not([readonly])`,
    ];
    for (const sel of titleSelectors) {
      const candidate = overlay.locator(sel).first();
      if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
        await candidate.fill(input.title).catch(() => undefined);
        titleInputFound = true;
        break;
      }
    }
    if (!titleInputFound) {
      body = `${input.title}\n\n${input.content}`;
    }
  }

  await target.fill(body);
  await safeSleep(page, 300);
}

async function confirmInsert(page: Page): Promise<void> {
  const overlay = page.locator(Selectors.sources.overlayPane).first();
  for (const sel of Selectors.sources.insertConfirm) {
    const btn = overlay.locator(sel).first();
    if (await btn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const disabled = await btn.isDisabled().catch(() => false);
      if (disabled) continue;
      await btn.click();
      log.info(`  ✅ submit clicked (selector: ${sel})`);
      return;
    }
  }
  log.warning("  ⚠️  No insert button matched, pressing Enter as fallback");
  await page.keyboard.press("Enter");
}

async function waitForOverlayToClose(page: Page, timeoutMs: number = 30_000): Promise<void> {
  await page
    .locator(Selectors.sources.overlayPane)
    .first()
    .waitFor({ state: "hidden", timeout: timeoutMs })
    .catch(() => undefined);
}

async function waitForSourceCountIncrease(
  page: Page,
  before: number,
  timeoutMs: number = 90_000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await countSources(page);
    if (current > before) return current;
    await safeSleep(page, 500);
  }
  return await countSources(page);
}

async function readDialogError(page: Page): Promise<string | null> {
  const errorSelectors = [
    '[role="alert"]:visible',
    ".error-message:visible",
    ".mdc-snackbar--open",
  ];
  const ICON_LEAKS = ["more_vert", "more_horiz", "open_in_new", "content_copy"];

  for (const sel of errorSelectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible({ timeout: 300 }).catch(() => false))) continue;
      const txt = (await el.textContent({ timeout: 1_000 }).catch(() => null))?.trim();
      if (!txt || txt.length > 240) continue;
      if (ICON_LEAKS.some((leak) => txt.includes(leak))) continue;
      return txt;
    } catch {
      continue;
    }
  }
  return null;
}
