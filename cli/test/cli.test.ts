import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.js");

let root = "";

function refs(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "refs-cli-")));
  const files: Record<string, string> = {
    "docs/auth.md": "# Auth\n\n## Token lifetime\n\n<!-- see nref:./tokens.md -->\n",
    "docs/tokens.md": "## Tokens\n\n<!-- Implemented in nref:../src/session.ts -->\n",
    "src/session.ts": "// TTL must match nref:/docs/auth.md#token-lifetime\nexport const ttl = 15;\n",
    "src/pool.go": "// nref:./config.go and nref:/docs/auth.md#token-lifetimes\n",
    "refs.toml": 'exclude = ["fixtures/**"]\n',
    "fixtures/example.md": "nref:/does/not/exist\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("refs check", () => {
  it("reports broken refs and exits 1", () => {
    const { code, stdout } = refs("check");
    assert.equal(code, 1);
    assert.match(stdout, /^src\/pool\.go:1:4 {2}error {2}nref:\.\/config\.go {2}no such file/mu);
    assert.match(stdout, /#token-lifetimes .*did you mean #token-lifetime\? \[missing-anchor\]/u);
    assert.match(stdout, /2 broken refs \(5 refs in 5 files\)$/mu);
    assert.doesNotMatch(stdout, /fixtures/u);
  });

  it("limits the check to paths and exits 0 when clean", () => {
    const { code, stdout } = refs("check", "docs");
    assert.equal(code, 0);
    assert.match(stdout, /0 broken refs \(2 refs in 2 files\)/u);
  });

  it("writes JSON and SARIF", () => {
    const json: unknown = JSON.parse(refs("check", "--format", "json").stdout);
    assert.ok(Array.isArray(json));
    assert.equal(json.length, 2);
    const sarif: unknown = JSON.parse(refs("check", "--format", "sarif").stdout);
    assert.ok(typeof sarif === "object" && sarif !== null && "version" in sarif && sarif.version === "2.1.0");
  });
});

describe("refs links and backlinks", () => {
  it("lists outgoing refs with their targets and context", () => {
    const { code, stdout } = refs("links", "src/session.ts", "-A", "1");
    assert.equal(code, 0);
    assert.match(stdout, /src\/session\.ts:1:19 {2}nref:\/docs\/auth\.md#token-lifetime {2}-> docs\/auth\.md#token-lifetime \(line 3\)/u);
    assert.match(stdout, /^ {3}2 \| export const ttl = 15;$/mu);
  });

  it("lists backlinks", () => {
    const { stdout } = refs("backlinks", "docs/auth.md");
    assert.deepEqual(stdout.trim().split("\n").map((line) => line.split("  ")[0]), ["src/pool.go:1:25", "src/session.ts:1:19"]);
  });

  it("follows refs recursively", () => {
    const tree = refs("links", "docs/auth.md", "-r").stdout;
    assert.equal(
      tree,
      ["docs/auth.md", "└── docs/tokens.md", "    └── src/session.ts", "        └── docs/auth.md  (cycle)", ""].join("\n"),
    );
    const paths = refs("links", "docs/auth.md", "--to", "src/session.ts", "-r").stdout;
    assert.match(paths, /docs\/auth\.md -> docs\/tokens\.md -> src\/session\.ts {3}\(2 hops\)/u);
  });

  it("exports the graph", () => {
    const dot = refs("graph").stdout;
    assert.match(dot, /"src\/pool\.go" -> "docs\/auth\.md" \[color=red, style=dashed\];/u);
    const mermaid = refs("graph", "docs/tokens.md", "--format", "mermaid").stdout;
    assert.match(mermaid, /^graph LR$/mu);
    assert.doesNotMatch(mermaid, /pool\.go/u);
    const xml = refs("graph", "--format", "drawio").stdout;
    assert.match(xml, /^<mxfile host="refs">/u);
    assert.equal(xml.match(/vertex="1"/gu)?.length, 4);
    assert.equal(xml.match(/edge="1"/gu)?.length, 4);
    assert.match(xml, /dashed=1;strokeColor=#b85450;" edge="1"/u);
  });
});

describe("usage errors", () => {
  it("exit 2", () => {
    assert.equal(refs().code, 2);
    assert.equal(refs("nope").code, 2);
    assert.equal(refs("links").code, 2);
    assert.equal(refs("links", "missing.md").code, 2);
    assert.equal(refs("check", "--format", "xml").code, 2);
    assert.equal(refs("check", "--bogus").code, 2);
  });
});
