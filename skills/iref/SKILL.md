---
name: iref
description: Add, edit and check interref links (iref:, sync:) between files of a git repo. Use when you write a comment that points to another file, spec section or doc heading; when two files must stay in sync (for example a spec and its model); when you move, rename or delete a file or heading in a repo that has refs; or when you run `iref check`, `iref links`, `iref backlinks` or `iref graph`.
---

# Use iref

interref makes cross-file links in comments checkable. A ref such as
`iref:/docs/auth.md#token-lifetime` points from a comment to a file, a
directory or a Markdown heading in the same git repo. `iref check` finds refs
that a move or a heading change broke. `iref` is the short name of the
`interref` CLI. Install it with `npm install --global @normal-computing/interref`
(Node 22 or later), or run `npx @normal-computing/interref <command>`.

`iref --guide` prints a sample skill file and may be different in different CLI versions.

## Write a ref

```text
iref:/path/from/repo/root
iref:./relative/to/this/file
iref:../also/relative
iref:/some/doc.md#heading-slug
iref:#heading-in-this-file   (in a Markdown file only)
iref:/some/directory/
```

- Start the path with `/`, `./` or `../`. A bare path (`iref:config.go`) is
  an error.
- Prefer `/` paths from the repo root. They stay correct when the file that
  holds the ref moves, and the reader does not have to count `../`.
- A trailing `/` means that the target must be a directory.
- Paths are case-sensitive and match `git ls-files`. An untracked target
  gives a warning.
- Percent-encode spaces, `#` and `%` in paths (`%20`, `%23`, `%25`).
- The ref stops at whitespace, a quote, a backtick or a bracket. A trailing
  `-->`, `*/` or `. , ; : ! ?` is not part of it. Thus `(iref:/a.md).` and
  `see iref:/a.md, then` are correct.
- To show the syntax without making a ref, write `iref\:`.

### Fragments

Only Markdown heading fragments work. Use the GitHub slug: lower case, remove
punctuation, change each space to `-`, and add `-1`, `-2` to repeated
headings. For example, `## Faults, overflow and reset` becomes
`#faults-overflow-and-reset`. Line fragments (`#L42`) and anchors (`#^name`)
are errors. Point to the most specific heading that the code depends on, not
only to the page.

## Put the ref in a comment

A ref counts only in a comment. The same text in a string, in code or in
Markdown body text is not a ref.

| File | Where to put the ref |
|---|---|
| Python | A `#` comment or a docstring. A module docstring is a good place for the ref of the whole file. An f-string is not a docstring. |
| C, C++, Go, Rust, JS, TS, Java, JSON | `//` or `/* */` |
| Shell, YAML, TOML, Makefile, Dockerfile | `#` |
| Markdown, HTML, XML, SVG | `<!-- iref:/path -->`. A Markdown link, code span or fenced block is not a ref. |
| Other languages | The usual comment syntax of the language, for example `--` in SQL and Lua. |

Do not put a ref in a docstring that the program shows to users, for example
an `argparse` description that uses `__doc__`.

A file type that interref does not know (for example `.txt`) has no refs.

## Choose the protocol

The default protocols are `iref:` and `sync:`. They resolve and check the same
way. The name tells the reader what the link means:

- `sync:` — the two files describe the same thing and must change together.
  For example, a model module and the spec section that it implements, a
  constants module and the spec page that it encodes, or a README section and
  the code that it describes.
- `iref:` — all other links. For example, "see also", a test and the contract
  that it checks, or a decision ID and the decision register.

The `protocols` key in the repo's config file can change this list. Read the
config file before you use another protocol name.

## Put one ref in the downstream file only

Write each link once, in the downstream file: the file that was made from,
depends on or describes the other file. Do not add the reverse ref.
`iref backlinks` shows the other direction.

| Relation | The ref goes in |
|---|---|
| Model or implementation coded from a spec | The model |
| Constants or format module that encodes a spec | The module |
| Test that checks a contract | The test |
| README section that describes code | The README |
| Code comment that names a decision ID | The code |

Do not add lists of refs to README files when Markdown links already show the
same paths. Add a ref only where a broken link must fail the check.

When a comment already names a path in plain text (`see docs/auth.md`), change
that text into a ref (`see iref:/docs/auth.md`) instead of adding a second
mention.

## Commands

Run the commands from anywhere in the repo. Give path arguments relative to the
current directory, not to the repo root. Paths in the output are relative to the
repo root.

| Command | Use |
|---|---|
| `iref check [<path>...]` | Find broken refs. Exit 1 if there is one. Each error tells the rule and, if possible, a fix. |
| `iref links <file>` | Show the refs in a file and their targets. |
| `iref links <file> --to <file>` | Show only the refs that reach the second file. Add `-r` to see each chain. |
| `iref backlinks <file-or-dir>` | Show the refs in the repo that point to the file or directory. Give a path without `#fragment`. |
| `iref graph [<file>] --format mermaid` | Show the link graph. Other formats: `dot` (default), `json`, `drawio`. |

Useful options: `-r` (follow refs transitively), `--depth N`, `-C N` (show
lines around each ref), `-T N` (show the first N lines of the target),
`--format json`.

## Procedures

### Add refs

1. Read the config file at the repo root for `protocols` and `exclude`. Its
   name is `interref.toml`, `.interref.toml`, `interref.json` or
   `.interref.json`. Two config files is an error.
2. For each link, find the downstream file and the most specific target
   heading.
3. Write the ref in a comment in the downstream file. Match the comment style
   of the file.
4. If a target file is new, `git add` it. `iref check` gets the file list from
   git.
5. Run `iref check`. Fix all errors.
6. Run the project's tests and docs build. A changed docstring or an HTML
   comment can change output that a check reads.

### Move or rename a file or a heading

1. Before the change, run `iref backlinks <path>` and record the refs. To
   move a file, also run `iref links <path>`: its `./` and `../` refs can
   break.
2. Make the change. Use `git mv`, or `git add` the new path. If git does not
   know the new path, `iref check` gives wrong errors and no fixes.
3. Run `iref check` with no paths. `iref check <path>` checks only the refs
   in that path, not the refs that point to it.
4. Use the suggested fix in each error, or update the refs that you recorded
   in step 1.

### Change a file that has sync refs

1. Run `iref links <file>` and `iref backlinks <file>`.
2. For each `sync:` link, read the other file and update it to agree with your
   change.

### Find the code for a spec section

Run `iref backlinks <spec.md>`. Each line shows the file, the line and the
heading fragment, so you can filter by `#heading-slug`.

## Rules

| Rule | Error when |
|---|---|
| `missing-file` | The target does not exist, or a trailing `/` names a file. |
| `missing-anchor` | The heading is not in the target, or the target is not Markdown. |
| `unsupported-fragment` | The fragment is `#L…` or `#^…`. |
| `bare-path` | The path does not start with `/`, `./` or `../`. |
| `escapes-root` | `..` goes above the repo root. |
| `case-mismatch` | The path differs from a repo path only in case. |
| `invalid-encoding` | The percent-encoding is bad. |
| `reserved-authority` | The ref uses `iref://`, which is kept for cross-repo refs. |
| `target-ignored` (warning) | The target is untracked or ignored by git. |

## CI

`iref check` exits 1 if a ref is broken. In GitHub Actions, after checkout and
Node 22 setup:

```yaml
- run: npx --yes @normal-computing/interref check
```
