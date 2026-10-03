# Check presets for `verify` blocks

Ready-made check lines for common stacks, to copy into a plan's ```` ```verify ```` blocks. Every line exits 0 on success, finishes on its own, and leaves nothing running. Run `/supervise check implementation.md` before a run to catch the usual mistakes.

Two patterns recur:

- **Must not appear:** `! rg 'pattern' path`. `rg` and `grep` exit 1 when nothing matches, so without `!` the check fails exactly when the code is right.
- **Starts up:** run the app in the background, poll it once a second until it answers or the limit passes, stop it, then test the result. A fixed `sleep` fails when the app is slow and wastes time when it is quick. Pin the port and make the server fail rather than move (`strictPort`), or a leftover app on the port answers instead. Arc also stops leftover processes before each phase's checks.

## Electron + electron-vite + React

Renderer config: `server: { port: 5173, strictPort: true }`.

```verify
npm run typecheck
npm run build && test -f out/main/index.js && test -f out/preload/index.js && test -f out/renderer/index.html
(npm run dev > /tmp/dev.log 2>&1 &); for i in $(seq 60); do code=$(curl -s -m 2 -o /dev/null -w "%{http_code}" http://localhost:5173/); test "$code" = 200 && break; sleep 1; done; pkill -f "$PWD/node_modules/electron"; pkill -f electron-vite; test "$code" = 200
! rg "node:|require\(|XMLHttpRequest" src/renderer src/preload
```

## Tauri + Vite

`vite.config.ts`: `server: { port: 1420, strictPort: true }`. The Rust side builds without opening a window.

```verify
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
(npx vite --port 1420 --strictPort > /tmp/vite.log 2>&1 &); for i in $(seq 30); do code=$(curl -s -m 2 -o /dev/null -w "%{http_code}" http://localhost:1420/); test "$code" = 200 && break; sleep 1; done; pkill -f "$PWD/node_modules/.bin/vite"; test "$code" = 200
```

## Web app (Vite, React or other)

```verify
npm run typecheck
npm run build && test -f dist/index.html
npx vitest --run
(npx vite preview --port 4173 --strictPort > /tmp/preview.log 2>&1 &); for i in $(seq 30); do code=$(curl -s -m 2 -o /dev/null -w "%{http_code}" http://localhost:4173/); test "$code" = 200 && break; sleep 1; done; pkill -f "$PWD/node_modules/.bin/vite"; test "$code" = 200
```

## Node CLI or library (TypeScript)

```verify
npm run typecheck
npm test
npm run build && node dist/cli.js --help > /dev/null
test "$(node dist/cli.js --version)" = "<exact version>"
```

## Python CLI or package

```verify
python3 -m compileall -q src
python3 -m pytest -q
python3 -m <package> --help > /dev/null
! rg "print\(" src/<package> --glob '!cli.py'
```

## Rust crate

```verify
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## Useful single checks

| Checks that | Line |
|---|---|
| A file exists | `test -f path/to/file` |
| A string appears exactly once | `test "$(grep -c 'exact text' path/to/file)" = 1` |
| A pattern appears nowhere | `! rg 'pattern' src` |
| A command prints an exact line | `test "$(command)" = "expected"` |
| JSON has a field | `node -e "process.exit(require('./package.json').scripts.build ? 0 : 1)"` |
| A server answers | background start, `for i in $(seq 30); do code=$(curl -s -m 2 -o /dev/null -w "%{http_code}" <url>); test "$code" = 200 && break; sleep 1; done`, `pkill`, `test "$code" = 200` |

Keep checks off services that may be down at night (model servers, the network beyond package installs). Those tests belong in the phase's manual list.
