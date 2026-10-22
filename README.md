# nref tools

`nref:` is a link that you write in a comment. It points from any file in this repo to another
file, directory or Markdown heading. These tools make the links clickable in VS Code and checkable
in CI. The design is in the "Proposal: Cross-File Reference System" doc (2026-10-19).

```python
# Timing comes from nref:/fuji/arch/docs/architecture/mccu/backend/index.md#u200-rowcopy-timing-example
```

```markdown
<!-- nref:../src/mccu_model/timing.py -->
```

| Folder    | Contents                                                                 |
| --------- | ------------------------------------------------------------------------ |
| `core/`   | Scanner, path resolution, Markdown headings, checks. Used by both tools. |
| `cli/`    | `refs`, the command-line tool.                                           |
| `vscode/` | The VS Code extension.                                                   |

All three are TypeScript. The extension calls `core` directly, so the editor and the CLI give the
same result for the same ref.

## Setup

You need Node 22 or later.

```sh
cd tools/nref
npm install
npm run build        # tsc for core and cli, esbuild for the extension
npm test             # build, then run all tests
npm run lint         # ESLint; `any` is an error, written or inferred
```

## Syntax

```text
nref:/path/from/repo/root
nref:./relative/to/this/file
nref:../also/relative
nref:/some/doc.md#heading-slug
nref:#heading-in-this-file
```

- A path starts with `/` (from the repo root), `./` or `../` (from the directory of the file that
  holds the ref). A bare path such as `nref:config.go` is an error; the fix is `nref:./config.go`.
- A path can name a file or a directory. A trailing `/` means that the target must be a directory.
- Paths are matched case-sensitively against `git ls-files`, so a ref that passes on macOS also
  passes on Linux CI.
- Percent-encode spaces, `#` and `%` in paths (`%20`, `%23`, `%25`).
- The ref ends at whitespace, a quote, a backtick or a bracket. A trailing `-->`, `*/` or
  `. , ; : ! ?` is not part of it.
- Write `nref\:` to show the syntax in text without making a ref.

### Fragments

Only heading fragments are supported for now. The slug follows the GitHub rules: lower case, drop
punctuation, change each space to `-`, and add `-1`, `-2` to repeated headings. For example,
`## Memory Controller & Compute Unit` becomes `#memory-controller--compute-unit`.

Line fragments (`#L42`, `#L40-L72`) and anchors (`#^name`) are errors (`unsupported-fragment`).

Note: the MkDocs site makes some heading ids differently from GitHub. For example, it merges
repeated hyphens. Use the GitHub form. When a slug is wrong, `refs check` and the editor suggest
the nearest correct slug.

## CLI

Run it from anywhere in the repo:

```sh
node tools/nref/cli/dist/src/main.js check
# or, from tools/nref:
npx refs check
# or put `refs` on your PATH:
npm link -w cli
```

| Command                           | Output                                                             |
| --------------------------------- | ------------------------------------------------------------------ |
| `refs check [<path>...]`          | Broken refs in the repo, or under the paths. Exit 1 if any.        |
| `refs links <file> [--to <file>]` | Refs that a file holds and where each one goes.                    |
| `refs backlinks <file>`           | Refs in the repo that point at a file or directory.                |
| `refs graph [<file>]`             | The link graph: `--format dot` (default), `mermaid`, `json` or `drawio`. |

| Option                    | Effect                                                                  |
| ------------------------- | ----------------------------------------------------------------------- |
| `-r`, `--recursive`       | `links` and `backlinks`: follow refs transitively. With `--to`: list each chain. |
| `--depth N`               | Limit the hops. For `graph <file>`, the default is 1.                   |
| `-C N`, `-A N`, `-B N`    | Show N lines around each ref, as `grep` does.                           |
| `-T N`, `--show-target N` | Show N lines of the target, from the heading or from the top.           |
| `--format F`              | `text`, `json`, `ndjson`; `check` also has `sarif`.                     |

Exit codes: 0 clean, 1 broken refs, 2 usage, git or `refs.toml` error.

`refs graph --format drawio > refs.drawio` writes a file that draw.io (or the Draw.io Integration
extension in VS Code) opens. The tool places the nodes itself, from left to right: a file is one
column after the files that link to it. Files are blue boxes and directories are yellow folders.
A red dashed arrow is a broken ref, and a number on an arrow counts the refs it stands for. With
`refs graph <file>`, that file has a thick border.

```console
$ refs check
fuji/a.py:3:5  error  nref:/fuji/arch/docs/x.md#tokn  no heading #tokn in fuji/arch/docs/x.md; did you mean #token? [missing-anchor]  (fix: nref:/fuji/arch/docs/x.md#token)
1 broken ref (15 refs in 2160 files)
```

### Rules

| Rule                   | Default | Fires when                                                        |
| ---------------------- | ------- | ----------------------------------------------------------------- |
| `missing-file`         | error   | The target does not exist, or a trailing `/` names a file.        |
| `missing-anchor`       | error   | The heading is not in the target, or the target is not Markdown.  |
| `unsupported-fragment` | error   | The fragment is `#L…` or `#^…`.                                   |
| `escapes-root`         | error   | `..` climbs above the repo root.                                  |
| `bare-path`            | error   | The path starts with none of `/`, `./`, `../`.                    |
| `reserved-authority`   | error   | The ref uses `nref://`, which is kept for cross-repo refs.         |
| `case-mismatch`        | error   | The path differs from a repo path only by case.                   |
| `invalid-encoding`     | error   | The percent-encoding is bad.                                      |
| `target-ignored`       | warn    | The target is untracked or ignored by git.                        |

### `refs.toml`

`refs.toml` at the repo root sets which files are not scanned and changes rule levels:

```toml
exclude = ["vendor/**", "**/*.min.js"]

[rules]
target-ignored = "off"   # "off", "warn" or "error"
```

In a glob, `**` matches across `/`, and `*` and `?` do not. A glob must match the whole repo path.
A directory glob such as `vendor/` also matches everything in that directory. Refs that point into
an excluded file still resolve.

## VS Code extension

Build and install it:

```sh
cd tools/nref
npm run package                       # makes vscode/nref.vsix
code --install-extension vscode/nref.vsix
```

To debug it, open `tools/nref` in VS Code and start "Run nref extension" (F5).

| Feature        | What you do                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| Follow         | Cmd/Ctrl+click a ref. A file opens at the heading. A directory shows in the explorer. |
| Hover          | Shows the target and its first lines (`nref.hover.lines`, default 10).               |
| Problems       | Broken refs get a red or yellow underline (`nref.diagnostics.enabled`).              |
| Quick fix      | Cmd/Ctrl+. on a broken ref offers the suggested refs.                                |
| Copy ref       | Right-click in an editor or the explorer. Copies `nref:/path`, plus `#slug` of the heading above the cursor in Markdown. |
| Completion     | Type `nref:/` or `nref:./` for paths, and `#` after a Markdown path for headings.    |
| Graph          | "nref: Show ref graph" (command palette, editor or explorer context menu). Pick 1 or 2 hops around the file, or the whole repo. |

### Graph preview

"nref: Show ref graph" writes the graph to a file in the extension's storage folder and opens it
in a viewer extension. The `nref.graph.viewer` setting selects the viewer. You must install that
extension first. If it is missing, the command offers to install it.

| `nref.graph.viewer` | Extension to install                                    | What you get                                                                   |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `drawio` (default)  | Draw.io Integration (`hediet.vscode-drawio`)            | The same layout as `refs graph --format drawio`. Turn on "Code Link" in the status bar, then double-click a node to open its file. |
| `mermaid`           | Mermaid, the official one (`MermaidChart.vscode-mermaid-chart`), or else Mermaid Preview (`vstirbu.vscode-mermaid-preview`) | A `.mmd` file and its preview. Mermaid lays out the graph itself. If both are installed, Mermaid is used. |

Each run writes the file again, so edits that you make to a graph file are lost on the next run.

The extension reads the file list from git. It reads it again when files are created or deleted,
or when `.gitignore` or `refs.toml` changes. Run "nref: Refresh file index" after other changes,
for example after `git add`. Headings come from the editor text, so they include unsaved edits.

## Not done yet

- Line and anchor fragments, and the `duplicate-anchor`, `line-ref` and `stale-line` rules.
- `refs mv`, `refs check --changed`, `--include`/`--exclude` flags, and the blob-hash cache.
- `refs lsp`. Because the extension uses `core` directly, it does not need a language server.
  Add one only if another editor needs one.
- Backlinks panel and rename safety in the extension.
- The graph preview does not update by itself. Run the command again after you change refs.
