import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commentSpans, findRefs } from "../src/comments.js";

// In each text, refs that must be found point at /yes…, and refs that must not be found point at /no.
const raws = (path: string, ...lines: string[]): string[] => findRefs(path, lines.join("\n")).map((ref) => ref.raw);

describe("findRefs", () => {
  it("keeps the offsets of the ref in the whole text", () => {
    const text = 'const a = "iref:/no";\n// see iref:/yes.md';
    const [ref] = findRefs("a.ts", text);
    assert.equal(ref?.start, text.indexOf("iref:/yes"));
    assert.equal(ref?.end, text.length);
  });

  it("finds nothing in a file of an unknown language", () => {
    assert.deepEqual(raws("notes.txt", "# iref:/no"), []);
    assert.deepEqual(raws("LICENSE", "// iref:/no"), []);
    assert.equal(commentSpans("data.csv", "x"), undefined);
  });

  it("still does not match the escaped form", () => {
    assert.deepEqual(raws("a.ts", "// iref\\:/no"), []);
  });

  it("uses the given protocols", () => {
    assert.deepEqual(
      findRefs("a.py", "# sync:/yes iref:/no", ["sync"]).map((ref) => ref.raw),
      ["sync:/yes"],
    );
  });
});

describe("comments by language", () => {
  it("JavaScript and TypeScript", () => {
    assert.deepEqual(
      raws(
        "a.ts",
        "// iref:/yes1",
        "/** JSDoc",
        " * iref:/yes2 */",
        'const a = "// iref:/no", b = \'/* iref:/no */\';',
        "const c = `",
        "  // iref:/no",
        "`;",
        "const re = /\"/g; // iref:/yes3",
        "const d = x / 2; // iref:/yes4",
        "const e = /[/*]/u.test(s); const f = 'x'; // iref:/yes5",
      ),
      ["iref:/yes1", "iref:/yes2", "iref:/yes3", "iref:/yes4", "iref:/yes5"],
    );
    assert.deepEqual(raws("a.tsx", "<div>{/* iref:/yes */}</div>", "<p>See https://iref:/no</p>"), ["iref:/yes"]);
    assert.deepEqual(raws("a.tsx", "const e = <span style={{ w: 1 }} />; // iref:/yes"), ["iref:/yes"]);
    assert.deepEqual(
      raws("a.js", "const html = `<p>${items.map((i) => `<li>${i /* iref:/yes1 */}</li>`)}</p> // iref:/no`; // iref:/yes2"),
      ["iref:/yes1", "iref:/yes2"],
    );
  });

  it("Python, with docstrings as comments", () => {
    assert.deepEqual(
      raws(
        "a.py",
        '#!/usr/bin/env python',
        '"""Module docs: iref:/yes1"""',
        "x = 'iref:/no'  # iref:/yes2",
        's = "# iref:/no"',
        'y = """iref:/no"""',
        "def f(a,",
        "      b) -> str:",
        '    r"""Function docs.',
        "",
        "    iref:/yes3",
        '    """',
        "    return g(",
        '        """iref:/no""",',
        "    )",
        "class C:",
        "    '''iref:/yes4'''",
        "TABLE = {}",
        '"""iref:/yes5"""',
        'z = ("a"',
        '     """iref:/no""")',
        'MODE = "x"',
        '"iref:/yes6"',
        'f"""iref:/no"""',
        "items = [",
        '    "iref:/no",',
        "]",
      ),
      ["iref:/yes1", "iref:/yes2", "iref:/yes3", "iref:/yes4", "iref:/yes5", "iref:/yes6"],
    );
  });

  it("C, C++, C#, Java and Go", () => {
    assert.deepEqual(
      raws(
        "a.cpp",
        "auto s = R\"x(// iref:/no)x\"; // iref:/yes1",
        "char q = '\"'; /* iref:/yes2 */",
        "s = \"\\\"// iref:/no\";",
        "case 1://iref:/yes3",
      ),
      ["iref:/yes1", "iref:/yes2", "iref:/yes3"],
    );
    assert.deepEqual(raws("a.cs", 'var p = @"C:\\"; // iref:/yes', 'var r = """', "// iref:/no", '""";'), ["iref:/yes"]);
    assert.deepEqual(raws("A.java", 'String t = """', "  // iref:/no", '  """; // iref:/yes'), ["iref:/yes"]);
    assert.deepEqual(raws("a.go", "s := `// iref:/no` // iref:/yes"), ["iref:/yes"]);
  });

  it("Rust, with lifetimes, raw strings and nested comments", () => {
    assert.deepEqual(
      raws(
        "a.rs",
        "fn f<'a>(x: &'a str) {} // iref:/yes1",
        "let q = b'\"'; // iref:/yes2",
        'let r = r#"// iref:/no " still"#;',
        "/* outer /* inner */ iref:/yes3 */",
      ),
      ["iref:/yes1", "iref:/yes2", "iref:/yes3"],
    );
  });

  it("shell scripts", () => {
    assert.deepEqual(
      raws(
        "a.sh",
        'echo "# iref:/no" # iref:/yes1',
        "echo ${#x} a#iref:/no it\\'s # iref:/yes2",
        "cat <<'EOF'",
        "# iref:/no",
        "EOF",
        "# iref:/yes3",
        "v=\"$(awk '{ print \"x\" }' f)\" # iref:/yes4",
      ),
      ["iref:/yes1", "iref:/yes2", "iref:/yes3", "iref:/yes4"],
    );
    assert.deepEqual(raws("run", "#!/usr/bin/env bash", "# iref:/yes"), ["iref:/yes"]);
  });

  it("Ruby, Perl and PHP", () => {
    assert.deepEqual(
      raws("a.rb", 'puts "#{h["k"]} # iref:/no" # iref:/yes0', "list<<item # iref:/yes1", "text = <<~EOS", "  # iref:/no", "EOS", "=begin", "iref:/yes2", "=end"),
      ["iref:/yes0", "iref:/yes1", "iref:/yes2"],
    );
    assert.deepEqual(raws("a.pl", "my $n = $#list; # iref:/yes"), ["iref:/yes"]);
    assert.deepEqual(raws("a.php", "#[Attr] // iref:/yes1", "$s = '# iref:/no'; # iref:/yes2"), ["iref:/yes1", "iref:/yes2"]);
  });

  it("SQL, Lua and Haskell", () => {
    assert.deepEqual(raws("a.sql", "SELECT '-- iref:/no', $$ -- iref:/no $$; -- iref:/yes"), ["iref:/yes"]);
    assert.deepEqual(raws("a.lua", "s = [[ -- iref:/no ]] --[==[ iref:/yes1 ]==] -- iref:/yes2"), ["iref:/yes1", "iref:/yes2"]);
    assert.deepEqual(raws("a.hs", "a --> b -- iref:/yes1", "{- {- -} iref:/yes2 -}"), ["iref:/yes1", "iref:/yes2"]);
  });

  it("YAML, TOML and JSON", () => {
    assert.deepEqual(
      raws(
        "a.yml",
        'key: "# iref:/no" # iref:/yes1',
        "url: http://x#iref:/no",
        "name: It's # iref:/yes2",
        "run: |",
        "  # iref:/no",
        "next: 1 # iref:/yes3",
        "args:",
        "  - |",
        "    # iref:/no",
        "  - b # iref:/yes4",
      ),
      ["iref:/yes1", "iref:/yes2", "iref:/yes3", "iref:/yes4"],
    );
    assert.deepEqual(raws("a.toml", 'a = "# iref:/no" # iref:/yes'), ["iref:/yes"]);
    assert.deepEqual(raws("a.graphql", '"""iref:/yes"""', 'type A { b(c: "iref:/no"): Int }'), ["iref:/yes"]);
    assert.deepEqual(raws("tsconfig.json", '{ "a": "iref:/no" } // iref:/yes'), ["iref:/yes"]);
  });

  it("Markdown: HTML comments outside code", () => {
    assert.deepEqual(
      raws(
        "a.md",
        "---",
        "title: x # iref:/yes1",
        "---",
        "Text iref:/no and `<!-- iref:/no -->`.",
        "<!-- iref:/yes2 -->",
        "```markdown",
        "<!-- iref:/no -->",
        "```",
        "~~~~",
        "<!-- iref:/no -->",
        "~~~~",
        "A lone ` backtick <!-- iref:/yes3 -->",
      ),
      ["iref:/yes1", "iref:/yes2", "iref:/yes3"],
    );
  });

  it("HTML with script and style", () => {
    assert.deepEqual(
      raws(
        "a.vue",
        "<p>iref:/no</p> <!-- iref:/yes1 -->",
        '<script setup lang="ts">',
        'const s = "iref:/no"; // iref:/yes2',
        "</script>",
        '<style lang="scss">',
        "a { b: url(http://x/iref:/no); } // iref:/yes3",
        "</style>",
      ),
      ["iref:/yes1", "iref:/yes2", "iref:/yes3"],
    );
  });

  it("files known by name or by content", () => {
    assert.deepEqual(raws("Dockerfile", "RUN echo '#iref:/no'", "# iref:/yes"), ["iref:/yes"]);
    assert.deepEqual(raws("Makefile", "a: ; echo \\#iref:/no # iref:/yes1", '\t@echo "# iref:/no" # iref:/yes2'), [
      "iref:/yes1",
      "iref:/yes2",
    ]);
    assert.deepEqual(raws("a.astro", "---", "// iref:/yes1", "---", "<p>{/* iref:/yes2 */}</p>"), ["iref:/yes1", "iref:/yes2"]);
    assert.deepEqual(raws("lib/x.m", "#import <Foundation/Foundation.h>", "// iref:/yes"), ["iref:/yes"]);
    assert.deepEqual(raws("lib/y.m", "x = 'a' % iref:/yes"), ["iref:/yes"]);
  });
});
