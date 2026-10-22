/** The link graph between files: outgoing refs, backlinks and transitive walks. */

import type { RefRecord } from "./check.js";

export class RefGraph {
  private readonly out = new Map<string, RefRecord[]>();
  private readonly in = new Map<string, RefRecord[]>();

  constructor(readonly records: readonly RefRecord[]) {
    for (const record of records) {
      push(this.out, record.source.path, record);
      if (record.target !== undefined) push(this.in, record.target.path, record);
    }
  }

  /** Refs written in `path`. */
  outgoing(path: string): readonly RefRecord[] {
    return this.out.get(path) ?? [];
  }

  /** Refs that point at `path`. */
  incoming(path: string): readonly RefRecord[] {
    return this.in.get(path) ?? [];
  }

  /** Distinct files that `path` links to (or, with `reverse`, that link to it), sorted. */
  neighbours(path: string, reverse = false): string[] {
    const records = reverse ? this.incoming(path) : this.outgoing(path);
    const paths = records.map((record) => (reverse ? record.source.path : record.target?.path));
    return [...new Set(paths.filter((p): p is string => p !== undefined && p !== path))].sort();
  }

  /** Every simple path of links from `from` to `to`, at most `depth` hops, shortest first. */
  pathsBetween(from: string, to: string, depth: number): string[][] {
    const found: string[][] = [];
    const walk = (chain: string[]): void => {
      const last = chain[chain.length - 1] ?? from;
      if (chain.length > depth) return;
      for (const next of this.neighbours(last)) {
        if (next === to) found.push([...chain, next]);
        else if (!chain.includes(next)) walk([...chain, next]);
      }
    };
    walk([from]);
    return found.sort((a, b) => a.length - b.length);
  }
}

function push(map: Map<string, RefRecord[]>, key: string, record: RefRecord): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [record]);
  else list.push(record);
}
