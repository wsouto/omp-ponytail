import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  hasUI?: boolean;
  isIdle?: () => boolean;
  reload?: () => Promise<void>;
  sessionManager?: { getBranch?: () => unknown[] };
  ui?: {
    confirm?: (title: string, message: string) => Promise<boolean>;
    notify?: (message: string, level: string) => void;
    setStatus?: (key: string, text: string) => void;
    setWorkingMessage?: (message?: string) => void;
    theme?: { fg: (color: string, text: string) => string };
  };
};
type ExecResult = { code: number; killed: boolean; stderr: string };
type Exec = (command: string, args: string[], options: { cwd: string }) => Promise<ExecResult>;
type RegisteredCommand = { handler: CommandHandler };

function extensionApi(api: {
  exec: Exec;
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

function harness({ exec = async () => ({ code: 0, killed: false, stderr: "" }) }: { exec?: Exec } = {}) {
  const events = new Map<string, EventHandler>();
  const commands = new Map<string, RegisteredCommand>();
  const entries: { customType: string; data: unknown }[] = [];
  const messages: { text: string; options?: unknown }[] = [];
  ponytailExtension(extensionApi({
    exec,
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
    const result = await requiredEvent(events, "before_agent_start")({ systemPrompt: ["BASE"] }, ctx) as { systemPrompt: string[] };
    expect(result.systemPrompt[0]).toBe("BASE");
    expect(result.systemPrompt[1]).toStartWith("PONYTAIL MODE ACTIVE — level: ultra");
    expect(result.systemPrompt[1]).not.toContain('full: "`@lru_cache');
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
    const result = await requiredEvent(events, "before_agent_start")({ systemPrompt: [] }, ctx);
    expect(result).toEqual({ systemPrompt: ["PONYTAIL MODE ACTIVE — level: review. Behavior defined by /ponytail-review skill."] });
  }));

  test("aliases skills and queues them while agent runs", async () => {
    const { commands, messages } = harness();
    await requiredCommand(commands, "ponytail-review").handler("", context());
    await requiredCommand(commands, "ponytail-help").handler("", context({ isIdle: () => false }));
    expect(messages).toEqual([{ text: "/skill:ponytail-review", options: undefined }, { text: "/skill:ponytail-help", options: { deliverAs: "followUp" } }]);
  });

  test("updates skills through OMP and reloads after confirmation", async () => {
    const calls: { command: string; args: string[]; options: { cwd: string } }[] = [];
    const { commands, entries } = harness({ exec: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, killed: false, stderr: "" };
    } });
    const notifications: { message: string; level: string }[] = [];
    const working: (string | undefined)[] = [];
    let reloads = 0;
    const ctx = context({
      hasUI: true,
      reload: async () => { reloads += 1; },
      ui: {
        confirm: async (title, message) => {
          expect([title, message]).toEqual(["Update Ponytail skills?", "Fetch the latest six skills and license from DietrichGebert/ponytail?"]);
          return true;
        },
        notify: (message, level) => notifications.push({ message, level }),
        setWorkingMessage: (message) => working.push(message),
      },
    });

    await requiredCommand(commands, "ponytail").handler("update", ctx);
    expect(calls).toEqual([{ command: "bun", args: ["run", "sync:upstream"], options: { cwd: join(import.meta.dir, "..") } }]);
    expect(notifications).toEqual([
      { message: "Updating Ponytail skills…", level: "info" },
      { message: "Ponytail skills updated. Reloading OMP…", level: "info" },
    ]);
    expect(working).toEqual(["Updating Ponytail skills…", undefined]);
    expect(reloads).toBe(1);
    expect(entries).toEqual([]);
  });

  test("does not update after declined confirmation", async () => {
    let calls = 0;
    let reloads = 0;
    const { commands } = harness({ exec: async () => {
      calls += 1;
      return { code: 0, killed: false, stderr: "" };
    } });
    await requiredCommand(commands, "ponytail").handler("update", context({
      hasUI: true,
      reload: async () => { reloads += 1; },
      ui: { confirm: async () => false, notify() {} },
    }));
    expect([calls, reloads]).toEqual([0, 0]);
  });

  test("reports update failures without reloading", async () => {
    for (const [failure, expected] of [
      [async (): Promise<ExecResult> => ({ code: 0, killed: true, stderr: "" }), "Ponytail update was cancelled."],
      [async (): Promise<ExecResult> => ({ code: 1, killed: false, stderr: "sync failed\n" }), "sync failed"],
      [async (): Promise<ExecResult> => ({ code: 2, killed: false, stderr: "" }), "bun run sync:upstream exited with code 2"],
      [async (): Promise<ExecResult> => { throw new Error("spawn failed"); }, "spawn failed"],
    ] as const) {
      const { commands, entries } = harness({ exec: failure });
      const notifications: { message: string; level: string }[] = [];
      let reloads = 0;
      await requiredCommand(commands, "ponytail").handler("update", context({
        reload: async () => { reloads += 1; },
        ui: { notify: (message, level) => notifications.push({ message, level }) },
      }));
      expect(notifications.at(-1)).toEqual({ message: `Failed to update Ponytail skills: ${expected}`, level: "error" });
      expect(reloads).toBe(0);
      expect(entries).toEqual([]);
    }
  });

  test("allows only one update at a time", async () => {
    let calls = 0;
    let finish: (result: ExecResult) => void = () => {};
    const pending = new Promise<ExecResult>((resolve) => { finish = resolve; });
    const { commands } = harness({ exec: async () => {
      calls += 1;
      return pending;
    } });
    const notifications: { message: string; level: string }[] = [];
    const ctx = context({ ui: { notify: (message, level) => notifications.push({ message, level }) } });
    const command = requiredCommand(commands, "ponytail");
    const first = command.handler("update", ctx);
    await command.handler("update", ctx);
    finish({ code: 0, killed: false, stderr: "" });
    await first;
    expect(calls).toBe(1);
    expect(notifications).toContainEqual({ message: "Ponytail update already in progress.", level: "warning" });
  });

  test("deactivation only accepts standalone commands", async () => withTempConfig(async () => {
    const { events, commands } = harness();
    const ctx = context();
    await requiredEvent(events, "session_start")({}, ctx);
    await requiredCommand(commands, "ponytail").handler("ultra", ctx);
    await requiredEvent(events, "input")({ text: "add a normal mode toggle", source: "interactive" }, ctx);
    expect((await requiredEvent(events, "before_agent_start")({ systemPrompt: [] }, ctx) as { systemPrompt: string[] }).systemPrompt.at(-1)).toContain("PONYTAIL MODE ACTIVE");
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
    expect(parsePonytailCommand("update")).toEqual({ type: "update" });
    expect(parsePonytailCommand("update now")).toEqual({ type: "invalid", reason: "invalid-mode", mode: "update" });
    expect(resolveSessionMode([{ type: "custom", customType: "ponytail-mode", data: { mode: "lite" } }], "full")).toBe("lite");
  });

  test("refuses to overwrite malformed config through the helper", () => withTempConfig(() => {
    const path = join(process.env.XDG_CONFIG_HOME!, "ponytail", "config.json");
    const invalid = '{"defaultMode":';
    mkdirSync(join(process.env.XDG_CONFIG_HOME!, "ponytail"), { recursive: true });
    writeFileSync(path, invalid, "utf8");

    expect(() => writeDefaultMode("ultra")).toThrow();
    expect(readFileSync(path, "utf8")).toBe(invalid);
  }));

  test("refuses non-object config roots through the helper", () => withTempConfig(() => {
    const path = join(process.env.XDG_CONFIG_HOME!, "ponytail", "config.json");
    mkdirSync(join(process.env.XDG_CONFIG_HOME!, "ponytail"), { recursive: true });

    for (const invalid of ["[]", "null", "42"]) {
      writeFileSync(path, invalid, "utf8");
      expect(() => writeDefaultMode("ultra")).toThrow(`Ponytail config ${path}: root must be a JSON object.`);
      expect(readFileSync(path, "utf8")).toBe(invalid);
    }
  }));

  test("reports malformed config save failures through the command", async () => withTempConfig(async () => {
    const path = join(process.env.XDG_CONFIG_HOME!, "ponytail", "config.json");
    const invalid = '{"defaultMode":';
    mkdirSync(join(process.env.XDG_CONFIG_HOME!, "ponytail"), { recursive: true });
    writeFileSync(path, invalid, "utf8");
    const notifications: { message: string; level: string }[] = [];
    const { commands } = harness();

    await requiredCommand(commands, "ponytail").handler("default ultra", context({ ui: { notify: (message, level) => notifications.push({ message, level }) } }));

    expect(notifications.at(-1)).toEqual({ message: expect.stringMatching(/^Failed to save default mode:/), level: "error" });
    expect(readFileSync(path, "utf8")).toBe(invalid);
  }));

  test("reads config and keeps rule bullets while filtering examples", () => withTempConfig(() => {
    const path = join(process.env.XDG_CONFIG_HOME!, "ponytail", "config.json");
    expect(readDefaultMode()).toBe("full");
    expect(writeDefaultMode("ultra")).toBe("ultra");
    expect(readDefaultMode()).toBe("ultra");
    expect(readQuietStartup()).toBeFalse();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ defaultMode: "ultra" });
    writeFileSync(path, JSON.stringify({ defaultMode: "lite", quietStartup: true, unrelated: { value: 1 } }), "utf8");
    expect(writeDefaultMode("full")).toBe("full");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ defaultMode: "full", quietStartup: true, unrelated: { value: 1 } });
    process.env.PONYTAIL_HIDE_STATUS = "0";
    expect(readHideStatus()).toBeFalse();
    const filtered = filterSkillBodyForMode('- Full: rule\n- lite: "example"\n- ultra: "example"', "ultra");
    expect(filtered).toContain("Full: rule");
    expect(filtered).not.toContain("- lite:");
    expect(getPonytailInstructions("review")).toContain("/ponytail-review skill");
  }));
});
