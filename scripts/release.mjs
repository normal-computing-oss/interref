// Sets one version in all packages, then commits and tags it. Pushing the tag starts
// .github/workflows/release.yml, which publishes the CLI to npm and makes the GitHub release.
// Usage: pnpm release <version>, for example `pnpm release 0.2.0` or `pnpm release 0.3.0-beta.1`.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

/** @type {(message: string) => never} */
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};
/** @type {(...args: string[]) => string} */
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  fail("give a version such as 0.2.0 or 0.3.0-beta.1");
}
const tag = `v${version}`;
if (git("branch", "--show-current") !== "main") fail("release from the main branch");
if (git("status", "--porcelain")) fail("commit or stash your changes first");
if (git("tag", "--list", tag)) fail(`tag ${tag} exists`);

const files = readdirSync("packages").map((dir) => `packages/${dir}/package.json`);
for (const file of files) {
  const manifest = /** @type {{ version: string }} */ (JSON.parse(readFileSync(file, "utf8")));
  manifest.version = version;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

git("add", ...files);
git("commit", "--message", `Release ${tag}`);
git("tag", "--annotate", tag, "--message", tag);
console.log(`Made the commit and the tag ${tag}. To publish, run:\n  git push --follow-tags`);
