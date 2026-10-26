/** A snapshot of one git repo: which paths exist, which are tracked, and their headings. */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { CONFIG_FILE, DEFAULT_CONFIG, excluder, parseConfig, type Config } from "./config.js";
import { extractHeadings, isMarkdownPath, type Heading } from "./markdown.js";

const run = promisify(execFile);

/** Reads text by absolute path. The VS Code extension returns unsaved editor text here. */
export type TextReader = (absolutePath: string) => string | undefined;

export type EntryKind = "file" | "directory";

/** Bytes looked at for a NUL when deciding that a file is binary. */
const BINARY_PROBE = 8192;

export const readTextFromDisk: TextReader = (absolutePath) => {
  try {
    const bytes = readFileSync(absolutePath);
    return bytes.subarray(0, BINARY_PROBE).includes(0) ? undefined : bytes.toString("utf8");
  } catch {
    return undefined;
  }
};

export class GitError extends Error {}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
    return stdout;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new GitError(`git ${args.join(" ")} failed in ${cwd}: ${reason}`);
  }
}

/** The top level of the repo that contains `path` (a file or a directory). */
export async function findRepoRoot(path: string): Promise<string> {
  let directory = path;
  try {
    if (!statSync(path).isDirectory()) directory = dirname(path);
  } catch {
    directory = dirname(path);
  }
  return realpathSync((await git(directory, ["rev-parse", "--show-toplevel"])).trim());
}

const splitNul = (output: string): string[] =>
  output
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => entry.normalize("NFC"));

export class Repo {
  private readonly fileSet: ReadonlySet<string>;
  private readonly trackedSet: ReadonlySet<string>;
  private readonly directorySet = new Set<string>([""]);
  private readonly trackedDirectories = new Set<string>([""]);
  private readonly byLowerCase = new Map<string, string[]>();
  private readonly children = new Map<string, Map<string, EntryKind>>();
  private readonly headingCache = new Map<string, readonly Heading[]>();
  private readonly excluded: (path: string) => boolean;

  /**
   * @param root absolute path of the repo top level
   * @param tracked paths in the git index
   * @param untracked untracked paths that are not ignored
   */
  constructor(
    readonly root: string,
    tracked: readonly string[],
    untracked: readonly string[],
    private readonly readText: TextReader = readTextFromDisk,
    readonly config: Config = DEFAULT_CONFIG,
  ) {
    this.excluded = excluder(config);
    this.trackedSet = new Set(tracked);
    this.fileSet = new Set([...tracked, ...untracked]);
    for (const file of this.fileSet) {
      this.addLowerCase(file);
      const isTracked = this.trackedSet.has(file);
      let child = file;
      let kind: EntryKind = "file";
      for (;;) {
        const slash = child.lastIndexOf("/");
        const parent = slash < 0 ? "" : child.slice(0, slash);
        let entries = this.children.get(parent);
        if (entries === undefined) {
          entries = new Map();
          this.children.set(parent, entries);
        }
        entries.set(child.slice(slash + 1), kind);
        if (isTracked) this.trackedDirectories.add(parent);
        if (parent === "") break;
        if (!this.directorySet.has(parent)) {
          this.directorySet.add(parent);
          this.addLowerCase(parent);
        }
        child = parent;
        kind = "directory";
      }
    }
  }

  /**
   * Lists the files of the repo that contains `path`, with `git ls-files`, and reads `interref.toml`.
   * Throws `ConfigError` when `interref.toml` is malformed.
   */
  static async open(path: string, readText: TextReader = readTextFromDisk): Promise<Repo> {
    const root = await findRepoRoot(path);
    const [tracked, untracked] = await Promise.all([
      git(root, ["ls-files", "-z", "--cached"]),
      git(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
    ]);
    const configText = readText(join(root, CONFIG_FILE));
    const config = configText === undefined ? DEFAULT_CONFIG : parseConfig(configText);
    return new Repo(root, splitNul(tracked), splitNul(untracked), readText, config);
  }

  /** Whether `interref.toml` excludes `path` from scanning. */
  isExcluded(path: string): boolean {
    return this.excluded(path);
  }

  private addLowerCase(path: string): void {
    const key = path.toLowerCase();
    const list = this.byLowerCase.get(key);
    if (list === undefined) this.byLowerCase.set(key, [path]);
    else list.push(path);
  }

  /** All files: tracked, plus untracked files that are not ignored. */
  get files(): ReadonlySet<string> {
    return this.fileSet;
  }

  /** Whether `path` names a file or directory in the file list. Matching is case-sensitive. */
  kind(path: string): EntryKind | undefined {
    if (this.fileSet.has(path)) return "file";
    if (this.directorySet.has(path)) return "directory";
    return undefined;
  }

  /** Whether git tracks `path` (for a directory: at least one file in it). */
  isTracked(path: string): boolean {
    return this.trackedSet.has(path) || this.trackedDirectories.has(path);
  }

  /** Listed paths that differ from `path` only in case. */
  caseVariants(path: string): readonly string[] {
    return (this.byLowerCase.get(path.toLowerCase()) ?? []).filter((candidate) => candidate !== path);
  }

  /** The entries directly in `directory`, for completion. */
  list(directory: string): ReadonlyMap<string, EntryKind> {
    return this.children.get(directory) ?? new Map<string, EntryKind>();
  }

  /**
   * Looks for `path` on disk with exact case, for targets that git ignores. A case-insensitive
   * file system would accept a wrong case, so each segment is compared with `readdir`.
   */
  kindOnDisk(path: string): EntryKind | undefined {
    if (path === "") return "directory";
    let directory = this.root;
    for (const segment of path.split("/")) {
      try {
        if (!readdirSync(directory).some((name) => name.normalize("NFC") === segment)) return undefined;
      } catch {
        return undefined;
      }
      directory = join(directory, segment);
    }
    try {
      return statSync(directory).isDirectory() ? "directory" : "file";
    } catch {
      return undefined;
    }
  }

  absolute(path: string): string {
    return path === "" ? this.root : join(this.root, ...path.split("/"));
  }

  /** The repo-relative path of an absolute path, or undefined when it is outside the repo. */
  relative(absolutePath: string): string | undefined {
    let real = absolutePath;
    try {
      real = realpathSync(absolutePath);
    } catch {
      // A path that does not exist yet keeps its spelling.
    }
    const rel = relative(this.root, real);
    if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return rel.split(sep).join("/").normalize("NFC");
  }

  text(path: string): string | undefined {
    return this.readText(this.absolute(path));
  }

  /** The headings of a Markdown file, cached until `invalidate`. Other files have none. */
  headings(path: string): readonly Heading[] {
    if (!isMarkdownPath(path)) return [];
    let headings = this.headingCache.get(path);
    if (headings === undefined) {
      const text = this.text(path);
      headings = text === undefined ? [] : extractHeadings(text);
      this.headingCache.set(path, headings);
    }
    return headings;
  }

  /** Forgets cached headings for one path, or for all paths. */
  invalidate(path?: string): void {
    if (path === undefined) this.headingCache.clear();
    else this.headingCache.delete(path);
  }
}
