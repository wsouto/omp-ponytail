import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const DEFAULT_MODE = "full";
export const RUNTIME_MODES = ["off", "lite", "full", "ultra"];
const PERSISTED_MODES = [...RUNTIME_MODES, "review"];
const SKILL_PATH = join(import.meta.dir, "skills", "ponytail", "SKILL.md");
const COMMANDS = ["ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help"];

type Context = {
  hasUI?: boolean;
  isIdle?: () => boolean;
  reload?: () => Promise<void>;
  sessionManager?: { getBranch?: () => unknown };
  ui?: {
    confirm?: (title: string, message: string) => Promise<boolean>;
    notify?: (message: string, level: "info" | "warning" | "error") => void;
    setStatus?: (key: string, text: string) => void;
    setWorkingMessage?: (message?: string) => void;
    theme?: { fg?: (color: string, text: string) => string };
  };
};

function normalize(mode: unknown, modes: string[]) {
  if (typeof mode !== "string") return undefined;
  const value = mode.trim().toLowerCase();
  return modes.includes(value) ? value : undefined;
}

export function normalizeMode(mode: unknown) {
  return normalize(mode, RUNTIME_MODES);
}

export function normalizePersistedMode(mode: unknown) {
  return normalize(mode, PERSISTED_MODES);
}

function configPath() {
  const base = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "ponytail")
    : process.platform === "win32"
      ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "ponytail")
      : join(homedir(), ".config", "ponytail");
  return join(base, "config.json");
}

function readConfigFile(path: string): Record<string, unknown> | undefined {
  const config = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  return config && typeof config === "object" && !Array.isArray(config) ? config : undefined;
}

function readConfig(): Record<string, unknown> {
  try {
    return readConfigFile(configPath()) || {};
  } catch {
    return {};
  }
}

function readConfigForWrite(path: string): Record<string, unknown> {
  try {
    const config = readConfigFile(path);
    if (!config) throw new Error(`Ponytail config ${path}: root must be a JSON object.`);
    return config;
  } catch (error: unknown) {
    if ((error as { code?: unknown } | undefined)?.code === "ENOENT") return {};
    throw error;
  }
}

function enabled(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function readDefaultMode() {
  return normalizeMode(process.env.PONYTAIL_DEFAULT_MODE) || normalizeMode(readConfig().defaultMode) || DEFAULT_MODE;
}

export function readQuietStartup() {
  return enabled(process.env.PONYTAIL_QUIET_STARTUP) ?? readConfig().quietStartup === true;
}

export function readHideStatus() {
  return enabled(process.env.PONYTAIL_HIDE_STATUS) ?? readConfig().hideStatus === true;
}

export function writeDefaultMode(mode: unknown) {
  const normalized = normalizeMode(mode);
  if (!normalized) return undefined;
  const path = configPath();

  const config = readConfigForWrite(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...config, defaultMode: normalized }, null, 2), "utf8");
  return normalized;
}

export function isDeactivationCommand(text: unknown) {
  const normalized = String(text || "").trim().toLowerCase().replace(/[.!?\s]+$/, "");
  return normalized === "stop ponytail" || normalized === "normal mode";
}

export function resolveSessionMode(entries: unknown, fallbackMode = DEFAULT_MODE) {
  const fallback = normalizePersistedMode(fallbackMode) || DEFAULT_MODE;
  if (!Array.isArray(entries)) return fallback;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; customType?: string; data?: { mode?: unknown } };
    if (entry?.type !== "custom" || entry.customType !== "ponytail-mode") continue;
    const mode = normalizePersistedMode(entry.data?.mode);
    if (mode) return mode;
  }

  return fallback;
}

export function parsePonytailCommand(text: unknown, defaultMode = DEFAULT_MODE) {
  const fallback = normalizePersistedMode(defaultMode) || DEFAULT_MODE;
  const [primary, secondary] = String(text || "").trim().toLowerCase().split(/\s+/);

  if (!primary) return { type: "set-mode", mode: fallback === "off" ? DEFAULT_MODE : fallback };
  if (primary === "status") return { type: "status" };
  if (primary === "update") return secondary ? { type: "invalid", reason: "invalid-mode", mode: primary } : { type: "update" };
  if (primary === "default") {
    const mode = normalizeMode(secondary);
    return mode ? { type: "set-default", mode } : { type: "invalid", reason: "invalid-default-mode" };
  }

  const mode = normalizeMode(primary);
  return mode ? { type: "set-mode", mode } : { type: "invalid", reason: "invalid-mode", mode: primary };
}

export function filterSkillBodyForMode(body: unknown, mode: unknown) {
  const effectiveMode = normalizeMode(mode) || DEFAULT_MODE;
  return String(body || "")
    .replace(/^---[\s\S]*?---\s*/, "")
    .split(/\r?\n/)
    .filter((line) => {
      const tableLabel = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|/);
      if (tableLabel) {
        const label = normalizeMode(tableLabel[1].trim());
        if (label) return label === effectiveMode;
      }
      const exampleLabel = line.match(/^-\s*([^:]+):\s*"/);
      if (exampleLabel) {
        const label = normalizeMode(exampleLabel[1].trim());
        if (label) return label === effectiveMode;
      }
      return true;
    })
    .join("\n");
}

function fallbackInstructions(mode: string) {
  return `PONYTAIL MODE ACTIVE — level: ${mode}

You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.

Before any code, stop at the first rung that holds: YAGNI, existing code, standard library, native platform, installed dependency, one line, then minimum code. No unrequested abstractions, avoidable dependencies, or boilerplate. Deletion over addition. Boring over clever.

Never simplify away understanding, trust-boundary validation, data-loss handling, security, accessibility, hardware calibration, explicit requirements, or one small runnable check for non-trivial logic.`;
}

export function getPonytailInstructions(mode: unknown) {
  const configured = normalizePersistedMode(mode) || DEFAULT_MODE;
  if (configured === "review") return "PONYTAIL MODE ACTIVE — level: review. Behavior defined by /ponytail-review skill.";

  try {
    return `PONYTAIL MODE ACTIVE — level: ${configured}\n\n${filterSkillBodyForMode(readFileSync(SKILL_PATH, "utf8"), configured)}`;
  } catch {
    return fallbackInstructions(configured);
  }
}

export default function ponytailExtension(pi: ExtensionAPI) {
  let currentMode = DEFAULT_MODE;
  let configuredDefaultMode = readDefaultMode();
  let hideStatus = readHideStatus();
  let isActive = false;
  let lastContext: Context | undefined;
  let updateInProgress = false;

  function syncStatus(context?: Context) {
    if (context) lastContext = context;
    const ctx = context || lastContext;
    if (hideStatus || !ctx?.ui?.setStatus) return;

    let theme;
    try {
      theme = ctx.ui.theme;
      if (!theme?.fg) return;
    } catch {
      return;
    }

    const indicator = isActive ? theme.fg("accent", "●") : theme.fg("dim", "○");
    ctx.ui.setStatus("ponytail", `${indicator} ${theme.fg("muted", "ponytail: ")}${theme.fg("text", currentMode.toUpperCase())}`);
  }

  function setMode(mode: unknown, context?: Context) {
    const normalized = normalizePersistedMode(mode);
    if (!normalized) return;
    currentMode = normalized;
    pi.appendEntry("ponytail-mode", { mode: normalized });
    syncStatus(context);
    context?.ui?.notify?.(`Ponytail mode set to ${normalized}.`, "info");
  }

  function sendAlias(skill: string, context: Context) {
    const message = `/skill:${skill}`;
    if (context?.isIdle?.() === false) {
      pi.sendUserMessage(message, { deliverAs: "followUp" });
      context?.ui?.notify?.(`${skill} queued as follow-up.`, "info");
      return;
    }
    pi.sendUserMessage(message);
  }

  async function updatePonytail(context: Context) {
    if (updateInProgress) {
      context?.ui?.notify?.("Ponytail update already in progress.", "warning");
      return;
    }

    updateInProgress = true;
    try {
      if (context?.hasUI === true && context.ui?.confirm && !(await context.ui.confirm("Update Ponytail skills?", "Fetch the latest six skills and license from DietrichGebert/ponytail?"))) return;

      context?.ui?.notify?.("Updating Ponytail skills…", "info");
      context?.ui?.setWorkingMessage?.("Updating Ponytail skills…");
      const result = await pi.exec("bun", ["run", "sync:upstream"], { cwd: import.meta.dir });
      if (result.killed) throw new Error("Ponytail update was cancelled.");
      if (result.code !== 0) throw new Error(result.stderr.trim() || `bun run sync:upstream exited with code ${result.code}`);

      context?.ui?.notify?.("Ponytail skills updated. Reloading OMP…", "info");
      await context?.reload?.();
    } catch (error: unknown) {
      context?.ui?.notify?.(`Failed to update Ponytail skills: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      context?.ui?.setWorkingMessage?.();
      updateInProgress = false;
    }
  }

  pi.registerCommand("ponytail", {
    description: `Set mode: ${RUNTIME_MODES.join("|")}. Commands: status, update, default <mode>`,
    handler: async (args: string, context: Context) => {
      const parsed = parsePonytailCommand(args, configuredDefaultMode);
      if (parsed.type === "status") context?.ui?.notify?.(`Ponytail: current ${currentMode} • default ${configuredDefaultMode}`, "info");
      else if (parsed.type === "set-default") {
        try {
          const written = writeDefaultMode(parsed.mode);
          if (written) {
            configuredDefaultMode = readDefaultMode();
            context?.ui?.notify?.(configuredDefaultMode === written ? `Default Ponytail mode set to ${written}.` : `Saved default ${written}, but env override keeps default at ${configuredDefaultMode}.`, "info");
          }
        } catch (error: unknown) {
          context?.ui?.notify?.(`Failed to save default mode: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      } else if (parsed.type === "update") await updatePonytail(context);
      else if (parsed.type === "set-mode") setMode(parsed.mode, context);
      else context?.ui?.notify?.("Unknown or unsupported /ponytail mode.", "warning");
    },
  });

  for (const command of COMMANDS) pi.registerCommand(command, { description: `Run /skill:${command}`, handler: async (_args: string, context: Context) => sendAlias(command, context) });

  pi.on("input", async (event: { source?: string; text?: string }) => {
    if (event?.source !== "extension" && currentMode !== "off" && isDeactivationCommand(event?.text)) setMode("off");
  });
  pi.on("session_start", async (_event: unknown, context: Context) => {
    configuredDefaultMode = readDefaultMode();
    hideStatus = readHideStatus();
    currentMode = resolveSessionMode(context?.sessionManager?.getBranch?.(), configuredDefaultMode);
    syncStatus(context);
    if (!readQuietStartup()) context?.ui?.notify?.(`Ponytail loaded: ${currentMode}`, "info");
  });
  pi.on("agent_start", async (_event: unknown, context: Context) => { isActive = true; syncStatus(context); });
  pi.on("agent_end", async (_event: unknown, context: Context) => { isActive = false; syncStatus(context); });
  pi.on("before_agent_start", async (event: { systemPrompt?: string }) => {
    if (currentMode === "off") return;
    const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : "";
    return { systemPrompt: `${base}${getPonytailInstructions(currentMode)}` };
  });
}
