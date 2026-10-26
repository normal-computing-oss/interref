/** Text, JSON and SARIF renderings of ref records. */

import { displayPath, LineIndex, RULE_SEVERITY, type RefRecord, type Repo, type RuleId } from "@interref/core";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function location(record: RefRecord): string {
  return `${record.source.path}:${record.source.line}:${record.source.col}`;
}

export function describeTarget(record: RefRecord): string {
  const target = record.target;
  if (target === undefined) return "?";
  const slug = target.fragment === undefined ? "" : `#${target.fragment.slug}`;
  const line = target.line === undefined ? "" : ` (line ${target.line})`;
  return `${displayPath(target.path, target.kind)}${slug}${line}`;
}

/** The record as the proposal's JSON shape, without editor-only offsets. */
export function recordJson(record: RefRecord): { [key: string]: JsonValue } {
  const json: { [key: string]: JsonValue } = {
    source: { path: record.source.path, line: record.source.line, col: record.source.col },
    raw: record.raw,
    target: null,
    status: record.status,
  };
  const target = record.target;
  if (target !== undefined) {
    const out: { [key: string]: JsonValue } = { path: target.path, kind: target.kind };
    if (target.fragment !== undefined) out["fragment"] = { kind: target.fragment.kind, slug: target.fragment.slug };
    if (target.line !== undefined) out["line"] = target.line;
    json["target"] = out;
  }
  if (record.rule !== undefined) json["rule"] = record.rule;
  if (record.message !== undefined) json["message"] = record.message;
  if (record.suggestions.length > 0) json["suggestions"] = [...record.suggestions];
  return json;
}

/** Prints `values` as one JSON array, or one value per line for ndjson. */
export function printJson(values: readonly JsonValue[], format: "json" | "ndjson"): void {
  if (format === "json") console.log(JSON.stringify(values, null, 2));
  else for (const value of values) console.log(JSON.stringify(value));
}

/** Numbered lines `from`..`to` (1-based, clamped), marking `mark` with `>`. */
export function numberedLines(text: string, from: number, to: number, mark?: number): string[] {
  const lines = new LineIndex(text);
  const first = Math.max(1, from);
  const last = Math.min(lines.lineCount, to);
  const width = String(last).length;
  const out: string[] = [];
  for (let line = first; line <= last; line++) {
    const gutter = line === mark ? ">" : " ";
    out.push(`  ${gutter}${String(line).padStart(width)} | ${lines.lineText(line)}`);
  }
  return out;
}

export interface ContextOptions {
  readonly before: number;
  readonly after: number;
  /** Lines of the target to show from the heading (or from the top), 0 for none. */
  readonly target: number;
}

/** The context lines around a ref and, if asked, the start of its target. */
export function contextBlock(repo: Repo, record: RefRecord, options: ContextOptions): string[] {
  const out: string[] = [];
  if (options.before > 0 || options.after > 0) {
    const text = repo.text(record.source.path);
    const line = record.source.line;
    if (text !== undefined) out.push(...numberedLines(text, line - options.before, line + options.after, line));
  }
  const target = record.target;
  if (options.target > 0 && target?.kind === "file") {
    const text = repo.text(target.path);
    const start = target.line ?? 1;
    if (text !== undefined) {
      out.push(`  ${target.path}:`);
      out.push(...numberedLines(text, start, start + options.target - 1));
    }
  }
  return out;
}

const RULE_TEXT: Readonly<Record<RuleId, string>> = {
  "missing-file": "Target path does not exist",
  "missing-anchor": "Heading not found in the target",
  "escapes-root": "Path climbs above the repo root",
  "bare-path": "Path starts with neither /, ./ nor ../",
  "reserved-authority": "<protocol>://<repo>/ is reserved for cross-repo refs",
  "case-mismatch": "Path differs from a repo path only by case",
  "unsupported-fragment": "Only heading fragments are supported",
  "invalid-encoding": "Bad percent-encoding",
  "target-ignored": "Target is untracked or ignored by git",
};

/** A SARIF 2.1.0 log of the records that have a problem, for CI annotations. */
export function sarif(records: readonly RefRecord[]): JsonValue {
  const rules = (Object.keys(RULE_TEXT) as RuleId[]).map((id) => ({
    id,
    shortDescription: { text: RULE_TEXT[id] },
    defaultConfiguration: { level: RULE_SEVERITY[id] === "error" ? "error" : "warning" },
  }));
  const results = records
    .filter((record) => record.rule !== undefined)
    .map((record) => ({
      ruleId: record.rule ?? "",
      level: record.status === "error" ? "error" : "warning",
      message: { text: `${record.raw}: ${record.message ?? ""}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: record.source.path, uriBaseId: "%SRCROOT%" },
            region: {
              startLine: record.source.line,
              startColumn: record.source.col,
              endColumn: record.source.col + record.raw.length,
            },
          },
        },
      ],
    }));
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{ tool: { driver: { name: "interref", rules } }, results }],
  };
}
