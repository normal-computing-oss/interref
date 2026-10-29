# interref

interref makes `iref:` links checkable in CI and clickable in VS Code. You write an `iref:` link in
a comment. It points from any file in a git repo to another file, directory or Markdown heading in
the same repo.

```python
# Token TTL must match the docs: iref:/docs/auth.md#token-lifetime
```

```markdown
<!-- Implemented in iref:../src/auth/session.ts -->
```

When a file moves or a heading changes, `interref check` finds the refs that are now broken. In VS
Code, you can Cmd/Ctrl+click a ref to open its target. The CLI and the extension use the same code,
so they give the same result for the same ref.

## Install

The CLI needs Node 22 or later:

```sh
npm install --global @normal-computing/interref   # installs `interref` and its alias `iref`
```

```sh
npx @normal-computing/interref check               # or run it with no install
```

The VS Code extension is not in the Marketplace. The CLI installs it from the newest
[GitHub release](https://github.com/normal-computing-oss/interref/releases):

```sh
interref install-extension                   # install, or update to the newest stable release
interref install-extension --check           # only tell if an update is available
interref install-extension --prerelease      # also use prereleases
interref install-extension --editor cursor   # Cursor, Windsurf (windsurf) or VSCodium (codium)
```

The command uses the `code` command of VS Code. If your shell does not find `code`, in VS Code run
"Shell Command: Install 'code' command in PATH". You can also download the `.vsix` from a release
and run `code --install-extension interref-<version>.vsix`.

### Updates

Once a day, the CLI asks npm if a newer stable version is available. If it is, the CLI tells you
how to upgrade, after the output of the command. The CLI does not ask when its output does not go
to a terminal or when the `CI` variable is set. To turn the check off, set
`INTERREF_NO_UPDATE_CHECK=1`.

## Syntax

```text
iref:/path/from/repo/root
iref:./relative/to/this/file
iref:../also/relative
iref:/some/doc.md#heading-slug
iref:#heading-in-this-file
```

- A path starts with `/` (from the repo root), `./` or `../` (from the directory of the file that
  holds the ref). A bare path such as `iref:config.go` is an error; the fix is `iref:./config.go`.
- A path can name a file or a directory. A trailing `/` means that the target must be a directory.
- Paths are matched case-sensitively against `git ls-files`, so a ref that passes on macOS also
  passes on Linux CI.
- Percent-encode spaces, `#` and `%` in paths (`%20`, `%23`, `%25`).
- The ref ends at whitespace, a quote, a backtick or a bracket. A trailing `-->`, `*/` or
  `. , ; : ! ?` is not part of it.
- Write `iref\:` to show the syntax in a comment without making a ref.

### Where a ref counts

A ref counts only in a comment. interref ignores the same text in a string, in code, in Markdown
text and in a code block. Thus an example in a test string or in a README is not a link:

```python
# iref:/docs/auth.md          <- a ref
url = "iref:/docs/auth.md"    # not a ref: it is in a string
```

- In Markdown, a ref counts in an HTML comment (`<!-- ... -->`) or in a YAML comment in the front
  matter. It does not count in text, in a code span or in a fenced code block.
- In HTML, Vue and Svelte, a ref counts in an HTML comment, and in a comment in `<script>` and
  `<style>`.
- In Python, a docstring is a comment: a string that is a statement of its own, for example the
  first line of a `def` or `class` body. An f-string is not a docstring.
- In GraphQL, a `"""` description is a comment.
- In JSON, a ref counts in a `//` or `/* */` comment (as in `tsconfig.json`).

interref finds the language from the file extension or the file name (for example `Dockerfile`,
`Makefile`, `CMakeLists.txt`). A file with no extension can name its language in a `#!` line. A file
in a language that interref does not know, for example `.txt`, has no refs.

| Comment syntax                    | Languages (examples)                                                      |
| --------------------------------- | ------------------------------------------------------------------------- |
| `//` and `/* */`                  | C, C++, C#, Java, Kotlin, Scala, Go, Rust, Swift, Dart, JavaScript, TypeScript, Zig, Solidity, Protobuf, JSON |
| `#`                               | Python, Ruby, Perl, shell, PowerShell, R, Julia, Elixir, Nim, YAML, TOML, Makefile, Dockerfile, Terraform, Nix, GraphQL |
| `--`                              | SQL, Lua, Haskell, Elm, VHDL, Lean                                        |
| `;`, `%`, `!`, `'`                | Lisp, Clojure, assembly, INI; Erlang, LaTeX, MATLAB; Fortran; Visual Basic |
| `(* *)`, `{- -}`                  | OCaml, F#, Pascal; Haskell                                                |
| `<!-- -->`                        | Markdown, HTML, XML, SVG, Vue, Svelte                                     |
| Other                             | reStructuredText (`..`), AsciiDoc (`//`), Org (`#`), Batch (`REM`), Vim script (`"`), Jinja and Twig (`{# #}`), Handlebars (`{{! }}`), ERB and EJS (`<%# %>`) |

The scanner is a lexer, not a parser. It knows strings, raw strings, heredocs and template
literals well enough to tell them from comments. In rare cases it can make an error, for example
with a JavaScript regex after an unusual token.

### Protocols

The name before the `:` is the protocol. By default, `iref:` and `sync:` start a ref, and they
work the same way. Use the name that tells the reader the most, for example `sync:` for
two things that must change together. The `protocols` key of the [config file](#config-file) sets
the list. A suggested fix keeps the protocol of the ref. "Copy ref" in VS Code uses the first
protocol in the list.

A protocol name must not have a letter, a digit, `_` or `-` immediately before it. Thus, if `ref` is
in the list, `iref:` is not also read as `ref:`.

### Fragments

Only heading fragments are supported for now. The slug follows the GitHub rules: lower case, drop
punctuation, change each space to `-`, and add `-1`, `-2` to repeated headings. For example,
`## Memory Controller & Compute Unit` becomes `#memory-controller--compute-unit`.

Line fragments (`#L42`, `#L40-L72`) and anchors (`#^name`) are errors (`unsupported-fragment`).

Note: some site generators, for example MkDocs, make heading ids differently from GitHub. MkDocs
merges repeated hyphens. Use the GitHub form. When a slug is wrong, `interref check` and the editor
suggest the nearest correct slug.

## CLI

Run it from anywhere in the repo that you want to check:

```console
$ interref check
src/auth/session.ts:3:5  error  iref:/docs/auth.md#tokn  no heading #tokn in docs/auth.md; did you mean #token? [missing-anchor]  (fix: iref:/docs/auth.md#token)
1 broken ref (15 refs in 2160 files)
```

| Command                               | Output                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `interref check [<path>...]`          | Broken refs in the repo, or under the paths. Exit 1 if any.              |
| `interref links <file>... [--to <file>]` | Refs that the files hold and where each one goes.                     |
| `interref backlinks <path>...`        | Refs in the repo that point at the files or directories.                 |
| `interref graph [<file>]`             | The link graph: `--format dot` (default), `mermaid`, `json` or `drawio`. |
| `interref install-extension`          | Install or update the VS Code extension. See [Install](#install).        |

| Option                    | Effect                                                                  |
| ------------------------- | ----------------------------------------------------------------------- |
| `-r`, `--recursive`       | `links` and `backlinks`: follow refs transitively. With `--to`: list each chain. |
| `--depth N`               | Limit the hops. For `graph <file>`, the default is 1.                   |
| `-C N`, `-A N`, `-B N`    | Show N lines around each ref, as `grep` does.                           |
| `-T N`, `--show-target N` | Show N lines of the target, from the heading or from the top.           |
| `--format F`              | `text`, `json`, `ndjson`; `check` also has `sarif`.                     |
| `--guide`                 | Print the guide for coding agents. See [Coding agents](#coding-agents). |
| `-v`, `--version`         | Show the version.                                                       |

Exit codes: 0 clean, 1 broken refs, 2 usage, git, config file, network or editor error. `links` and
`backlinks` also exit 1 when a ref that they list is broken.

### Paths from stdin

A path argument `-` reads the paths from stdin, one on each line, or separated by NUL as with
`git diff -z`. Thus git, `find` or another tool can choose the files. From stdin, a path that does
not exist is not an error: `links` and `check` skip it, and `backlinks` still finds the refs that
point to it. Give the paths relative to the current directory, as `git diff` does when you run it
at the repo root.

For example, to see what a branch changed at the two ends of its refs:

```sh
changed() { git diff -z --name-only --no-renames "$(git merge-base origin/main HEAD)"; git ls-files -z --others --exclude-standard; }
changed | interref links -                        # refs in the changed files
changed | interref backlinks -                    # refs to the changed files, also to deleted ones
changed | interref backlinks - | grep '  sync:'   # only the sync: refs
{ changed | interref links -; changed | interref backlinks -; } | sort | uniq -d   # both ends changed
```

`links` and `backlinks` print a ref on the same line, so `sort`, `uniq` and `comm` can compare their
output. `--no-renames` keeps the old path of a moved file, so the refs to the old path show.

`interref graph --format drawio > refs.drawio` writes a file that draw.io (or the Draw.io Integration
extension in VS Code) opens. The tool places the nodes itself, from left to right: a file is one
column after the files that link to it. Files are blue boxes and directories are yellow folders.
A red dashed arrow is a broken ref, and a number on an arrow counts the refs it stands for. With
`interref graph <file>`, that file has a thick border.

### Use in CI

`interref check` exits with 1 when a ref is broken, so a CI step fails. For GitHub Actions:

```yaml
- uses: actions/checkout@v5
- uses: actions/setup-node@v5
  with:
    node-version: 22
- run: npx --yes @normal-computing/interref check
```

If the repo already has broken refs, a pull request can check only the refs in or to the files that
it changes. `fetch-depth: 0` gets the history that `git merge-base` needs:

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0
- uses: actions/setup-node@v5
  with:
    node-version: 22
- run: npm install --global @normal-computing/interref
- run: |
    base=$(git merge-base origin/${{ github.base_ref }} HEAD)
    git diff -z --name-only --no-renames "$base" | interref check -
    git diff -z --name-only --no-renames "$base" | interref backlinks -
```

### Coding agents

`interref --guide` prints a guide for coding agents: how to write refs, where to put them, what to
run after a file moves, and how to check a change for inconsistency between linked files. The guide
is an [Agent Skill](https://agentskills.io) file. An agent can read it once, or you can save it as a
skill:

```sh
interref --guide > .claude/skills/iref/SKILL.md   # Claude Code
interref --guide > .agents/skills/iref/SKILL.md   # other agents that read .agents/skills
```

The frontmatter of the printed guide has the CLI version in `metadata.interref-version`. A patch
version (for example 0.3.1 to 0.3.2) does not change the meaning of the guide. It can only fix
typos, wording or formatting. A major or minor version can change the procedures and the rules in
the guide. After such an update, tell your agent to read `interref --guide` again, compare it with
the repo's skill and propose the changes. The guide tells the agent to do this when it sees that
the installed CLI is newer than the skill. Do not simply overwrite the skill: the repo's skill can
have changes for the repo.

If the repo has its own iref skill and it is different from the guide, the repo's skill wins. The
source of the guide is [skills/iref/SKILL.md](skills/iref/SKILL.md).

### Rules

| Rule                   | Default | Fires when                                                        |
| ---------------------- | ------- | ----------------------------------------------------------------- |
| `missing-file`         | error   | The target does not exist, or a trailing `/` names a file.        |
| `missing-anchor`       | error   | The heading is not in the target, or the target is not Markdown.  |
| `unsupported-fragment` | error   | The fragment is `#L…` or `#^…`.                                   |
| `escapes-root`         | error   | `..` climbs above the repo root.                                  |
| `bare-path`            | error   | The path starts with none of `/`, `./`, `../`.                    |
| `reserved-authority`   | error   | The ref uses `iref://` (or `sync://`, …), kept for cross-repo refs. |
| `case-mismatch`        | error   | The path differs from a repo path only by case.                   |
| `invalid-encoding`     | error   | The percent-encoding is bad.                                      |
| `target-ignored`       | warn    | The target is untracked or ignored by git.                        |

### Config file

The config file at the repo root sets which files are not scanned, which protocols start a ref, and
the rule levels. It can have one of these names: `interref.toml`, `.interref.toml`, `interref.json`
or `.interref.json`. Use only one of them; two or more config files is an error.

```toml
exclude = ["vendor/**", "**/*.min.js"]
protocols = ["iref", "sync"]   # the default

[rules]
target-ignored = "off"   # "off", "warn" or "error"
```

The same config as JSON:

```json
{
  "exclude": ["vendor/**", "**/*.min.js"],
  "protocols": ["iref", "sync"],
  "rules": { "target-ignored": "off" }
}
```

All keys are optional.

In a glob, `**` matches across `/`, and `*` and `?` do not. A glob must match the whole repo path.
A directory glob such as `vendor/` also matches everything in that directory. Refs that point into
an excluded file still resolve.

## VS Code extension

| Feature        | What you do                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| Follow         | Cmd/Ctrl+click a ref. A file opens at the heading. A directory shows in the explorer. |
| Hover          | Shows the target and its first lines (`interref.hover.lines`, default 10).               |
| Problems       | Broken refs get a red or yellow underline (`interref.diagnostics.enabled`).              |
| Quick fix      | Cmd/Ctrl+. on a broken ref offers the suggested refs.                                |
| Copy ref       | Right-click in an editor or the explorer. Copies `iref:/path`, plus `#slug` of the heading above the cursor in Markdown. |
| Completion     | In a comment, type `iref:/` or `iref:./` for paths, and `#` after a Markdown path for headings. |
| Graph          | "interref: Show ref graph" (command palette, editor or explorer context menu). Pick 1 or 2 hops around the file, or the whole repo. |

### Graph preview

"interref: Show ref graph" writes the graph to a file in the extension's storage folder and opens it
in a viewer extension. The `interref.graph.viewer` setting selects the viewer. You must install that
extension first. If it is missing, the command offers to install it.

| `interref.graph.viewer` | Extension to install                                    | What you get                                                                   |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `drawio` (default)  | Draw.io Integration (`hediet.vscode-drawio`)            | The same layout as `interref graph --format drawio`. Turn on "Code Link" in the status bar, then double-click a node to open its file. |
| `mermaid`           | Mermaid, the official one (`MermaidChart.vscode-mermaid-chart`), or else Mermaid Preview (`vstirbu.vscode-mermaid-preview`) | A `.mmd` file and its preview. Mermaid lays out the graph itself. If both are installed, Mermaid is used. |

Each run writes the file again, so edits that you make to a graph file are lost on the next run.

### File index

The extension reads the file list from git. It reads it again when files are created or deleted,
or when `.gitignore` or the config file changes. Run "interref: Refresh file index" after other changes,
for example after `git add`. Headings come from the editor text, so they include unsaved edits.

## Limitations

- Only heading fragments work. Line fragments (`#L42`) and anchors (`#^name`) are not supported yet.
- The graph preview does not update by itself. Run the command again after you change refs.
- The extension has no backlinks panel, and it does not update refs when you rename a file.

## Contributing

To build, test or release interref, see [DEVELOPMENT.md](DEVELOPMENT.md).

## License

[Apache-2.0](LICENSE)
