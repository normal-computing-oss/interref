import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Makes a git repo in a temporary directory. Paths in `tracked` are committed to the index;
 * paths in `untracked` are only written; `.gitignore` content can be part of `tracked`.
 */
export function makeRepo(tracked: Record<string, string>, untracked: Record<string, string> = {}): {
  root: string;
  dispose: () => void;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "interref-test-")));
  const write = (files: Record<string, string>): void => {
    for (const [path, content] of Object.entries(files)) {
      const file = join(root, ...path.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  };
  execFileSync("git", ["init", "-q"], { cwd: root });
  write(tracked);
  execFileSync("git", ["add", "-A"], { cwd: root });
  write(untracked);
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
