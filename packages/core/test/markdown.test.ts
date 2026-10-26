import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractHeadings, renderHeadingText, slugify } from "../src/markdown.js";

const slugs = (markdown: string): string[] => extractHeadings(markdown).map((heading) => heading.slug);

describe("slugify", () => {
  it("follows the GitHub rules", () => {
    assert.equal(slugify("U200 RowCopy timing example"), "u200-rowcopy-timing-example");
    assert.equal(slugify("Memory Controller & Compute Unit"), "memory-controller--compute-unit");
    assert.equal(slugify("What's new? (v2.0)"), "whats-new-v20");
    assert.equal(slugify("snake_case — and dashes"), "snake_case--and-dashes");
    assert.equal(slugify("Größe ändern"), "größe-ändern");
    assert.equal(slugify("🚀 Launch"), "-launch");
  });
});

describe("renderHeadingText", () => {
  it("removes inline markup", () => {
    assert.equal(renderHeadingText("The `tRCD` **window**"), "The tRCD window");
    assert.equal(renderHeadingText("[Link](http://x) and ![img](a.png)"), "Link and img");
    assert.equal(renderHeadingText("_em_ and __init__ and a_b"), "em and init and a_b");
    assert.equal(renderHeadingText("`__init__`"), "__init__");
    assert.equal(renderHeadingText("a &amp; b <br/>"), "a & b");
    assert.equal(renderHeadingText("\\*literal\\*"), "*literal*");
  });
});

describe("extractHeadings", () => {
  it("reads ATX headings and closing hashes", () => {
    const headings = extractHeadings("# Title\n\ntext\n\n## Section ##\n###not a heading\n    # code\n");
    assert.deepEqual(
      headings.map((h) => [h.level, h.slug, h.line]),
      [
        [1, "title", 1],
        [2, "section", 5],
      ],
    );
  });

  it("reads setext headings but not thematic breaks", () => {
    assert.deepEqual(slugs("Title\n=====\n\npara\n---\n\n---\n\n- item\n---\n"), ["title", "para"]);
  });

  it("skips fenced code, front matter and HTML comments", () => {
    const markdown = [
      "---",
      "title: x",
      "---",
      "# Real",
      "```bash",
      "# not a heading",
      "```",
      "~~~~",
      "```",
      "# still code",
      "~~~~",
      "<!--",
      "# commented out",
      "-->",
      "## After",
    ].join("\n");
    assert.deepEqual(slugs(markdown), ["real", "after"]);
  });

  it("numbers repeated slugs like GitHub", () => {
    assert.deepEqual(slugs("# A\n# A\n# A-1\n# A"), ["a", "a-1", "a-1-1", "a-2"]);
  });
});
