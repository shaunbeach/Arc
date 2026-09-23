# pi-tui (trimmed)

pi-tui, the terminal UI library from [pi](https://github.com/earendil-works/pi) by Mario Zechner (MIT License), cut down to what Arc uses:

- `TuiMainScreen`: renders into the terminal's main screen with differential line updates and synchronized output, so terminal and tmux scrollback keep working
- `Editor` with slash-command autocomplete, `Markdown`, `SelectList`, `Text`, `Spacer`
- Key parsing (`matchesKey`) and width-aware text helpers (`truncateToWidth`, `wrapTextWithAnsi`, `visibleWidth`)

The alternate-screen renderer, layout stacks, scroll views, images, LaTeX, and native platform helpers were removed.

The package exports its TypeScript sources directly (`src/index.ts`). Node runs them with type stripping, and Arc's build bundles them.

Run the tests with `npm test` (node:test).
