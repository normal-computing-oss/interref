// Bundles the extension and @nref/core (from its TypeScript source) into one CommonJS file.
import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  conditions: ["source"],
  sourcemap: true,
  logLevel: "warning",
});
