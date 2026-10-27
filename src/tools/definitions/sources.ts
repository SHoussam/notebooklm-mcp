/**
 * MCP tool definitions for source ingestion, source listing, Audio Overview,
 * and unified Studio Artifacts (v2.1.0).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const sharedNotebookTargeting = {
  session_id: {
    type: "string",
    description:
      "Reuse an existing browser session by id. Recommended when you have " +
      "already interacted with the same notebook — saves page-load time.",
  },
  notebook_id: {
    type: "string",
    description:
      "Library notebook id (from `list_notebooks` / `search_notebooks`). " +
      "Defaults to the active notebook (see `select_notebook`) when omitted.",
  },
  notebook_url: {
    type: "string",
    description:
      "Direct NotebookLM URL — overrides `notebook_id`. Format: " +
      "`https://notebooklm.google.com/notebook/<uuid>`.",
  },
};

export const addSourceTool: Tool = {
  name: "add_source",
  description:
    "Ingest a source into a NotebookLM notebook. Supports four source types in v2.1:\n" +
    "  • `url`     — NotebookLM crawls and indexes a website\n" +
    "  • `youtube` — NotebookLM indexes a YouTube video's captions/transcript\n" +
    "  • `text`    — paste raw text (treated as a copied document)\n" +
    "  • `file`    — upload a local file (.pdf, .txt, .md, .docx, .mp3, .wav, .m4a, images)\n\n" +
    "Returns `sourceCountBefore`/`sourceCountAfter` so the caller can verify " +
    "the new source landed. Call once per source.",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["url", "youtube", "text", "file"],
        description:
          "`url` crawls a website; `youtube` indexes a YouTube video URL; " +
          "`text` ingests `content` verbatim; `file` uploads a local file path.",
      },
      content: {
        type: "string",
        description:
          "When `type=url` or `youtube`: fully-qualified https:// URL. " +
          "When `type=text`: raw text body. " +
          "When `type=file`: local path to the file on disk (absolute path recommended).",
      },
      title: {
        type: "string",
        description:
          "Optional display title (used when `type=text`; files/URLs use their own titles).",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["type", "content"],
  },
  annotations: {
    title: "Add source to notebook",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const listSourcesTool: Tool = {
  name: "list_sources",
  description:
    "List all sources currently loaded in a NotebookLM notebook's Sources sidebar " +
    "(count and ordered source titles).",
  inputSchema: {
    type: "object",
    properties: {
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
  },
  annotations: {
    title: "List sources in notebook",
    readOnlyHint: true,
    openWorldHint: true,
  },
};

export const generateAudioTool: Tool = {
  name: "generate_audio",
  description:
    "Trigger podcast-style Audio Overview generation for a notebook (async by default).\n\n" +
    "Workflow:\n" +
    "  1. `generate_audio` → returns immediately with `started` / `in_progress` / `ready`\n" +
    "  2. Poll `get_audio_status` every ~30 s\n" +
    "  3. When status is `ready`, call `download_audio`",
  inputSchema: {
    type: "object",
    properties: {
      custom_prompt: {
        type: "string",
        description: "Optional focus prompt passed into the Audio Customize dialog.",
      },
      wait_for_completion: {
        type: "boolean",
        description:
          "If true, block until the audio tile is ready (up to `timeout_ms`). Default: false.",
      },
      timeout_ms: {
        type: "number",
        description: "Maximum wait in ms when `wait_for_completion=true`. Default: 600000.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
  },
  annotations: {
    title: "Generate Audio Overview",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const getAudioStatusTool: Tool = {
  name: "get_audio_status",
  description:
    "Non-blocking probe for the current Audio Overview state (`ready`, `in_progress`, or `not_started`).",
  inputSchema: {
    type: "object",
    properties: {
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
  },
  annotations: {
    title: "Get Audio Overview status",
    readOnlyHint: true,
    openWorldHint: true,
  },
};

export const downloadAudioTool: Tool = {
  name: "download_audio",
  description:
    "Save the completed Audio Overview to disk (`destination_dir`). Run after `get_audio_status` reports `ready`.",
  inputSchema: {
    type: "object",
    properties: {
      destination_dir: {
        type: "string",
        description: "Absolute directory path where the audio file is saved.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["destination_dir"],
  },
  annotations: {
    title: "Download Audio Overview",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const generateStudioArtifactTool: Tool = {
  name: "generate_studio_artifact",
  description:
    "Trigger generation of any NotebookLM Studio artifact:\n" +
    "  • `audio`        — Podcast-style Audio Overview\n" +
    "  • `video`        — Narrated Video Overview\n" +
    "  • `mindmap`      — Interactive Mind Map\n" +
    "  • `slide_deck`   — Presentation / Slide Deck\n" +
    "  • `infographic`  — Visual Infographic\n" +
    "  • `flashcards`   — Study Flashcards\n" +
    "  • `quiz`         — Practice Quiz\n" +
    "  • `briefing_doc` — Briefing Document report\n" +
    "  • `study_guide`  — Study Guide report\n" +
    "  • `faq`          — FAQ report\n" +
    "  • `timeline`     — Chronological Timeline report\n\n" +
    "Async by default: poll `get_studio_status` and then export via `export_studio_artifact`.",
  inputSchema: {
    type: "object",
    properties: {
      artifact_type: {
        type: "string",
        enum: [
          "audio",
          "video",
          "mindmap",
          "slide_deck",
          "infographic",
          "flashcards",
          "quiz",
          "briefing_doc",
          "study_guide",
          "faq",
          "timeline",
        ],
        description: "Which Studio artifact to generate.",
      },
      custom_prompt: {
        type: "string",
        description: "Optional focus prompt when supported by the artifact's customize dialog.",
      },
      wait_for_completion: {
        type: "boolean",
        description: "Block until the new Studio tile finishes generating. Default: false.",
      },
      timeout_ms: {
        type: "number",
        description: "Maximum wait in ms when `wait_for_completion=true`. Default: 600000.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["artifact_type"],
  },
  annotations: {
    title: "Generate Studio artifact",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const getStudioStatusTool: Tool = {
  name: "get_studio_status",
  description:
    "Inspect all Studio artifacts in the notebook's right-hand Studio panel " +
    "(title, 1-based index, icon, and `ready` vs `in_progress` status).",
  inputSchema: {
    type: "object",
    properties: {
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
  },
  annotations: {
    title: "Get Studio artifacts status",
    readOnlyHint: true,
    openWorldHint: true,
  },
};

export const exportStudioArtifactTool: Tool = {
  name: "export_studio_artifact",
  description:
    "Export a completed Studio artifact to `destination_dir`. Downloads binary files " +
    "(Audio, Video, Infographic, Slides, Mind Map) when a Download option exists, or " +
    "extracts text/Markdown (`.md`) for Reports, Flashcards, and Quizzes.",
  inputSchema: {
    type: "object",
    properties: {
      destination_dir: {
        type: "string",
        description: "Absolute directory path where the exported artifact file will be saved.",
      },
      artifact_index: {
        type: "number",
        description:
          "Optional 1-based artifact index from `get_studio_status` (defaults to the first ready item).",
      },
      title_filter: {
        type: "string",
        description: "Optional case-insensitive substring to match an artifact's title.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["destination_dir"],
  },
  annotations: {
    title: "Export Studio artifact",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const sourceTools: Tool[] = [
  addSourceTool,
  listSourcesTool,
  generateAudioTool,
  getAudioStatusTool,
  downloadAudioTool,
  generateStudioArtifactTool,
  getStudioStatusTool,
  exportStudioArtifactTool,
];
