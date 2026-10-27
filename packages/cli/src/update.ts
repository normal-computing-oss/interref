/** Versions: the upgrade notice for the CLI (from npm) and the VS Code extension (from GitHub releases). */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** esbuild replaces this with the version in package.json. tsrs output (the unit tests) has no value. */
declare const INTERREF_VERSION: string | undefined;

export const VERSION = typeof INTERREF_VERSION === "string" ? INTERREF_VERSION : "0.0.0-dev";
export const PACKAGE = "@normal-computing/interref";
const REPO = "normal-computing-oss/interref";
const EXTENSION_ID = "normal-computing.vscode-interref";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The notice runs after each command, so it must not wait long. */
const NOTICE_TIMEOUT_MS = 1500;
const REQUEST_TIMEOUT_MS = 10_000;

/** A network, GitHub or editor problem. The CLI prints the message, without a stack. */
export class UpdateError extends Error {}

/** Compares two semver versions: negative if a < b. A prerelease is lower than its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string): { core: number[]; pre: string[] } => {
    const [plain = ""] = version.replace(/^v/u, "").split("+");
    const dash = plain.indexOf("-");
    const core = dash < 0 ? plain : plain.slice(0, dash);
    return { core: core.split(".").map(Number), pre: dash < 0 ? [] : plain.slice(dash + 1).split(".") };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const [p = "", q = ""] = [x.pre[i], y.pre[i]];
    const [pn, qn] = [/^\d+$/u.test(p), /^\d+$/u.test(q)];
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

export const isStable = (version: string): boolean => !version.includes("-");

/** The text that asks the user to upgrade, or undefined when `latest` is not a newer stable version. */
export function upgradeMessage(name: string, current: string, latest: string | undefined): string | undefined {
  if (latest === undefined || !isStable(latest) || compareVersions(latest, current) <= 0) return undefined;
  return `${name} ${latest} is available. You have ${current}. To upgrade, run:\n  npm install --global ${PACKAGE}`;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": `interref/${VERSION}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new UpdateError(`cannot reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new UpdateError(`${url} answered ${response.status} ${response.statusText}`);
  return response.json();
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The `latest` dist-tag of the CLI on npm. */
async function latestOnNpm(timeoutMs: number): Promise<string | undefined> {
  const tags = await getJson(`https://registry.npmjs.org/-/package/${encodeURIComponent(PACKAGE)}/dist-tags`, timeoutMs);
  return isRecord(tags) && typeof tags.latest === "string" ? tags.latest : undefined;
}

interface Cache {
  checkedAt: number;
  latest?: string;
}

function cacheFile(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "interref", "update-check.json");
}

function readCache(): Cache | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(cacheFile(), "utf8"));
    if (!isRecord(value) || typeof value.checkedAt !== "number") return undefined;
    return typeof value.latest === "string" ? { checkedAt: value.checkedAt, latest: value.latest } : { checkedAt: value.checkedAt };
  } catch {
    return undefined;
  }
}

function writeCache(cache: Cache): void {
  try {
    mkdirSync(dirname(cacheFile()), { recursive: true });
    writeFileSync(cacheFile(), `${JSON.stringify(cache)}\n`);
  } catch {
    // The notice is optional; a cache that cannot be written only means more checks.
  }
}

/** True when the user or the environment turned the check off. */
export function updateCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  return [env.INTERREF_NO_UPDATE_CHECK, env.NO_UPDATE_NOTIFIER, env.CI].some((value) => value !== undefined && value !== "" && value !== "0");
}

/**
 * The upgrade notice to print after a command, or undefined. It asks npm at most once a day, and
 * only when a person can see stderr. It never fails: offline, it uses the last answer.
 */
export async function upgradeNotice(name: string): Promise<string | undefined> {
  if (process.stderr.isTTY !== true || updateCheckDisabled(process.env)) return undefined;
  const cache = readCache();
  if (cache !== undefined && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) return upgradeMessage(name, VERSION, cache.latest);
  let latest = cache?.latest;
  try {
    latest = (await latestOnNpm(NOTICE_TIMEOUT_MS)) ?? latest;
  } catch {
    // Offline, slow or npm is down: use the last answer, and try again tomorrow.
  }
  writeCache(latest === undefined ? { checkedAt: Date.now() } : { checkedAt: Date.now(), latest });
  return upgradeMessage(name, VERSION, latest);
}

interface Release {
  version: string;
  vsix: { name: string; url: string };
}

function toRelease(value: unknown): Release | undefined {
  if (!isRecord(value) || typeof value.tag_name !== "string" || value.draft === true || !Array.isArray(value.assets)) return undefined;
  for (const asset of value.assets as unknown[]) {
    if (isRecord(asset) && typeof asset.name === "string" && asset.name.endsWith(".vsix") && typeof asset.browser_download_url === "string") {
      return { version: value.tag_name.replace(/^v/u, ""), vsix: { name: asset.name, url: asset.browser_download_url } };
    }
  }
  return undefined;
}

/** The newest GitHub release that has a .vsix. Without `prerelease`, only stable releases count. */
export async function latestExtensionRelease(prerelease: boolean): Promise<Release> {
  const releases = await getJson(`https://api.github.com/repos/${REPO}/releases?per_page=30`, REQUEST_TIMEOUT_MS);
  const found = (Array.isArray(releases) ? (releases as unknown[]) : [])
    .filter((release) => prerelease || (isRecord(release) && release.prerelease !== true))
    .map(toRelease)
    .filter((release) => release !== undefined)
    .sort((a, b) => compareVersions(b.version, a.version));
  const newest = found[0];
  if (newest !== undefined) return newest;
  throw new UpdateError(
    prerelease
      ? `no release of ${REPO} has a .vsix`
      : `${REPO} has no stable release with a .vsix yet. To install the newest prerelease, add --prerelease`,
  );
}

/** Runs the editor's command-line tool. On Windows, `code` is a .cmd file, so it needs a shell. */
function editorCommand(editor: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const windows = process.platform === "win32";
  const quoted = windows ? args.map((arg) => (/\s/u.test(arg) ? `"${arg}"` : arg)) : [...args];
  const result = spawnSync(editor, quoted, { encoding: "utf8", shell: windows });
  if (result.error !== undefined) {
    throw new UpdateError(
      `cannot run "${editor}". In VS Code, run "Shell Command: Install 'code' command in PATH", or name another editor with --editor (for example cursor)`,
    );
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The version of the extension in the editor, or undefined if it is not installed. */
export function installedExtension(editor: string): string | undefined {
  const { stdout } = editorCommand(editor, ["--list-extensions", "--show-versions"]);
  const prefix = `${EXTENSION_ID}@`;
  const line = stdout.split(/\r?\n/u).find((entry) => entry.toLowerCase().startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

/** Downloads the .vsix of a release and installs it in the editor. */
export async function installExtension(editor: string, release: Release): Promise<void> {
  let response: Response;
  try {
    response = await fetch(release.vsix.url, { signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new UpdateError(`cannot download ${release.vsix.url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new UpdateError(`cannot download ${release.vsix.url}: ${response.status} ${response.statusText}`);
  const folder = mkdtempSync(join(tmpdir(), "interref-"));
  try {
    const file = join(folder, release.vsix.name);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    const result = editorCommand(editor, ["--install-extension", file, "--force"]);
    if (result.status !== 0) throw new UpdateError(`${editor} --install-extension failed:\n${result.stderr || result.stdout}`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
