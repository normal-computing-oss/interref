// Copies the repo README into packages/cli for the npm package page. `prepack` of the CLI runs it.
// npm shows a relative link such as (LICENSE) or (DEVELOPMENT.md) wrongly, so they become GitHub URLs.
import { readFileSync, writeFileSync } from "node:fs";

const BLOB = "https://github.com/normal-computing-oss/interref/blob/main/";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const linked = readme.replace(/\]\((?![a-z]+:|#)([^)\s]+)\)/gu, (_match, /** @type {string} */ path) => `](${BLOB}${path})`);
writeFileSync(new URL("../packages/cli/README.md", import.meta.url), linked);
