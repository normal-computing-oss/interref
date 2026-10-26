// Releases the CLI and the VS Code extension from this machine. Both get the same version.
//
//   pnpm release 0.2.0              npm dist-tag `latest`
//   pnpm release 0.3.0-beta.1       npm dist-tag `beta` (the word after the -); a GitHub prerelease
//   pnpm release 0.2.0 --dry-run    do all the checks and builds, then undo them; publish nothing
//
// Steps: checks, set the versions, `pnpm check`, pack, commit and tag, npm publish, git push,
// GitHub release. If a step before the npm publish fails, the script undoes the commit and the tag.
// If a step after the npm publish fails, the script shows the commands that are still to do.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

/** @type {(message: string) => never} */
const fail = (message) => {
  console.error(`\nrelease: ${message}`);
  process.exit(1);
};
/** Runs a command and shows its output. Throws if the command fails. */
/** @type {(command: string, args: string[], cwd?: string) => void} */
const run = (command, args, cwd = ".") => {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", cwd });
};
/** @type {(command: string, ...args: string[]) => string} */
const output = (command, ...args) => execFileSync(command, args, { encoding: "utf8" }).trim();
/** @type {(command: string, ...args: string[]) => boolean} */
const succeeds = (command, ...args) => {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const version = args.find((arg) => !arg.startsWith("--")) ?? "";
if (!/^\d+\.\d+\.\d+(-[A-Za-z][0-9A-Za-z]*(\.[0-9A-Za-z]+)*)?$/.test(version)) {
  fail("give a version such as 0.2.0 or 0.3.0-beta.1");
}
const tag = `v${version}`;
const prerelease = version.includes("-");
const distTag = /-([A-Za-z][0-9A-Za-z]*)/.exec(version)?.[1] ?? "latest";
const cli = /** @type {{ name: string }} */ (JSON.parse(readFileSync("packages/cli/package.json", "utf8")));
const tarball = `release/${cli.name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
const vsix = `release/interref-${version}.vsix`;

console.log(`Checking before the release of ${tag}${dryRun ? " (dry run)" : ""}...`);
if (output("git", "branch", "--show-current") !== "main") fail("release from the main branch");
if (output("git", "status", "--porcelain")) fail("commit or stash your changes first");
run("git", ["fetch", "--quiet", "--tags", "origin", "main"]);
const start = output("git", "rev-parse", "HEAD");
if (start !== output("git", "rev-parse", "origin/main")) fail("main is not the same as origin/main; pull or push first");
if (output("git", "tag", "--list", tag)) fail(`tag ${tag} exists`);
if (!succeeds("npm", "whoami")) fail("log in to npm first: npm login");
if (succeeds("npm", "view", `${cli.name}@${version}`, "version")) fail(`npm has ${cli.name}@${version}`);
if (!succeeds("gh", "auth", "status")) fail("log in to GitHub first: gh auth login");

const undo = () => {
  execFileSync("git", ["reset", "--quiet", "--hard", start]);
  if (output("git", "tag", "--list", tag)) execFileSync("git", ["tag", "--delete", tag]);
};

try {
  for (const file of readdirSync("packages").map((dir) => `packages/${dir}/package.json`)) {
    const manifest = /** @type {{ version: string }} */ (JSON.parse(readFileSync(file, "utf8")));
    manifest.version = version;
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  run("pnpm", ["check"]);

  rmSync("release", { recursive: true, force: true });
  mkdirSync("release");
  run("pnpm", ["pack", "--pack-destination", "../../release"], "packages/cli");
  run("pnpm", ["--filter", "vscode-interref", "package"]);
  copyFileSync("packages/vscode/interref.vsix", vsix);

  run("git", ["commit", "--quiet", "--all", "--message", `Release ${tag}`]);
  run("git", ["tag", "--annotate", tag, "--message", tag]);
  run("npm", ["publish", `./${tarball}`, "--tag", distTag, ...(dryRun ? ["--dry-run"] : [])]);
} catch {
  undo();
  fail("a step failed, so nothing was published. The commit and the tag are undone.");
}

const after = [
  ["git", "push", "--atomic", "origin", "main", tag],
  ["gh", "release", "create", tag, tarball, vsix, "--verify-tag", "--generate-notes", ...(prerelease ? ["--prerelease"] : [])],
];
if (dryRun) {
  undo();
  console.log(`\nDry run done. The commit and the tag are undone. A real release would also run:`);
  for (const step of after) console.log(`  ${step.join(" ")}`);
  process.exit(0);
}
for (const [index, [command = "", ...rest]] of after.entries()) {
  try {
    run(command, rest);
  } catch {
    const todo = after.slice(index).map((step) => `  ${step.join(" ")}`);
    fail(`npm has ${cli.name}@${version}, but this step failed. Fix the problem, then run:\n${todo.join("\n")}`);
  }
}
console.log(`\nReleased ${tag}: npm ${cli.name}@${version} (${distTag}) and the GitHub release.`);
