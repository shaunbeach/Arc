# Project conventions template (`AGENTS.md`)

Put a file named `AGENTS.md` in the project's root, and `/supervise` includes it in every phase brief (up to about 3,000 characters, since it is sent again with each phase). Use it for rules that hold in every phase, so the plan does not have to repeat them and nothing is lost when a new phase starts in a fresh context.

Keep it short: a small model follows ten clear rules better than fifty. Write each rule as an instruction, and give the reason when it is not obvious.

```md
# Conventions

## Project
- This folder is the project root. Never create a nested project folder.
- The spec is Spec.md; the plan is implementation.md. Never edit either.

## Code
- TypeScript strict. No `any`.
- <Module system and output names, e.g. CommonJS output; no "type": "module" in package.json.>
- Keep files under ~200 lines; split by concern.
- <Naming, formatting, and import rules the project uses.>

## Commands
- Type check: `npm run typecheck`. Build: `npm run build`. Tests: `npm test`.
- Never run `npm run dev` or any command that does not exit on its own. To see whether the app starts, run it in the background, probe it, and stop it.
- Never change a script in package.json that a check runs.

## Libraries
- Before calling a library, read its types or README in node_modules. Do not guess an API.
- Add a dependency only when the phase asks for it.

## Decisions so far
- <Choices earlier phases made that later ones must keep, e.g. "The renderer root is src/renderer; index.html lives there.">
```

The "Decisions so far" section is the place for what one phase learned and the next must know. You can add to it between runs, or while a run is stopped.
