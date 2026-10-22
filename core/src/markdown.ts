/**
 * Markdown headings and their GitHub slugs. This is a line scanner, not a full CommonMark parser:
 * it knows ATX and setext headings, front matter, fenced code and multi-line HTML comments, which
 * covers the places where a `#` line is not a heading.
 */

export interface Heading {
  /** 1 to 6. */
  readonly level: number;
  /** The heading as rendered text, without Markdown markup. */
  readonly text: string;
  /** The GitHub anchor, unique in the file. */
  readonly slug: string;
  /** 1-based line of the heading (the text line, for a setext heading). */
  readonly line: number;
}

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd"];

export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// github-slugger keeps letters, marks, numbers, connector punctuation, spaces and hyphens.
const SLUG_DROP = /[^\p{L}\p{M}\p{N}\p{Pc} -]/gu;

/** The GitHub slug of rendered heading text, before de-duplication. */
export function slugify(text: string): string {
  return text.toLowerCase().replace(SLUG_DROP, "").replace(/ /gu, "-");
}

/** Gives each heading in a file a unique slug, the same way GitHub does (`a`, `a-1`, `a-2`). */
export class Slugger {
  private readonly occurrences = new Map<string, number>();

  slug(text: string): string {
    const base = slugify(text);
    let slug = base;
    while (this.occurrences.has(slug)) {
      const count = (this.occurrences.get(base) ?? 0) + 1;
      this.occurrences.set(base, count);
      slug = `${base}-${count}`;
    }
    this.occurrences.set(slug, 0);
    return slug;
  }
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Removes inline Markdown from heading source, leaving the text that GitHub renders. */
export function renderHeadingText(source: string): string {
  let text = source
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/gu, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/gu, "");
  // Code spans and backslash escapes are literal; strip emphasis only outside them.
  let out = "";
  let plain = "";
  const flush = (): void => {
    out += plain.replace(/\*+|~~/gu, "").replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "");
    plain = "";
  };
  for (let i = 0; i < text.length; ) {
    const ch = text.charAt(i);
    if (ch === "\\" && /[!-/:-@[-`{-~]/u.test(text.charAt(i + 1))) {
      flush();
      out += text.charAt(i + 1);
      i += 2;
      continue;
    }
    if (ch === "`") {
      const fence = /^`+/u.exec(text.slice(i))?.[0] ?? "`";
      const close = text.indexOf(fence, i + fence.length);
      if (close >= 0) {
        flush();
        out += text.slice(i + fence.length, close).trim();
        i = close + fence.length;
        continue;
      }
    }
    plain += ch;
    i++;
  }
  flush();
  text = out.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, name: string) => {
    if (!name.startsWith("#")) return ENTITIES[name.toLowerCase()] ?? whole;
    const hex = name.charAt(1) === "x" || name.charAt(1) === "X";
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
  return text.trim();
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/u;
const ATX_CLOSING = /(?:^|[ \t]+)#+$/u;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/u;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
// Lines that start a block other than a paragraph, so a setext underline after them is not one.
const NOT_PARAGRAPH = /^ {0,3}(?:[>#|]|[-*+][ \t]|\d{1,9}[.)][ \t]|<)|^(?: {4}|\t)/u;

/** Returns the headings of a Markdown file with their slugs. */
export function extractHeadings(markdown: string): Heading[] {
  const lines = markdown.split(/\r?\n/u);
  const headings: Heading[] = [];
  const slugger = new Slugger();
  const add = (level: number, source: string, line: number): void => {
    const text = renderHeadingText(source);
    headings.push({ level, text, slug: slugger.slug(text), line });
  };

  let i = 0;
  if (lines[0] === "---") {
    const end = lines.findIndex((line, n) => n > 0 && (line === "---" || line === "..."));
    if (end > 0) i = end + 1;
  }

  let paragraph: { start: number; lines: string[] } | undefined;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const fence = FENCE_OPEN.exec(line);
    if (fence?.[1] !== undefined && !(fence[1].startsWith("`") && (fence[2] ?? "").includes("`"))) {
      const marker = fence[1];
      const close = new RegExp(`^ {0,3}${marker.charAt(0)}{${marker.length},}[ \\t]*$`, "u");
      while (i + 1 < lines.length && !close.test(lines[i + 1] ?? "")) i++;
      i++;
      paragraph = undefined;
      continue;
    }

    if (/^ {0,3}<!--/u.test(line) && !line.includes("-->")) {
      while (i + 1 < lines.length && !(lines[i + 1] ?? "").includes("-->")) i++;
      i++;
      paragraph = undefined;
      continue;
    }

    const atx = ATX.exec(line);
    if (atx?.[1] !== undefined) {
      add(atx[1].length, (atx[2] ?? "").replace(ATX_CLOSING, ""), i + 1);
      paragraph = undefined;
      continue;
    }

    const setext = SETEXT.exec(line);
    if (setext?.[1] !== undefined) {
      // With no paragraph above, this is a thematic break, not an underline.
      if (paragraph !== undefined) {
        add(setext[1].startsWith("=") ? 1 : 2, paragraph.lines.join("\n"), paragraph.start);
      }
      paragraph = undefined;
      continue;
    }

    if (line.trim() === "") paragraph = undefined;
    else if (paragraph !== undefined) paragraph.lines.push(line.trim());
    else if (!NOT_PARAGRAPH.test(line)) paragraph = { start: i + 1, lines: [line.trim()] };
  }
  return headings;
}
