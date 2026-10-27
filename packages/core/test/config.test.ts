import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkText } from "../src/check.js";
import { ConfigError, DEFAULT_CONFIG, excluder, globToRegExp, parseConfig } from "../src/config.js";
import { Repo } from "../src/repo.js";
import { makeRepo } from "./fixture.js";

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
    assert.deepEqual(config.protocols, ["iref", "sync"]);
  });

  it("reads protocols", () => {
    assert.deepEqual(parseConfig('protocols = ["ref", "nref"]').protocols, ["ref", "nref"]);
  });

  it("rejects unknown keys, rules and settings", () => {
    assert.throws(() => parseConfig("include = []"), ConfigError);
    assert.throws(() => parseConfig('[rules]\nline-reff = "off"'), ConfigError);
    assert.throws(() => parseConfig('[rules]\nmissing-file = "loud"'), ConfigError);
    assert.throws(() => parseConfig("[other]"), ConfigError);
    assert.throws(() => parseConfig("protocols = []"), ConfigError);
    assert.throws(() => parseConfig('protocols = ["n ref"]'), ConfigError);
    assert.throws(() => parseConfig('protocols = ["1ref"]'), ConfigError);
  });

  it("reads JSON when the file name ends in .json", () => {
    const config = parseConfig(
      JSON.stringify({ exclude: ["vendor/**"], protocols: ["sync"], rules: { "target-ignored": "off" } }),
      ".interref.json",
    );
    assert.deepEqual(config, { exclude: ["vendor/**"], protocols: ["sync"], rules: { "target-ignored": "off" } });
    assert.deepEqual(parseConfig("{}", "interref.json"), DEFAULT_CONFIG);
  });

  it("rejects bad JSON", () => {
    const json = (text: string) => () => parseConfig(text, "interref.json");
    assert.throws(json("{"), ConfigError);
    assert.throws(json("[]"), ConfigError);
    assert.throws(json('{"include": []}'), ConfigError);
    assert.throws(json('{"exclude": "vendor/**"}'), ConfigError);
    assert.throws(json('{"protocols": []}'), ConfigError);
    assert.throws(json('{"rules": {"line-reff": "off"}}'), ConfigError);
    assert.throws(json('{"rules": {"missing-file": 1}}'), ConfigError);
  });
});

describe("config files", () => {
  const open = async (files: Record<string, string>): Promise<Repo> => {
    const fixture = makeRepo(files);
    try {
      return await Repo.open(fixture.root);
    } finally {
      fixture.dispose();
    }
  };

  it("reads a hidden TOML or JSON file", async () => {
    assert.deepEqual((await open({ ".interref.toml": 'protocols = ["a"]\n' })).config.protocols, ["a"]);
    assert.deepEqual((await open({ "interref.json": '{"protocols": ["b"]}' })).config.protocols, ["b"]);
    assert.deepEqual((await open({ ".interref.json": '{"protocols": ["c"]}' })).config.protocols, ["c"]);
    assert.deepEqual((await open({ "a.md": "" })).config, DEFAULT_CONFIG);
  });

  it("rejects more than one config file", async () => {
    await assert.rejects(open({ "interref.toml": "", ".interref.json": "{}" }), /interref\.toml and \.interref\.json/u);
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
    const excluded = excluder({ ...DEFAULT_CONFIG, exclude: ["docs/"] });
    assert.ok(excluded("docs/a.md") && !excluded("docsx/a.md"));
  });
});

describe("rule settings", () => {
  it("turn rules off or change their severity", () => {
    const repo = new Repo("/nowhere", ["a.md"], [], () => undefined, {
      ...DEFAULT_CONFIG,
      exclude: ["skip/**"],
      rules: { "missing-file": "warn", "bare-path": "off" },
    });
    const [missing, bare] = checkText(repo, "a.md", "<!-- iref:/b.md iref:b.md -->");
    assert.equal(missing?.status, "warn");
    assert.equal(bare?.status, "ok");
    assert.equal(bare?.rule, undefined);
    assert.deepEqual(checkText(repo, "skip/x.md", "<!-- iref:/b.md -->"), []);
  });
});
