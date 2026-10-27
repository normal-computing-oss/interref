# interref for VS Code

This extension makes `iref:` links in comments clickable, and it shows broken links.

- Cmd/Ctrl+click a ref to open its target. A heading fragment opens the file at that heading.
- Hover over a ref to see the start of its target.
- Broken refs show in Problems. Cmd/Ctrl+. offers fixes.
- "Copy ref" in the editor or explorer context menu copies `iref:/path#heading`.
- In a comment, type `iref:/`, `iref:./` or `#` to get completions for paths and headings. `iref:`, `sync:` and the
  other protocols in the config file work the same way.
- "interref: Show ref graph" opens the link graph around a file, or for the whole repo. You must
  install a viewer extension first: Draw.io Integration (`hediet.vscode-drawio`, the default), or
  for Mermaid the official Mermaid extension (`MermaidChart.vscode-mermaid-chart`) or Mermaid
  Preview (`vstirbu.vscode-mermaid-preview`). If the viewer is missing, the command offers to
  install it.

A ref counts only in a comment, not in a string or in Markdown text. Only heading fragments are
supported for now. For the full syntax and the `interref` CLI, see the
`README.md` of the interref repo.

## Settings

- `interref.diagnostics.enabled` (default `true`): show broken refs as problems.
- `interref.hover.lines` (default `10`): lines of the target in the hover.
- `interref.graph.viewer` (default `drawio`): `drawio` or `mermaid`, the extension that shows the graph.
