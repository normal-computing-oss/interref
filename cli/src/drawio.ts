/**
 * The link graph as a draw.io file. draw.io does not lay out a diagram when it opens one, so this
 * places the nodes itself: left to right in layers, each node one layer after its longest chain of
 * predecessors, with cycles broken where a depth-first walk finds them.
 */

export interface DrawioNode {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly label: string;
}

export interface DrawioEdge {
  readonly from: string;
  readonly to: string;
  readonly count: number;
  readonly broken: boolean;
}

const NODE_HEIGHT = 40;
const ROW_GAP = 30;
const COLUMN_GAP = 120;
const CHAR_WIDTH = 7;

const FILE_STYLE = "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;";
const DIRECTORY_STYLE =
  "shape=folder;tabWidth=40;tabHeight=8;tabPosition=left;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;";
const CENTER_STYLE = "strokeWidth=3;";
const EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;";
const BROKEN_STYLE = "dashed=1;strokeColor=#b85450;";

function escapeXml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

/** Layer of each node: 0 for nodes with no predecessors, else one more than the deepest one. */
function layers(nodes: readonly string[], successors: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  // A depth-first walk gives a topological order of the graph without its back edges.
  const state = new Map<string, "open" | "done">();
  const order: string[] = [];
  const forward = new Map<string, string[]>();
  const visit = (node: string): void => {
    state.set(node, "open");
    const kept: string[] = [];
    for (const next of successors.get(node) ?? []) {
      const seen = state.get(next);
      if (seen === "open") continue; // back edge: part of a cycle
      kept.push(next);
      if (seen === undefined) visit(next);
    }
    forward.set(node, kept);
    state.set(node, "done");
    order.push(node);
  };
  for (const node of nodes) if (!state.has(node)) visit(node);

  const layer = new Map<string, number>(nodes.map((node) => [node, 0]));
  for (const node of order.reverse()) {
    const from = layer.get(node) ?? 0;
    for (const next of forward.get(node) ?? []) layer.set(next, Math.max(layer.get(next) ?? 0, from + 1));
  }
  return layer;
}

export function drawio(nodes: readonly DrawioNode[], edges: readonly DrawioEdge[], center?: string): string {
  const paths = nodes.map((node) => node.path);
  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  for (const edge of edges) {
    successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
    predecessors.set(edge.to, [...(predecessors.get(edge.to) ?? []), edge.from]);
  }
  const layer = layers(paths, successors);

  // Order each column by the mean row of its predecessors, to cut down on crossings.
  const columns: DrawioNode[][] = [];
  for (const node of nodes) {
    const index = layer.get(node.path) ?? 0;
    (columns[index] ??= []).push(node);
  }
  const row = new Map<string, number>();
  for (const column of columns) {
    const weight = (node: DrawioNode): number => {
      const rows = (predecessors.get(node.path) ?? []).flatMap((p) => {
        const r = row.get(p);
        return r === undefined ? [] : [r];
      });
      return rows.length === 0 ? Number.POSITIVE_INFINITY : rows.reduce((a, b) => a + b, 0) / rows.length;
    };
    column.sort((a, b) => weight(a) - weight(b) || a.path.localeCompare(b.path));
    column.forEach((node, index) => row.set(node.path, index));
  }

  const width = (node: DrawioNode): number => Math.min(520, Math.max(120, node.label.length * CHAR_WIDTH + 24));
  const tallest = Math.max(0, ...columns.map((column) => column.length));
  const ids = new Map(nodes.map((node, index) => [node.path, `n${index}`]));
  const cells: string[] = [];
  let x = 0;
  for (const column of columns) {
    const columnWidth = Math.max(0, ...column.map(width));
    const top = ((tallest - column.length) * (NODE_HEIGHT + ROW_GAP)) / 2;
    column.forEach((node, index) => {
      const style =
        (node.kind === "directory" ? DIRECTORY_STYLE : FILE_STYLE) + (node.path === center ? CENTER_STYLE : "");
      const y = top + index * (NODE_HEIGHT + ROW_GAP);
      cells.push(
        `        <mxCell id="${ids.get(node.path) ?? ""}" value="${escapeXml(node.label)}" style="${style}" vertex="1" parent="1">`,
        `          <mxGeometry x="${x}" y="${y}" width="${columnWidth}" height="${NODE_HEIGHT}" as="geometry" />`,
        "        </mxCell>",
      );
    });
    x += columnWidth + COLUMN_GAP;
  }
  edges.forEach((edge, index) => {
    const label = edge.count > 1 ? String(edge.count) : "";
    const style = EDGE_STYLE + (edge.broken ? BROKEN_STYLE : "");
    const source = ids.get(edge.from) ?? "";
    const target = ids.get(edge.to) ?? "";
    cells.push(
      `        <mxCell id="e${index}" value="${label}" style="${style}" edge="1" parent="1" source="${source}" target="${target}">`,
      '          <mxGeometry relative="1" as="geometry" />',
      "        </mxCell>",
    );
  });

  return [
    '<mxfile host="refs">',
    '  <diagram id="refs" name="refs graph">',
    '    <mxGraphModel grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" math="0" shadow="0">',
    "      <root>",
    '        <mxCell id="0" />',
    '        <mxCell id="1" parent="0" />',
    ...cells,
    "      </root>",
    "    </mxGraphModel>",
    "  </diagram>",
    "</mxfile>",
  ].join("\n");
}
