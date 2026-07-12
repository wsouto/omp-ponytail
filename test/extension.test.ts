import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import ponytailExtension, {
  filterSkillBodyForMode,
  getPonytailInstructions,
  parsePonytailCommand,
  readDefaultMode,
  readHideStatus,
  readQuietStartup,
  resolveSessionMode,
  writeDefaultMode,
} from "../index";

const originalEnv = { ...process.env };
type EventHandler = (event?: unknown, context?: TestContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, context: TestContext) => Promise<unknown> | unknown;
type TestContext = {
  isIdle?: () => boolean;
  sessionManager?: { getBranch?: () => unknown[] };
  ui?: {
    notify?: (message: string, level: string) => void;
    setStatus?: (key: string, text: string) => void;
    theme?: { fg: (color: string, text: string) => string };
  };
};
type RegisteredCommand = { handler: CommandHandler };

function extensionApi(api: {
  on: (name: string, handler: EventHandler) => void;
  registerCommand: (name: string, command: RegisteredCommand) => void;
  appendEntry: (customType: string, data: unknown) => void;
  sendUserMessage: (text: string, options?: unknown) => void;
}) {
  return api as unknown as ExtensionAPI; // Test harness implements only the extension methods under test.
}

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

function harness() {
  const events = new Map<string, EventHandler>();
  const commands = new Map<string, RegisteredCommand>();
  const entries: { customType: string; data: unknown }[] = [];
  const messages: { text: string; options?: unknown }[] = [];
  ponytailExtension(extensionApi({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ customType, data }),
    sendUserMessage: (text, options) => messages.push({ text, options }),
  }));
  return { events, commands, entries, messages };
}

function context(overrides: TestContext = {}): TestContext {
  return { isIdle: () => true, sessionManager: { getBranch: () => [] }, ui: { notify() {} }, ...overrides };
}

function requiredEvent(events: Map<string, EventHandler>, name: string) {
  const handler = events.get(name);
  if (!handler) throw new Error(`Missing ${name} event handler`);
  return handler;
}

function requiredCommand(commands: Map<string, RegisteredCommand>, name: string) {
  const command = commands.get(name);
  if (!command) throw new Error(`Missing ${name} command`);
  return command;
}

function withTempConfig(run: () => Promise<void> | void) {
  const directory = mkdtempSync(join(tmpdir(), "ponytail-omp-test-"));
  process.env.XDG_CONFIG_HOME = directory;
  delete process.env.PONYTAIL_DEFAULT_MODE;
  delete process.env.PONYTAIL_QUIET_STARTUP;
  delete process.env.PONYTAIL_HIDE_STATUS;
  return Promise.resolve(run()).finally(() => rmSync(directory, { recursive: true, force: true }));
}

describe("OMP Ponytail extension", () => {
  test("registers all Ponytail commands", () => {
    expect([...harness().commands.keys()].sort()).toEqual(["ponytail", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help", "ponytail-review"]);
  });

  test("persists mode and injects filtered rules", async () => withTempConfig(async () => {
    const { events, commands, entries } = harness();
    const ctx = context();
    await requiredEvent(events, "session_start")({}, ctx);
    await requiredCommand(commands, "ponytail").handler("ultra", ctx);
    expect(entries.at(-1)).toEqual({ customType: "ponytail-mode", data: { mode: "ultra" } });
    const result = await requiredEvent(events, "before_agent_start")({ systemPrompt: "BASE" }, ctx) as { systemPrompt: string };
    expect(result.systemPrompt).toStartWith("BASE\n\nPONYTAIL MODE ACTIVE — level: ultra");
    expect(result.systemPrompt).not.toContain('full: "`@lru_cache');
  }));

  test("reads standalone vendored instructions rather than fallback text", () => {
    const instructions = getPonytailInstructions("full");
    expect(instructions).toContain("The ladder is a reflex, not a research project");
    expect(instructions).not.toContain("The best code is the code never written.\n\nBefore any code");
  });

  test("restores latest mode, including review, without undefined prompts", async () => withTempConfig(async () => {
    const { events } = harness();
    const ctx = context({ sessionManager: { getBranch: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "lite" } }, { type: "custom", customType: "ponytail-mode", data: { mode: "review" } }] } });
    await requiredEvent(events, "session_start")({}, ctx);
    const result = await requiredEvent(events, "before_agent_start")(undefined, ctx);
    expect(result).toEqual({ systemPrompt: "PONYTAIL MODE ACTIVE — level: review. Behavior defined by /ponytail-review skill." });
  }));

  test("aliases skills and queues them while agent runs", async () => {
    const { commands, messages } = harness();
    await requiredCommand(commands, "ponytail-review").handler("", context());
    await requiredCommand(commands, "ponytail-help").handler("", context({ isIdle: () => false }));
    expect(messages).toEqual([{ text: "/skill:ponytail-review", options: undefined }, { text: "/skill:ponytail-help", options: { deliverAs: "followUp" } }]);
  });

  test("deactivation only accepts standalone commands", async () => withTempConfig(async () => {
    const { events, commands } = harness();
    const ctx = context();
    await requiredEvent(events, "session_start")({}, ctx);
    await requiredCommand(commands, "ponytail").handler("ultra", ctx);
    await requiredEvent(events, "input")({ text: "add a normal mode toggle", source: "interactive" }, ctx);
    expect((await requiredEvent(events, "before_agent_start")({}, ctx) as { systemPrompt: string }).systemPrompt).toContain("PONYTAIL MODE ACTIVE");
    await requiredEvent(events, "input")({ text: "normal mode", source: "interactive" }, ctx);
    expect(await requiredEvent(events, "before_agent_start")({}, ctx)).toBeUndefined();
  }));

  test("renders active status and respects hide setting", async () => withTempConfig(async () => {
    const { events, commands } = harness();
    const writes: string[] = [];
    const ctx = context({ sessionManager: { getBranch: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } }] }, ui: { notify() {}, setStatus: (_key, text) => writes.push(text), theme: { fg: (_color, text) => text } } });
    await requiredEvent(events, "session_start")({}, ctx);
    await requiredEvent(events, "agent_start")({}, ctx);
    expect(writes.at(-2)).toBe("○ ponytail: ULTRA");
    expect(writes.at(-1)).toBe("● ponytail: ULTRA");
    await requiredEvent(events, "agent_end")({}, ctx);
    await requiredCommand(commands, "ponytail").handler("off", ctx);
    expect(writes.at(-1)).toBe("○ ponytail: OFF");
    process.env.PONYTAIL_HIDE_STATUS = "1";
    const hidden = harness();
    await requiredEvent(hidden.events, "session_start")({}, ctx);
    await requiredEvent(hidden.events, "agent_start")({}, ctx);
    expect(writes).toHaveLength(4);
  }));
});

describe("helpers", () => {
  test("parses modes and resolves latest valid session value", () => {
    expect(parsePonytailCommand("", "off")).toEqual({ type: "set-mode", mode: "full" });
    expect(parsePonytailCommand("default review")).toEqual({ type: "invalid", reason: "invalid-default-mode" });
    expect(resolveSessionMode([{ type: "custom", customType: "ponytail-mode", data: { mode: "lite" } }], "full")).toBe("lite");
  });

  test("reads config and keeps rule bullets while filtering examples", () => withTempConfig(() => {
    expect(readDefaultMode()).toBe("full");
    expect(writeDefaultMode("ultra")).toBe("ultra");
    expect(readDefaultMode()).toBe("ultra");
    expect(readQuietStartup()).toBeFalse();
    process.env.PONYTAIL_HIDE_STATUS = "0";
    expect(readHideStatus()).toBeFalse();
    const filtered = filterSkillBodyForMode('- Full: rule\n- lite: "example"\n- ultra: "example"', "ultra");
    expect(filtered).toContain("Full: rule");
    expect(filtered).not.toContain("- lite:");
    expect(getPonytailInstructions("review")).toContain("/ponytail-review skill");
  }));
});
