# Development Rules

## Style

- Short, direct, technical prose. No emojis in commits, issues, or code.
- Explain non-trivial designs as: problem, concrete example, solution.

## Code

- Read files in full before wide-ranging changes.
- No `any` unless unavoidable. Top-level imports only; no `await import()`.
- Erasable TypeScript only, because Node runs the sources with type stripping: no `enum`, `namespace`, parameter properties, or `import =`.
- The system prompt plus tool definitions must stay under 1,000 tokens. `packages/lite/test/prompt.test.ts` enforces an estimate; check real counts with `pi-lite --show-prompt` and the prompt sizes in `~/.pi-lite/logs/llama-server.log`.
- The system prompt must stay byte-identical within a session so llama.cpp can reuse its KV cache. No dates or counters in it.
- The UI renders on the terminal's main screen. Keep the transcript append-only; changing lines above the viewport forces a full redraw that clears scrollback.
- App key checks go through `APP_KEYBINDINGS` in `packages/lite/src/tui/app.ts`. Do not hardcode keys elsewhere.

## Commands

- After code changes: `npm run check` (biome, then tsgo). Fix every error and warning.
- `npm test` runs the pi-lite (vitest) and pi-tui (node:test) unit tests. No test needs a model or a server.
- `npm run build` bundles `packages/lite/dist/pi-lite.js`. `npm run dev -- <args>` runs from source.
- `npm pack --workspace pi-lite` builds the npm tarball: the bundle plus README and LICENSE, copied in by `prepack`.
- Live checks need llama-server and a `models.yml`. Drive the TUI in tmux: `tmux new-session -d -s pi -x 100 -y 30`, then `send-keys` and `capture-pane`.

## Dependencies

- The npm package ships only the bundle, so every library pi-lite uses is a devDependency of `packages/lite`. Never add runtime `dependencies`.
- Pin direct dependencies to exact versions.
- Refresh the lockfile with `npm install --package-lock-only --ignore-scripts`; install with `npm ci --ignore-scripts`.

## Git

- Stage explicit paths. Never `git add -A`, `git add .`, `git reset --hard`, or `git commit --no-verify`.
- Commit messages: `{feat,fix,docs,chore}[(lite,tui)]: summary`.
- Never commit `models.yml`; it holds local paths.
