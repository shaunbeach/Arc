# Spec template

A plan is only as good as its spec. The model that writes `implementation.md` from this spec, and the critic that judges each phase, both read it literally, so write what must be true, in exact terms. Save the filled-in spec as `Spec.md` next to the plan, then ask for the plan with [implementation-plan-template.md](implementation-plan-template.md).

Rules for filling it in:

- Exact values over descriptions: the literal window title, file name, error message, port, and version.
- Every requirement testable: a person or a command can say yes or no.
- Say what is out of scope. A small model fills silence with features.
- Say what will not be available while the plan runs unattended, such as a model server, the network, or a signed-in account.

````md
# <Project name>

<One paragraph: what it is, who uses it, and the one thing it must do well.>

## 1. Scope

**In:** <features, as a short list>
**Out:** <things a reader might assume but that are not wanted>

## 2. Technical choices (fixed)

| Area | Choice | Version |
|---|---|---|
| Language | <TypeScript, strict> | <5.x> |
| Framework | <Electron + electron-vite + React> | <exact or range> |
| Styling | <Tailwind> | |
| Module system | <CommonJS output; no "type": "module"> | |
| Build output | <out/main/index.js, out/preload/index.js, out/renderer/index.html> | |
| Dev server | <Vite on port 5173, strictPort> | |
| Package manager | <npm> | |

Libraries the app talks to, with the exact API to confirm before use:

- `<package>@<version>`: <what it is used for>. Confirm the constructor options and method names in `node_modules` before writing code.

## 3. Behavior

<For each feature: what the user does, what happens, and every message shown, word for word.>

### 3.1 <Feature>

1. <Step>
2. <Step>

Errors: <each failure and the exact text shown>

## 4. Architecture

<Processes, modules, and what may talk to what. For example: the renderer never touches Node or the network; all backend work goes through a typed bridge.>

## 5. Files and layout

```
<project root, which is this folder>
  package.json
  src/
    main/
    ...
```

## 6. Environment while the plan runs

- Available: <node, npm, git, network for npm install>
- Not available: <the model server, a display for manual tests, credentials>
- Checks must not depend on the unavailable items; those tests go in the manual list.

## 7. Exact strings

<Prompts, labels, log lines, and file names that must match character for character, each in a code block.>

## 8. Acceptance checklist

Each item is testable. Mark how it is verified.

- [ ] <requirement> (check: `<command>`)
- [ ] <requirement> (manual: <what a person does and sees>)
````
