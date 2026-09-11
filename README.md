# pi-lite

A terminal coding assistant for local models served by llama.cpp. It starts `llama-server` for the model you pick, gives the model four tools (read, edit, write, bash), and keeps its prompt, memory use, and screen updates small.

pi-lite is a modified, stripped-down version of [pi](https://github.com/earendil-works/pi), the terminal coding agent by Mario Zechner and contributors. It keeps pi's agent loop, tools, and terminal UI library, and drops the cloud providers, logins, extensions, and telemetry. See [Origin and license](#origin-and-license).

- **Local only.** Models, ports, and llama-server arguments come from `models.yml`. The only API is llama-server's `/v1/chat/completions`.
- **Small prompt.** The system prompt and tool definitions take under 1,000 tokens and stay byte-identical, so llama.cpp reuses its KV cache.
- **Small process.** One Node process (about 60 MB resident) running a single 530 KB file. llama-server runs only while pi-lite does.
- **Two sampling modes.** Thinking and instruct, switchable at any time.
- **Terminal friendly.** Renders on the main screen, so tmux and terminal scrollback keep working. Sessions are saved as append-only JSONL.

## Requirements

- Node.js 22.19 or later
- `llama-server` from llama.cpp on your `PATH`, or its path in `models.yml` (`llamaServer`) or `$LLAMA_SERVER`. On macOS, `brew install node llama.cpp` covers both.
- GGUF models

## Install

```bash
npm install -g pi-lite
pi-lite --init    # writes ~/.pi-lite/models.yml; set your GGUF path in it
pi-lite
```

The package is one bundled file with no dependencies. `npx pi-lite` works for a quick try, but it keeps an extra npm process running for the whole session, so install it for daily use.

From a clone:

```bash
git clone https://github.com/shaunbeach/pi-lite.git
cd pi-lite
npm ci --ignore-scripts
npm run build
ln -s "$PWD/packages/lite/dist/pi-lite.js" ~/.local/bin/pi-lite   # a symlink, so rebuilds apply at once
```

## models.yml

pi-lite reads `--models <path>`, else `$PI_MODELS`, else `./models.yml`, else `~/.pi-lite/models.yml`. `pi-lite --init` writes a commented starter file to the last location. Only the `providers:` key is read, so the file can hold settings for other tools; to share one file, symlink it to `~/.pi-lite/models.yml`.

```yaml
providers:
  llamacpp:
    baseUrl: http://localhost:8080/v1
    auth: none
    modelDir: ~/models
    models:
      - id: Qwen3.8-27B/Qwen3.8-27B-Q4_K_M.gguf
        name: Qwen3.8-27B
        reasoning: true          # the model has a thinking switch
        contextWindow: 12288
        maxTokens: 4096          # tokens reserved for the reply
        launchArgs: ["--port", "8080", "--ctx-size", "12288", "--n-gpu-layers", "99", "--flash-attn", "on"]
        # mode: instruct         # default mode; thinking for reasoning models otherwise
        # sampling:              # per-mode overrides of the built-in presets
        #   thinking:
        #     reasoningEffort: high
        #     extra:
        #       thinking_budget_tokens: 2048
```

pi-lite runs `llama-server -m <modelDir>/<id> <launchArgs>`, adding `--port` from `baseUrl` when it is missing, and waits for `/health`. It stops the server when you quit or switch models. A running server that already serves the same GGUF is reused and is never stopped by pi-lite.

## Sampling modes

| Mode | temperature | top_p | top_k | min_p | presence_penalty | Thinking |
|---|---|---|---|---|---|---|
| thinking | 1.0 | 0.95 | 20 | 0.0 | 0.0 | On. Reasoning from the current turn is sent back; older reasoning is dropped. |
| instruct | 0.7 | 0.80 | 20 | 0.0 | 1.5 | Off |

The presets live in `packages/lite/src/config/sampling.ts`. A model's `sampling:` block can override any field, including `thinkingHistory` (`none`, `turn`, or `all`), `reasoningEffort`, and `extra`, which merges arbitrary request fields.

## Usage

```bash
pi-lite                                        # interactive session with the model you used last (else the first)
pi-lite -m 27b                                 # any unique part of a model name
pi-lite -m Qwen3.8 --mode instruct
pi-lite -c                                     # continue the latest session in this directory
pi-lite -r                                     # pick a saved session to resume
pi-lite -p "run the tests and fix failures"    # one prompt, reply on stdout
pi-lite --list-models                          # * marks the model a plain pi-lite opens
pi-lite --show-prompt                          # system prompt and tool definitions, with a token estimate
```

| Command | Effect |
|---|---|
| `/model [name]` | Switch model (restarts llama-server). Without a name, opens a picker. |
| `/mode [thinking\|instruct]` | Switch sampling mode. Without an argument, toggles. |
| `/new` | Start a new session. |
| `/resume [id]` | Resume a saved session. Without an id, opens a picker. |
| `/quit` | Exit. |

| Key | Effect |
|---|---|
| `esc` | Abort the running request |
| `ctrl+c` | Abort; otherwise clear the editor; otherwise exit |
| `ctrl+d` | Exit when the editor is empty |
| `shift+tab` | Switch mode |

Messages typed while the model works are sent with its next turn. Sessions are stored in `~/.pi-lite/sessions/` (set `PI_LITE_DIR` to move them), and llama-server output goes to `~/.pi-lite/logs/llama-server.log`.

## Context window

Nothing is trimmed while the prompt fits in `contextWindow - maxTokens`. Past that, pi-lite trims to 60% of the budget in one go, oldest first:

1. reasoning of all but the two most recent steps (a step is one model response and its tool results);
2. long tool-call arguments and tool output of those steps, replaced by placeholders such as `[elided from context: 319 lines]`. Files stay on disk, and `write` and `edit` refuse placeholder text, so a model that copies one cannot overwrite a file with it;
3. whole old turns, never the one in progress;
4. only if the two most recent steps alone still exceed the budget: the same for all but the latest step.

A trimmed message looks the same in every later request, so trimming happens rarely and llama.cpp re-evaluates the prompt only then. That re-evaluation is the cost: at 20 tokens/s of prompt processing, about a minute per 1,200 tokens kept. When a request would leave less than 1,024 tokens (or `maxTokens`, if smaller) for the reply even after trimming, the run stops with a "Context full" error instead of sending it. Each tool result is capped relative to the window, at about 9 KB for a 12k window.

## Layout

```
packages/lite          the app
  src/cli.ts           flags and print mode
  src/config/          models.yml loader, sampling presets
  src/llm/             llama.cpp client (fetch and SSE), llama-server manager
  src/agent/           agent loop
  src/tools/           read, edit, write, bash
  src/context.ts       context window trimming
  src/prompt.ts        system prompt
  src/session.ts       JSONL sessions
  src/tui/             terminal UI
packages/tui           pi-tui, trimmed to the main-screen renderer, editor, markdown, and select list
```

## Development

```bash
npm run check                  # biome and type check
npm test                       # unit tests; no model needed
npm run dev -- -p "hello"      # run from source
```

## Origin and license

pi-lite began as a fork of [earendil-works/pi](https://github.com/earendil-works/pi) at commit `08dc60bc5` (September 2026) and was cut down to a llama.cpp-only harness. This repository starts with a fresh history; pi's repository holds the history of the code pi-lite inherits.

- **Adapted from pi:** the agent loop and its event stream, tool-argument validation, streaming JSON parsing, the read, edit, write, and bash tools (including edit's fuzzy matching and output truncation), and pi-tui, pi's terminal UI library, trimmed to what pi-lite uses (`packages/tui`).
- **Written for pi-lite:** the llama.cpp client (based on pi's OpenAI-compatible client, rebuilt on plain `fetch`), llama-server management, the models.yml loader, sampling presets, context trimming, sessions, the system prompt, and the interactive app.
- **Removed:** cloud providers and OAuth, the model catalog, extensions and package management, remote sessions, compaction, telemetry, and pi's other packages.

pi-lite is not affiliated with or endorsed by the pi project. Both are released under the MIT License, and [LICENSE](LICENSE) keeps pi's copyright notice alongside pi-lite's.
