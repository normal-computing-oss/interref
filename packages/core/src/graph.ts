/** The link graph between files: outgoing refs, backlinks and transitive walks. */

import type { RefRecord } from "./check.js";
import type { EntryKind } from "./repo.js";

export interface GraphNode {
  readonly path: string;
  readonly kind: EntryKind;
}

/** All refs from one file to another, merged. */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** How many refs the edge stands for. */
  readonly count: number;
  /** At least one of those refs is an error, for example a missing heading. */
  readonly broken: boolean;
}

/** The part of the graph to draw: nodes sorted by path, edges in record order. */
export interface GraphView {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly center?: string;
}

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

/**
 * The whole graph, or the files within `depth` hops of `center` in either direction. A ref from a
 * file to itself is not drawn. `centerKind` is used when the center has no refs at all.
 */
export function graphView(
  graph: RefGraph,
  options: { center?: string | undefined; depth?: number; centerKind?: EntryKind } = {},
): GraphView {
  const { center } = options;
  let within: Set<string> | undefined;
  if (center !== undefined) {
    within = new Set([center]);
    let frontier = [center];
    for (let hop = 0; hop < (options.depth ?? 1) && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const path of frontier) {
        for (const neighbour of [...graph.neighbours(path), ...graph.neighbours(path, true)]) {
          if (!within.has(neighbour)) {
            within.add(neighbour);
            next.push(neighbour);
          }
        }
      }
      frontier = next;
    }
  }

  const edges = new Map<string, { from: string; to: string; count: number; broken: boolean }>();
  const kinds = new Map<string, EntryKind>();
  for (const record of graph.records) {
    const target = record.target;
    if (target === undefined || target.path === record.source.path) continue;
    if (within !== undefined && !(within.has(record.source.path) && within.has(target.path))) continue;
    kinds.set(record.source.path, "file");
    kinds.set(target.path, target.kind);
    const key = `${record.source.path}\0${target.path}`;
    const edge = edges.get(key) ?? { from: record.source.path, to: target.path, count: 0, broken: false };
    edge.count++;
    edge.broken ||= record.status === "error";
    edges.set(key, edge);
  }
  if (center !== undefined && !kinds.has(center)) kinds.set(center, options.centerKind ?? "file");
  const nodes = [...kinds].map(([path, kind]) => ({ path, kind })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { nodes, edges: [...edges.values()], ...(center === undefined ? {} : { center }) };
}

function push(map: Map<string, RefRecord[]>, key: string, record: RefRecord): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [record]);
  else list.push(record);
}
