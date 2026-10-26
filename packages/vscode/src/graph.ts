/**
 * "Show ref graph": writes the link graph to a file and opens it in a viewer extension: Draw.io
 * Integration, or for Mermaid the official Mermaid extension with Mermaid Preview as a fallback.
 * This extension draws nothing itself.
 */

import { basename, relative, sep } from "node:path";
import { graphView, RefGraph, scanRepo, toDrawio, toMermaid, type GraphView, type Repo } from "@interref/core";
import * as vscode from "vscode";
import type { Repos } from "./repos.js";

type ViewerId = "drawio" | "mermaid";

/** An extension that can show the graph file. */
interface Provider {
  readonly name: string;
  /** Marketplace id. */
  readonly extension: string;
  /** Command that previews the active editor, if the provider needs one. */
  readonly previewCommand?: string;
}

interface Viewer {
  /** Tried in order; the first installed one is used. */
  readonly providers: readonly [Provider, ...Provider[]];
  readonly fileExtension: string;
  render(view: GraphView, repo: Repo, file: vscode.Uri): string;
  open(file: vscode.Uri, provider: Provider): Promise<void>;
}

const DRAWIO_EDITOR = "hediet.vscode-drawio-text";
const CODE_LINK_TIP = "interref.graph.codeLinkTipShown";

const VIEWERS: Readonly<Record<ViewerId, Viewer>> = {
  drawio: {
    providers: [{ name: "Draw.io Integration", extension: "hediet.vscode-drawio" }],
    fileExtension: ".drawio",
    // Code links are relative to the .drawio file itself, as Draw.io Integration writes them.
    render: (view, repo, file) =>
      toDrawio(view, { link: (path) => relative(file.fsPath, repo.absolute(path)).split(sep).join("/") }),
    open: async (file) => {
      await vscode.commands.executeCommand("vscode.openWith", file, DRAWIO_EDITOR);
    },
  },
  mermaid: {
    providers: [
      { name: "Mermaid", extension: "MermaidChart.vscode-mermaid-chart", previewCommand: "mermaidChart.preview" },
      { name: "Mermaid Preview", extension: "vstirbu.vscode-mermaid-preview", previewCommand: "preview.mermaidChart.preview" },
    ],
    fileExtension: ".mmd",
    render: (view) => `${toMermaid(view)}\n`,
    open: async (file, provider) => {
      // Both Mermaid previews follow the active editor.
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false });
      const command = provider.previewCommand;
      if (command !== undefined && (await vscode.commands.getCommands(true)).includes(command)) {
        await vscode.commands.executeCommand(command);
      } else {
        void vscode.window.showInformationMessage(`interref: open the preview with the ${provider.name} extension.`);
      }
    },
  },
};

const isInstalled = (provider: Provider): boolean => vscode.extensions.getExtension(provider.extension) !== undefined;

/** The first installed provider of the viewer; if there is none, offers to install one. */
async function findProvider(viewer: Viewer): Promise<Provider | undefined> {
  const installed = viewer.providers.find(isInstalled);
  if (installed !== undefined) return installed;
  const names = viewer.providers.map((provider) => provider.name).join(" or ");
  const choice = await vscode.window.showWarningMessage(
    `interref: the ref graph needs the ${names} extension. Install one, or change the interref.graph.viewer setting.`,
    ...viewer.providers.map((provider) => `Install ${provider.name}`),
  );
  const chosen = viewer.providers.find((provider) => choice === `Install ${provider.name}`);
  if (chosen === undefined) return undefined;
  await vscode.commands.executeCommand("workbench.extensions.installExtension", chosen.extension);
  return isInstalled(chosen) ? chosen : undefined;
}

interface Scope extends vscode.QuickPickItem {
  readonly depth: number | undefined;
}

/** Around the file (1 or 2 hops) or the whole repo; undefined if the user cancels. */
async function pickScope(center: string | undefined): Promise<Scope | undefined> {
  const whole: Scope = { label: "$(globe) Whole repo", depth: undefined };
  if (center === undefined || center === "") return whole;
  const name = basename(center);
  return vscode.window.showQuickPick<Scope>(
    [
      { label: `$(target) Around ${name}`, description: "1 hop", depth: 1 },
      { label: `$(target) Around ${name}`, description: "2 hops", depth: 2 },
      whole,
    ],
    { title: "interref: Show ref graph", placeHolder: "Which part of the graph?" },
  );
}

/** A file name from a repo path: `fuji/arch/a.md` becomes `fuji-arch-a.md`. */
function fileName(repo: Repo, center: string | undefined): string {
  const base = center === undefined ? basename(repo.root) : `${basename(repo.root)}-${center}`;
  return base.replace(/[^\p{L}\p{N}._-]+/gu, "-");
}

export async function showGraph(context: vscode.ExtensionContext, repos: Repos, argument: unknown): Promise<void> {
  const viewerId = vscode.workspace.getConfiguration("interref").get<ViewerId>("graph.viewer", "drawio");
  const viewer = VIEWERS[viewerId];
  const provider = await findProvider(viewer);
  if (provider === undefined) return;

  const uri =
    argument instanceof vscode.Uri
      ? argument
      : (vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri);
  const located = uri === undefined ? undefined : await repos.locate(uri);
  if (located === undefined) {
    void vscode.window.showWarningMessage("interref: open a file in a git repo to show its ref graph");
    return;
  }
  const { repo } = located;
  const known = repo.kind(located.path) !== undefined;
  const scope = await pickScope(known ? located.path : undefined);
  if (scope === undefined) return;
  const center = scope.depth === undefined ? undefined : located.path;

  const view = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "interref: building the ref graph" },
    () =>
      Promise.resolve(
        graphView(new RefGraph(scanRepo(repo).records), {
          center,
          depth: scope.depth ?? 1,
          centerKind: center === undefined ? "file" : (repo.kind(center) ?? "file"),
        }),
      ),
  );
  if (view.edges.length === 0) {
    void vscode.window.showInformationMessage(
      center === undefined ? "interref: this repo has no refs between files" : `interref: no refs to or from ${center}`,
    );
    return;
  }

  const folder = vscode.Uri.joinPath(context.globalStorageUri, "graphs");
  const file = vscode.Uri.joinPath(folder, `${fileName(repo, center)}${viewer.fileExtension}`);
  await vscode.workspace.fs.createDirectory(folder);
  await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(viewer.render(view, repo, file)));
  await viewer.open(file, provider);

  if (viewerId === "drawio" && context.globalState.get<boolean>(CODE_LINK_TIP) !== true) {
    await context.globalState.update(CODE_LINK_TIP, true);
    void vscode.window.showInformationMessage(
      'interref: turn on "Code Link" in the status bar, then double-click a node to open its file.',
    );
  }
}
