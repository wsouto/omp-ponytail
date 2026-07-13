import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const UPSTREAM_REPOSITORY = "DietrichGebert/ponytail";
export const UPSTREAM_REF = "main";
export const SKILL_NAMES = ["ponytail", "ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help"] as const;
const RESOLVED_COMMIT_URL = `https://api.github.com/repos/${UPSTREAM_REPOSITORY}/commits/${UPSTREAM_REF}`;
const REPOSITORY_URL = `https://github.com/${UPSTREAM_REPOSITORY}`;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

type FetchResponse = { ok: boolean; status: number; text: () => Promise<string> };
type Fetcher = (url: string) => Promise<FetchResponse>;
type LockFile = { repository: string; ref: string; commit: string; files: Record<string, string> };
type Rename = (oldPath: string, newPath: string) => Promise<void>;
type SyncOptions = { root?: string; fetch?: Fetcher; log?: (message: string) => void; rename?: Rename };

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
  const lockDocument = `${JSON.stringify(lock, null, 2)}\n`;
  const publisherLockPath = join(root, ".upstream-sync.lock");
  const publisherRename = options.rename ?? rename;
  let publisherLock: FileHandle | undefined;
  let operationError: unknown;

  try {
    await mkdir(root, { recursive: true });
    try {
      publisherLock = await open(publisherLockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Another upstream sync is already in progress for ${root}`, { cause: error });
      }
      throw error;
    }

    const transaction = await mkdtemp(join(root, ".upstream-sync-"));
    const stagedRoot = join(transaction, "staged");
    const backupRoot = join(transaction, "backup");
    const transactionPaths = [...paths, "upstream-lock.json"];
    const transactionEntries = transactionPaths.map((path) => ({
      path,
      target: join(root, path),
      staged: join(stagedRoot, path),
      backup: join(backupRoot, path),
    }));
    const backedUp: typeof transactionEntries = [];
    const installed: typeof transactionEntries = [];
    let transactionError: unknown;

    try {
      await Promise.all(transactionEntries.map(async ({ target, staged, backup }) => {
        await Promise.all([
          mkdir(dirname(target), { recursive: true }),
          mkdir(dirname(staged), { recursive: true }),
          mkdir(dirname(backup), { recursive: true }),
        ]);
      }));
      await Promise.all(transactionEntries.map(({ path, staged }) =>
        writeFile(staged, path === "upstream-lock.json" ? lockDocument : files[path], "utf8")));

      try {
        for (const entry of transactionEntries) {
          await publisherRename(entry.target, entry.backup);
          backedUp.push(entry);
          await publisherRename(entry.staged, entry.target);
          installed.push(entry);
        }
      } catch (error) {
        const rollbackErrors: Error[] = [];
        for (let index = installed.length - 1; index >= 0; index -= 1) {
          const entry = installed[index];
          try {
            await rm(entry.target, { force: true });
          } catch (rollbackError) {
            rollbackErrors.push(new Error(`remove installed ${entry.path}: ${String(rollbackError)}`, { cause: rollbackError }));
          }
        }
        for (let index = backedUp.length - 1; index >= 0; index -= 1) {
          const entry = backedUp[index];
          try {
            await publisherRename(entry.backup, entry.target);
          } catch (rollbackError) {
            rollbackErrors.push(new Error(`restore backup ${entry.path}: ${String(rollbackError)}`, { cause: rollbackError }));
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(rollbackErrors, "Upstream sync publication failed and rollback encountered errors", { cause: error });
        }
        throw error;
      }
    } catch (error) {
      transactionError = error;
    } finally {
      try {
        await rm(transaction, { recursive: true, force: true });
      } catch (cleanupError) {
        if (!transactionError) transactionError = cleanupError;
      }
    }
    if (transactionError) throw transactionError;

    log(`Synced ${paths.length - 1} skills and LICENSE from ${UPSTREAM_REPOSITORY}@${commit}.`);
    return lock;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (publisherLock) {
      try {
        await publisherLock.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (publisherLock) {
      try {
        await rm(publisherLockPath, { force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0 && !operationError) {
      throw new AggregateError(cleanupErrors, "Upstream sync publisher lock cleanup failed");
    }
  }
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
