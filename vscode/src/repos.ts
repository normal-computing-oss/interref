/** One `Repo` snapshot per git root, rebuilt when files are added, removed or ignored. */

import { dirname } from "node:path";
import { findRepoRoot, readTextFromDisk, Repo } from "@nref/core";
import * as vscode from "vscode";

export interface Located {
  readonly repo: Repo;
  /** Repo-relative path of the document. */
  readonly path: string;
}

/** Text of an open editor when there is one, so that unsaved headings count. */
function readText(absolutePath: string): string | undefined {
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === "file" && document.uri.fsPath === absolutePath,
  );
  return open === undefined ? readTextFromDisk(absolutePath) : open.getText();
}

export class Repos implements vscode.Disposable {
  private readonly roots = new Map<string, Promise<string | undefined>>();
  private readonly repos = new Map<string, Promise<Repo | undefined>>();
  private readonly loaded = new Set<Repo>();
  private readonly reported = new Set<string>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires after `refresh` or `invalidate`, when refs may resolve differently. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly log: vscode.OutputChannel) {}

  /** The repo that holds `uri` and the repo path of `uri`, or undefined outside git. */
  async locate(uri: vscode.Uri): Promise<Located | undefined> {
    if (uri.scheme !== "file") return undefined;
    const directory = dirname(uri.fsPath);
    let root = this.roots.get(directory);
    if (root === undefined) {
      root = findRepoRoot(directory).catch(() => undefined);
      this.roots.set(directory, root);
    }
    const top = await root;
    if (top === undefined) return undefined;
    const repo = await this.open(top);
    const path = repo?.relative(uri.fsPath);
    return repo === undefined || path === undefined ? undefined : { repo, path };
  }

  private open(root: string): Promise<Repo | undefined> {
    let repo = this.repos.get(root);
    if (repo === undefined) {
      repo = Repo.open(root, readText).then(
        (opened) => {
          this.loaded.add(opened);
          this.log.appendLine(`Indexed ${opened.files.size} files in ${root}`);
          return opened;
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.log.appendLine(`Cannot index ${root}: ${message}`);
          if (!this.reported.has(message)) {
            this.reported.add(message);
            void vscode.window.showWarningMessage(`nref: ${message}`);
          }
          return undefined;
        },
      );
      this.repos.set(root, repo);
    }
    return repo;
  }

  /** Lists the files again (git ls-files) and rereads refs.toml. */
  refresh(): void {
    this.repos.clear();
    this.loaded.clear();
    this.reported.clear();
    this.changed.fire();
  }

  /** Forgets cached headings of a file that changed. */
  invalidate(uri: vscode.Uri): void {
    if (uri.scheme !== "file") return;
    for (const repo of this.loaded) {
      const path = repo.relative(uri.fsPath);
      if (path !== undefined) repo.invalidate(path);
    }
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
