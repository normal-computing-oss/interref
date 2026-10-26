import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LineIndex, scanRefs } from "../src/syntax.js";

const raws = (text: string): string[] => scanRefs(text).map((ref) => ref.raw);

describe("scanRefs", () => {
  it("finds refs in comments of any language", () => {
    assert.deepEqual(raws("// see nref:./retry.ts#backoff"), ["nref:./retry.ts#backoff"]);
    assert.deepEqual(raws("# schema: nref:/db/schema.sql"), ["nref:/db/schema.sql"]);
    assert.deepEqual(raws("-- mirrored in nref:/src/models/user.py"), ["nref:/src/models/user.py"]);
  });

  it("splits path and fragment", () => {
    const [ref] = scanRefs("x nref:../api.md#auth y");
    assert.equal(ref?.path, "../api.md");
    assert.equal(ref?.fragment, "auth");
    assert.equal(ref?.start, 2);
    assert.equal(ref?.end, 2 + "nref:../api.md#auth".length);
  });

  it("trims comment ends and sentence punctuation", () => {
    assert.deepEqual(raws("<!--nref:./a.md-->"), ["nref:./a.md"]);
    assert.deepEqual(raws("<!-- nref:./a.md#intro-->"), ["nref:./a.md#intro"]);
    assert.deepEqual(raws("/*nref:./a.ts*/"), ["nref:./a.ts"]);
    assert.deepEqual(raws("see nref:./a.md."), ["nref:./a.md"]);
    assert.deepEqual(raws("see nref:./a.md#b, and nref:/c/!"), ["nref:./a.md#b", "nref:/c/"]);
    assert.deepEqual(raws("(nref:/a.md#x):"), ["nref:/a.md#x"]);
    assert.deepEqual(raws("nref:./a.md#."), ["nref:./a.md"]);
  });

  it("stops at quotes, brackets and whitespace", () => {
    assert.deepEqual(raws('"nref:/a.ts" `nref:/b.ts` [nref:/c.ts] {nref:/d.ts}'), [
      "nref:/a.ts",
      "nref:/b.ts",
      "nref:/c.ts",
      "nref:/d.ts",
    ]);
  });

  it("needs a boundary before the prefix", () => {
    assert.deepEqual(raws("xnref:/a.ts my-nref:/a.ts _nref:/a.ts énref:/a.ts"), []);
    assert.deepEqual(raws("ref:/a.ts $ref: xref:a"), []);
  });

  it("does not match the escaped form", () => {
    assert.deepEqual(raws("write nref\\:/path to show the syntax"), []);
  });

  it("keeps a lone prefix as a ref to the same file", () => {
    assert.deepEqual(raws("the `nref:` prefix"), ["nref:"]);
    assert.deepEqual(raws("ends with nref:"), ["nref:"]);
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
