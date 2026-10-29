---
name: iref
description: Add, edit and check interref links (iref:, sync:) between files of a git repo. Use when you write a comment that points to another file, spec section or doc heading; when two files must stay in sync (for example a spec and its model); when you move, rename or delete a file or heading in a repo that has refs; when you review a change or a pull request for inconsistency between linked files; or when you run `iref check`, `iref links`, `iref backlinks` or `iref graph`.
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
| `iref links <file>...` | Show the refs in the files and their targets. Exit 1 if one is broken. |
| `iref links <file> --to <file>` | Show only the refs that reach the second file. Add `-r` to see each chain. |
| `iref backlinks <path>...` | Show the refs in the repo that point to the files or directories. Exit 1 if one is broken. Give a path without `#fragment`. |
| `... \| iref links -` | Read the paths from stdin, one on each line or NUL-separated. Also for `backlinks` and `check`. A path from stdin that does not exist is not an error. |
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
4. Run `iref check`. Fix all errors. A new target file gives a
   `target-ignored` warning until you `git add` it.
5. Run the project's tests and docs build. A changed docstring or an HTML
   comment can change output that a check reads.

### Move or rename a file or a heading

1. Before the change, run `iref backlinks <path>` and record the refs. To
   move a file, also run `iref links <path>`: its `./` and `../` refs can
   break.
2. Make the change.
3. Run `iref check` with no paths. `iref check <path>` checks only the refs
   in that path, not the refs that point to it.
4. Use the suggested fix in each error, or update the refs that you recorded
   in step 1.

### Change a file that has sync refs

1. Run `iref links <file>` and `iref backlinks <file>`.
2. For each `sync:` link, read the other file and update it to agree with your
   change.

### Check a set of changes for inconsistency

Use this procedure to review a branch, a pull request or uncommitted changes.
It finds the broken refs in or to the changed files, and the `sync:` links
where one side changed and the other side possibly did not.

git lists the changed files, and iref reads the list from stdin (`-`). The
`changed` function lists the files that changed since the merge base: the
commits, the uncommitted changes and the new untracked files. `--no-renames`
keeps the old path of a moved file, so the refs to the old path show. For a
branch or a pull request, use its base branch, for example `origin/main`. For
only the uncommitted changes, use `HEAD` in place of the merge base. Each shell
call is new, so define `changed` in the same call as the commands that use it.

```sh
cd "$(git rev-parse --show-toplevel)"
changed() { git diff -z --name-only --no-renames "$(git merge-base origin/main HEAD)"; git ls-files -z --others --exclude-standard; }
changed | iref links -       # refs in the changed files: the source changed
changed | iref backlinks -   # refs to the changed files: the target changed
```

1. Run the two commands. Each one exits 1 if a ref that it lists is broken.
   Fix the broken refs. `iref check` with no paths shows all problems, also the
   ones that were there before the change. Do not fix those unless the user
   asks.
2. Keep only the `sync:` links: add `| grep '  sync:'` to each command. A line
   that is in the output of both commands is a link where both sides changed:
   `{ changed | iref links -; changed | iref backlinks -; } | sort | uniq -d`.
   If the config file adds protocols, find out what they mean. Add each one
   that means "change together" to the pattern, for example
   `grep -E '  (sync|spec):'`.
3. For each link, read the two sides. If the ref has a heading, only that
   section of the target counts. A change in a different section does not
   affect the link.
   - If one side changed, read its diff
     (`git diff "$(git merge-base origin/main HEAD)" -- <file>`), or the whole
     file if it is new. Then read the other side. Add `-T 40` to the commands
     to see the start of each target section. Decide if the change makes the
     other side wrong.
   - If both sides changed, read both diffs and make sure that they agree.
   - A change that keeps the meaning needs no change on the other side. For
     example: new wording, new formatting, or a typed value replaced by a
     generated value.
4. Do the same for an `iref:` link only when the change removes or changes
   something that the other file depends on. For example, a test that checks a
   rule that the change removed.
5. Report each link in one of three groups: agrees, must change (tell what to
   change), or not sure (tell why).

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
