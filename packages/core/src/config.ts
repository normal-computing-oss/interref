/**
 * The config file at the repo root. Only the subset that the proposal uses is read:
 *
 *     exclude = ["vendor/**", "**\/*.min.js"]
 *     protocols = ["iref", "sync"]
 *
 *     [rules]
 *     target-ignored = "warn"
 *
 * A `.json` file holds the same keys: `{ "exclude": [...], "protocols": [...], "rules": {...} }`.
 */

import { join } from "node:path";
import { RULE_SEVERITY, type RuleId, type Severity } from "./resolve.js";
import { DEFAULT_PROTOCOLS, PROTOCOL_NAME } from "./syntax.js";

/** The names that the config file can have. A repo can have only one of them. */
export const CONFIG_FILES: readonly string[] = ["interref.toml", ".interref.toml", "interref.json", ".interref.json"];

export type RuleSetting = Severity | "off";

export interface Config {
  /** Globs of repo paths whose refs are not scanned. Targets in them still resolve. */
  readonly exclude: readonly string[];
  /** The names before `:` that start a ref, for example `iref` in `iref:/a.md`. */
  readonly protocols: readonly string[];
  readonly rules: Readonly<Partial<Record<RuleId, RuleSetting>>>;
}

export const DEFAULT_CONFIG: Config = { exclude: [], protocols: DEFAULT_PROTOCOLS, rules: {} };

export class ConfigError extends Error {}

const isRuleId = (name: string): name is RuleId => Object.hasOwn(RULE_SEVERITY, name);
const isSetting = (value: string): value is RuleSetting => value === "off" || value === "warn" || value === "error";

function checkProtocols(protocols: readonly string[], where: string): void {
  if (protocols.length === 0) throw new ConfigError(`${where}: protocols must not be empty`);
  for (const name of protocols) {
    if (!PROTOCOL_NAME.test(name)) {
      throw new ConfigError(`${where}: protocol "${name}" must be a letter, then letters, digits, "+", "-" or "."`);
    }
  }
}

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

/** Parses the config text. A file name that ends in `.json` selects JSON; others are TOML. */
export function parseConfig(text: string, file = "interref.toml"): Config {
  return file.endsWith(".json") ? parseJsonConfig(text, file) : parseTomlConfig(text, file);
}

function parseTomlConfig(text: string, file: string): Config {
  const exclude: string[] = [];
  let protocols: string[] | undefined;
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

    if (table === "" && (key === "exclude" || key === "protocols")) {
      // Arrays may span lines: keep reading until the closing bracket.
      while (!value.trimEnd().endsWith("]") && i + 1 < lines.length) {
        i++;
        line = stripComment(lines[i] ?? "").trim();
        value += ` ${line}`;
      }
      const array = /^\[(.*)\]$/su.exec(value.trim());
      if (array?.[1] === undefined) throw new ConfigError(`${where}: ${key} must be an array of strings`);
      const items = (array[1].match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^,\s]+/gu) ?? []).map((item) => parseString(item, where));
      if (key === "exclude") exclude.push(...items);
      else {
        checkProtocols(items, where);
        protocols = items;
      }
    } else if (table === "rules") {
      if (!isRuleId(key)) throw new ConfigError(`${where}: unknown rule ${key}`);
      const setting = parseString(value.trim(), where);
      if (!isSetting(setting)) throw new ConfigError(`${where}: ${key} must be "off", "warn" or "error"`);
      rules[key] = setting;
    } else {
      throw new ConfigError(`${where}: unknown key ${key}`);
    }
  }
  return { exclude, protocols: protocols ?? DEFAULT_PROTOCOLS, rules };
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseJsonConfig(text: string, file: string): Config {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(data)) throw new ConfigError(`${file}: expected an object`);
  const exclude: string[] = [];
  let protocols: readonly string[] = DEFAULT_PROTOCOLS;
  const rules: Partial<Record<RuleId, RuleSetting>> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "exclude" || key === "protocols") {
      if (!isStringArray(value)) throw new ConfigError(`${file}: ${key} must be an array of strings`);
      if (key === "exclude") exclude.push(...value);
      else {
        checkProtocols(value, file);
        protocols = value;
      }
    } else if (key === "rules") {
      if (!isObject(value)) throw new ConfigError(`${file}: rules must be an object`);
      for (const [rule, setting] of Object.entries(value)) {
        if (!isRuleId(rule)) throw new ConfigError(`${file}: unknown rule ${rule}`);
        if (typeof setting !== "string" || !isSetting(setting)) {
          throw new ConfigError(`${file}: ${rule} must be "off", "warn" or "error"`);
        }
        rules[rule] = setting;
      }
    } else {
      throw new ConfigError(`${file}: unknown key ${key}`);
    }
  }
  return { exclude, protocols, rules };
}

/**
 * Reads the config file in `root`, or gives `DEFAULT_CONFIG` when there is none.
 * Throws `ConfigError` when the file is malformed or when there is more than one config file.
 */
export function loadConfig(root: string, readText: (absolutePath: string) => string | undefined): Config {
  const found: { file: string; text: string }[] = [];
  for (const file of CONFIG_FILES) {
    const text = readText(join(root, file));
    if (text !== undefined) found.push({ file, text });
  }
  const [first, second] = found;
  if (first === undefined) return DEFAULT_CONFIG;
  if (second !== undefined) {
    throw new ConfigError(`found ${found.map((entry) => entry.file).join(" and ")}; keep only one config file`);
  }
  return parseConfig(first.text, first.file);
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
