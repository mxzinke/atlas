#!/usr/bin/env bun
/**
 * Generate Claude Code settings.json from Atlas config.yml.
 * Reads model preferences and produces the hooks configuration.
 * Run from init.sh on every container start.
 */
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, lstatSync } from "fs";

const CONFIG_PATH = "/atlas/workspace/config.yml";
const SETTINGS_PATH = "/atlas/app/.claude/settings.json";

// Defaults if config.yml is missing or incomplete
const DEFAULT_MODELS = {
  main: "claude-sonnet-4-6",
  subagent_review: "claude-sonnet-4-6",
  hooks: "claude-haiku-4-5",
};

const DEFAULT_FAILURE = {
  notification_command: "",
  backoff_initial_seconds: "30",
  backoff_max_seconds: "900",
  notification_threshold_minutes: "30",
};

/**
 * Minimal YAML parser for the flat models section.
 * Extracts `models.key: value` from lines like:
 *   main: claude-sonnet-4-6  # comment
 */
function parseModelsFromYaml(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  let inModels = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trimEnd();
    // Top-level key (no indent)
    if (/^\S/.test(trimmed)) {
      inModels = trimmed.startsWith("models:");
      continue;
    }
    if (!inModels) continue;
    // Indented key: value under models
    const m = trimmed.match(/^\s+(\w+):\s*(.+?)(?:\s+#.*)?$/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

/**
 * Minimal YAML parser for the failure_handling section.
 * Handles empty values (notification_command: "").
 */
function parseFailureHandlingFromYaml(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  let inSection = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trimEnd();
    if (/^\S/.test(trimmed)) {
      inSection = trimmed.startsWith("failure_handling:");
      continue;
    }
    if (!inSection) continue;
    const m = trimmed.match(/^\s+(\w+):\s*(.*)(?:\s+#.*)?$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

// Read config
let models = { ...DEFAULT_MODELS };
let failure = { ...DEFAULT_FAILURE };
try {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const parsed = parseModelsFromYaml(raw);
  if (parsed.main) models.main = parsed.main;
  if (parsed.subagent_review) models.subagent_review = parsed.subagent_review;
  if (parsed.hooks) models.hooks = parsed.hooks;
  const parsedFailure = parseFailureHandlingFromYaml(raw);
  if (parsedFailure.notification_command !== undefined) failure.notification_command = parsedFailure.notification_command;
  if (parsedFailure.backoff_initial_seconds) failure.backoff_initial_seconds = parsedFailure.backoff_initial_seconds;
  if (parsedFailure.backoff_max_seconds) failure.backoff_max_seconds = parsedFailure.backoff_max_seconds;
  if (parsedFailure.notification_threshold_minutes) failure.notification_threshold_minutes = parsedFailure.notification_threshold_minutes;
} catch {
  console.log("Warning: could not read config.yml, using default models");
}

const failureEnvContent = [
  `ATLAS_BACKOFF_INITIAL=${failure.backoff_initial_seconds}`,
  `ATLAS_BACKOFF_MAX=${failure.backoff_max_seconds}`,
  `ATLAS_NOTIFY_THRESHOLD_MINUTES=${failure.notification_threshold_minutes}`,
  `ATLAS_NOTIFY_COMMAND=${JSON.stringify(failure.notification_command)}`,
  "",
].join("\n");
writeFileSync("/atlas/workspace/.failure-env", failureEnvContent);

const subagentStopPrompt = [
  "A team member has completed their task. Review the result in $ARGUMENTS.",
  "",
  "Evaluate:",
  "1. Was the original task fully completed?",
  "2. Are there obvious errors or gaps?",
  "3. Is the result acceptable or does it need rework?",
  "",
  'Respond with JSON: {"ok": true/false, "reason": "brief explanation"}',
  'Use "ok": false only if the result is clearly incomplete or wrong.',
].join("\n");

const settings: Record<string, unknown> = {
  env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    CLAUDE_MODEL: models.main,
  },
  permissions: {
    allow: [
      "Bash(*)",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "mcp__*",
    ],
  },
  hooks: {
    SessionStart: [
      {
        hooks: [
          { type: "command", command: "/atlas/app/hooks/session-start.sh" },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          { type: "command", command: "/atlas/app/hooks/stop.sh" },
        ],
      },
    ],
    PreCompact: [
      {
        matcher: "auto",
        hooks: [
          { type: "command", command: "/atlas/app/hooks/pre-compact-auto.sh" },
        ],
      },
      {
        matcher: "manual",
        hooks: [
          { type: "command", command: "/atlas/app/hooks/pre-compact-manual.sh" },
        ],
      },
    ],
    SubagentStop: [
      {
        hooks: [
          {
            type: "prompt",
            prompt: subagentStopPrompt,
            model: models.subagent_review,
          },
        ],
      },
    ],
  },
};

mkdirSync("/atlas/app/.claude", { recursive: true });
writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");

// Symlink skills from workspace into Claude Code's discovery path
const skillsLink = "/atlas/app/.claude/skills";
const skillsTarget = "/atlas/workspace/skills";
try {
  lstatSync(skillsLink);
} catch {
  // Link doesn't exist yet — create it
  try {
    symlinkSync(skillsTarget, skillsLink);
    console.log(`Skills symlinked: ${skillsLink} -> ${skillsTarget}`);
  } catch (e) {
    console.log(`Warning: could not symlink skills: ${e}`);
  }
}

console.log(`Settings generated: main=${models.main}, subagent_review=${models.subagent_review}, hooks=${models.hooks}`);
