/**
 * Unified NotebookLM Studio Artifacts Engine (v2.1.0).
 *
 * Wraps the modern 2026 NotebookLM Studio right-hand panel beyond Audio
 * Overviews:
 *   - `audio`        — Podcast-style Audio Overview (.m4a / .wav download)
 *   - `video`        — narrated Video Overview (.mp4 download)
 *   - `mindmap`      — interactive Mind Map (PNG/SVG download or node text extraction)
 *   - `slide_deck`   — Presentation / Slide Deck
 *   - `infographic`  — visual Infographic
 *   - `flashcards`   — study Flashcards
 *   - `quiz`         — practice Quiz
 *   - `briefing_doc` — Briefing Document report
 *   - `study_guide`  — Study Guide report
 *   - `faq`          — FAQ report
 *   - `timeline`     — Chronological Timeline report
 */

import type { Page } from "patchright";
import fs from "fs";
import path from "path";
import { Selectors, joinAlt } from "./selectors.js";
import { safeSleep, isRecoverable } from "../browser/watchdog.js";
import { log } from "../utils/logger.js";

export type StudioArtifactType =
  | "audio"
  | "video"
  | "mindmap"
  | "slide_deck"
  | "infographic"
  | "flashcards"
  | "quiz"
  | "briefing_doc"
  | "study_guide"
  | "faq"
  | "timeline";

export interface GenerateStudioArtifactOptions {
  artifactType: StudioArtifactType;
  /** Optional custom focus prompt (supported on Audio/Video/Report customize dialogs). */
  customPrompt?: string;
  /** Block until the new artifact tile finishes generating. Default: false (async). */
  waitForCompletion?: boolean;
  /** Maximum wait when `waitForCompletion=true`. Default: 600_000 ms (10 min). */
  timeoutMs?: number;
}

export interface GenerateStudioArtifactResult {
  status: "started" | "in_progress" | "ready" | "error";
  artifactType: StudioArtifactType;
  artifactCountBefore: number;
  artifactCountAfter?: number;
  message?: string;
}

export interface StudioArtifactSummary {
  index: number;
  title: string;
  status: "ready" | "in_progress";
  icon?: string;
}

export interface StudioStatusResult {
  status: "ok" | "error";
  totalArtifacts: number;
  inProgress: boolean;
  artifacts: StudioArtifactSummary[];
  message?: string;
}

export interface ExportStudioArtifactOptions {
  destinationDir: string;
  /** Optional 1-based artifact index from `get_studio_status` (defaults to latest ready item, index 1). */
  artifactIndex?: number;
  /** Optional case-insensitive title substring filter to pick the right Studio tile. */
  titleFilter?: string;
}

export interface ExportStudioArtifactResult {
  success: boolean;
  mode?: "download" | "text_markdown";
  filePath?: string;
  title?: string;
  contentPreview?: string;
  message?: string;
}

const IN_PROGRESS_PHRASES = [
  "check back in a few minutes",
  "come back in a few minutes",
  "being generated",
  "generating",
  "kommen sie in ein paar minuten wieder",
  "wird erstellt",
  "wird generiert",
  "revenez dans quelques minutes",
  "génération",
  "vuelve en unos minutos",
  "generando",
  "torna tra qualche minuto",
  "generazione",
  "volte em alguns minutos",
  "gerando",
  "kom over een paar minuten terug",
  "wordt gegenereerd",
  "数分後にもう一度ご確認ください",
  "生成しています",
];

function getTriggersForArtifact(type: StudioArtifactType): readonly string[] {
  switch (type) {
    case "audio":
      return Selectors.studio.audioOverviewButton;
    case "video":
      return Selectors.studio.videoOverviewButton;
    case "mindmap":
      return Selectors.studio.mindMapButton;
    case "slide_deck":
      return Selectors.studio.slideDeckButton;
    case "infographic":
      return Selectors.studio.infographicButton;
    case "flashcards":
      return Selectors.studio.flashcardsButton;
    case "quiz":
      return Selectors.studio.quizButton;
    case "briefing_doc":
      return [...Selectors.studio.briefingDocButton, ...Selectors.studio.reportsButton];
    case "study_guide":
      return [...Selectors.studio.studyGuideButton, ...Selectors.studio.reportsButton];
    case "faq":
      return [...Selectors.studio.faqButton, ...Selectors.studio.reportsButton];
    case "timeline":
      return [...Selectors.studio.timelineButton, ...Selectors.studio.reportsButton];
  }
}

function isReportSubType(type: StudioArtifactType): boolean {
  return type === "briefing_doc" || type === "study_guide" || type === "faq" || type === "timeline";
}

function getSubTypeSpecificSelectors(type: StudioArtifactType): readonly string[] {
  switch (type) {
    case "briefing_doc":
      return Selectors.studio.briefingDocButton;
    case "study_guide":
      return Selectors.studio.studyGuideButton;
    case "faq":
      return Selectors.studio.faqButton;
    case "timeline":
      return Selectors.studio.timelineButton;
    default:
      return [];
  }
}

export async function ensureStudioExpanded(page: Page): Promise<void> {
  const anyCardVisible = await page
    .locator(
      joinAlt([
        ...Selectors.studio.audioOverviewButton.slice(0, 3),
        ...Selectors.studio.mindMapButton.slice(0, 2),
      ])
    )
    .first()
    .isVisible({ timeout: 600 })
    .catch(() => false);
  if (anyCardVisible) return;

  for (const sel of Selectors.studio.expandButton) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click().catch(() => undefined);
      await safeSleep(page, 400);
      return;
    }
  }
}

/**
 * Trigger generation of any supported NotebookLM Studio artifact.
 */
export async function generateStudioArtifact(
  page: Page,
  options: GenerateStudioArtifactOptions
): Promise<GenerateStudioArtifactResult> {
  const { artifactType, customPrompt, waitForCompletion = false, timeoutMs = 600_000 } = options;

  try {
    await ensureStudioExpanded(page);
    const statusBefore = await getStudioStatusOnPage(page);
    const countBefore = statusBefore.totalArtifacts;

    // For report subtypes in the 2026 layout, NotebookLM either shows direct
    // chips ("Briefing doc", "Study guide", "FAQ", "Timeline") OR nests them
    // inside a "Reports" dialog. Handle both transparently!
    if (isReportSubType(artifactType)) {
      const directSelectors = getSubTypeSpecificSelectors(artifactType);
      const clickedDirect = await tryClickFirstVisible(page, directSelectors);
      if (!clickedDirect) {
        const openedReports = await tryClickFirstVisible(page, Selectors.studio.reportsButton);
        if (!openedReports) {
          throw new Error(
            `Could not locate Studio trigger for ${artifactType} (tried direct chips and Reports card).`
          );
        }
        await safeSleep(page, 500);
        const clickedInModal = await tryClickFirstVisible(page, directSelectors);
        if (!clickedInModal && customPrompt) {
          await fillModalPromptAndGenerate(page, customPrompt);
        } else if (!clickedInModal) {
          throw new Error(
            `Opened Reports dialog, but could not find ${artifactType} option inside it.`
          );
        }
      }
    } else if (customPrompt && (artifactType === "audio" || artifactType === "video")) {
      const customised = await tryOpenCustomizeForType(page, artifactType);
      if (customised) {
        await fillModalPromptAndGenerate(page, customPrompt);
      } else {
        await clickRequiredVisible(page, getTriggersForArtifact(artifactType), artifactType);
      }
    } else {
      await clickRequiredVisible(page, getTriggersForArtifact(artifactType), artifactType);
      // If clicking opened a Customize/Generate modal (e.g. Slide Deck / Video options), submit it
      const modalVisible = await page
        .locator(Selectors.sources.overlayPane)
        .first()
        .isVisible({ timeout: 800 })
        .catch(() => false);
      if (modalVisible) {
        await fillModalPromptAndGenerate(page, customPrompt);
      }
    }

    log.info(`  🎨 Studio artifact triggered: ${artifactType}`);

    if (!waitForCompletion) {
      return {
        status: "started",
        artifactType,
        artifactCountBefore: countBefore,
        message:
          `Triggered '${artifactType}' generation. Poll \`get_studio_status\` to check progress, ` +
          `then call \`export_studio_artifact\` once ready.`,
      };
    }

    // Synchronous wait until a new ready artifact appears
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await safeSleep(page, 2_000);
      const nowStatus = await getStudioStatusOnPage(page);
      const readyCountBefore = statusBefore.artifacts.filter((a) => a.status === "ready").length;
      const readyCountNow = nowStatus.artifacts.filter((a) => a.status === "ready").length;
      if (readyCountNow > readyCountBefore) {
        return {
          status: "ready",
          artifactType,
          artifactCountBefore: countBefore,
          artifactCountAfter: nowStatus.totalArtifacts,
        };
      }
    }

    return {
      status: "in_progress",
      artifactType,
      artifactCountBefore: countBefore,
      message: `Timed out after ${timeoutMs} ms waiting for '${artifactType}' to finish; generation is still running.`,
    };
  } catch (err) {
    if (isRecoverable(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    log.warning(`  ⚠️  generateStudioArtifact(${artifactType}) failed: ${msg}`);
    return {
      status: "error",
      artifactType,
      artifactCountBefore: 0,
      message: msg,
    };
  }
}

/**
 * Inspect all Studio artifacts currently present in the notebook's Studio panel.
 */
export async function getStudioStatusOnPage(page: Page): Promise<StudioStatusResult> {
  try {
    await ensureStudioExpanded(page);

    const studioText =
      (await page
        .locator(Selectors.studio.panel)
        .first()
        .textContent({ timeout: 800 })
        .catch(() => "")) ?? "";
    const panelLower = studioText.toLowerCase();
    const panelInProgress = IN_PROGRESS_PHRASES.some((p) => panelLower.includes(p));

    const items = (await page.evaluate(`
      (() => {
        const nodes = document.querySelectorAll('artifact-library-item, .artifact-library-container artifact-library-item');
        const out = [];
        const seen = new Set();
        nodes.forEach((node) => {
          if (seen.has(node)) return;
          seen.add(node);
          const iconEl = node.querySelector('mat-icon');
          const icon = iconEl ? (iconEl.textContent || '').trim() : undefined;
          const rawText = (node.innerText || node.textContent || '').trim();
          const lines = rawText
            .split('\\n')
            .map((l) => l.trim())
            .filter((l) => l && l !== 'more_vert' && l !== 'play_arrow' && l !== icon);
          const title = lines[0] || 'Studio Artifact';
          const hasSpinner = Boolean(
            node.querySelector('mat-spinner, mat-progress-spinner, [role="progressbar"]')
          );
          out.push({
            title,
            icon,
            hasSpinner,
            rawLower: rawText.toLowerCase(),
          });
        });
        return out;
      })()
    `)) as Array<{ title: string; icon?: string; hasSpinner: boolean; rawLower: string }>;

    const artifacts: StudioArtifactSummary[] = items.map((item, idx) => {
      const phraseBusy = IN_PROGRESS_PHRASES.some((p) => item.rawLower.includes(p));
      const isBusy = item.hasSpinner || phraseBusy;
      return {
        index: idx + 1,
        title: item.title,
        status: isBusy ? "in_progress" : "ready",
        ...(item.icon && { icon: item.icon }),
      };
    });

    return {
      status: "ok",
      totalArtifacts: artifacts.length,
      inProgress: panelInProgress || artifacts.some((a) => a.status === "in_progress"),
      artifacts,
    };
  } catch (err) {
    if (isRecoverable(err)) throw err;
    return {
      status: "error",
      totalArtifacts: 0,
      inProgress: false,
      artifacts: [],
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Download or export a completed Studio artifact to `destinationDir`.
 * - If the tile exposes a Download action (Audio, Video, Infographic, Slides,
 *   Mind Map), captures the browser download stream and writes the binary file.
 * - Otherwise opens the artifact viewer, extracts its text content, and writes
 *   a clean `.md` file to `destinationDir`.
 */
export async function exportStudioArtifact(
  page: Page,
  options: ExportStudioArtifactOptions
): Promise<ExportStudioArtifactResult> {
  const { destinationDir, artifactIndex, titleFilter } = options;

  try {
    fs.mkdirSync(destinationDir, { recursive: true });
    await ensureStudioExpanded(page);

    const status = await getStudioStatusOnPage(page);
    const readyItems = status.artifacts.filter((a) => a.status === "ready");
    if (readyItems.length === 0) {
      return {
        success: false,
        message: status.inProgress
          ? "Artifact generation is still in progress. Poll `get_studio_status` until `ready`."
          : "No completed Studio artifacts found in this notebook.",
      };
    }

    let chosen = readyItems[0];
    if (artifactIndex !== undefined) {
      const byIndex = status.artifacts.find((a) => a.index === artifactIndex);
      if (!byIndex) {
        return {
          success: false,
          message: `Artifact index ${artifactIndex} not found (total artifacts: ${status.totalArtifacts}).`,
        };
      }
      if (byIndex.status !== "ready") {
        return {
          success: false,
          message: `Artifact #${artifactIndex} ("${byIndex.title}") is still in_progress.`,
        };
      }
      chosen = byIndex;
    } else if (titleFilter) {
      const needle = titleFilter.toLowerCase();
      const matched = readyItems.find((a) => a.title.toLowerCase().includes(needle));
      if (!matched) {
        return {
          success: false,
          message: `No ready Studio artifact matched titleFilter="${titleFilter}".`,
        };
      }
      chosen = matched;
    }

    const tile = page.locator("artifact-library-item").nth(chosen.index - 1);

    // Strategy 1: Open the tile's three-dot menu and look for a Download menuitem
    const moreBtn = tile
      .locator(
        'button:has(mat-icon:text-is("more_vert")), button[aria-label*="more" i], button[aria-label*="mehr" i], button[aria-label*="plus" i]'
      )
      .first();

    if (await moreBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await moreBtn.click();
      await safeSleep(page, 300);

      const dlMenuItem = page.locator(joinAlt(Selectors.studio.audioDownloadMenuItem)).first();
      if (await dlMenuItem.isVisible({ timeout: 1_200 }).catch(() => false)) {
        const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
        await dlMenuItem.click();
        const download = await downloadPromise;
        const suggested = sanitizeFileName(download.suggestedFilename() || `${chosen.title}.bin`);
        const filePath = path.join(destinationDir, suggested);
        await download.saveAs(filePath);
        return {
          success: true,
          mode: "download",
          filePath,
          title: chosen.title,
        };
      }
      // Close menu if no Download item was present
      await page.keyboard.press("Escape").catch(() => undefined);
      await safeSleep(page, 200);
    }

    // Strategy 2: Open the artifact tile to inspect viewer (may contain a Download icon button or rich text)
    await tile.click();
    await safeSleep(page, 800);

    const viewerDownloadBtn = page.locator(joinAlt(Selectors.studio.downloadButton)).first();
    if (await viewerDownloadBtn.isVisible({ timeout: 1_200 }).catch(() => false)) {
      const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
      await viewerDownloadBtn.click();
      const download = await downloadPromise;
      const suggested = sanitizeFileName(download.suggestedFilename() || `${chosen.title}.png`);
      const filePath = path.join(destinationDir, suggested);
      await download.saveAs(filePath);
      await page.keyboard.press("Escape").catch(() => undefined);
      return {
        success: true,
        mode: "download",
        filePath,
        title: chosen.title,
      };
    }

    // Strategy 3: Extract text/markdown from note/report/flashcards/quiz viewer panel
    const extractedText = (await page.evaluate(`
      (() => {
        const selectors = [
          '.artifact-viewer',
          'artifact-viewer',
          '.note-editor',
          'note-editor',
          '[role="dialog"]',
          '.studio-panel'
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.innerText && el.innerText.trim().length > 40) {
            return el.innerText.trim();
          }
        }
        return '';
      })()
    `)) as string;

    await page.keyboard.press("Escape").catch(() => undefined);

    if (!extractedText) {
      return {
        success: false,
        title: chosen.title,
        message: `Opened "${chosen.title}", but neither a downloadable file nor extractable text content was found.`,
      };
    }

    const mdName = `${sanitizeFileName(chosen.title || "studio-artifact")}.md`;
    const filePath = path.join(destinationDir, mdName);
    const markdown = `# ${chosen.title}\n\n${extractedText}\n`;
    await fs.promises.writeFile(filePath, markdown, "utf-8");

    return {
      success: true,
      mode: "text_markdown",
      filePath,
      title: chosen.title,
      contentPreview: extractedText.slice(0, 500),
    };
  } catch (err) {
    if (isRecoverable(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    log.warning(`  ⚠️  exportStudioArtifact failed: ${msg}`);
    return { success: false, message: msg };
  }
}

function sanitizeFileName(raw: string): string {
  let cleaned = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    cleaned += code < 32 ? "_" : raw[i];
  }
  return cleaned
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

async function tryClickFirstVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const sel of selectors) {
    const candidate = page.locator(sel).first();
    if (await candidate.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await candidate.click();
      await safeSleep(page, 300);
      return true;
    }
  }
  return false;
}

async function clickRequiredVisible(
  page: Page,
  selectors: readonly string[],
  label: string
): Promise<void> {
  const ok = await tryClickFirstVisible(page, selectors);
  if (!ok) {
    throw new Error(
      `Could not find Studio control for '${label}'. NotebookLM Studio UI may have changed or requires at least 1 source in the notebook.`
    );
  }
}

async function tryOpenCustomizeForType(page: Page, type: "audio" | "video"): Promise<boolean> {
  const keyword = type === "audio" ? "audio" : "video";
  const selectors = [
    `button[aria-label*="customize" i][aria-label*="${keyword}" i]`,
    `button[aria-label*="customise" i][aria-label*="${keyword}" i]`,
    `button[aria-label*="anpassen" i][aria-label*="${keyword}" i]`,
    `button[aria-label*="personnaliser" i][aria-label*="${keyword}" i]`,
    `button[aria-label*="personalizar" i][aria-label*="${keyword}" i]`,
  ];
  return tryClickFirstVisible(page, selectors);
}

async function fillModalPromptAndGenerate(page: Page, customPrompt?: string): Promise<void> {
  const overlay = page.locator(Selectors.sources.overlayPane).first();
  if (customPrompt) {
    const promptField = overlay.locator("textarea, input[type='text']").first();
    if (await promptField.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await promptField.fill(customPrompt);
      await safeSleep(page, 250);
    }
  }
  const clickedGen = await tryClickFirstVisible(page, Selectors.studio.generateButton);
  if (!clickedGen) {
    await tryClickFirstVisible(page, Selectors.sources.insertConfirm);
  }
}
