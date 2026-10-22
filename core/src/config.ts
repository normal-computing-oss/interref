/**
 * `refs.toml` at the repo root. Only the subset that the proposal uses is read:
 *
 *     exclude = ["vendor/**", "**\/*.min.js"]
 *
 *     [rules]
 *     target-ignored = "warn"
 */

import { RULE_SEVERITY, type RuleId, type Severity } from "./resolve.js";

export const CONFIG_FILE = "refs.toml";

export type RuleSetting = Severity | "off";

export interface Config {
  /** Globs of repo paths whose refs are not scanned. Targets in them still resolve. */
  readonly exclude: readonly string[];
  readonly rules: Readonly<Partial<Record<RuleId, RuleSetting>>>;
}

export const DEFAULT_CONFIG: Config = { exclude: [], rules: {} };

export class ConfigError extends Error {}

const isRuleId = (name: string): name is RuleId => Object.hasOwn(RULE_SEVERITY, name);
const isSetting = (value: string): value is RuleSetting => value === "off" || value === "warn" || value === "error";

/** Removes a `#` comment that is not inside a string. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quote !== undefined) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function parseString(text: string, where: string): string {
  const basic = /^"((?:[^"\\]|\\.)*)"$/u.exec(text);
  if (basic?.[1] !== undefined) {
    return basic[1].replace(/\\(["\\])/gu, "$1");
  }
  const literal = /^'([^']*)'$/u.exec(text);
  if (literal?.[1] !== undefined) return literal[1];
  throw new ConfigError(`${where}: expected a quoted string, got ${text}`);
}

export function parseConfig(text: string, file = CONFIG_FILE): Config {
  const exclude: string[] = [];
  const rules: Partial<Record<RuleId, RuleSetting>> = {};
  let table = "";
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    const where = `${file}:${i + 1}`;
    let line = stripComment(lines[i] ?? "").trim();
    if (line === "") continue;
    const header = /^\[([A-Za-z0-9_-]+)\]$/u.exec(line);
    if (header?.[1] !== undefined) {
      table = header[1];
      if (table !== "rules") throw new ConfigError(`${where}: unknown table [${table}]`);
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/u.exec(line);
    if (pair?.[1] === undefined || pair[2] === undefined) throw new ConfigError(`${where}: expected key = value`);
    const key = pair[1];
    let value = pair[2];

    if (table === "" && key === "exclude") {
      // Arrays may span lines: keep reading until the closing bracket.
      while (!value.trimEnd().endsWith("]") && i + 1 < lines.length) {
        i++;
        line = stripComment(lines[i] ?? "").trim();
        value += ` ${line}`;
      }
      const array = /^\[(.*)\]$/su.exec(value.trim());
      if (array?.[1] === undefined) throw new ConfigError(`${where}: exclude must be an array of strings`);
      const items = array[1].match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^,\s]+/gu) ?? [];
      for (const item of items) exclude.push(parseString(item, where));
    } else if (table === "rules") {
      if (!isRuleId(key)) throw new ConfigError(`${where}: unknown rule ${key}`);
      const setting = parseString(value.trim(), where);
      if (!isSetting(setting)) throw new ConfigError(`${where}: ${key} must be "off", "warn" or "error"`);
      rules[key] = setting;
    } else {
      throw new ConfigError(`${where}: unknown key ${key}`);
    }
  }
  return { exclude, rules };
}

/** A glob as a regular expression over whole repo paths: `**` crosses `/`, `*` and `?` do not. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*" && glob.charAt(i + 1) === "*") {
      i++;
      if (glob.charAt(i + 1) === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[\\^$.|+()[\]{}]/u, "\\$&");
  }
  // A directory pattern such as `vendor/` or `vendor` also covers what is inside it.
  return new RegExp(`^${source.replace(/\/$/u, "")}(?:/.*)?$`, "u");
}

/** A predicate that is true for paths matched by any `exclude` glob. */
export function excluder(config: Config): (path: string) => boolean {
  const patterns = config.exclude.map(globToRegExp);
  return (path) => patterns.some((pattern) => pattern.test(path));
}
