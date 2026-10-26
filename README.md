# interref

interref makes `nref:` links checkable in CI and clickable in VS Code. You write an `nref:` link in
a comment. It points from any file in a git repo to another file, directory or Markdown heading in
the same repo. The design is in the "Proposal: Cross-File Reference System" doc (2026-10-19).

```python
# Token TTL must match the docs: nref:/docs/auth.md#token-lifetime
```

```markdown
<!-- Implemented in nref:../src/auth/session.ts -->
```

| Folder             | Package            | Contents                                                                 |
| ------------------ | ------------------ | ------------------------------------------------------------------------ |
| `packages/core/`   | `@interref/core`   | Scanner, path resolution, Markdown headings, checks. Used by both tools. |
| `packages/cli/`    | `interref`         | The command-line tool. Published to npm as `interref`.                   |
| `packages/vscode/` | `vscode-interref`  | The VS Code extension.                                                   |

All three are TypeScript. The extension calls `core` directly, so the editor and the CLI give the
same result for the same ref.

## Setup

You need Node 22 or later and pnpm. The repo is a pnpm workspace. The `packageManager` field in
`package.json` sets the pnpm version. Shared dependency versions are in the `catalog` of
`pnpm-workspace.yaml`.

```sh
pnpm install
pnpm build           # tsrs for all packages, then esbuild bundles the CLI and the extension
pnpm test            # build, then run the tests of all packages
pnpm lint            # oxlint with type-aware rules; `any` is an error, written or inferred
```

The type checker is [tsrs](https://github.com/oxc-project/tsrs), a Rust port of TypeScript 7. Use
`pnpm exec tsrs` where you would use `tsc`. The linter is [oxlint](https://oxc.rs/docs/guide/usage/linter);
its rules are in `.oxlintrc.json`. tsrs is a beta, so its version is pinned exactly.

In VS Code, install the extensions that the workspace recommends: "TypeScript (Native Preview)" and
"Oxc". `.vscode/settings.json` makes the TypeScript extension use the tsrs language server from
`node_modules`. VS Code asks you to trust the workspace before it starts that server.

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
repeated hyphens. Use the GitHub form. When a slug is wrong, `interref check` and the editor suggest
the nearest correct slug.

## CLI

Run it from anywhere in the repo that you want to check:

```sh
node ~/workspace/interref/packages/cli/dist/interref.mjs check
# or put `interref` on your PATH (run this in the interref repo; ~/.local/bin must be on PATH):
ln -s "$PWD/packages/cli/dist/interref.mjs" ~/.local/bin/interref
```

`pnpm build` writes the CLI and `@interref/core` into one file, `packages/cli/dist/interref.mjs`.
That file is the whole npm package, so it has no dependencies at run time.

| Command                           | Output                                                             |
| --------------------------------- | ------------------------------------------------------------------ |
| `interref check [<path>...]`          | Broken refs in the repo, or under the paths. Exit 1 if any.        |
| `interref links <file> [--to <file>]` | Refs that a file holds and where each one goes.                    |
| `interref backlinks <file>`           | Refs in the repo that point at a file or directory.                |
| `interref graph [<file>]`             | The link graph: `--format dot` (default), `mermaid`, `json` or `drawio`. |

| Option                    | Effect                                                                  |
| ------------------------- | ----------------------------------------------------------------------- |
| `-r`, `--recursive`       | `links` and `backlinks`: follow refs transitively. With `--to`: list each chain. |
| `--depth N`               | Limit the hops. For `graph <file>`, the default is 1.                   |
| `-C N`, `-A N`, `-B N`    | Show N lines around each ref, as `grep` does.                           |
| `-T N`, `--show-target N` | Show N lines of the target, from the heading or from the top.           |
| `--format F`              | `text`, `json`, `ndjson`; `check` also has `sarif`.                     |

Exit codes: 0 clean, 1 broken refs, 2 usage, git or `interref.toml` error.

`interref graph --format drawio > refs.drawio` writes a file that draw.io (or the Draw.io Integration
extension in VS Code) opens. The tool places the nodes itself, from left to right: a file is one
column after the files that link to it. Files are blue boxes and directories are yellow folders.
A red dashed arrow is a broken ref, and a number on an arrow counts the refs it stands for. With
`interref graph <file>`, that file has a thick border.

```console
$ interref check
src/auth/session.ts:3:5  error  nref:/docs/auth.md#tokn  no heading #tokn in docs/auth.md; did you mean #token? [missing-anchor]  (fix: nref:/docs/auth.md#token)
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

### `interref.toml`

`interref.toml` at the repo root sets which files are not scanned and changes rule levels:

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
pnpm package                                   # makes packages/vscode/interref.vsix
code --install-extension packages/vscode/interref.vsix
```

To debug it, open this repo in VS Code and start "Run interref extension" (F5).

| Feature        | What you do                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| Follow         | Cmd/Ctrl+click a ref. A file opens at the heading. A directory shows in the explorer. |
| Hover          | Shows the target and its first lines (`interref.hover.lines`, default 10).               |
| Problems       | Broken refs get a red or yellow underline (`interref.diagnostics.enabled`).              |
| Quick fix      | Cmd/Ctrl+. on a broken ref offers the suggested refs.                                |
| Copy ref       | Right-click in an editor or the explorer. Copies `nref:/path`, plus `#slug` of the heading above the cursor in Markdown. |
| Completion     | Type `nref:/` or `nref:./` for paths, and `#` after a Markdown path for headings.    |
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

The extension reads the file list from git. It reads it again when files are created or deleted,
or when `.gitignore` or `interref.toml` changes. Run "interref: Refresh file index" after other changes,
for example after `git add`. Headings come from the editor text, so they include unsaved edits.

## Not done yet

- Line and anchor fragments, and the `duplicate-anchor`, `line-ref` and `stale-line` rules.
- `interref mv`, `interref check --changed`, `--include`/`--exclude` flags, and the blob-hash cache.
- `interref lsp`. Because the extension uses `core` directly, it does not need a language server.
  Add one only if another editor needs one.
- Backlinks panel and rename safety in the extension.
- The graph preview does not update by itself. Run the command again after you change refs.
