import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeRefPath, formatRef, parseFragment, resolveTarget } from "../src/resolve.js";

const target = (source: string, path: string): string => {
  const result = resolveTarget(source, path);
  return result.ok ? result.value.path : `!${result.problem.rule}`;
};

describe("resolveTarget", () => {
  it("resolves the proposal examples", () => {
    assert.equal(target("docs/guide/setup.md", "/src/main.ts"), "src/main.ts");
    assert.equal(target("docs/guide/setup.md", "../api.md"), "docs/api.md");
    assert.equal(target("src/db/pool.go", "./config.go"), "src/db/config.go");
    assert.equal(target("src/db/pool.go", ""), "src/db/pool.go");
    assert.equal(target("src/db/pool.go", "config.go"), "!bare-path");
  });

  it("rejects the reserved authority form and climbing above the root", () => {
    assert.equal(target("a.md", "//repo/a.md"), "!reserved-authority");
    assert.equal(target("a.md", "../b.md"), "!escapes-root");
    assert.equal(target("x/a.md", "/../b.md"), "!escapes-root");
  });

  it("normalises dot segments and decodes percent-encoding", () => {
    assert.equal(target("x/y/a.md", "./../z/./b%20c.md"), "x/z/b c.md");
    assert.equal(target("a.md", "/"), "");
    assert.equal(target("a.md", "/%E0%A4"), "!invalid-encoding");
  });

  it("records a trailing slash", () => {
    const result = resolveTarget("a.md", "/docs/");
    assert.ok(result.ok);
    assert.equal(result.value.trailingSlash, true);
  });
});

describe("parseFragment", () => {
  it("accepts heading slugs only", () => {
    assert.deepEqual(parseFragment("token-lifetime"), { ok: true, value: { kind: "heading", slug: "token-lifetime" } });
    const line = parseFragment("L40-L72");
    assert.ok(!line.ok && line.problem.rule === "unsupported-fragment");
    const anchor = parseFragment("^token-ttl");
    assert.ok(!anchor.ok && anchor.problem.rule === "unsupported-fragment");
  });

  it("decodes encoded slugs", () => {
    assert.deepEqual(parseFragment("gr%C3%B6%C3%9Fe"), { ok: true, value: { kind: "heading", slug: "größe" } });
  });
});

describe("formatRef", () => {
  it("writes each style", () => {
    assert.equal(formatRef("docs/a.md", "src/b.ts", { style: "absolute" }), "iref:/src/b.ts");
    assert.equal(formatRef("docs/a.md", "src/b.ts", { style: "relative" }), "iref:../src/b.ts");
    assert.equal(formatRef("docs/a.md", "docs/c.md", { style: "relative", slug: "x" }), "iref:./c.md#x");
    assert.equal(formatRef("docs/a.md", "docs/a.md", { style: "self", slug: "x" }), "iref:#x");
    assert.equal(formatRef("docs/a.md", "docs", { style: "relative", directory: true }), "iref:./");
    assert.equal(formatRef("docs/a.md", "", { style: "relative", directory: true }), "iref:../");
    assert.equal(formatRef("a.md", "src", { style: "relative", directory: true }), "iref:./src/");
    assert.equal(formatRef("docs/a.md", "src/b.ts", { style: "absolute", protocol: "sync" }), "sync:/src/b.ts");
  });

  it("encodes characters that would end the ref", () => {
    assert.equal(encodeRefPath("a b#(c).md"), "a%20b%23%28c%29.md");
  });
});
