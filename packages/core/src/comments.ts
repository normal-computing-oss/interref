/**
 * Finds the comments in source text, so that only a ref in a comment counts. A ref in a string, in
 * code or in Markdown text is an example, not a link.
 *
 * Each language is a list of token rules: comments, strings and other spans in which a comment
 * marker does not start a comment. The lexer is not a parser. It knows enough of each language to
 * tell a comment from a string, which is the only question that it has to answer. The language comes
 * from the file name, or from the `#!` line of a file that has no known extension. A file of an
 * unknown language has no comments, so it has no refs.
 */

import { posix } from "node:path";
import { DEFAULT_PROTOCOLS, scanRefs, type RefMatch } from "./syntax.js";

/** Offsets of one comment, its markers included (UTF-16 code units). */
export interface Span {
  readonly start: number;
  readonly end: number;
}

type Close = string | RegExp;

interface RuleSpec {
  /** Regular expression source that matches where the token starts. */
  readonly open: string;
  /** How the token ends. Without it, the open match is the whole token. */
  readonly close?: Close | ((open: RegExpExecArray, text: string) => Close);
  readonly comment?: true;
  /** A character that makes the next character literal, for example `\` in a C string. */
  readonly escape?: string;
  /** The token ends at a line break even when it has no close. */
  readonly singleLine?: true;
  /** Without a close, the open is not a token, for example an unmatched backtick in Markdown. */
  readonly needsClose?: true;
  /**
   * In the token, these open code that runs to the matching bracket, for example `${` in a
   * JavaScript template or `$(` in a shell string. Each is two characters, and the second is `{` or `(`.
   */
  readonly interpolations?: readonly string[];
  /** The open can occur again in the token, and each one needs its own close. */
  readonly nested?: true;
  /** A Python string that is a statement of its own (a docstring) is a comment. */
  readonly docstring?: true;
  /** The text between open and close is in another language, for example `<script>` in HTML. */
  readonly embed?: (open: RegExpExecArray) => Language;
}

interface Rule extends RuleSpec {
  readonly start: RegExp;
}

interface Language {
  readonly rules: readonly Rule[];
  /** Finds the next place where any rule can start. */
  readonly finder: RegExp;
  /** Some rule has `docstring`, so the lexer counts open brackets. */
  readonly docstrings: boolean;
}

function language(...specs: readonly (RuleSpec | readonly RuleSpec[])[]): Language {
  const flat = specs.flat();
  return {
    rules: flat.map((spec) => ({ ...spec, start: new RegExp(spec.open, "muy") })),
    finder: new RegExp(flat.map((spec) => `(?:${spec.open})`).join("|"), "mug"),
    docstrings: flat.some((spec) => spec.docstring === true),
  };
}

const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");

/** A regular expression source that matches `word` in any case. */
const anyCase = (word: string): string =>
  word.replace(/[a-z]/giu, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);

/** Repeats a captured run, for closes such as `]==]` after `[==[`. */
const same = (prefix: string, group: number, suffix = ""): ((open: RegExpExecArray) => string) =>
  (open) => `${prefix}${open[group] ?? ""}${suffix}`;

/** The first defined capture group: a name that can be bare or quoted. */
const captured = (open: RegExpExecArray): string => open.slice(1).find((group) => group !== undefined) ?? "";

/** A heredoc body: from the open to a line that holds only the name. */
const heredocEnd = (open: RegExpExecArray): RegExp => new RegExp(`\\n[ \\t]*${escapeRegExp(captured(open))}(?=\\r?\\n|$)`, "gu");

const lineRegExp = (source: string): RegExp => new RegExp(source, "gmu");

// Pieces that many languages share.
const SLASH_LINE: RuleSpec = { open: "//.*", comment: true };
const C_BLOCK: RuleSpec = { open: String.raw`/\*`, close: "*/", comment: true };
const C_BLOCK_NESTED: RuleSpec = { ...C_BLOCK, nested: true };
const HASH_LINE: RuleSpec = { open: "#.*", comment: true };
/** `#` at the start of a word, as in a shell or YAML: `a#b` and `${#x}` are not comments. */
const WORD_HASH_LINE: RuleSpec = { open: String.raw`(?<![^\s;&|()])#.*`, comment: true };
const LINE_START_HASH: RuleSpec = { open: String.raw`^[ \t]*#.*`, comment: true };
const DASH_LINE: RuleSpec = { open: "--.*", comment: true };
const SEMICOLON_LINE: RuleSpec = { open: ";.*", comment: true };
const PERCENT_LINE: RuleSpec = { open: "%.*", comment: true };
const BACKSLASH: RuleSpec = { open: String.raw`\\[\s\S]` };

interface QuoteOptions {
  readonly escape?: string;
  readonly singleLine?: true;
  readonly open?: string;
  readonly interpolations?: readonly string[];
}
const quoted = (quote: string, options: QuoteOptions = {}): RuleSpec => ({
  open: options.open ?? escapeRegExp(quote),
  close: quote,
  ...(options.escape === undefined ? {} : { escape: options.escape }),
  ...(options.singleLine === undefined ? {} : { singleLine: options.singleLine }),
  ...(options.interpolations === undefined ? {} : { interpolations: options.interpolations }),
});
const DQ = quoted('"', { escape: "\\", singleLine: true });
const SQ = quoted("'", { escape: "\\", singleLine: true });
const DQ_MULTI = quoted('"', { escape: "\\" });
const DQ_DOLLAR = quoted('"', { escape: "\\", singleLine: true, interpolations: ["${"] });
const SQ_MULTI = quoted("'", { escape: "\\" });
const DQ_PLAIN = quoted('"', { singleLine: true });
const SQ_PLAIN = quoted("'", { singleLine: true });
const DQ3 = quoted('"""', { escape: "\\" });
const SQ3 = quoted("'''", { escape: "\\" });
const DQ3_RAW = quoted('"""');
const SQ3_RAW = quoted("'''");
const BACKTICK_RAW = quoted("`");
/** A character literal such as `'a'`, `'\n'` or `b'"'`. A lone `'` (a Rust lifetime, `x'` in Haskell) is not one. */
const CHAR: RuleSpec = {
  open: String.raw`(?:(?<![\p{L}\p{N}_])(?:u8|[bBuUL])|(?<![\p{L}\p{N}_']))'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)|[^\\'\n])'`,
};

const C_FAMILY = [SLASH_LINE, C_BLOCK, DQ, CHAR];
const C = language(
  SLASH_LINE,
  C_BLOCK,
  { open: String.raw`(?:u8|[uUL])?R"([^()\\\s]{0,16})\(`, close: same(")", 1, '"') },
  DQ,
  CHAR,
);
const CSHARP = language(
  SLASH_LINE,
  C_BLOCK,
  { open: String.raw`\$*("{3,})`, close: (open) => open[1] ?? '"""' },
  quoted('"', { open: String.raw`(?:\$@|@\$?)"` }),
  DQ,
  CHAR,
);
const JAVA = language(SLASH_LINE, C_BLOCK, DQ3, DQ, CHAR);
const KOTLIN = language(SLASH_LINE, C_BLOCK_NESTED, DQ3_RAW, DQ_DOLLAR, CHAR);
const GROOVY = language(SLASH_LINE, C_BLOCK, DQ3, SQ3, DQ_DOLLAR, SQ);
const GO = language(SLASH_LINE, C_BLOCK, DQ, BACKTICK_RAW, CHAR);
const RUST = language(
  SLASH_LINE,
  C_BLOCK_NESTED,
  { open: String.raw`(?<![\p{L}\p{N}_])[bc]?r(#*)"`, close: same('"', 1) },
  DQ_MULTI,
  CHAR,
);
const SWIFT = language(
  SLASH_LINE,
  C_BLOCK_NESTED,
  { open: '(#+)"""', close: same('"""', 1) },
  { open: '(#+)"', close: same('"', 1) },
  DQ3,
  DQ,
);
const DART = language(
  SLASH_LINE,
  C_BLOCK_NESTED,
  quoted('"""', { open: 'r"""' }),
  quoted("'''", { open: "r'''" }),
  DQ3,
  SQ3,
  quoted('"', { open: 'r"', singleLine: true }),
  quoted("'", { open: "r'", singleLine: true }),
  DQ_DOLLAR,
  quoted("'", { escape: "\\", singleLine: true, interpolations: ["${"] }),
);
const ZIG = language(SLASH_LINE, { open: String.raw`\\\\.*` }, DQ, CHAR);
const C_LIKE = language(C_FAMILY);
const PROTOBUF = language(SLASH_LINE, C_BLOCK, DQ, SQ);
const PRISMA = language(SLASH_LINE, DQ);

/** A JavaScript regex literal, guessed from the token before it, so that `/"/` is not a string. */
const JS_REGEX: RuleSpec = {
  open: String.raw`(?<=(?:^|[(,=:[!&|?{;]|\b(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new))[ \t]*)/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+/[A-Za-z]*`,
};
/** In JavaScript, `//` after `:` is a URL in JSX text, not a comment. */
const JAVASCRIPT = language({ open: "(?<!:)//.*", comment: true }, C_BLOCK, DQ, SQ, quoted("`", { escape: "\\", interpolations: ["${"] }), JS_REGEX);
const JSONC = language(SLASH_LINE, C_BLOCK, DQ, SQ);
const CSS = language(C_BLOCK, DQ, SQ);
const SCSS = language({ open: String.raw`url\((?![ \t]*["'])[^)\n]*\)` }, SLASH_LINE, C_BLOCK, DQ, SQ);

const PY_PREFIX = String.raw`(?:(?<![\p{L}\p{N}_])[rRuUbBfFtT]{1,2})?`;
const PYTHON = language(
  HASH_LINE,
  { ...quoted('"""', { escape: "\\", open: `${PY_PREFIX}"""` }), docstring: true },
  { ...quoted("'''", { escape: "\\", open: `${PY_PREFIX}'''` }), docstring: true },
  { ...quoted('"', { escape: "\\", singleLine: true, open: `${PY_PREFIX}"` }), docstring: true },
  { ...quoted("'", { escape: "\\", singleLine: true, open: `${PY_PREFIX}'` }), docstring: true },
);

const HEREDOC_NAME = String.raw`(?:'([A-Za-z_][\w-]*)'|"([A-Za-z_][\w-]*)"|\\?([A-Za-z_][\w-]*))`;
const SHELL = language(
  BACKSLASH,
  WORD_HASH_LINE,
  { open: String.raw`(?<!<)<<-?[ \t]*${HEREDOC_NAME}`, close: heredocEnd, needsClose: true },
  quoted('"', { escape: "\\", interpolations: ["$(", "${"] }),
  quoted("'"),
);
const POWERSHELL = language(
  { open: "<#", close: "#>", comment: true },
  HASH_LINE,
  { open: '@"', close: lineRegExp('^"@') },
  { open: "@'", close: lineRegExp("^'@") },
  quoted('"', { escape: "`" }),
  quoted("'"),
);
const BATCH = language({ open: String.raw`^[ \t@]*(?:${anyCase("rem")}(?=[ \t]|$)|::).*`, comment: true });
const RUBY = language(
  HASH_LINE,
  { open: "^=begin\\b", close: lineRegExp("^=end\\b.*"), comment: true },
  { open: String.raw`<<[~-]${HEREDOC_NAME}|<<(?:'(\w+)'|"(\w+)"|([A-Z_][A-Z0-9_]*)\b)`, close: heredocEnd, needsClose: true },
  quoted('"', { escape: "\\", interpolations: ["#{"] }),
  SQ_MULTI,
);
const PERL = language(
  { open: String.raw`(?<!\$)#.*`, comment: true },
  { open: "^=[a-zA-Z]\\w*", close: lineRegExp("^=cut\\b.*"), comment: true },
  { open: String.raw`<<~?(?:'(\w+)'|"(\w+)"|([A-Za-z_]\w*))`, close: heredocEnd, needsClose: true },
  DQ_MULTI,
  SQ_MULTI,
);
const PHP = language(
  SLASH_LINE,
  { open: String.raw`#(?!\[).*`, comment: true },
  C_BLOCK,
  { open: String.raw`<<<[ \t]*${HEREDOC_NAME}`, close: heredocEnd, needsClose: true },
  DQ_MULTI,
  SQ_MULTI,
);
const LUA = language(
  { open: String.raw`--\[(=*)\[`, close: same("]", 1, "]"), comment: true },
  DASH_LINE,
  { open: String.raw`\[(=*)\[`, close: same("]", 1, "]") },
  DQ,
  SQ,
);
const SQL = language(
  DASH_LINE,
  C_BLOCK,
  quoted("'"),
  quoted('"'),
  quoted("`"),
  { open: String.raw`\$(?:[A-Za-z_]\w*)?\$`, close: (open) => open[0], needsClose: true },
);
const HASKELL = language(
  { open: String.raw`--+(?![!#$%&*+./<=>?@\\^|~:]).*`, comment: true },
  { open: String.raw`\{-`, close: "-}", comment: true, nested: true },
  DQ,
  CHAR,
);
const LEAN = language(DASH_LINE, { open: "/-", close: "-/", comment: true, nested: true }, DQ, CHAR);
const OCAML = language({ open: String.raw`\(\*(?!\))`, close: "*)", comment: true, nested: true }, DQ_MULTI, CHAR);
const FSHARP = language(
  SLASH_LINE,
  { open: String.raw`\(\*(?!\))`, close: "*)", comment: true, nested: true },
  DQ3_RAW,
  quoted('"', { open: '@"' }),
  DQ_MULTI,
  CHAR,
);
const PASCAL = language(
  SLASH_LINE,
  { open: String.raw`\{`, close: "}", comment: true },
  { open: String.raw`\(\*`, close: "*)", comment: true },
  quoted("'", { singleLine: true }),
);
const LISP = language(BACKSLASH, SEMICOLON_LINE, { open: String.raw`#\|`, close: "|#", comment: true, nested: true }, DQ_MULTI);
const ERLANG = language({ open: String.raw`\$\\?[\s\S]` }, PERCENT_LINE, DQ_MULTI, SQ);
const ELIXIR = language({ open: String.raw`(?<![\p{L}\p{N}_])\?\\?.` }, HASH_LINE, DQ3, SQ3, DQ_MULTI, SQ_MULTI);
const R = language(HASH_LINE, DQ_MULTI, SQ_MULTI, BACKTICK_RAW);
const JULIA = language({ open: "#=", close: "=#", comment: true, nested: true }, HASH_LINE, DQ3, DQ_MULTI, CHAR);
const NIM = language({ open: String.raw`#\[`, close: "]#", comment: true, nested: true }, HASH_LINE, DQ3_RAW, DQ, CHAR);
const HASH_STRINGS = language(HASH_LINE, DQ, SQ);
const TCL = language({ open: String.raw`(?<=(?:^|;)[ \t]*)#.*`, comment: true }, DQ_MULTI);
const FORTRAN = language({ open: "!.*", comment: true }, DQ_PLAIN, SQ_PLAIN);
const MATLAB = language(
  { open: String.raw`^[ \t]*%\{[ \t]*$`, close: lineRegExp(String.raw`^[ \t]*%\}[ \t]*$`), comment: true },
  PERCENT_LINE,
  DQ_PLAIN,
  quoted("'", { singleLine: true, open: String.raw`(?<![\p{L}\p{N}_)\]}.'])'` }),
);
const VB = language(
  { open: "'.*", comment: true },
  { open: String.raw`(?<![^\s:])${anyCase("rem")}(?=[ \t]|$).*`, comment: true },
  DQ_PLAIN,
);
const VHDL = language(DASH_LINE, C_BLOCK, DQ_PLAIN, CHAR);
const ASSEMBLY = language(SEMICOLON_LINE, DQ, SQ);
const TEX = language(
  BACKSLASH,
  { open: String.raw`\\begin\{comment\}`, close: String.raw`\end{comment}`, comment: true },
  PERCENT_LINE,
);

const YAML_BLOCK_SCALAR: RuleSpec = {
  open: String.raw`(?<=(?:^|[:?-])[ \t]*)[|>][-+1-9]{0,2}(?=[ \t]*(?:#.*)?$)`,
  // The scalar ends at the first line that is not more indented than its key, or than its `-` when
  // the scalar is a list item (`- |`).
  close: (open, text) => {
    const lineStart = text.lastIndexOf("\n", open.index - 1) + 1;
    const before = text.slice(lineStart, open.index);
    const indent = /^[ \t]*(?:-[ \t]+)+$/u.test(before)
      ? before.lastIndexOf("-")
      : (/^[ \t]*(?:-[ \t]+)*/u.exec(before)?.[0].length ?? 0);
    return new RegExp(`\\n(?=[ ]{0,${indent}}[^ \\r\\n])`, "gu");
  },
};
/** A quote starts a YAML string only at the start of a value: the `'` in `name: It's` is text. */
const YAML_VALUE_START = String.raw`(?<=(?:^|[[{,]|[:?-][ \t])[ \t]*)`;
const YAML = language(
  { open: String.raw`(?<![^\s])#.*`, comment: true },
  YAML_BLOCK_SCALAR,
  quoted('"', { escape: "\\", open: `${YAML_VALUE_START}"` }),
  quoted("'", { open: `${YAML_VALUE_START}'` }),
);
const TOML = language(HASH_LINE, DQ3, SQ3_RAW, DQ, SQ_PLAIN);
const INI = language({ open: String.raw`^[ \t]*[#;].*`, comment: true });
const PROPERTIES = language({ open: String.raw`^[ \t]*[#!].*`, comment: true });
const CONF = language(WORD_HASH_LINE, { open: String.raw`^[ \t]*;.*`, comment: true });
const LINE_HASH = language(LINE_START_HASH);
const WORD_HASH = language(WORD_HASH_LINE);
/** A recipe line (it starts with a tab) is a shell command: `@echo "# x"` has a string, not a comment. */
const MAKE = language({ open: "^\t", close: /(?<!\\)(?=\n)/gu, embed: () => SHELL }, BACKSLASH, HASH_LINE);
const CMAKE = language(
  { open: String.raw`#\[(=*)\[`, close: same("]", 1, "]"), comment: true },
  HASH_LINE,
  { open: String.raw`\[(=*)\[`, close: same("]", 1, "]") },
  DQ_MULTI,
);
const HCL = language(
  HASH_LINE,
  SLASH_LINE,
  C_BLOCK,
  { open: String.raw`<<-?([A-Za-z_]\w*)`, close: heredocEnd, needsClose: true },
  DQ,
);
const NIX = language(HASH_LINE, C_BLOCK, { open: "''", close: "''" }, DQ_MULTI);
const JSONNET = language(HASH_LINE, SLASH_LINE, C_BLOCK, { open: String.raw`\|\|\|`, close: "|||" }, DQ, SQ);
/** A `"""` description documents the schema, as a docstring does, so it is a comment. */
const GRAPHQL = language(HASH_LINE, { ...DQ3, comment: true }, DQ);
const THRIFT = language(HASH_LINE, SLASH_LINE, C_BLOCK, DQ, SQ);
const VIM = language({ open: String.raw`^[ \t:]*".*`, comment: true });

const HTML_COMMENT: RuleSpec = { open: "<!--", close: "-->", comment: true };
const CDATA: RuleSpec = { open: String.raw`<!\[CDATA\[`, close: "]]>" };
const styleLanguage = (open: RegExpExecArray): Language => (/\blang=["']?s[ac]ss/iu.test(open[0]) ? SCSS : CSS);
const HTML_RULES: readonly RuleSpec[] = [
  HTML_COMMENT,
  CDATA,
  {
    open: String.raw`<${anyCase("script")}\b[^>]*>`,
    close: new RegExp(String.raw`</script\s*>`, "giu"),
    embed: () => JAVASCRIPT,
  },
  { open: String.raw`<${anyCase("style")}\b[^>]*>`, close: new RegExp(String.raw`</style\s*>`, "giu"), embed: styleLanguage },
];
const HTML = language(HTML_RULES);
const ASTRO = language(
  { open: String.raw`(?<![\s\S])---[ \t]*$`, close: lineRegExp(String.raw`^---[ \t]*$`), embed: () => JAVASCRIPT },
  { open: String.raw`\{/\*`, close: "*/}", comment: true },
  HTML_RULES,
);
const HANDLEBARS = language(
  { open: String.raw`\{\{!--`, close: "--}}", comment: true },
  { open: String.raw`\{\{!`, close: "}}", comment: true },
  HTML_RULES,
);
const JINJA = language(
  { open: String.raw`\{#`, close: "#}", comment: true },
  {
    open: String.raw`\{%-?[ \t]*comment[ \t]*-?%\}`,
    close: new RegExp(String.raw`\{%-?[ \t]*endcomment[ \t]*-?%\}`, "gu"),
    comment: true,
  },
  HTML_RULES,
);
const ERB = language({ open: "<%#", close: "%>", comment: true }, HTML_RULES);

const MARKDOWN_RULES: readonly RuleSpec[] = [
  { open: String.raw`(?<![\s\S])---[ \t]*$`, close: lineRegExp(String.raw`^(?:---|\.\.\.)[ \t]*$`), embed: () => YAML },
  BACKSLASH,
  // Fenced code, to the closing fence or to the end of the file.
  {
    open: "^ {0,3}(`{3,}|~{3,})",
    close: (open) => {
      const fence = open[1] ?? "```";
      return lineRegExp(`^ {0,3}${escapeRegExp(fence.charAt(0))}{${fence.length},}[ \\t]*$`);
    },
  },
  HTML_COMMENT,
  // A code span; a backtick run without a matching run is text.
  { open: "`+", close: (open) => open[0], needsClose: true },
];
const MARKDOWN = language(MARKDOWN_RULES);
const MDX = language(MARKDOWN_RULES, { open: String.raw`\{/\*`, close: "*/}", comment: true });
const RESTRUCTURED_TEXT = language({
  open: String.raw`^\.\.(?=[ \t]|$)(?![ \t]+(?:[^\s:]+::|_|\[|\|)).*(?:\n[ \t]+\S.*)*`,
  comment: true,
});
const ASCIIDOC = language(
  { open: String.raw`^/{4,}[ \t]*$`, close: lineRegExp(String.raw`^/{4,}[ \t]*$`), comment: true },
  { open: String.raw`^(?:-{4,}|\.{4,})[ \t]*$`, close: (open) => lineRegExp(`^${escapeRegExp(open[0].trim())}[ \\t]*$`) },
  { open: "^//.*", comment: true },
);
const ORG = language(
  {
    open: `^[ \\t]*#\\+${anyCase("begin_comment")}`,
    close: new RegExp(`^[ \\t]*#\\+${anyCase("end_comment")}.*`, "gmu"),
    comment: true,
  },
  { open: `^[ \\t]*#\\+${anyCase("begin_")}\\w+`, close: new RegExp(`^[ \\t]*#\\+${anyCase("end_")}\\w+.*`, "gmu") },
  { open: String.raw`^[ \t]*#(?=[ \t]|$).*`, comment: true },
);

const OBJECTIVE_C_HINT = /^[ \t]*(?:#import|#include|@interface|@implementation|@protocol)\b/mu;

const EXTENSIONS: Readonly<Record<string, Language>> = {
  // C family
  ".c": C, ".h": C, ".cc": C, ".cpp": C, ".cxx": C, ".c++": C, ".hh": C, ".hpp": C, ".hxx": C, ".h++": C,
  ".ipp": C, ".inl": C, ".tpp": C, ".ino": C, ".cu": C, ".cuh": C, ".mm": C, ".metal": C,
  ".glsl": C, ".vert": C, ".frag": C, ".geom": C, ".comp": C, ".hlsl": C, ".wgsl": C_LIKE,
  ".cs": CSHARP, ".csx": CSHARP,
  ".java": JAVA,
  ".kt": KOTLIN, ".kts": KOTLIN, ".scala": KOTLIN, ".sc": KOTLIN,
  ".groovy": GROOVY, ".gradle": GROOVY, ".gvy": GROOVY,
  ".go": GO,
  ".rs": RUST,
  ".swift": SWIFT,
  ".dart": DART,
  ".zig": ZIG,
  ".sol": C_LIKE, ".v": C_LIKE, ".sv": C_LIKE, ".svh": C_LIKE, ".vh": C_LIKE, ".cue": C_LIKE, ".move": C_LIKE,
  ".d": C_LIKE, ".hx": C_LIKE, ".as": C_LIKE, ".cairo": C_LIKE, ".typ": C_LIKE,
  ".proto": PROTOBUF, ".prisma": PRISMA,
  // Web
  ".js": JAVASCRIPT, ".mjs": JAVASCRIPT, ".cjs": JAVASCRIPT, ".jsx": JAVASCRIPT,
  ".ts": JAVASCRIPT, ".mts": JAVASCRIPT, ".cts": JAVASCRIPT, ".tsx": JAVASCRIPT,
  ".json": JSONC, ".jsonc": JSONC, ".json5": JSONC,
  ".css": CSS, ".scss": SCSS, ".sass": SCSS, ".less": SCSS, ".styl": SCSS,
  ".html": HTML, ".htm": HTML, ".xhtml": HTML, ".vue": HTML, ".svelte": HTML, ".astro": ASTRO,
  ".xml": HTML, ".svg": HTML, ".xsl": HTML, ".xslt": HTML, ".xsd": HTML, ".plist": HTML, ".csproj": HTML,
  ".fsproj": HTML, ".vbproj": HTML, ".props": HTML, ".targets": HTML, ".resx": HTML, ".xaml": HTML,
  ".storyboard": HTML, ".xib": HTML, ".wsdl": HTML, ".rss": HTML, ".atom": HTML, ".kml": HTML,
  ".hbs": HANDLEBARS, ".handlebars": HANDLEBARS, ".mustache": HANDLEBARS,
  ".j2": JINJA, ".jinja": JINJA, ".jinja2": JINJA, ".njk": JINJA, ".twig": JINJA, ".liquid": JINJA,
  ".erb": ERB, ".ejs": ERB,
  // Scripting
  ".py": PYTHON, ".pyi": PYTHON, ".pyw": PYTHON, ".pyx": PYTHON, ".pxd": PYTHON, ".bzl": PYTHON,
  ".star": PYTHON, ".bazel": PYTHON, ".gn": PYTHON, ".gni": PYTHON, ".vy": PYTHON, ".mojo": PYTHON,
  ".sh": SHELL, ".bash": SHELL, ".zsh": SHELL, ".ksh": SHELL, ".fish": SHELL, ".command": SHELL,
  ".ps1": POWERSHELL, ".psm1": POWERSHELL, ".psd1": POWERSHELL,
  ".bat": BATCH, ".cmd": BATCH,
  ".rb": RUBY, ".rake": RUBY, ".gemspec": RUBY, ".ru": RUBY, ".cr": RUBY, ".podspec": RUBY,
  ".pl": PERL, ".pm": PERL, ".t": PERL, ".pod": PERL,
  ".php": PHP, ".phtml": PHP,
  ".lua": LUA, ".luau": LUA,
  ".r": R, ".jl": JULIA,
  ".tcl": TCL, ".awk": HASH_STRINGS, ".sed": WORD_HASH, ".coffee": HASH_STRINGS, ".raku": PERL, ".pl6": PERL,
  ".ex": ELIXIR, ".exs": ELIXIR, ".erl": ERLANG, ".hrl": ERLANG,
  ".nim": NIM, ".nims": NIM, ".cmake": CMAKE,
  // Functional
  ".hs": HASKELL, ".elm": HASKELL, ".purs": HASKELL, ".dhall": HASKELL, ".agda": HASKELL, ".idr": HASKELL,
  ".lean": LEAN,
  ".ml": OCAML, ".mli": OCAML, ".sml": OCAML, ".fs": FSHARP, ".fsi": FSHARP, ".fsx": FSHARP,
  ".clj": LISP, ".cljs": LISP, ".cljc": LISP, ".edn": LISP, ".lisp": LISP, ".lsp": LISP, ".cl": LISP,
  ".el": LISP, ".scm": LISP, ".ss": LISP, ".rkt": LISP, ".fnl": LISP,
  // Other languages
  ".sql": SQL, ".psql": SQL, ".pgsql": SQL, ".ddl": SQL,
  ".pas": PASCAL, ".dpr": PASCAL, ".lpr": PASCAL,
  ".f": FORTRAN, ".for": FORTRAN, ".f90": FORTRAN, ".f95": FORTRAN, ".f03": FORTRAN, ".f08": FORTRAN,
  ".vb": VB, ".vbs": VB, ".bas": VB,
  ".vhd": VHDL, ".vhdl": VHDL,
  ".asm": ASSEMBLY, ".nasm": ASSEMBLY,
  ".tex": TEX, ".sty": TEX, ".cls": TEX, ".bib": TEX, ".ltx": TEX, ".dtx": TEX,
  ".vim": VIM,
  // Data and config
  ".yaml": YAML, ".yml": YAML,
  ".toml": TOML,
  ".ini": INI, ".cfg": INI, ".inf": INI, ".editorconfig": INI, ".gitconfig": INI, ".service": INI,
  ".desktop": INI, ".properties": PROPERTIES,
  ".conf": CONF, ".npmrc": CONF, ".yarnrc": CONF,
  ".tf": HCL, ".tfvars": HCL, ".hcl": HCL, ".nomad": HCL,
  ".nix": NIX, ".jsonnet": JSONNET, ".libsonnet": JSONNET,
  ".graphql": GRAPHQL, ".gql": GRAPHQL, ".graphqls": GRAPHQL, ".thrift": THRIFT,
  ".mk": MAKE, ".mak": MAKE, ".just": MAKE, ".dockerfile": LINE_HASH, ".containerfile": LINE_HASH,
  ".gitignore": LINE_HASH, ".gitattributes": LINE_HASH, ".dockerignore": LINE_HASH, ".npmignore": LINE_HASH,
  ".env": LINE_HASH, ".bazelrc": WORD_HASH, ".ninja": WORD_HASH, ".cabal": HASKELL,
  // Prose
  ".md": MARKDOWN, ".markdown": MARKDOWN, ".mdown": MARKDOWN, ".mkd": MARKDOWN, ".mkdn": MARKDOWN,
  ".qmd": MARKDOWN, ".rmd": MARKDOWN, ".mdx": MDX,
  ".rst": RESTRUCTURED_TEXT, ".adoc": ASCIIDOC, ".asciidoc": ASCIIDOC, ".org": ORG,
};

/** Files known by name. A name that starts with a dot is also its extension, so most are above. */
const NAMES: Readonly<Record<string, Language>> = {
  "makefile": MAKE, "gnumakefile": MAKE, "justfile": MAKE,
  "dockerfile": LINE_HASH, "containerfile": LINE_HASH,
  "cmakelists.txt": CMAKE,
  "build": PYTHON, "workspace": PYTHON, "module": PYTHON, "tiltfile": PYTHON, "sconstruct": PYTHON,
  "sconscript": PYTHON,
  "gemfile": RUBY, "rakefile": RUBY, "podfile": RUBY, "vagrantfile": RUBY, "brewfile": RUBY,
  "fastfile": RUBY, "appfile": RUBY, "guardfile": RUBY, "dangerfile": RUBY, "berksfile": RUBY,
  "jenkinsfile": GROOVY,
  "codeowners": LINE_HASH, "caddyfile": WORD_HASH, "procfile": LINE_HASH, ".htaccess": WORD_HASH,
  ".bashrc": SHELL, ".bash_profile": SHELL, ".bash_logout": SHELL, ".zshrc": SHELL, ".zshenv": SHELL,
  ".zprofile": SHELL, ".profile": SHELL, ".envrc": SHELL,
  ".vimrc": VIM, ".gvimrc": VIM, ".gitmodules": INI, ".tmux.conf": CONF,
  ".prettierrc": JSONC, ".eslintrc": JSONC, ".babelrc": JSONC, ".swcrc": JSONC,
};

/** Interpreters on a `#!` line. */
const INTERPRETERS: Readonly<Record<string, Language>> = {
  sh: SHELL, bash: SHELL, zsh: SHELL, ksh: SHELL, dash: SHELL, ash: SHELL, fish: SHELL,
  python: PYTHON, pypy: PYTHON, uv: PYTHON,
  node: JAVASCRIPT, deno: JAVASCRIPT, bun: JAVASCRIPT, tsx: JAVASCRIPT, "ts-node": JAVASCRIPT, zx: JAVASCRIPT,
  ruby: RUBY, perl: PERL, php: PHP, lua: LUA, luajit: LUA, rscript: R, julia: JULIA, pwsh: POWERSHELL,
  tclsh: TCL, wish: TCL, awk: HASH_STRINGS, gawk: HASH_STRINGS, make: MAKE, elixir: ELIXIR, escript: ERLANG,
  runghc: HASKELL, sbcl: LISP, guile: LISP, racket: LISP, bb: LISP, nix: NIX,
};

function languageOf(path: string, text: string): Language | undefined {
  const name = posix.basename(path).toLowerCase();
  const byName = NAMES[name];
  if (byName !== undefined) return byName;
  if (name.startsWith("dockerfile.") || name.startsWith("containerfile.")) return LINE_HASH;
  if (/^requirements.*\.(?:txt|in)$/u.test(name) || name.endsWith(".pip")) return WORD_HASH;
  if (name.startsWith(".env.")) return LINE_HASH;
  const extension = posix.extname(name);
  if (extension === ".m") return OBJECTIVE_C_HINT.test(text) ? C : MATLAB;
  const byExtension = EXTENSIONS[extension === "" && name.startsWith(".") ? name : extension];
  if (byExtension !== undefined) return byExtension;
  const shebang = /^#![ \t]*(?:\S*\/)?([\w.+-]+)(?:[ \t]+(?:-\S+[ \t]+)*([\w.+-]+))?/u.exec(text);
  if (shebang === null) return undefined;
  const interpreter = (shebang[1] === "env" ? shebang[2] : shebang[1]) ?? "";
  return INTERPRETERS[interpreter.toLowerCase().replace(/[\d.]+$/u, "")];
}

/** Where a token ends. `contentEnd` is where its close starts. */
interface End {
  readonly contentEnd: number;
  readonly end: number;
}

function findClose(
  text: string,
  from: number,
  to: number,
  rule: Rule,
  close: Close,
  lang: Language,
  comments: Span[],
): End | undefined {
  if (close instanceof RegExp) {
    close.lastIndex = from;
    const found = close.exec(text);
    if (found === null || found.index + found[0].length > to) return undefined;
    return { contentEnd: found.index, end: found.index + found[0].length };
  }
  let depth = 1;
  for (let i = from; i < to; i++) {
    const ch = text.charAt(i);
    if (ch === rule.escape) {
      i++;
    } else if (rule.interpolations?.some((open) => text.startsWith(open, i)) === true) {
      i = lex(text, lang, i + 2, to, comments, text.charAt(i + 1)) - 1;
    } else if (ch === "\n" && rule.singleLine === true) {
      return { contentEnd: i, end: i };
    } else if (text.startsWith(close, i)) {
      depth--;
      if (depth === 0) return { contentEnd: i, end: i + close.length };
      i += close.length - 1;
    } else if (rule.nested === true) {
      rule.start.lastIndex = i;
      const open = rule.start.exec(text);
      if (open !== null) {
        depth++;
        i += open[0].length - 1;
      }
    }
  }
  return undefined;
}

/**
 * True when a Python string at `at` is a statement of its own: first on its line, outside brackets,
 * and the line before does not continue into it (as `\` or `=` do). An f-string or a bytes string
 * is not a docstring.
 */
function isDocstring(text: string, at: number, lastCode: string, nesting: number): boolean {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  return (
    nesting <= 0 &&
    /^[ \t]*$/u.test(text.slice(lineStart, at)) &&
    /^[rRuU]?["']/u.test(text.slice(at, at + 2)) &&
    !/[=+\-*/%\\|&<>~^@.,]/u.test(lastCode)
  );
}

/** Open brackets minus close brackets in `code`. */
function bracketBalance(code: string): number {
  let balance = 0;
  for (const ch of code.matchAll(/[([{)\]}]/gu)) balance += "([{".includes(ch[0]) ? 1 : -1;
  return balance;
}

const BRACKETS: Readonly<Record<string, RegExp>> = { "{": /[{}]/gu, "(": /[()]/gu };

/**
 * Adds the comments between `from` and `to` to `comments`. With `until` (`{` or `(`), it stops
 * after the closing bracket that has no opening one: the end of an interpolation. Returns where it
 * stopped.
 */
function lex(text: string, lang: Language, from: number, to: number, comments: Span[], until?: string): number {
  const brackets = until === undefined ? undefined : BRACKETS[until];
  let i = from;
  // The last character of code (not of a comment) before `i`, and the open brackets, for docstrings.
  let lastCode = "";
  let nesting = 0;
  let depth = 0;
  while (i < to) {
    lang.finder.lastIndex = i;
    const found = lang.finder.exec(text);
    const at = found === null || found.index >= to ? to : found.index;
    if (brackets !== undefined) {
      for (brackets.lastIndex = i; ; ) {
        const bracket = brackets.exec(text);
        if (bracket === null || bracket.index >= at) break;
        if (bracket[0] === until) depth++;
        else if (depth-- === 0) return bracket.index + 1;
      }
    }
    if (at === to) return to;
    const code = text.slice(i, at).trimEnd();
    if (code !== "") lastCode = code.charAt(code.length - 1);
    if (lang.docstrings) nesting += bracketBalance(code);
    let next = at + 1;
    for (const rule of lang.rules) {
      rule.start.lastIndex = at;
      const open = rule.start.exec(text);
      if (open === null) continue;
      const openEnd = at + open[0].length;
      let end: End = { contentEnd: openEnd, end: openEnd };
      if (rule.close !== undefined) {
        const close = typeof rule.close === "function" ? rule.close(open, text) : rule.close;
        const closed = findClose(text, openEnd, to, rule, close, lang, comments);
        if (closed !== undefined) end = closed;
        else if (rule.needsClose === true) continue;
        else end = { contentEnd: to, end: to };
      }
      if (rule.comment === true || (rule.docstring === true && isDocstring(text, at, lastCode, nesting))) {
        comments.push({ start: at, end: end.end });
      } else {
        if (rule.embed !== undefined) lex(text, rule.embed(open), openEnd, end.contentEnd, comments);
        lastCode = text.charAt(end.end - 1);
      }
      next = Math.max(end.end, at + 1);
      break;
    }
    i = next;
  }
  return to;
}

/**
 * The comments in `text`, in order. The file name (and for some files the text) selects the
 * language. Returns undefined when the language is not known.
 */
export function commentSpans(path: string, text: string): Span[] | undefined {
  const lang = languageOf(path, text);
  if (lang === undefined) return undefined;
  const comments: Span[] = [];
  lex(text, lang, 0, text.length, comments);
  return comments;
}

/** Returns every ref in the comments of `text`, in order. `path` selects the language. */
export function findRefs(path: string, text: string, protocols: readonly string[] = DEFAULT_PROTOCOLS): RefMatch[] {
  if (!protocols.some((name) => text.includes(`${name}:`))) return [];
  const refs: RefMatch[] = [];
  for (const span of commentSpans(path, text) ?? []) {
    for (const ref of scanRefs(text.slice(span.start, span.end), protocols)) {
      refs.push({ ...ref, start: ref.start + span.start, end: ref.end + span.start });
    }
  }
  return refs;
}
