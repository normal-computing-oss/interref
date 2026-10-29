# Developing interref

This file is for people who change interref. For how to use it, see [README.md](README.md). The
design is in the "Proposal: Cross-File Reference System" doc (2026-10-19).

## Packages

| Folder             | Package                      | Contents                                                                 |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------ |
| `packages/core/`   | `@interref/core`             | Comment lexer, scanner, path resolution, Markdown headings, checks. Used by both tools. |
| `packages/cli/`    | `@normal-computing/interref` | The command-line tool. Its commands are `interref` and `iref`.           |
| `packages/vscode/` | `vscode-interref`            | The VS Code extension. Attached to each GitHub release as a `.vsix`.     |

All three are TypeScript. The extension calls `core` directly, so the editor and the CLI give the
same result for the same ref. `@interref/core` is not published. esbuild bundles it into the CLI and
into the extension.

## Setup

You need Node 22 or later and pnpm. The repo is a pnpm workspace. The `packageManager` field in
`package.json` sets the pnpm version. Shared dependency versions are in the `catalog` of
`pnpm-workspace.yaml`.

```sh
pnpm install
pnpm build           # tsrs for all packages, then esbuild bundles the CLI and the extension
pnpm test            # build, then run the tests of all packages
pnpm lint            # oxlint with type-aware rules; `any` is an error, written or inferred
pnpm check           # lint, then test; CI runs this on pull requests and on main
```

The type checker is [tsrs](https://github.com/oxc-project/tsrs), a Rust port of TypeScript 7. Use
`pnpm exec tsrs` where you would use `tsc`. The linter is [oxlint](https://oxc.rs/docs/guide/usage/linter);
its rules are in `.oxlintrc.json`. tsrs is a beta, so its version is pinned exactly.

In VS Code, install the extensions that the workspace recommends: "TypeScript (Native Preview)" and
"Oxc". `.vscode/settings.json` makes the TypeScript extension use the tsrs language server from
`node_modules`. VS Code asks you to trust the workspace before it starts that server.

## Comment lexer

`packages/core/src/comments.ts` finds the comments of a file, and `checkText` keeps only the refs in
them. Each language is a list of token rules: comments, and the strings and other spans in which a
comment marker does not start a comment. To add a language, add an entry to `EXTENSIONS` or
`NAMES`, and reuse a language that has the same rules or make one with `language(...)`. Add a test
to `packages/core/test/comments.test.ts` with a ref in a comment and a ref in a string.

To check the lexer on real code, compare it with Shiki, which has the TextMate grammars of VS Code.
Shiki is a dev dependency only: it is not in the CLI or the extension.

```sh
pnpm verify-comments                       # the files of this repo
pnpm verify-comments ~/src/repo-a ~/src/b  # other git repos
pnpm verify-comments ~/src/a --lang python,rust --show 50
```

`scripts/verify-comments.mjs` marks each character as comment or not, by our lexer and by Shiki,
and shows the regions where they disagree. It exits 1 if there are any. A grammar can be wrong too,
so read each region before you change the lexer. Known differences by design (docstrings, code
blocks in Markdown) and known grammar gaps are at the top of the script. Run it after you change
the lexer, on repos that use the languages you changed.

## CLI

`pnpm build` writes the CLI and `@interref/core` into one file, `packages/cli/dist/interref.mjs`.
That file is the whole npm package, so it has no dependencies at run time. esbuild also writes the
version from `package.json` into the bundle, for `--version` and the update check, and the agent
guide `skills/iref/SKILL.md`, for `--guide`. `prepack` copies the repo README and LICENSE into
`packages/cli`, so the npm page shows the README.
`scripts/npm-readme.mjs` changes the relative links in the copy to GitHub URLs.

`packages/cli/src/update.ts` has the network code. The update check reads the `latest` dist-tag
from npm and keeps the answer for a day in `~/.cache/interref/update-check.json` (or
`$XDG_CACHE_HOME/interref/`). `install-extension` reads the GitHub releases and installs the
`.vsix` asset with `<editor> --install-extension`. To test it without a change to your VS Code,
use `--editor` with a script that runs `code --extensions-dir <temporary folder> "$@"`.

To run your local build, use `node ~/workspace/interref/packages/cli/dist/interref.mjs check`, or
link it onto your PATH (run this in the interref repo; `~/.local/bin` must be on PATH):

```sh
ln -s "$PWD/packages/cli/dist/interref.mjs" ~/.local/bin/interref
ln -s "$PWD/packages/cli/dist/interref.mjs" ~/.local/bin/iref
```

## VS Code extension

To build and install it from source:

```sh
pnpm package                                   # makes packages/vscode/interref.vsix
code --install-extension packages/vscode/interref.vsix
```

To debug it, open this repo in VS Code and start "Run interref extension" (F5).

`packages/vscode/README.md` is the page that VS Code shows for the extension. When you change a
feature or a setting, update it and the user README.

## Releasing

You release from your machine. CI does not publish. The CLI and the extension always have the
same version. On an up-to-date `main` with no changes, run:

```sh
pnpm release 0.2.0 --dry-run   # do all the steps, publish nothing, then undo the commit and the tag
pnpm release 0.2.0             # the real release
```

`scripts/release.mjs` does these steps. It stops at the first step that fails:

1. It makes sure that you are on `main`, that `main` is the same as `origin/main`, that the tag
   does not exist, that npm does not have the version, and that you are logged in to npm and `gh`.
2. It sets the version in all packages, then runs `pnpm check`.
3. It packs the CLI and the extension into `release/`.
4. It commits `Release v0.2.0` and makes the tag `v0.2.0`.
5. It publishes the CLI to npm. npm can ask you to log in or to approve in the browser.
6. It pushes `main` and the tag.
7. It makes a GitHub release with notes from the merged pull requests. It attaches the CLI tarball
   and `interref-<version>.vsix`.

If a step before the npm publish fails, the script undoes the commit and the tag, so you can fix
the problem and run it again. If a step after the npm publish fails, the script shows the commands
that are still to do. Do not publish the same version again.

A version with a `-` goes to the npm dist-tag with the same word as its prerelease part
(`0.3.0-beta.1` goes to `beta`), and its GitHub release is a prerelease. Other versions go to
`latest`.

### One-time setup

- Log in to npm (`npm login`) with an account that can publish in the npm org `normal-computing`.
- Log in to GitHub (`gh auth login`) with an account that can push to `main` and make releases.

The package name has a scope because npm refuses the unscoped names `interref`, `inter-ref` and
`iref`. They are too similar to the existing package `interpret`.

## Not done yet

- Line and anchor fragments, and the `duplicate-anchor`, `line-ref` and `stale-line` rules.
- `interref mv`, `interref check --changed`, `--include`/`--exclude` flags, and the blob-hash cache.
- `interref lsp`. Because the extension uses `core` directly, it does not need a language server.
  Add one only if another editor needs one.
- Backlinks panel and rename safety in the extension.
- The graph preview does not update by itself. Run the command again after you change refs.
