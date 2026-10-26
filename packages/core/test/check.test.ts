import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { checkText, scanRepo } from "../src/check.js";
import { RefGraph } from "../src/graph.js";
import { Repo } from "../src/repo.js";
import { makeRepo } from "./fixture.js";

describe("checkText", () => {
  let fixture: ReturnType<typeof makeRepo>;
  let repo: Repo;

  before(async () => {
    fixture = makeRepo(
      {
        ".gitignore": "build/\n",
        "docs/auth.md": "# Auth\n\n## Token lifetime\n\nText.\n",
        "docs/tokens.md": "<!-- Implemented in nref:../src/auth/session.ts -->\n",
        "src/auth/session.ts": "// Token TTL must match nref:/docs/auth.md#token-lifetime\n",
        "src/db/config.go": "package db\n",
        "src/db/pool.go": "// nref:./config.go\n",
        "src/Readme.md": "# Readme\n",
      },
      { "notes/draft.md": "# Draft\n", "build/out.txt": "x\n" },
    );
    repo = await Repo.open(fixture.root);
  });
  after(() => fixture.dispose());

  const check = (source: string, text: string) => checkText(repo, source, text);
  const only = (source: string, text: string) => {
    const [record] = check(source, text);
    assert.ok(record);
    return record;
  };

  it("accepts files, directories and headings", () => {
    const record = only("src/auth/session.ts", "x nref:/docs/auth.md#token-lifetime");
    assert.equal(record.status, "ok");
    assert.deepEqual(record.target, {
      path: "docs/auth.md",
      kind: "file",
      fragment: { kind: "heading", slug: "token-lifetime" },
      line: 3,
    });
    assert.deepEqual(record.source, { path: "src/auth/session.ts", line: 1, col: 3 });
    assert.equal(only("docs/auth.md", "nref:../src/").target?.kind, "directory");
    assert.equal(only("docs/auth.md", "nref:/").target?.path, "");
    assert.equal(only("docs/auth.md", "nref:#auth").status, "ok");
  });

  it("reports missing files with suggestions in the same style", () => {
    const record = only("src/db/pool.go", "nref:./confg.go");
    assert.equal(record.rule, "missing-file");
    assert.deepEqual(record.suggestions, ["nref:./config.go"]);
    assert.deepEqual(only("docs/a.md", "nref:/lib/session.ts").suggestions, ["nref:/src/auth/session.ts"]);
  });

  it("reports bare paths, case mismatches and the reserved authority", () => {
    const bare = only("src/db/pool.go", "nref:config.go#x");
    assert.equal(bare.rule, "bare-path");
    assert.deepEqual(bare.suggestions, ["nref:./config.go#x"]);
    const cased = only("docs/a.md", "nref:/src/readme.md");
    assert.equal(cased.rule, "case-mismatch");
    assert.deepEqual(cased.suggestions, ["nref:/src/Readme.md"]);
    assert.equal(only("docs/a.md", "nref://other/a.md").rule, "reserved-authority");
    assert.equal(only("docs/a.md", "nref:../../x").rule, "escapes-root");
  });

  it("checks heading fragments", () => {
    const missing = only("docs/tokens.md", "nref:./auth.md#token-lifetimes");
    assert.equal(missing.rule, "missing-anchor");
    assert.deepEqual(missing.suggestions, ["nref:./auth.md#token-lifetime"]);
    assert.equal(missing.target?.path, "docs/auth.md");
    assert.deepEqual(only("docs/tokens.md", "nref:./auth.md#tok").suggestions, ["nref:./auth.md#token-lifetime"]);
    assert.equal(only("docs/a.md", "nref:/src/db/pool.go#x").rule, "missing-anchor");
    assert.equal(only("docs/a.md", "nref:/src/#x").rule, "missing-anchor");
  });

  it("rejects line and anchor fragments for now", () => {
    const line = only("docs/a.md", "nref:/src/db/pool.go#L3");
    assert.equal(line.rule, "unsupported-fragment");
    assert.deepEqual(line.suggestions, ["nref:/src/db/pool.go"]);
    assert.equal(only("docs/a.md", "nref:/src/db/pool.go#^name").rule, "unsupported-fragment");
  });

  it("warns about untracked and ignored targets", () => {
    const untracked = only("docs/a.md", "nref:/notes/draft.md#draft");
    assert.equal(untracked.status, "warn");
    assert.equal(untracked.rule, "target-ignored");
    assert.equal(only("docs/a.md", "nref:/build/out.txt").rule, "target-ignored");
    assert.equal(only("docs/a.md", "nref:/build/").status, "warn");
  });

  it("requires a directory after a trailing slash", () => {
    assert.equal(only("docs/a.md", "nref:/docs/auth.md/").rule, "missing-file");
  });
});

describe("scanRepo and RefGraph", () => {
  let fixture: ReturnType<typeof makeRepo>;
  let repo: Repo;

  before(async () => {
    fixture = makeRepo({
      "a.md": "<!-- nref:./b.md nref:./c.md -->\n",
      "b.md": "<!-- nref:./c.md nref:./a.md -->\n",
      "c.md": "# C\n",
      "image.bin": "\0binary nref:./a.md",
    });
    repo = await Repo.open(fixture.root);
  });
  after(() => fixture.dispose());

  it("scans text files only", () => {
    const scan = scanRepo(repo);
    assert.equal(scan.filesScanned, 3);
    assert.equal(scan.records.length, 4);
  });

  it("answers outgoing, incoming and path queries", () => {
    const graph = new RefGraph(scanRepo(repo).records);
    assert.deepEqual(graph.neighbours("a.md"), ["b.md", "c.md"]);
    assert.deepEqual(graph.neighbours("c.md", true), ["a.md", "b.md"]);
    assert.deepEqual(graph.pathsBetween("a.md", "c.md", 5), [
      ["a.md", "c.md"],
      ["a.md", "b.md", "c.md"],
    ]);
    assert.deepEqual(graph.pathsBetween("a.md", "c.md", 1), [["a.md", "c.md"]]);
  });
});
