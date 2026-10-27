// Compares the comment lexer of @interref/core with the TextMate grammars of Shiki (the grammars
// that VS Code uses). It is a check for development only: Shiki is not in the CLI or the extension.
//
//   pnpm verify-comments                      the files of this repo
//   pnpm verify-comments ~/src/a ~/src/b      the git files of other repos
//   pnpm verify-comments --lang py,rs --show 50
//
// For each file in a language that both know, each character that is not whitespace is a comment
// or not, by our lexer and by Shiki. The script shows the lines where they disagree, and exits 1
// if there are any. A grammar can be wrong too, so read each line before you change the lexer.
// Run `pnpm build` first: the script uses the built core.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { bundledLanguagesInfo, createHighlighter } from "shiki";
import { commentSpans } from "../packages/core/dist/src/comments.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { lang: { type: "string" }, show: { type: "string", default: "20" } },
});
const roots = positionals.length > 0 ? positionals : ["."];
const onlyLangs = values.lang?.split(",");
const show = Number(values.show);
const MAX_BYTES = 1_000_000;

// Shiki language for files whose extension is not a Shiki name or alias. `.json` is JSON with
// comments for us, as in tsconfig.json. `.m` is Objective-C or MATLAB, so it is not compared.
/** @type {Readonly<Record<string, string>>} */
const LANG_BY_EXTENSION = {
  h: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp", cc: "cpp", cxx: "cpp", ino: "cpp", cu: "cpp",
  mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript",
  json: "jsonc", json5: "json5", bash: "shellscript", zsh: "shellscript", ksh: "shellscript",
  pyi: "python", bzl: "python", star: "python", gemspec: "ruby", rake: "ruby", pm: "perl", t: "perl",
  exs: "elixir", hrl: "erlang", mli: "ocaml", fsi: "fsharp", fsx: "fsharp", cljs: "clojure", cljc: "clojure",
  edn: "clojure", el: "emacs-lisp", rkt: "racket", tf: "terraform", tfvars: "terraform", mk: "make",
  ps1: "powershell", psm1: "powershell", vue: "vue", svelte: "svelte", sty: "latex", cls: "latex",
  markdown: "markdown", mdown: "markdown", mkd: "markdown", kts: "kotlin", gradle: "groovy",
};
/** @type {Readonly<Record<string, string>>} */
const LANG_BY_NAME = {
  dockerfile: "docker", containerfile: "docker", makefile: "make", gnumakefile: "make",
  "cmakelists.txt": "cmake", gemfile: "ruby", rakefile: "ruby", podfile: "ruby", vagrantfile: "ruby",
  jenkinsfile: "groovy", build: "python", workspace: "python", ".bashrc": "shellscript", ".zshrc": "shellscript",
  ".gitignore": "ignore", ".dockerignore": "ignore",
};

// How a Shiki scope stack maps to "comment" in our sense:
// - A Python docstring is a comment for us. Shiki marks it as a string.
// - A comment in a Markdown code block or code span is an example, not a comment of the file.
// - A comment in a string is text, for example `# x` in a Python verbose regex. A `${...}` in a
//   template literal (and other embedded code) is code again, so a comment there counts.
// - In a prose file, only a comment of the prose language counts (HTML in Markdown, `..` in
//   reStructuredText), not a comment of the code in a `.. code-block::`.
const COMMENT = /^comment\b|^string\.quoted\.docstring\b/u;
const CODE_BLOCK = /^markup\.(?:fenced_code|inline\.raw|raw|code)\b/u;
const STRING = /^string\b/u;
const EMBEDDED_CODE = /^(?:meta\.embedded|meta\.template\.expression|meta\.interpolation|source)\b/u;
const PROSE = new Set(["markdown", "mdx", "rst", "asciidoc", "org"]);
const PROSE_COMMENT = /\.(?:html|markdown|mdx|yaml|rst|asciidoc|org|block|line|inline)$/u;

/** @type {(scopes: readonly string[], lang: string) => boolean} */
function isComment(scopes, lang) {
  const prose = PROSE.has(lang);
  let inString = false;
  for (const scope of scopes) {
    if (lang === "astro" && scope === "comment") return false;
    if (CODE_BLOCK.test(scope)) return false;
    if (COMMENT.test(scope)) return !inString && (!prose || PROSE_COMMENT.test(scope));
    if (EMBEDDED_CODE.test(scope)) inString = false;
    else if (STRING.test(scope)) inString = true;
  }
  return false;
}

// Places where a grammar is incomplete, so that it disagrees with us on correct code:
// - R: in a roxygen comment (`#' @param x`, `#' @examples` code), parts have no comment scope.
// - Makefile: a recipe line is shell, so `# x` there is a shell comment; the grammar has no scope.
// - Astro: the `---` lines around the front matter have the scope `comment`.
// - MDX and Astro: the grammars do not know `{/* ... */}` comments in the markup.
/** @type {Readonly<Record<string, (line: string, scopes: readonly string[]) => boolean>>} */
const REST_OF_LINE_IS_COMMENT = {
  r: (line) => /^[ \t]*#'/u.test(line),
  make: (line, scopes) => scopes.includes("meta.scope.recipe.makefile") && /^\t[ \t]*#/u.test(line),
};

const highlighter = await createHighlighter({ langs: [], themes: [] });

/** @type {(path: string) => string | undefined} */
function shikiLang(path) {
  const name = basename(path).toLowerCase();
  const extension = extname(name).slice(1);
  if (extension === "m") return undefined;
  const candidates = [LANG_BY_NAME[name], LANG_BY_EXTENSION[extension], extension];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === "") continue;
    const info = bundledLanguagesInfo.find((lang) => lang.id === candidate || lang.aliases?.includes(candidate));
    if (info !== undefined) return info.id;
  }
  return undefined;
}

/** Marks each character that Shiki puts in a comment. @type {(text: string, lang: string) => Uint8Array} */
function shikiComments(text, lang) {
  const marks = new Uint8Array(text.length);
  const grammar = highlighter.getLanguage(lang);
  /** @type {Parameters<typeof grammar.tokenizeLine>[1]} */
  let state = null;
  let offset = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    const quirk = REST_OF_LINE_IS_COMMENT[lang];
    for (const token of result.tokens) {
      if (quirk?.(line, token.scopes) === true) {
        marks.fill(1, offset + token.startIndex, offset + line.length);
        break;
      }
      if (!isComment(token.scopes, lang)) continue;
      marks.fill(1, offset + token.startIndex, offset + Math.min(token.endIndex, line.length));
    }
    offset += rawLine.length + 1;
  }
  if (lang === "mdx" || lang === "astro") {
    for (const match of text.matchAll(/\{\/\*[\s\S]*?\*\/\}/gu)) marks.fill(1, match.index, match.index + match[0].length);
  }
  return marks;
}

/** @type {Map<string, { files: number; comments: number; regions: number }>} */
const totals = new Map();
/** @type {string[]} */
const examples = [];

/** @type {(text: string, offset: number) => number} */
const lineAt = (text, offset) => text.slice(0, offset).split("\n").length;

for (const root of roots) {
  const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const files = execFileSync("git", ["-C", root, "ls-files", "-z", "."], { encoding: "utf8", maxBuffer: 1 << 30 })
    .split("\0")
    .filter((file) => file !== "");
  const prefix = execFileSync("git", ["-C", root, "rev-parse", "--show-prefix"], { encoding: "utf8" }).trim();
  for (const file of files) {
    const path = prefix + file;
    const lang = shikiLang(path);
    if (lang === undefined || (onlyLangs !== undefined && !onlyLangs.includes(lang))) continue;
    let text;
    try {
      text = readFileSync(join(top, path), "utf8");
    } catch {
      continue;
    }
    if (text.length > MAX_BYTES || text.includes("\0")) continue;
    const ours = commentSpans(path, text);
    if (ours === undefined) continue;
    if (!highlighter.getLoadedLanguages().includes(lang)) await highlighter.loadLanguage(/** @type {never} */ (lang));
    const theirs = shikiComments(text, lang);
    const mine = new Uint8Array(text.length);
    for (const span of ours) mine.fill(1, span.start, span.end);

    const total = totals.get(lang) ?? { files: 0, comments: 0, regions: 0 };
    totals.set(lang, total);
    total.files++;
    total.comments += ours.length;
    // A `#!` line is a comment in Shiki for every language, and in ours only where `#` is one.
    const start = text.startsWith("#!") ? text.indexOf("\n") + 1 || text.length : 0;
    // A region is a run of characters that disagree, with only whitespace between them.
    /** @type {number | undefined} */
    let regionStart;
    let regionEnd = 0;
    const endRegion = () => {
      if (regionStart === undefined) return;
      total.regions++;
      if (examples.length < show) {
        const first = lineAt(text, regionStart);
        const last = lineAt(text, regionEnd);
        const lineEnd = text.indexOf("\n", regionStart);
        const firstLine = text.slice(text.lastIndexOf("\n", regionStart - 1) + 1, lineEnd < 0 ? text.length : lineEnd);
        const who = mine[regionStart] === 1 ? "only ours " : "only Shiki";
        const lines = first === last ? `${first}` : `${first}-${last}`;
        examples.push(`${resolve(top, path)}:${lines}  ${who}  ${firstLine.trim().slice(0, 100)}`);
      }
      regionStart = undefined;
    };
    for (let i = start; i < text.length; i++) {
      if (/\s/u.test(text.charAt(i))) continue;
      if (mine[i] === theirs[i]) endRegion();
      else {
        if (regionStart !== undefined && mine[i] !== mine[regionStart]) endRegion();
        regionStart ??= i;
        regionEnd = i;
      }
    }
    endRegion();
  }
}

let disagreements = 0;
console.log("language          files  comments  disagree");
for (const [lang, total] of [...totals].sort(([a], [b]) => a.localeCompare(b))) {
  disagreements += total.regions;
  const counts = [total.files, total.comments, total.regions].map((count, i) => String(count).padStart(i === 0 ? 5 : 9));
  console.log(`${lang.padEnd(16)} ${counts.join(" ")}`);
}
if (examples.length > 0) console.log(`\n${examples.join("\n")}`);
if (disagreements > examples.length) console.log(`... and ${disagreements - examples.length} more (--show N)`);
process.exit(disagreements > 0 ? 1 : 0);
