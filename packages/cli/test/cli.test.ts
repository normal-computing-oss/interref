import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Tests run the bundle that npm ships.
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "interref.mjs");

let root = "";

function refs(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "refs-cli-")));
  const files: Record<string, string> = {
    "docs/auth.md": "# Auth\n\n## Token lifetime\n\n<!-- see iref:./tokens.md -->\n",
    "docs/tokens.md": "## Tokens\n\n<!-- Implemented in iref:../src/session.ts -->\n",
    "src/session.ts": "// TTL must match iref:/docs/auth.md#token-lifetime\nexport const ttl = 15;\n",
    "src/pool.go": "// iref:./config.go and iref:/docs/auth.md#token-lifetimes\n",
    ".interref.json": '{ "exclude": ["fixtures/**"] }\n',
    "fixtures/example.md": "iref:/does/not/exist\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("interref check", () => {
  it("reports broken refs and exits 1", () => {
    const { code, stdout } = refs("check");
    assert.equal(code, 1);
    assert.match(stdout, /^src\/pool\.go:1:4 {2}error {2}iref:\.\/config\.go {2}no such file/mu);
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

describe("interref links and backlinks", () => {
  it("lists outgoing refs with their targets and context", () => {
    const { code, stdout } = refs("links", "src/session.ts", "-A", "1");
    assert.equal(code, 0);
    assert.match(stdout, /src\/session\.ts:1:19 {2}iref:\/docs\/auth\.md#token-lifetime {2}-> docs\/auth\.md#token-lifetime \(line 3\)/u);
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
    assert.match(xml, /^<mxfile host="interref">/u);
    assert.equal(xml.match(/vertex="1"/gu)?.length, 4);
    assert.equal(xml.match(/edge="1"/gu)?.length, 4);
    assert.match(xml, /dashed=1;strokeColor=#b85450;" edge="1"/u);
  });
});

describe("many paths and paths from stdin", () => {
  const piped = (input: string, ...args: string[]): { code: number | null; stdout: string } => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", input });
    return { code: result.status, stdout: result.stdout };
  };
  const sources = (stdout: string): string[] => stdout.trim().split("\n").map((line) => line.split("  ")[0] ?? "");

  it("lists the refs of many files, and exits 1 when one of them is broken", () => {
    const { code, stdout } = refs("links", "src/session.ts", "docs/tokens.md");
    assert.equal(code, 0);
    assert.deepEqual(sources(stdout), ["docs/tokens.md:3:21", "src/session.ts:1:19"]);
    assert.equal(refs("links", "src/pool.go").code, 1);
  });

  it("reads paths from stdin, one on each line or NUL-separated", () => {
    assert.deepEqual(sources(piped("docs/auth.md\ndocs/tokens.md\n", "backlinks", "-").stdout), [
      "docs/auth.md:5:10",
      "src/pool.go:1:25",
      "src/session.ts:1:19",
    ]);
    assert.deepEqual(sources(piped("src/session.ts\0docs/tokens.md\0", "links", "-").stdout), [
      "docs/tokens.md:3:21",
      "src/session.ts:1:19",
    ]);
  });

  it("finds refs to a path from stdin that does not exist, and skips it in links and check", () => {
    const { code, stdout } = piped("src/config.go\n", "backlinks", "-");
    assert.equal(code, 1);
    assert.match(stdout, /^src\/pool\.go:1:4 {2}iref:\.\/config\.go {2}error missing-file/u);
    assert.equal(piped("src/config.go\n", "links", "-").code, 0);
    assert.match(piped("src/config.go\n", "check", "-").stdout, /0 broken refs \(0 refs in 0 files\)/u);
    assert.equal(refs("backlinks", "src/config.go").code, 2);
  });

  it("prints the same line for a ref in links and in backlinks", () => {
    const line = (stdout: string): string | undefined => stdout.split("\n").find((l) => l.startsWith("src/session.ts:"));
    assert.equal(line(refs("links", "src/session.ts").stdout), line(refs("backlinks", "docs/auth.md").stdout));
  });

  it("accepts - only as the one path", () => {
    assert.equal(piped("", "links", "-", "src/session.ts").code, 2);
    assert.equal(piped("", "links", "-r", "-").code, 2);
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

  it("use the short name iref when the CLI runs as iref", () => {
    const bin = mkdtempSync(join(tmpdir(), "refs-bin-"));
    try {
      symlinkSync(CLI, join(bin, "iref"));
      const result = spawnSync(process.execPath, [join(bin, "iref"), "nope"], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /^iref: unknown command "nope"\nRun iref --help for usage\.$/mu);
      assert.match(refs("nope").stderr, /^interref: unknown command/u);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("interref --version and install-extension", () => {
  const run = (...args: string[]): { code: number | null; stdout: string; stderr: string } => {
    const env = { ...process.env, INTERREF_NO_UPDATE_CHECK: "1" };
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const manifest = JSON.parse(readFileSync(join(dirname(CLI), "..", "package.json"), "utf8")) as { version: string };

  it("prints the version from package.json", () => {
    for (const flag of ["--version", "-v"]) {
      const { code, stdout, stderr } = run(flag);
      assert.equal(code, 0);
      assert.equal(stdout, `${manifest.version}\n`);
      assert.equal(stderr, "");
    }
  });

  it("prints the agent guide from skills/iref/SKILL.md with the version in its frontmatter, also outside a repo", () => {
    const skill = readFileSync(join(dirname(CLI), "..", "..", "..", "skills", "iref", "SKILL.md"), "utf8");
    const result = spawnSync(process.execPath, [CLI, "--guide"], { cwd: tmpdir(), encoding: "utf8", env: { ...process.env, INTERREF_NO_UPDATE_CHECK: "1" } });
    assert.equal(result.status, 0);
    assert.match(skill, /^---\nname: iref\n/u);
    const end = skill.indexOf("\n---\n", 4);
    const metadata = `\nmetadata:\n  interref-version: "${manifest.version}"`;
    assert.equal(result.stdout, `${skill.slice(0, end)}${metadata}${skill.slice(end)}`);
  });

  it("exits 2 when the editor command does not exist", () => {
    const { code, stderr } = run("install-extension", "--editor", "no-such-editor-command");
    assert.equal(code, 2);
    assert.match(stderr, /^interref: cannot run "no-such-editor-command"\./u);
  });
});
