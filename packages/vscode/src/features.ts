/** Links, hovers, diagnostics, quick fixes and completion for refs in any file. */

import { extname } from "node:path";
import {
  checkText,
  encodeRefPath,
  isMarkdownPath,
  resolveTarget,
  type RefRecord,
  type Repo,
} from "@interref/core";
import * as vscode from "vscode";
import type { Located, Repos } from "./repos.js";

export const SOURCE = "interref";
export const REVEAL_DIRECTORY = "interref.revealDirectory";

export interface Analysis extends Located {
  readonly records: readonly RefRecord[];
}

export async function analyse(repos: Repos, document: vscode.TextDocument): Promise<Analysis | undefined> {
  const located = await repos.locate(document.uri);
  if (located === undefined) return undefined;
  return { ...located, records: checkText(located.repo, located.path, document.getText()) };
}

function recordRange(document: vscode.TextDocument, record: RefRecord): vscode.Range {
  return new vscode.Range(document.positionAt(record.start), document.positionAt(record.end));
}

function targetLabel(record: RefRecord): string {
  const target = record.target;
  if (target === undefined) return record.raw;
  const path = target.path === "" ? "/" : target.kind === "directory" ? `${target.path}/` : target.path;
  return target.fragment === undefined ? path : `${path}#${target.fragment.slug}`;
}

/** Where a click on the ref goes: the file at its heading line, or the directory in the explorer. */
export function targetUri(repo: Repo, record: RefRecord): vscode.Uri | undefined {
  const target = record.target;
  if (target === undefined) return undefined;
  const absolute = repo.absolute(target.path);
  if (target.kind === "directory") {
    return vscode.Uri.parse(`command:${REVEAL_DIRECTORY}?${encodeURIComponent(JSON.stringify([absolute]))}`);
  }
  const uri = vscode.Uri.file(absolute);
  return target.line === undefined ? uri : uri.with({ fragment: `L${target.line}` });
}

export class LinkProvider implements vscode.DocumentLinkProvider {
  constructor(private readonly repos: Repos) {}

  async provideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
    const analysis = await analyse(this.repos, document);
    if (analysis === undefined) return [];
    const links: vscode.DocumentLink[] = [];
    for (const record of analysis.records) {
      const uri = targetUri(analysis.repo, record);
      if (uri === undefined) continue;
      const link = new vscode.DocumentLink(recordRange(document, record), uri);
      link.tooltip = `Open ${targetLabel(record)}`;
      links.push(link);
    }
    return links;
  }
}

const FENCE_LANGUAGES: Readonly<Record<string, string>> = {
  ".md": "markdown",
  ".py": "python",
  ".ts": "typescript",
  ".js": "javascript",
  ".json": "json",
  ".toml": "toml",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".sh": "bash",
  ".tcl": "tcl",
  ".sv": "systemverilog",
  ".svh": "systemverilog",
  ".v": "verilog",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".rs": "rust",
  ".go": "go",
};

/** A Markdown code block whose fence is longer than any backtick run in `code`. */
function codeBlock(code: string, language: string): string {
  const longest = Math.max(2, ...(code.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${code}\n${fence}`;
}

export class HoverProvider implements vscode.HoverProvider {
  constructor(private readonly repos: Repos) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const analysis = await analyse(this.repos, document);
    if (analysis === undefined) return undefined;
    const offset = document.offsetAt(position);
    const record = analysis.records.find((candidate) => candidate.start <= offset && offset <= candidate.end);
    if (record === undefined) return undefined;

    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown("**interref** → ");
    markdown.appendText(targetLabel(record));
    if (record.target?.line !== undefined) markdown.appendText(` (line ${record.target.line})`);
    if (record.message !== undefined) {
      markdown.appendMarkdown(record.status === "error" ? "\n\n$(error) " : "\n\n$(warning) ");
      markdown.appendText(`${record.message} [${record.rule ?? ""}]`);
    }
    markdown.supportThemeIcons = true;

    const lines = vscode.workspace.getConfiguration("interref").get<number>("hover.lines", 10);
    const target = record.target;
    if (target !== undefined && lines > 0) {
      if (target.kind === "directory") {
        const entries = [...analysis.repo.list(target.path)]
          .map(([name, kind]) => (kind === "directory" ? `${name}/` : name))
          .sort();
        const shown = entries.slice(0, lines);
        if (entries.length > shown.length) shown.push(`… ${entries.length - shown.length} more`);
        markdown.appendMarkdown("\n\n");
        markdown.appendMarkdown(codeBlock(shown.join("\n"), ""));
      } else {
        const text = analysis.repo.text(target.path);
        if (text !== undefined) {
          const start = (target.line ?? 1) - 1;
          const excerpt = text.split(/\r?\n/u).slice(start, start + lines).join("\n");
          markdown.appendMarkdown("\n\n");
          markdown.appendMarkdown(codeBlock(excerpt, FENCE_LANGUAGES[extname(target.path).toLowerCase()] ?? ""));
        }
      }
    }
    return new vscode.Hover(markdown, recordRange(document, record));
  }
}

export class Diagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection(SOURCE);
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly repos: Repos) {}

  private enabled(): boolean {
    return vscode.workspace.getConfiguration("interref").get<boolean>("diagnostics.enabled", true);
  }

  /** Rechecks one document after `delay` ms; a newer request for it replaces this one. */
  schedule(document: vscode.TextDocument, delay = 250): void {
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.update(document);
      }, delay),
    );
  }

  scheduleAll(delay = 250): void {
    for (const document of vscode.workspace.textDocuments) this.schedule(document, delay);
  }

  async update(document: vscode.TextDocument): Promise<void> {
    if (document.isClosed || !this.enabled()) {
      this.collection.delete(document.uri);
      return;
    }
    const analysis = await analyse(this.repos, document);
    const diagnostics: vscode.Diagnostic[] = [];
    for (const record of analysis?.records ?? []) {
      if (record.status === "ok") continue;
      const diagnostic = new vscode.Diagnostic(
        recordRange(document, record),
        record.message ?? "broken ref",
        record.status === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = SOURCE;
      if (record.rule !== undefined) diagnostic.code = record.rule;
      diagnostics.push(diagnostic);
    }
    if (document.isClosed) this.collection.delete(document.uri);
    else this.collection.set(document.uri, diagnostics);
  }

  forget(document: vscode.TextDocument): void {
    clearTimeout(this.timers.get(document.uri.toString()));
    this.collection.delete(document.uri);
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.collection.dispose();
  }
}

export class QuickFixes implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  constructor(private readonly repos: Repos) {}

  async provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): Promise<vscode.CodeAction[]> {
    const ours = context.diagnostics.filter((diagnostic) => diagnostic.source === SOURCE);
    if (ours.length === 0) return [];
    const analysis = await analyse(this.repos, document);
    if (analysis === undefined) return [];
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of ours) {
      const record = analysis.records.find((candidate) => recordRange(document, candidate).isEqual(diagnostic.range));
      record?.suggestions.forEach((suggestion, index) => {
        const action = new vscode.CodeAction(`Change to ${suggestion}`, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnostic.range, suggestion);
        action.diagnostics = [diagnostic];
        action.isPreferred = index === 0;
        actions.push(action);
      });
    }
    return actions;
  }
}

// The part of a ref before the cursor: its path so far, and its fragment so far after a `#`.
const PARTIAL_REF = /(?:(?<=<!--)|(?<![\p{L}\p{N}_-]))nref:([^\s#"'`<>()[\]{}]*)(?:#([^\s"'`<>()[\]{}]*))?$/u;

export class Completion implements vscode.CompletionItemProvider {
  static readonly triggers = [":", "/", "#"];

  constructor(private readonly repos: Repos) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const before = document.lineAt(position.line).text.slice(0, position.character);
    const partial = PARTIAL_REF.exec(before);
    if (partial === null) return undefined;
    const located = await this.repos.locate(document.uri);
    if (located === undefined) return undefined;
    const { repo, path: source } = located;
    const typedPath = partial[1] ?? "";
    const typedFragment = partial[2];

    if (typedFragment !== undefined) {
      const target = resolveTarget(source, typedPath);
      if (!target.ok || !isMarkdownPath(target.value.path)) return undefined;
      const headings = repo.headings(target.value.path);
      const range = new vscode.Range(position.translate(0, -typedFragment.length), position);
      return headings.map((heading) => {
        const item = new vscode.CompletionItem(heading.slug, vscode.CompletionItemKind.Reference);
        item.detail = `${"#".repeat(heading.level)} ${heading.text}`;
        item.range = range;
        item.sortText = String(heading.line).padStart(6, "0");
        return item;
      });
    }

    if (typedPath === "") {
      return ["/", "./", "../"].map((start) => {
        const item = new vscode.CompletionItem(start, vscode.CompletionItemKind.Folder);
        item.command = { command: "editor.action.triggerSuggest", title: "Suggest" };
        return item;
      });
    }
    const slash = typedPath.lastIndexOf("/");
    if (slash < 0) return undefined;
    const directory = resolveTarget(source, typedPath.slice(0, slash + 1));
    if (!directory.ok || repo.kind(directory.value.path) !== "directory") return undefined;
    const typedName = typedPath.slice(slash + 1);
    const range = new vscode.Range(position.translate(0, -typedName.length), position);
    return [...repo.list(directory.value.path)].map(([name, kind]) => {
      const isDirectory = kind === "directory";
      const item = new vscode.CompletionItem(
        isDirectory ? `${name}/` : name,
        isDirectory ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File,
      );
      item.insertText = encodeRefPath(name) + (isDirectory ? "/" : "");
      item.filterText = name;
      item.range = range;
      item.sortText = `${isDirectory ? "0" : "1"}${name}`;
      if (isDirectory) item.command = { command: "editor.action.triggerSuggest", title: "Suggest" };
      return item;
    });
  }
}
