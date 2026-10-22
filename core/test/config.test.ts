import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkText } from "../src/check.js";
import { ConfigError, excluder, globToRegExp, parseConfig } from "../src/config.js";
import { Repo } from "../src/repo.js";

describe("parseConfig", () => {
  it("reads exclude globs and rule settings", () => {
    const config = parseConfig(
      [
        "# refs config",
        'exclude = ["vendor/**", "**/*.min.js",',
        "  'testdata/**'] # trailing comment",
        "",
        "[rules]",
        'target-ignored = "off"',
        'missing-anchor = "warn"',
      ].join("\n"),
    );
    assert.deepEqual(config.exclude, ["vendor/**", "**/*.min.js", "testdata/**"]);
    assert.deepEqual(config.rules, { "target-ignored": "off", "missing-anchor": "warn" });
  });

  it("rejects unknown keys, rules and settings", () => {
    assert.throws(() => parseConfig("include = []"), ConfigError);
    assert.throws(() => parseConfig('[rules]\nline-reff = "off"'), ConfigError);
    assert.throws(() => parseConfig('[rules]\nmissing-file = "loud"'), ConfigError);
    assert.throws(() => parseConfig("[other]"), ConfigError);
  });
});

describe("globs", () => {
  it("matches whole repo paths", () => {
    assert.ok(globToRegExp("vendor/**").test("vendor/a/b.js"));
    assert.ok(globToRegExp("**/*.min.js").test("a.min.js"));
    assert.ok(globToRegExp("**/*.min.js").test("x/y/a.min.js"));
    assert.ok(!globToRegExp("*.js").test("x/a.js"));
    assert.ok(globToRegExp("tools/*/test").test("tools/nref/test/a.ts"));
    assert.ok(!globToRegExp("a.b").test("axb"));
    const excluded = excluder({ exclude: ["docs/"], rules: {} });
    assert.ok(excluded("docs/a.md") && !excluded("docsx/a.md"));
  });
});

describe("rule settings", () => {
  it("turn rules off or change their severity", () => {
    const repo = new Repo("/nowhere", ["a.md"], [], () => undefined, {
      exclude: ["skip/**"],
      rules: { "missing-file": "warn", "bare-path": "off" },
    });
    const [missing, bare] = checkText(repo, "a.md", "nref:/b.md nref:b.md");
    assert.equal(missing?.status, "warn");
    assert.equal(bare?.status, "ok");
    assert.equal(bare?.rule, undefined);
    assert.deepEqual(checkText(repo, "skip/x.md", "nref:/b.md"), []);
  });
});
