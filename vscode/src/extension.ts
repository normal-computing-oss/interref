/** Entry point: wires the providers, commands and file watchers. */

import { basename } from "node:path";
import { CONFIG_FILE, extractHeadings, formatRef, isMarkdownPath } from "@interref/core";
import * as vscode from "vscode";
import { Completion, Diagnostics, HoverProvider, LinkProvider, QuickFixes, REVEAL_DIRECTORY } from "./features.js";
import { showGraph } from "./graph.js";
import { Repos } from "./repos.js";

const ALL_FILES: vscode.DocumentSelector = { scheme: "file" };

/** Files whose change alters which paths exist, are tracked, or are scanned. */
const INDEX_FILES = new Set([".gitignore", CONFIG_FILE]);

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("interref");
  const repos = new Repos(log);
  const diagnostics = new Diagnostics(repos);
  context.subscriptions.push(log, repos, diagnostics);

  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(ALL_FILES, new LinkProvider(repos)),
    vscode.languages.registerHoverProvider(ALL_FILES, new HoverProvider(repos)),
    vscode.languages.registerCodeActionsProvider(ALL_FILES, new QuickFixes(repos), {
      providedCodeActionKinds: QuickFixes.kinds,
    }),
    vscode.languages.registerCompletionItemProvider(ALL_FILES, new Completion(repos), ...Completion.triggers),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("interref.copyRef", (uri: unknown) => copyRef(repos, uri)),
    vscode.commands.registerCommand("interref.showGraph", (uri: unknown) => showGraph(context, repos, uri)),
    vscode.commands.registerCommand("interref.refresh", () => repos.refresh()),
    vscode.commands.registerCommand(REVEAL_DIRECTORY, async (path: unknown) => {
      if (typeof path !== "string") return;
      await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(path));
    }),
  );

  // Headings live in file text, so edits to one file can fix or break refs in another.
  repos.onDidChange(() => diagnostics.scheduleAll(), undefined, context.subscriptions);
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => diagnostics.schedule(document, 0)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.forget(document)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length === 0) return;
      diagnostics.schedule(event.document);
      if (isMarkdownPath(event.document.uri.fsPath)) repos.invalidate(event.document.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("interref")) return;
      diagnostics.clear();
      diagnostics.scheduleAll(0);
    }),
  );

  // Creating or deleting files changes the file list; git ls-files runs again after a pause.
  let refreshTimer: NodeJS.Timeout | undefined;
  const refreshSoon = (): void => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => repos.refresh(), 500);
  };
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(refreshSoon),
    watcher.onDidDelete(refreshSoon),
    watcher.onDidChange((uri) => {
      if (INDEX_FILES.has(basename(uri.fsPath))) refreshSoon();
      else if (isMarkdownPath(uri.fsPath)) repos.invalidate(uri);
    }),
    { dispose: () => clearTimeout(refreshTimer) },
  );

  diagnostics.scheduleAll(0);
}

/** Copies `nref:/path` for a file or folder, plus `#slug` of the heading above the cursor in Markdown. */
async function copyRef(repos: Repos, argument: unknown): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const uri = argument instanceof vscode.Uri ? argument : editor?.document.uri;
  if (uri === undefined) return;
  const located = await repos.locate(uri);
  if (located === undefined) {
    void vscode.window.showWarningMessage("interref: this file is not in a git repo");
    return;
  }
  const { repo, path } = located;
  let directory = repo.kind(path) === "directory";
  if (repo.kind(path) === undefined) {
    directory = (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.Directory;
  }

  let slug: string | undefined;
  if (!directory && editor !== undefined && editor.document.uri.toString() === uri.toString() && isMarkdownPath(path)) {
    const line = editor.selection.active.line + 1;
    slug = extractHeadings(editor.document.getText())
      .filter((heading) => heading.line <= line)
      .at(-1)?.slug;
  }

  const ref = formatRef(path, path, { style: "absolute", directory, slug });
  await vscode.env.clipboard.writeText(ref);
  vscode.window.setStatusBarMessage(`Copied ${ref}`, 3000);
}

export function deactivate(): void {}
