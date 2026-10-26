#!/usr/bin/env node
/** interref: outgoing refs, backlinks, broken refs and the link graph of a git repo. */

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  ConfigError,
  GitError,
  graphView,
  RefGraph,
  Repo,
  scanRepo,
  toDot,
  toDrawio,
  toMermaid,
  type RefRecord,
} from "@interref/core";
import {
  contextBlock,
  describeTarget,
  location,
  printJson,
  recordJson,
  sarif,
  type ContextOptions,
  type JsonValue,
} from "./format.js";

const USAGE = `Usage: interref <command> [options]

Commands:
  links <file> [--to <file>]   Refs written in a file, optionally only those that reach <file>
  backlinks <file>             Refs in the repo that point at a file or directory
  check [<path>...]            Report broken refs in the repo or under the paths; exit 1 if any
  graph [<file>]               Export the link graph, whole repo or around one file (> x.drawio)

Options:
  -r, --recursive              Follow refs transitively (links, backlinks)
      --depth N                Stop after N hops (recursive walks; graph around a file: default 1)
  -C N, -A N, -B N             Show N lines of context around each ref where it is written
  -T N, --show-target N        Show N lines of the target, from the heading or the top
      --format F               text | json | ndjson, plus sarif for check; dot | mermaid | json | drawio for graph
  -h, --help                   Show this help

Paths in output are relative to the repo root. Exit codes: 0 clean, 1 broken refs, 2 usage error.
Only heading fragments (#some-heading) are supported for now.`;

class UsageError extends Error {}

const OPTIONS = {
  recursive: { type: "boolean", short: "r" },
  depth: { type: "string" },
  context: { type: "string", short: "C" },
  after: { type: "string", short: "A" },
  before: { type: "string", short: "B" },
  "show-target": { type: "string", short: "T" },
  format: { type: "string" },
  to: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

function count(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${name} needs a whole number, not "${value}"`);
  return n;
}

function format<T extends string>(value: string | undefined, allowed: readonly T[]): T {
  const chosen = value ?? allowed[0];
  const match = allowed.find((candidate) => candidate === chosen);
  if (match === undefined) throw new UsageError(`--format must be one of ${allowed.join(", ")}`);
  return match;
}

function contextOptions(values: Values): ContextOptions {
  const around = count(values.context, "-C", 0);
  return {
    before: count(values.before, "-B", around),
    after: count(values.after, "-A", around),
    target: count(values["show-target"], "-T", 0),
  };
}

/** A command-line path as a repo path that must exist in the file list. */
function repoPath(repo: Repo, argument: string): string {
  const path = repo.relative(resolve(argument));
  if (path === undefined) throw new UsageError(`${argument} is outside the repo at ${repo.root}`);
  if (repo.kind(path) === undefined) throw new UsageError(`${argument} is not a file or directory known to git`);
  return path;
}

function onePath(positionals: readonly string[], command: string): string {
  const [path, ...rest] = positionals;
  if (path === undefined || rest.length > 0) throw new UsageError(`${command} takes exactly one file`);
  return path;
}

function printRecord(repo: Repo, record: RefRecord, context: ContextOptions, arrow: boolean): void {
  let line = `${location(record)}  ${record.raw}`;
  if (arrow && record.target !== undefined) line += `  -> ${describeTarget(record)}`;
  if (record.rule !== undefined) line += `  ${record.status} ${record.rule}: ${record.message ?? ""}`;
  console.log(line);
  for (const extra of contextBlock(repo, record, context)) console.log(extra);
}

/** The files reachable from `root` as a tree; each file is expanded once. */
function tree(graph: RefGraph, root: string, depth: number, reverse: boolean): { lines: string[]; json: JsonValue[] } {
  const expanded = new Set<string>();
  const json: JsonValue[] = [];
  const lines: string[] = [root];
  const walk = (path: string, prefix: string, level: number, ancestors: readonly string[]): void => {
    expanded.add(path);
    const records = reverse ? graph.incoming(path) : graph.outgoing(path);
    const broken = reverse ? [] : records.filter((record) => record.target === undefined);
    const next = graph.neighbours(path, reverse);
    const entries = [...next.map((p) => ({ kind: "path" as const, p })), ...broken.map((r) => ({ kind: "broken" as const, r }))];
    entries.forEach((entry, index) => {
      const last = index === entries.length - 1;
      const branch = prefix + (last ? "└── " : "├── ");
      const childPrefix = prefix + (last ? "    " : "│   ");
      if (entry.kind === "broken") {
        lines.push(`${branch}✗ ${entry.r.raw} (${entry.r.rule ?? "broken"})`);
        json.push({ depth: level, from: path, to: null, ...recordJson(entry.r) });
        return;
      }
      const child = entry.p;
      json.push(reverse ? { depth: level, from: child, to: path } : { depth: level, from: path, to: child });
      if (ancestors.includes(child) || child === path) lines.push(`${branch}${child}  (cycle)`);
      else if (expanded.has(child)) lines.push(`${branch}${child}  (see above)`);
      else if (level >= depth) lines.push(`${branch}${child}  …`);
      else {
        lines.push(`${branch}${child}`);
        walk(child, childPrefix, level + 1, [...ancestors, path]);
      }
    });
  };
  walk(root, "", 1, []);
  return { lines, json };
}

function printTree(graph: RefGraph, root: string, depth: number, reverse: boolean, outputFormat: string): void {
  const { lines, json } = tree(graph, root, depth, reverse);
  if (outputFormat === "text") for (const line of lines) console.log(line);
  else printJson(json, outputFormat === "json" ? "json" : "ndjson");
}

function commandLinks(repo: Repo, values: Values, positionals: readonly string[]): number {
  const outputFormat = format(values.format, ["text", "json", "ndjson"] as const);
  const file = repoPath(repo, onePath(positionals, "links"));
  const to = values.to === undefined ? undefined : repoPath(repo, values.to);
  const depth = count(values.depth, "--depth", Number.POSITIVE_INFINITY);

  if (values.recursive === true) {
    const graph = new RefGraph(scanRepo(repo).records);
    if (to === undefined) {
      printTree(graph, file, depth, false, outputFormat);
      return 0;
    }
    const paths = graph.pathsBetween(file, to, depth);
    if (outputFormat !== "text") {
      printJson(paths.map((path) => ({ path, hops: path.length - 1 })), outputFormat);
    } else {
      const width = Math.max(0, ...paths.map((path) => path.join(" -> ").length));
      for (const path of paths) {
        const hops = path.length - 1;
        console.log(`${path.join(" -> ").padEnd(width)}   (${hops === 1 ? "direct" : `${hops} hops`})`);
      }
      if (paths.length === 0) console.log(`no chain of refs leads from ${file} to ${to}`);
    }
    return 0;
  }

  const text = repo.text(file);
  const { records } = scanRepo(repo, (path) => path === file);
  const shown = to === undefined ? records : records.filter((record) => record.target?.path === to);
  if (text === undefined && repo.kind(file) === "directory") throw new UsageError(`${file} is a directory; links needs a file`);
  if (outputFormat !== "text") printJson(shown.map(recordJson), outputFormat);
  else for (const record of shown) printRecord(repo, record, contextOptions(values), true);
  return 0;
}

function commandBacklinks(repo: Repo, values: Values, positionals: readonly string[]): number {
  const outputFormat = format(values.format, ["text", "json", "ndjson"] as const);
  const file = repoPath(repo, onePath(positionals, "backlinks"));
  const graph = new RefGraph(scanRepo(repo).records);
  if (values.recursive === true) {
    printTree(graph, file, count(values.depth, "--depth", Number.POSITIVE_INFINITY), true, outputFormat);
    return 0;
  }
  const records = graph.incoming(file);
  if (outputFormat !== "text") printJson(records.map(recordJson), outputFormat);
  else for (const record of records) printRecord(repo, record, contextOptions(values), false);
  return 0;
}

function commandCheck(repo: Repo, values: Values, positionals: readonly string[]): number {
  const outputFormat = format(values.format, ["text", "json", "ndjson", "sarif"] as const);
  const roots = positionals.map((argument) => repoPath(repo, argument));
  const include = (path: string): boolean =>
    roots.length === 0 || roots.some((root) => root === "" || path === root || path.startsWith(`${root}/`));
  const scan = scanRepo(repo, include);
  const problems = scan.records.filter((record) => record.status !== "ok");
  const errors = problems.filter((record) => record.status === "error").length;

  if (outputFormat === "sarif") console.log(JSON.stringify(sarif(problems), null, 2));
  else if (outputFormat !== "text") printJson(problems.map(recordJson), outputFormat);
  else {
    const context = contextOptions(values);
    for (const record of problems) {
      const hint = record.suggestions.length > 0 ? `  (fix: ${record.suggestions.join(" or ")})` : "";
      console.log(`${location(record)}  ${record.status}  ${record.raw}  ${record.message ?? ""} [${record.rule ?? ""}]${hint}`);
      for (const extra of contextBlock(repo, record, context)) console.log(extra);
    }
    const warnings = problems.length - errors;
    const files = `${scan.filesScanned} file${scan.filesScanned === 1 ? "" : "s"}`;
    const parts = [`${errors} broken ref${errors === 1 ? "" : "s"}`];
    if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
    console.log(`${parts.join(", ")} (${scan.records.length} refs in ${files})`);
  }
  return errors > 0 ? 1 : 0;
}

function commandGraph(repo: Repo, values: Values, positionals: readonly string[]): number {
  const outputFormat = format(values.format, ["dot", "mermaid", "json", "drawio"] as const);
  if (positionals.length > 1) throw new UsageError("graph takes at most one file");
  const center = positionals[0] === undefined ? undefined : repoPath(repo, positionals[0]);
  const view = graphView(new RefGraph(scanRepo(repo).records), {
    center,
    depth: count(values.depth, "--depth", 1),
    centerKind: center === undefined ? "file" : (repo.kind(center) ?? "file"),
  });
  if (outputFormat === "json") {
    const edges = view.edges.map(({ from, to, count: refs, broken }) => ({ from, to, refs, broken }));
    console.log(JSON.stringify({ nodes: view.nodes.map(({ path, kind }) => ({ path, kind })), edges }, null, 2));
  } else if (outputFormat === "drawio") console.log(toDrawio(view));
  else if (outputFormat === "dot") console.log(toDot(view));
  else console.log(toMermaid(view));
  return 0;
}

const COMMANDS: Readonly<Record<string, (repo: Repo, values: Values, positionals: readonly string[]) => number>> = {
  links: commandLinks,
  backlinks: commandBacklinks,
  check: commandCheck,
  graph: commandGraph,
};

async function main(argv: readonly string[]): Promise<number> {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help === true || command === undefined) {
    console.log(USAGE);
    return command === undefined && values.help !== true ? 2 : 0;
  }
  const run = COMMANDS[command];
  if (run === undefined) throw new UsageError(`unknown command "${command}"`);
  return run(await Repo.open(process.cwd()), values, rest);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError || error instanceof GitError || error instanceof ConfigError) {
      console.error(`interref: ${error.message}`);
      if (error instanceof UsageError) console.error("Run interref --help for usage.");
      process.exitCode = 2;
    } else {
      console.error(error);
      process.exitCode = 2;
    }
  },
);
