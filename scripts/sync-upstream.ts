import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export const UPSTREAM_REPOSITORY = "DietrichGebert/ponytail";
export const UPSTREAM_REF = "main";
export const SKILL_NAMES = ["ponytail", "ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help"] as const;
const RESOLVED_COMMIT_URL = `https://api.github.com/repos/${UPSTREAM_REPOSITORY}/commits/${UPSTREAM_REF}`;
const REPOSITORY_URL = `https://github.com/${UPSTREAM_REPOSITORY}`;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

type FetchResponse = { ok: boolean; status: number; text: () => Promise<string> };
type Fetcher = (url: string) => Promise<FetchResponse>;
type LockFile = { repository: string; ref: string; commit: string; files: Record<string, string> };
type SyncOptions = { root?: string; fetch?: Fetcher; log?: (message: string) => void };

function digest(content: string) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function upstreamUrl(commit: string, path: string) {
  return `https://raw.githubusercontent.com/${UPSTREAM_REPOSITORY}/${commit}/${path}`;
}

function requireSkillName(path: string, content: string) {
  const match = content.match(/^---\r?\n(?:[^\n]*\r?\n)*?name:\s*([^\r\n#]+)\s*\r?\n[\s\S]*?^---\s*$/m);
  const expected = path.split("/")[1];
  if (!match || match[1].trim().replace(/["']/g, "") !== expected) throw new Error(`${path}: YAML frontmatter name must be ${expected}`);
}

function assertContent(path: string, content: string) {
  if (content.length === 0 || content.includes("\uFFFD")) throw new Error(`${path}: response is empty or not valid UTF-8`);
  if (path !== "LICENSE") requireSkillName(path, content);
}

async function responseText(fetcher: Fetcher, url: string) {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

function temporaryPath(path: string) {
  return `${path}.tmp`;
}

async function writeAtomically(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = temporaryPath(path);
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

async function cleanupTemporary(paths: string[]) {
  await Promise.all(paths.map((path) => rm(temporaryPath(path), { force: true })));
}

export async function syncUpstream(options: SyncOptions = {}) {
  const root = resolve(options.root ?? import.meta.dir + "/..");
  const fetcher = options.fetch ?? (async (url: string) => fetch(url));
  const log = options.log ?? console.log;
  const commitDocument = await responseText(fetcher, RESOLVED_COMMIT_URL);
  let commit: unknown;
  try {
    commit = JSON.parse(commitDocument).sha;
  } catch {
    throw new Error(`${RESOLVED_COMMIT_URL}: invalid JSON response`);
  }
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) throw new Error(`${RESOLVED_COMMIT_URL}: missing 40-hex commit SHA`);

  const paths = ["LICENSE", ...SKILL_NAMES.map((name) => `skills/${name}/SKILL.md`)];
  const fetched = await Promise.all(paths.map(async (path) => {
    const url = upstreamUrl(commit, path);
    const content = await responseText(fetcher, url);
    assertContent(path, content);
    return [path, content] as const;
  }));
  const files = Object.fromEntries(fetched);
  const lock: LockFile = {
    repository: REPOSITORY_URL,
    ref: UPSTREAM_REF,
    commit,
    files: Object.fromEntries(paths.map((path) => [path, digest(files[path])])),
  };
  const lockPath = join(root, "upstream-lock.json");
  const targetPaths = paths.map((path) => join(root, path));

  try {
    for (const path of targetPaths) await mkdir(dirname(path), { recursive: true });
    await Promise.all([...targetPaths.map((path, index) => writeFile(temporaryPath(path), files[paths[index]], "utf8")), writeFile(temporaryPath(lockPath), `${JSON.stringify(lock, null, 2)}\n`, "utf8")]);
    for (const path of targetPaths) await rename(temporaryPath(path), path);
    await rename(temporaryPath(lockPath), lockPath);
  } catch (error) {
    await cleanupTemporary([...targetPaths, lockPath]);
    throw error;
  }

  log(`Synced ${paths.length - 1} skills and LICENSE from ${UPSTREAM_REPOSITORY}@${commit}.`);
  return lock;
}

export async function readLock(root = resolve(import.meta.dir + "/..")) {
  return JSON.parse(await readFile(join(root, "upstream-lock.json"), "utf8")) as LockFile;
}

if (import.meta.main) {
  syncUpstream().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
