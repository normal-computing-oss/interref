/** Checks refs against a repo snapshot and gives each one a status. */

import { posix } from "node:path";
import { isMarkdownPath } from "./markdown.js";
import type { EntryKind, Repo } from "./repo.js";
import {
  formatRef,
  parseFragment,
  resolveTarget,
  RULE_SEVERITY,
  type HeadingFragment,
  type RuleId,
} from "./resolve.js";
import { LineIndex, scanRefs, type RefMatch } from "./syntax.js";

export type Status = "ok" | "warn" | "error";

export interface ResolvedTarget {
  readonly path: string;
  readonly kind: EntryKind;
  readonly fragment?: HeadingFragment;
  /** 1-based line of the heading, when the fragment was found. */
  readonly line?: number;
}

export interface RefRecord {
  readonly source: { readonly path: string; readonly line: number; readonly col: number };
  readonly raw: string;
  /** Offsets of `raw` in the source text. */
  readonly start: number;
  readonly end: number;
  /** Set when the path resolved to something that exists, even if the ref has a problem. */
  readonly target?: ResolvedTarget;
  readonly status: Status;
  readonly rule?: RuleId;
  readonly message?: string;
  /** Replacement refs that would fix the problem, best first. */
  readonly suggestions: readonly string[];
}

const MAX_SUGGESTIONS = 3;

/** Levenshtein distance, early exit once it passes `limit`. */
export function editDistance(a: string, b: string, limit = Number.POSITIVE_INFINITY): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function closest(wanted: string, candidates: Iterable<string>, limit: number): string[] {
  const scored: { candidate: string; distance: number }[] = [];
  for (const candidate of candidates) {
    const distance = editDistance(wanted, candidate, limit);
    if (distance <= limit) scored.push({ candidate, distance });
  }
  scored.sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
  return scored.slice(0, MAX_SUGGESTIONS).map((entry) => entry.candidate);
}

/** Existing paths that the author probably meant: same name elsewhere, or a near spelling. */
export function similarPaths(repo: Repo, path: string): string[] {
  const name = posix.basename(path).toLowerCase();
  const sameName = [...repo.files].filter((file) => posix.basename(file).toLowerCase() === name);
  if (sameName.length > 0) return closest(path, sameName, Number.POSITIVE_INFINITY);
  const directory = posix.dirname(path) === "." ? "" : posix.dirname(path);
  const siblings = [...repo.list(directory).keys()].map((entry) => (directory === "" ? entry : `${directory}/${entry}`));
  return closest(path, siblings, Math.max(2, Math.floor(posix.basename(path).length / 3)));
}

/** Checks one ref written in `source` (a repo-relative path), with the rule settings of the config. */
export function checkRef(repo: Repo, source: string, match: RefMatch, lines: LineIndex): RefRecord {
  const position = lines.position(match.start);
  const base = { source: { path: source, ...position }, raw: match.raw, start: match.start, end: match.end };
  const problem = (rule: RuleId, message: string, suggestions: readonly string[] = [], target?: ResolvedTarget): RefRecord => {
    const setting = repo.config.rules[rule] ?? RULE_SEVERITY[rule];
    const located = { ...base, ...(target === undefined ? {} : { target }) };
    if (setting === "off") return { ...located, status: "ok", suggestions: [] };
    return { ...located, status: setting, rule, message, suggestions };
  };

  const fragmentSuffix = match.fragment === undefined ? "" : `#${match.fragment}`;
  const resolved = resolveTarget(source, match.path, match.protocol);
  if (!resolved.ok) {
    const suggestions = resolved.problem.rule === "bare-path" ? [`${match.protocol}:./${match.path}${fragmentSuffix}`] : [];
    return problem(resolved.problem.rule, resolved.problem.message, suggestions);
  }
  const { path, style, trailingSlash } = resolved.value;
  const rewrite = (to: string, kind: EntryKind, slug = match.fragment): string =>
    formatRef(source, to, { style, directory: kind === "directory" && trailingSlash, slug, protocol: match.protocol });

  let kind = repo.kind(path);
  let warning: { rule: RuleId; message: string } | undefined;
  if (kind === undefined) {
    const variants = repo.caseVariants(path);
    const first = variants[0];
    if (first !== undefined) {
      const variantKind = repo.kind(first) ?? "file";
      return problem(
        "case-mismatch",
        `no such path; the repo has ${first} (paths are case-sensitive)`,
        variants.map((variant) => rewrite(variant, variantKind)),
      );
    }
    kind = repo.kindOnDisk(path);
    if (kind === undefined) {
      const near = similarPaths(repo, path);
      const hint = near[0] === undefined ? "" : `; did you mean ${near[0]}?`;
      return problem(
        "missing-file",
        `no such file or directory: ${path === "" ? "/" : path}${hint}`,
        near.map((candidate) => rewrite(candidate, repo.kind(candidate) ?? "file")),
      );
    }
    warning = { rule: "target-ignored", message: `${path} is ignored by git, so this ref breaks for others` };
  } else if (path !== source && !repo.isTracked(path)) {
    warning = { rule: "target-ignored", message: `${path} is not tracked by git; commit it or this ref breaks for others` };
  }

  if (trailingSlash && kind === "file") {
    return problem("missing-file", `${path} is a file, not a directory`, [rewrite(path, "file")]);
  }

  let target: ResolvedTarget = { path, kind };
  if (match.fragment !== undefined) {
    const fragment = parseFragment(match.fragment);
    if (!fragment.ok) return problem(fragment.problem.rule, fragment.problem.message, [rewrite(path, kind, "")], target);
    target = { ...target, fragment: fragment.value };
    const { slug } = fragment.value;
    if (kind === "directory") {
      return problem("missing-anchor", "a directory has no headings", [rewrite(path, kind, "")], target);
    }
    if (!isMarkdownPath(path)) {
      return problem("missing-anchor", "only Markdown files have heading fragments", [rewrite(path, kind, "")], target);
    }
    const headings = repo.headings(path);
    const heading = headings.find((candidate) => candidate.slug === slug);
    if (heading === undefined) {
      const slugs = headings.map((candidate) => candidate.slug);
      const prefixed = slugs.filter((candidate) => slug !== "" && candidate.startsWith(slug));
      const spelled = closest(slug, slugs, Math.max(3, Math.floor(slug.length / 3)));
      const near = [...new Set([...spelled, ...prefixed])].slice(0, MAX_SUGGESTIONS);
      const hint = near[0] === undefined ? "" : `; did you mean #${near[0]}?`;
      return problem(
        "missing-anchor",
        `no heading #${slug} in ${path}${hint}`,
        near.map((candidate) => rewrite(path, "file", candidate)),
        target,
      );
    }
    target = { ...target, line: heading.line };
  }

  if (warning !== undefined) return problem(warning.rule, warning.message, [], target);
  return { ...base, target, status: "ok", suggestions: [] };
}

/** Scans and checks every ref in one file. A file that the config excludes has none. */
export function checkText(repo: Repo, source: string, text: string): RefRecord[] {
  if (repo.isExcluded(source)) return [];
  const matches = scanRefs(text, repo.config.protocols);
  if (matches.length === 0) return [];
  const lines = new LineIndex(text);
  return matches.map((match) => checkRef(repo, source, match, lines));
}

export interface RepoScan {
  readonly records: readonly RefRecord[];
  /** Text files read (binary files are skipped). */
  readonly filesScanned: number;
}

/** Checks the refs in every repo file accepted by `include` and not excluded by the config. */
export function scanRepo(repo: Repo, include: (path: string) => boolean = () => true): RepoScan {
  const records: RefRecord[] = [];
  let filesScanned = 0;
  for (const path of [...repo.files].sort()) {
    if (!include(path) || repo.isExcluded(path)) continue;
    const text = repo.text(path);
    if (text === undefined) continue;
    filesScanned++;
    records.push(...checkText(repo, path, text));
  }
  return { records, filesScanned };
}
