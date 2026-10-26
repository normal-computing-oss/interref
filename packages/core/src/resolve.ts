/** Turns the path and fragment of a ref into a repo-relative target. Pure: no file access. */

import { posix } from "node:path";

export type RuleId =
  | "missing-file"
  | "missing-anchor"
  | "escapes-root"
  | "bare-path"
  | "reserved-authority"
  | "case-mismatch"
  | "unsupported-fragment"
  | "invalid-encoding"
  | "target-ignored";

export type Severity = "error" | "warn";

export const RULE_SEVERITY: Readonly<Record<RuleId, Severity>> = {
  "missing-file": "error",
  "missing-anchor": "error",
  "escapes-root": "error",
  "bare-path": "error",
  "reserved-authority": "error",
  "case-mismatch": "error",
  "unsupported-fragment": "error",
  "invalid-encoding": "error",
  "target-ignored": "warn",
};

/** How the ref names its target. Fixes keep the same form. */
export type PathStyle = "absolute" | "relative" | "self";

export interface Target {
  /** Repo-relative POSIX path; `""` is the repo root. */
  readonly path: string;
  readonly style: PathStyle;
  /** The ref ends in `/`, so the target must be a directory. */
  readonly trailingSlash: boolean;
}

/** Only heading fragments are supported for now. */
export interface HeadingFragment {
  readonly kind: "heading";
  readonly slug: string;
}

export interface Problem {
  readonly rule: RuleId;
  readonly message: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: Problem };

const fail = (rule: RuleId, message: string): { ok: false; problem: Problem } => ({
  ok: false,
  problem: { rule, message },
});

/**
 * Resolves the (percent-encoded) path of a ref written in `source`, which is a repo-relative path.
 */
export function resolveTarget(source: string, encodedPath: string): Result<Target> {
  if (encodedPath.startsWith("//")) {
    return fail("reserved-authority", "nref://<repo>/ is reserved for cross-repo refs; use nref:/path");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedPath).normalize("NFC");
  } catch {
    return fail("invalid-encoding", `bad percent-encoding in "${encodedPath}"`);
  }
  if (decoded === "") return { ok: true, value: { path: source, style: "self", trailingSlash: false } };

  let style: PathStyle;
  let joined: string;
  if (decoded.startsWith("/")) {
    style = "absolute";
    joined = decoded.slice(1);
  } else if (decoded.startsWith("./") || decoded.startsWith("../")) {
    style = "relative";
    joined = `${posix.dirname(source)}/${decoded}`;
  } else {
    return fail("bare-path", `path must start with /, ./ or ../; did you mean nref:./${encodedPath}?`);
  }

  const segments: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.pop() === undefined) return fail("escapes-root", "path climbs above the repo root");
    } else {
      segments.push(segment);
    }
  }
  return {
    ok: true,
    value: { path: segments.join("/"), style, trailingSlash: decoded.endsWith("/") && segments.length > 0 },
  };
}

export function parseFragment(encoded: string): Result<HeadingFragment> {
  let fragment: string;
  try {
    fragment = decodeURIComponent(encoded).normalize("NFC");
  } catch {
    return fail("invalid-encoding", `bad percent-encoding in "#${encoded}"`);
  }
  if (/^L\d/u.test(fragment)) {
    return fail("unsupported-fragment", "line fragments (#L42) are not supported yet; link to a heading");
  }
  if (fragment.startsWith("^")) {
    return fail("unsupported-fragment", "anchor fragments (#^name) are not supported yet; link to a heading");
  }
  return { ok: true, value: { kind: "heading", slug: fragment } };
}

const UNSAFE_PATH_CHAR = /[\s%#"'`<>()[\]{}]/gu;

/** Percent-encodes the characters that would end a ref or change its meaning. */
export function encodeRefPath(path: string): string {
  return path.replace(UNSAFE_PATH_CHAR, (ch) =>
    Array.from(new TextEncoder().encode(ch), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  );
}

/**
 * Writes a ref from `source` to `target` in the given style. A relative ref from a file to
 * itself is written `nref:` + fragment.
 */
export function formatRef(
  source: string,
  target: string,
  options: { style: PathStyle; directory?: boolean; slug?: string | undefined },
): string {
  const fragment = options.slug === undefined || options.slug === "" ? "" : `#${encodeRefPath(options.slug)}`;
  const slash = options.directory === true && target !== "" ? "/" : "";
  if (options.style === "self" && target === source) return `nref:${fragment}`;
  if (options.style === "absolute") return `nref:/${encodeRefPath(target)}${slash}${fragment}`;
  // Rooted at "/" so that the result never depends on the process working directory.
  let relative = posix.relative(`/${posix.dirname(source)}`, `/${target}`);
  if (relative === "") relative = "./";
  else if (relative === "..") relative = "../";
  else if (relative.startsWith("../")) relative += slash;
  else relative = `./${relative}${slash}`;
  return `nref:${encodeRefPath(relative)}${fragment}`;
}
