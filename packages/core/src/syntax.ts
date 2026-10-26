/**
 * Finds refs such as `iref:./a.md` in text. The protocol names (`iref` and `sync` by default) come
 * from the config. The pattern is the one in the proposal, with two changes: "no letter, digit, `_`
 * or `-` before the ref" uses Unicode classes rather than ASCII `\w`, and `<!--` right before the ref
 * is allowed, so that `<!--iref:./a.md-->` matches as the proposal's example says.
 */

/** The protocol names that start a ref when the config does not set `protocols`. */
export const DEFAULT_PROTOCOLS = ["iref", "sync"] as const;

/** What a protocol name can be: the URI scheme rule. */
export const PROTOCOL_NAME = /^[A-Za-z][A-Za-z0-9+.-]*$/u;

/** One ref as it is written in a source file. */
export interface RefMatch {
  /** The ref after trimming, for example `iref:./a.md#intro`. */
  readonly raw: string;
  /** The protocol name without `:`, for example `iref`. */
  readonly protocol: string;
  /** Offset of the first letter of the protocol (UTF-16 code units). */
  readonly start: number;
  /** Offset just after the last character of `raw`. */
  readonly end: number;
  /** The path part, still percent-encoded. It can be empty. */
  readonly path: string;
  /** The fragment without `#`, or undefined when the ref has no fragment. */
  readonly fragment: string | undefined;
}

const TRAILING_PUNCTUATION = /[.,;:!?]$/u;

/**
 * The regular expression source that matches one of `protocols` at the start of a ref, with the
 * boundary check, and captures the protocol name. The VS Code completion uses it too.
 */
export function protocolPattern(protocols: readonly string[]): string {
  const names = protocols.map((name) => name.replace(/[.+]/gu, "\\$&")).join("|");
  return `(?:(?<=<!--)|(?<![\\p{L}\\p{N}_-]))(${names}):`;
}

const patterns = new Map<string, RegExp>();

function refPattern(protocols: readonly string[]): RegExp {
  const key = protocols.join(" ");
  let pattern = patterns.get(key);
  if (pattern === undefined) {
    pattern = new RegExp(`${protocolPattern(protocols)}[^\\s#"'\`<>()[\\]{}]*(?:#[^\\s"'\`<>()[\\]{}]+)?`, "gu");
    patterns.set(key, pattern);
  }
  return pattern;
}

/** Returns every ref in `text` that starts with one of `protocols`, in order. */
export function scanRefs(text: string, protocols: readonly string[] = DEFAULT_PROTOCOLS): RefMatch[] {
  if (!protocols.some((name) => text.includes(`${name}:`))) return [];
  const refs: RefMatch[] = [];
  for (const match of text.matchAll(refPattern(protocols))) {
    const start = match.index;
    const protocol = match[1] ?? "";
    const prefixLength = protocol.length + 1;
    const raw = trimRef(text, start, match[0], prefixLength);
    const hash = raw.indexOf("#");
    refs.push({
      raw,
      protocol,
      start,
      end: start + raw.length,
      path: hash < 0 ? raw.slice(prefixLength) : raw.slice(prefixLength, hash),
      fragment: hash < 0 ? undefined : raw.slice(hash + 1),
    });
  }
  return refs;
}

/**
 * Drops a trailing `-->`, `*` + `/` or `. , ; : ! ?` until none is left, so that a ref can end a
 * comment or a sentence. The pattern stops before `>`, so `-->` shows up as `--` followed by `>`.
 */
function trimRef(text: string, start: number, matched: string, prefixLength: number): string {
  let ref = matched;
  while (ref.length > prefixLength) {
    const next = text.charAt(start + ref.length);
    let trimmed = ref;
    if (ref.endsWith("--") && next === ">") trimmed = ref.slice(0, -2);
    else if (ref.endsWith("*/")) trimmed = ref.slice(0, -2);
    else if (TRAILING_PUNCTUATION.test(ref)) trimmed = ref.slice(0, -1);
    // A fragment that trims to nothing leaves its `#` behind; drop it too.
    if (trimmed.endsWith("#")) trimmed = trimmed.slice(0, -1);
    if (trimmed.length < prefixLength) trimmed = ref.slice(0, prefixLength);
    if (trimmed === ref) break;
    ref = trimmed;
  }
  return ref;
}

/** Converts offsets to 1-based line and column numbers. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
  }

  get lineCount(): number {
    return this.starts.length;
  }

  /** The 1-based line and column of `offset`. */
  position(offset: number): { line: number; col: number } {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, col: offset - (this.starts[low] ?? 0) + 1 };
  }

  /** The text of 1-based line `line`, without its line break. */
  lineText(line: number): string {
    const start = this.starts[line - 1];
    if (start === undefined) return "";
    const next = this.starts[line];
    const end = next === undefined ? this.text.length : next - 1;
    return this.text.slice(start, end).replace(/\r$/u, "");
  }
}
