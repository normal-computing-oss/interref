import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LineIndex, scanRefs } from "../src/syntax.js";

const raws = (text: string): string[] => scanRefs(text).map((ref) => ref.raw);

describe("scanRefs", () => {
  it("finds refs in comments of any language", () => {
    assert.deepEqual(raws("// see iref:./retry.ts#backoff"), ["iref:./retry.ts#backoff"]);
    assert.deepEqual(raws("# schema: iref:/db/schema.sql"), ["iref:/db/schema.sql"]);
    assert.deepEqual(raws("-- mirrored in iref:/src/models/user.py"), ["iref:/src/models/user.py"]);
  });

  it("splits path and fragment", () => {
    const [ref] = scanRefs("x iref:../api.md#auth y");
    assert.equal(ref?.path, "../api.md");
    assert.equal(ref?.fragment, "auth");
    assert.equal(ref?.start, 2);
    assert.equal(ref?.end, 2 + "iref:../api.md#auth".length);
  });

  it("trims comment ends and sentence punctuation", () => {
    assert.deepEqual(raws("<!--iref:./a.md-->"), ["iref:./a.md"]);
    assert.deepEqual(raws("<!-- iref:./a.md#intro-->"), ["iref:./a.md#intro"]);
    assert.deepEqual(raws("/*iref:./a.ts*/"), ["iref:./a.ts"]);
    assert.deepEqual(raws("see iref:./a.md."), ["iref:./a.md"]);
    assert.deepEqual(raws("see iref:./a.md#b, and iref:/c/!"), ["iref:./a.md#b", "iref:/c/"]);
    assert.deepEqual(raws("(iref:/a.md#x):"), ["iref:/a.md#x"]);
    assert.deepEqual(raws("iref:./a.md#."), ["iref:./a.md"]);
  });

  it("stops at quotes, brackets and whitespace", () => {
    assert.deepEqual(raws('"iref:/a.ts" `iref:/b.ts` [iref:/c.ts] {iref:/d.ts}'), [
      "iref:/a.ts",
      "iref:/b.ts",
      "iref:/c.ts",
      "iref:/d.ts",
    ]);
  });

  it("needs a boundary before the prefix", () => {
    assert.deepEqual(raws("xiref:/a.ts my-iref:/a.ts _iref:/a.ts éiref:/a.ts async:/a.ts"), []);
    assert.deepEqual(raws("ref:/a.ts nref:/a.ts"), []);
  });

  it("finds each protocol and records which one", () => {
    const found = scanRefs("iref:./b.md sync:../c.md#x");
    assert.deepEqual(
      found.map((ref) => [ref.protocol, ref.path, ref.fragment]),
      [
        ["iref", "./b.md", undefined],
        ["sync", "../c.md", "x"],
      ],
    );
  });

  it("uses only the given protocols", () => {
    const scan = (text: string, protocols: string[]): string[] => scanRefs(text, protocols).map((ref) => ref.raw);
    assert.deepEqual(scan("iref:/a.ts nref:/b.ts.", ["nref"]), ["nref:/b.ts"]);
    assert.deepEqual(scan("iref:/a.ts ref:/b.ts", ["ref"]), ["ref:/b.ts"]);
    assert.deepEqual(scan("my.ref:/a.ts myxref:/b.ts", ["my.ref"]), ["my.ref:/a.ts"]);
    assert.deepEqual(scan("<!--x+y:-->", ["x+y"]), ["x+y:"]);
  });

  it("does not match the escaped form", () => {
    assert.deepEqual(raws("write iref\\:/path to show the syntax"), []);
  });

  it("keeps a lone prefix as a ref to the same file", () => {
    assert.deepEqual(raws("the `iref:` prefix"), ["iref:"]);
    assert.deepEqual(raws("ends with iref:"), ["iref:"]);
  });
});

describe("LineIndex", () => {
  it("maps offsets to 1-based lines and columns", () => {
    const index = new LineIndex("ab\ncd\r\nef");
    assert.deepEqual(index.position(0), { line: 1, col: 1 });
    assert.deepEqual(index.position(4), { line: 2, col: 2 });
    assert.deepEqual(index.position(7), { line: 3, col: 1 });
    assert.equal(index.lineText(2), "cd");
    assert.equal(index.lineText(3), "ef");
    assert.equal(index.lineCount, 3);
  });
});
