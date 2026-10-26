# Developing interref

This file is for people who change interref. For how to use it, see [README.md](README.md). The
design is in the "Proposal: Cross-File Reference System" doc (2026-10-19).

## Packages

| Folder             | Package                      | Contents                                                                 |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------ |
| `packages/core/`   | `@interref/core`             | Scanner, path resolution, Markdown headings, checks. Used by both tools. |
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
pnpm check           # lint, then test; CI runs this
```

The type checker is [tsrs](https://github.com/oxc-project/tsrs), a Rust port of TypeScript 7. Use
`pnpm exec tsrs` where you would use `tsc`. The linter is [oxlint](https://oxc.rs/docs/guide/usage/linter);
its rules are in `.oxlintrc.json`. tsrs is a beta, so its version is pinned exactly.

In VS Code, install the extensions that the workspace recommends: "TypeScript (Native Preview)" and
"Oxc". `.vscode/settings.json` makes the TypeScript extension use the tsrs language server from
`node_modules`. VS Code asks you to trust the workspace before it starts that server.

## CLI

`pnpm build` writes the CLI and `@interref/core` into one file, `packages/cli/dist/interref.mjs`.
That file is the whole npm package, so it has no dependencies at run time.

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

The CLI and the extension always have the same version. To release, on an up-to-date `main`:

```sh
pnpm release 0.2.0          # sets the version in all packages, then commits and tags v0.2.0
git push --follow-tags      # the tag starts .github/workflows/release.yml
```

The workflow does these steps:

1. It makes sure that the tag and the package versions are the same.
2. It runs `pnpm check`.
3. It publishes the CLI to npm. npm trusted publishing gives the authentication, so the repo has no
   npm token.
4. It makes a GitHub release with notes from the merged pull requests. It attaches the CLI tarball
   and `interref-<version>.vsix`.

A version with a `-` (for example `0.3.0-beta.1`) goes to the npm `next` dist-tag, and its GitHub
release is a prerelease.

If the workflow fails before the npm publish, delete the tag (`git push --delete origin v0.2.0` and
`git tag -d v0.2.0`), fix the problem, then release again. If it fails after the npm publish, do not
publish the same version again. Make the GitHub release by hand, or release the next patch version.

### One-time npm setup

The package name has a scope because npm refuses the unscoped names `interref`, `inter-ref` and
`iref`. They are too similar to the existing package `interpret`.

npm accepts a trusted publisher only for a package that exists. Thus, the first publish is manual:

1. Make the npm org `normal-computing` (npmjs.com/org/create). Public packages are free.
2. Run `pnpm build`, then in `packages/cli`, run `pnpm pack` and
   `npm publish ./normal-computing-interref-<version>.tgz --tag next`. You must be logged in to npm
   (`npm login`).
3. On npmjs.com, open the settings of `@normal-computing/interref` and add a trusted publisher:
   GitHub Actions, repository `normal-computing-oss/interref`, workflow `release.yml`.

## Not done yet

- Line and anchor fragments, and the `duplicate-anchor`, `line-ref` and `stale-line` rules.
- `interref mv`, `interref check --changed`, `--include`/`--exclude` flags, and the blob-hash cache.
- `interref lsp`. Because the extension uses `core` directly, it does not need a language server.
  Add one only if another editor needs one.
- Backlinks panel and rename safety in the extension.
- The graph preview does not update by itself. Run the command again after you change refs.
