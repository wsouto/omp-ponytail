import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { SKILL_NAMES, UPSTREAM_REPOSITORY, syncUpstream } from "../scripts/sync-upstream";

const repositoryRoot = resolve(import.meta.dir, "..");
const commit = "0123456789abcdef0123456789abcdef01234567";
const expectedPaths = ["LICENSE", ...SKILL_NAMES.map((name) => `skills/${name}/SKILL.md`)];
type FetchResponse = { ok: boolean; status: number; text: () => Promise<string> };

function sha256(content: string) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function temporaryRepository() {
  const root = await mkdtemp(join(tmpdir(), "omp-ponytail-sync-"));
  await cp(join(repositoryRoot, "skills"), join(root, "skills"), { recursive: true });
  await cp(join(repositoryRoot, "LICENSE"), join(root, "LICENSE"));
  await cp(join(repositoryRoot, "upstream-lock.json"), join(root, "upstream-lock.json"));
  return root;
}

async function fixtureFiles() {
  return Object.fromEntries(await Promise.all(expectedPaths.map(async (path) => [path, await readFile(join(repositoryRoot, path), "utf8")] as const)));
}

function fetchFrom(files: Record<string, string>) {
  return async (url: string): Promise<FetchResponse> => {
    if (url === `https://api.github.com/repos/${UPSTREAM_REPOSITORY}/commits/main`) return { ok: true, status: 200, text: async () => JSON.stringify({ sha: commit }) };
    const prefix = `https://raw.githubusercontent.com/${UPSTREAM_REPOSITORY}/${commit}/`;
    const path = url.startsWith(prefix) ? url.slice(prefix.length) : "";
    const content = files[path];
    return typeof content === "string" ? { ok: true, status: 200, text: async () => content } : { ok: false, status: 404, text: async () => "not found" };
  };
}

describe("syncUpstream", () => {
  test("writes one resolved commit with complete, correct content hashes", async () => {
    const root = await temporaryRepository();
    try {
      const files = await fixtureFiles();
      const lock = await syncUpstream({ root, fetch: fetchFrom(files), log() {} });
      expect(lock).toEqual({
        repository: "https://github.com/DietrichGebert/ponytail",
        ref: "main",
        commit,
        files: Object.fromEntries(expectedPaths.map((path) => [path, sha256(files[path])])),
      });
      for (const path of expectedPaths) expect(await readFile(join(root, path), "utf8")).toBe(files[path]);
      expect(JSON.parse(await readFile(join(root, "upstream-lock.json"), "utf8"))).toEqual(lock);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("leaves files and lock untouched when any fetched skill is invalid", async () => {
    const root = await temporaryRepository();
    try {
      const files = await fixtureFiles();
      files["skills/ponytail-help/SKILL.md"] = "---\nname: wrong-name\n---\ninvalid";
      const before = Object.fromEntries(await Promise.all([...expectedPaths, "upstream-lock.json"].map(async (path) => [path, await readFile(join(root, path), "utf8")] as const)));
      await expect(syncUpstream({ root, fetch: fetchFrom(files), log() {} })).rejects.toThrow("YAML frontmatter name must be ponytail-help");
      for (const [path, content] of Object.entries(before)) expect(await readFile(join(root, path), "utf8")).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("leaves files and lock untouched when a fetch fails", async () => {
    const root = await temporaryRepository();
    try {
      const before = await readFile(join(root, "upstream-lock.json"), "utf8");
      await expect(syncUpstream({ root, fetch: async () => ({ ok: false, status: 503, text: async () => "offline" }), log() {} })).rejects.toThrow("HTTP 503");
      expect(await readFile(join(root, "upstream-lock.json"), "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires exactly the expected provenance entries", async () => {
    const lock = JSON.parse(await readFile(join(repositoryRoot, "upstream-lock.json"), "utf8")) as { files: Record<string, string> };
    expect(Object.keys(lock.files).sort()).toEqual([...expectedPaths].sort());
    for (const path of expectedPaths) expect(lock.files[path]).toBe(sha256(await readFile(join(repositoryRoot, path), "utf8")));
  });
});
