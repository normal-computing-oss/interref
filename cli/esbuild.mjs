// Bundles the CLI and @interref/core (from its TypeScript source) into one file for npm.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/interref.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  conditions: ["source"],
  logLevel: "warning",
});
