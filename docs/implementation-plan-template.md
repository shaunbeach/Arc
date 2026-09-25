# Implementation plan template for `/supervise`

Give this file to the model that writes the plan, for example: *"Read Spec.md and write implementation.md following docs/implementation-plan-template.md."* Part 1 is rules for the writer. Part 2 is the skeleton to fill in. The finished plan contains only Part 2's shape, never Part 1.

## Part 1: Rules for the plan writer

The plan is executed unattended: an actor model builds one phase at a time with a small context window, shell checks run, and a critic model reviews the diff. Nobody is watching. Write so that a small model, reading only one phase, can finish it and prove it.

**Format (Arc parses it):**

- Each phase starts with `## Phase N: Title`, numbered from 0 or 1 without gaps. Any other `#` or `##` heading ends the phase; `###` headings stay inside it.
- The automated checks go in a fenced block tagged `verify`, one shell command per line. A line ending in `\` continues on the next. `#` lines are comments.
- Each phase is sent to the actor on its own, with a fresh context. It must make sense without the other phases, apart from files earlier phases created.

**Phases:**

- One concern per phase, at most about 8 tasks, and a list of the files it may create or change. A phase should fit comfortably in a 20k-token window together with the files it reads.
- Order phases so each one builds on verified work: types, then plumbing, then wiring, then UI, then features, then final checks.
- Put exact values in the plan (names, paths, strings, numbers), not "something like".

**Checks (the `verify` block):**

- Every command must exit 0 on success and non-zero on failure. `rg` and `grep` exit 1 when nothing matches, so a "must not appear" check is written `! rg 'pattern' path`.
- Every command must finish on its own. Never put a dev server, a watcher, or anything interactive in a check directly. To prove an app starts, run it in the background, probe it, and stop it (see the skeleton's startup check).
- Test the exact outputs the plan names, such as `test -f out/main/index.js`, so the build configuration cannot drift from the plan.
- Checks run from the project root, in order, and stop at the first failure. Put the cheap ones first (typecheck, then build, then the rest).
- A check must not depend on a service that may be down at night, such as a model server. Leave those tests to the manual list.
- Add a startup check in the first phase that sets up the app, and again in the last phase. A passing build does not prove the app loads.
- Fix the dev server's port and make it fail rather than move when the port is taken (Vite: `server: { port: 5173, strictPort: true }` in the renderer config). Otherwise a leftover app on the port answers the startup check in place of the new one.

**Libraries:**

- Do not state a library's API from memory. When a phase uses one, give the package name and version range and say "confirm the constructor options and method names in node_modules before writing code." A wrong API in the plan (for example an option named `baseUrl` when the library takes `host`) sends the actor searching the package for something that does not exist.
- Pin the module system and output file names once, in the scaffold phase (for example: "no `"type": "module"` in package.json; outputs are `.js`"), so later phases and checks agree with it.

**Manual steps:**

- Anything a person must do (click in a window, watch output, test against a live service) goes in a **Manual checks** list after the `verify` block. The critic judges those from the code; a person runs them after the whole plan passes.

**Setup the plan must state:**

- This folder is the project root. Scaffolding tools that create a subfolder must have their files moved up.
- Where the spec is (for example `Spec.md` in this folder), and which of its sections each phase uses.

## Part 2: Skeleton

````md
# <Project name>: Implementation Plan

> **How this plan runs.** Arc's `/supervise` works through it one phase at a time. Each phase is built in a fresh context,
> checked by the commands in its `verify` block, and reviewed. This folder is the project root: `package.json` and `src/`
> live here, not in a subfolder. The spec is `Spec.md` in this folder.
>
> **Rules for every phase:**
> 1. Read only the files listed for the phase, plus the spec sections it names.
> 2. Do the tasks in order. Do not start work that belongs to a later phase.
> 3. Before ending your turn, run the phase's `verify` commands exactly as written. Do not change what they test.
> 4. Never run a dev server, watcher, or other command that does not exit on its own. The checks start the app themselves.
> 5. Before calling a library, confirm its API in `node_modules` (types or README). Do not guess.

---

## Phase 0: Project scaffold

**Goal:** <one sentence: what exists and works after this phase>
**Spec:** §<n>
**Files (create or change only these):** `package.json`, `<config files>`, `src/main/index.ts`, ...
**Fixed choices:** <module system, output paths and file names, dev server port with strictPort>

- [ ] <task with exact names, paths, and values>
- [ ] <task>
- [ ] Add scripts to `package.json`: `"dev": "..."`, `"build": "..."`, `"typecheck": "..."`.

```verify
npm run typecheck
npm run build && test -f <exact output path 1> && test -f <exact output path 2>
# Startup check: start the app in the background, fetch its page, stop it, pass only on HTTP 200.
(npm run dev > /tmp/dev.log 2>&1 &); sleep 20; code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/); pkill -f "$PWD/node_modules/electron"; pkill -f electron-vite; test "$code" = 200
```

**Manual checks (a person, after the plan passes):**
1. `npm run dev` opens <what the window shows>.

---

## Phase 1: <Title>

**Goal:** ...
**Spec:** §...
**Files (create or change only these):** ...

- [ ] ...

```verify
npm run typecheck
test "$(grep -c '<exact required string>' <file>)" = 1
! rg '<forbidden pattern>' <path>
```

**Manual checks (a person, after the plan passes):**
1. ...

---

## Phase 2: Final hardening and acceptance

**Goal:** Everything in the spec's acceptance checklist holds. (Always the last phase, numbered after the others.)
**Files:** <files the sweep may touch>

- [ ] <each acceptance item as a checkable task>

```verify
npm run typecheck
npm run build
(npm run dev > /tmp/dev.log 2>&1 &); sleep 20; code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/); pkill -f "$PWD/node_modules/electron"; pkill -f electron-vite; test "$code" = 200
```

**Manual checks (a person, after the plan passes):**
1. <each acceptance item that needs a person or a live service>

---

## Appendix: Phase dependencies

<optional diagram; this heading ends the last phase>
````

The startup check above is for an Electron and Vite app on port 5173. For other stacks, keep its shape: start in the background, wait, probe, stop, and test the result. For a CLI, run it with a sample input and compare the output instead.

## Before `/supervise`

```
git init                                  # if the folder is not a repository yet
printf 'node_modules/\nout/\ndist/\n' > .gitignore
git add .gitignore implementation.md Spec.md
git commit -m "plan"
```

Then in Arc: `/model <actor>`, stay in agent mode, and `/supervise implementation.md`. models.yml needs a `supervisor:` block naming the critic.
