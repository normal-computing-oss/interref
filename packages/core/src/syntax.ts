/**
 * Finds `nref:` refs in text. The pattern is the one in the proposal, with two changes: "no letter,
 * digit, `_` or `-` before the ref" uses Unicode classes rather than ASCII `\w`, and `<!--` right
 * before the ref is allowed, so that `<!--nref:./a.md-->` matches as the proposal's example says.
 */

/** One ref as it is written in a source file. */
export interface RefMatch {
  /** The ref after trimming, for example `nref:./a.md#intro`. */
  readonly raw: string;
  /** Offset of the `n` of `nref:` (UTF-16 code units). */
  readonly start: number;
  /** Offset just after the last character of `raw`. */
  readonly end: number;
  /** The path part, still percent-encoded. It can be empty. */
  readonly path: string;
  /** The fragment without `#`, or undefined when the ref has no fragment. */
  readonly fragment: string | undefined;
}

const PREFIX = "nref:";
const REF_PATTERN = /(?:(?<=<!--)|(?<![\p{L}\p{N}_-]))nref:[^\s#"'`<>()[\]{}]*(?:#[^\s"'`<>()[\]{}]+)?/gu;
const TRAILING_PUNCTUATION = /[.,;:!?]$/u;

/** Returns every ref in `text`, in order. */
export function scanRefs(text: string): RefMatch[] {
  if (!text.includes(PREFIX)) return [];
  const refs: RefMatch[] = [];
  for (const match of text.matchAll(REF_PATTERN)) {
    const start = match.index;
    const raw = trimRef(text, start, match[0]);
    const hash = raw.indexOf("#");
    refs.push({
      raw,
      start,
      end: start + raw.length,
      path: hash < 0 ? raw.slice(PREFIX.length) : raw.slice(PREFIX.length, hash),
      fragment: hash < 0 ? undefined : raw.slice(hash + 1),
    });
  }
  return refs;
}

/**
 * Drops a trailing `-->`, `*` + `/` or `. , ; : ! ?` until none is left, so that a ref can end a
 * comment or a sentence. The pattern stops before `>`, so `-->` shows up as `--` followed by `>`.
 */
function trimRef(text: string, start: number, matched: string): string {
  let ref = matched;
  while (ref.length > PREFIX.length) {
    const next = text.charAt(start + ref.length);
    let trimmed = ref;
    if (ref.endsWith("--") && next === ">") trimmed = ref.slice(0, -2);
    else if (ref.endsWith("*/")) trimmed = ref.slice(0, -2);
    else if (TRAILING_PUNCTUATION.test(ref)) trimmed = ref.slice(0, -1);
    // A fragment that trims to nothing leaves its `#` behind; drop it too.
    if (trimmed.endsWith("#")) trimmed = trimmed.slice(0, -1);
    if (trimmed.length < PREFIX.length) trimmed = PREFIX;
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
