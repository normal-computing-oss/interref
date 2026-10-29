// Bundles the CLI and @interref/core (from its TypeScript source) into one file for npm.
// The bundle also holds the version and the agent guide (skills/iref/SKILL.md) for --guide.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import manifest from "./package.json" with { type: "json" };

// The guide's frontmatter gets the CLI version, so an agent can compare a saved skill with `iref --version`.
const skill = readFileSync(new URL("../../skills/iref/SKILL.md", import.meta.url), "utf8");
const frontmatterEnd = skill.indexOf("\n---\n", 4);
if (!skill.startsWith("---\n") || frontmatterEnd === -1 || /^metadata:/mu.test(skill.slice(0, frontmatterEnd))) {
  throw new Error("skills/iref/SKILL.md must start with a frontmatter that has no metadata key");
}
const guide = `${skill.slice(0, frontmatterEnd)}\nmetadata:\n  interref-version: "${manifest.version}"${skill.slice(frontmatterEnd)}`;

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/interref.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  conditions: ["source"],
  define: {
    INTERREF_VERSION: JSON.stringify(manifest.version),
    INTERREF_GUIDE: JSON.stringify(guide),
  },
  logLevel: "warning",
});
