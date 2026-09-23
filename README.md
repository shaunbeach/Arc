# pi-lite

A terminal coding assistant for local models served by llama.cpp. It starts `llama-server` for the model you pick, gives the model tools to read, edit, and write files, run shell commands, and search and read the web, and keeps its prompt, memory use, and screen updates small.

pi-lite is a modified version of [pi](https://github.com/earendil-works/pi), the terminal coding agent by Mario Zechner and contributors. It keeps pi's agent loop, tools, and terminal UI library, and drops the cloud providers, logins, extensions, and telemetry. See [Origin and license](#origin-and-license).

- **Local models.** Models, ports, and llama-server arguments come from `models.yml`; the model runs on llama-server. The only other network requests come from the web tools, which `/web off` turns off.
- **Small prompt.** The system prompt and tool definitions take under 1,000 tokens and stay byte-identical until you switch mode or `/web`, so llama.cpp reuses its KV cache.
- **Small process.** One Node process (about 60 MB resident) running a single 590 KB file. llama-server runs only while pi-lite does.
- **Three ways to work.** Agent mode changes code, plan mode researches and plans without changing files, chat mode just talks. Thinking and instruct sampling switch independently.
- **Built for long runs in small windows.** Trimming keeps a record of what it removes, so a model with a 16k window does not lose track of the files it wrote. See [Context window](#context-window).
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

pi-lite runs `llama-server -m <modelDir>/<id> <launchArgs>`, adding `--port` from `baseUrl` when it is missing, and waits for `/health`. It stops the server when you quit, switch models, or `/disconnect`. A running server that already serves the same GGUF is reused and is never stopped by pi-lite.

## Sampling modes

| Mode | temperature | top_p | top_k | min_p | presence_penalty | Thinking |
|---|---|---|---|---|---|---|
| thinking | 1.0 | 0.95 | 20 | 0.0 | 0.0 | On. Reasoning from the current turn is sent back; older reasoning is dropped. |
| instruct | 0.7 | 0.80 | 20 | 0.0 | 1.5 | Off |

The presets live in `packages/lite/src/config/sampling.ts`. A model's `sampling:` block can override any field, including `thinkingHistory` (`none`, `turn`, or `all`), `reasoningEffort`, and `extra`, which merges arbitrary request fields.

## Usage

```bash
pi-lite                                        # interactive session; pick a model with /model
pi-lite -m 27b                                 # load a model at start: any unique part of its name
pi-lite -m Qwen3.8 --mode instruct
pi-lite -c                                     # continue the latest session in this directory
pi-lite -r                                     # pick a saved session to resume
pi-lite --serve 27b                            # host a model for other machines (see Hosting)
pi-lite -m 27b --max-swap 6GB                  # guard memory during a long run (see Memory guard)
pi-lite -p "run the tests and fix failures"    # one prompt, reply on stdout
pi-lite --list-models                          # * marks the model -p uses without -m
pi-lite --show-prompt                          # system prompt and tool definitions, with a token estimate
```

An interactive session starts without a model; `/model` opens a picker, and a message sent before then opens it too. `-c`, `-r`, and `--session` load the model the session used.

| Command | Effect |
|---|---|
| `/model [name]` | Load or switch model (restarts llama-server). Without a name, opens a picker. |
| `/mode [thinking\|instruct]` | Switch sampling mode. Without an argument, toggles. |
| `/agent`, `/plan`, `/chat` | Switch how the model works. See [Modes](#modes). |
| `/web [on\|off]` | Give the model the web tools, or take them away. Without an argument, toggles. |
| `/compact [threshold]` | Ask the model which old tool results it still needs, and cut the rest. See [Context window](#context-window). |
| `/serve [name]` | Host a model for other machines. See [Hosting](#hosting). |
| `/disconnect` | Stop llama-server and unload the model without exiting. |
| `/clear` | Clear the conversation and start a new session (also `/new`, `/cls`, `/reset`). |
| `/resume [id]` | Resume a saved session. Without an id, opens a picker. |
| `/quit` | Exit. |

| Key | Effect |
|---|---|
| `esc` | Abort the running request, model load, or `/compact`; stop hosting |
| `ctrl+c` | Abort or stop hosting; otherwise clear the editor; otherwise exit |
| `ctrl+d` | Exit when the editor is empty |
| `shift+tab` | Switch sampling mode |

Messages typed while the model works are sent with its next turn. The footer shows the model, the sampling mode, `[plan]` or `[chat]`, `[no web]`, and what the model is doing. Sessions are stored in `~/.pi-lite/sessions/` (set `PI_LITE_DIR` to move them), and llama-server output goes to `~/.pi-lite/logs/llama-server.log`.

## Modes

| Mode | Tools | Use it to |
|---|---|---|
| agent | read, edit, write, bash, web_search, web_fetch | change code, run commands and tests |
| plan | read, web_search, web_fetch | research the project and write a plan, without changing files |
| chat | web_search, web_fetch | talk, look things up |

Each mode has its own system prompt. The mode and the `/web` setting are saved with the session, so `-c` resumes where you left off; `/clear` starts again in agent mode with the web tools on.

## Web tools

`web_search` searches DuckDuckGo, or Tavily or Brave when `TAVILY_API_KEY` or `BRAVE_API_KEY` is set. `web_fetch` reads one page:

- HTML becomes Markdown with absolute links, so the model can follow them. Text, JSON, and XML come back as they are.
- Long pages come in parts; the result says which `start` continues it.
- Other files, such as PDFs, images, and archives, are saved to `$TMPDIR/pi-lite-fetch/`, and the model is told where, so it can extract them with bash or `read` an image.
- In plan and chat modes, where the web tools are all the model has, `web_fetch` refuses loopback and private addresses, including through redirects, so a page cannot steer the model into your local network. Agent mode reaches them, as bash could anyway.

`PI_WEB_TIMEOUT_MS` changes the request timeout (30 s for pages, 20 s for searches). `/web off` removes both tools and every mention of them from the prompt.

## Hosting

`/serve [name]` or `pi-lite --serve [name]` runs llama-server for the model on `0.0.0.0`, so other machines can use it at the address shown, such as `http://192.168.1.20:8080/v1`. A panel above the editor shows the server's log; esc or ctrl+c stops it. pi-lite refuses to host on a port another llama-server already holds. Stop hosting before sending prompts.

## Memory guard

When memory runs short, the system moves it to swap on disk, and a model that keeps growing slows everything down. The guard stops the model's server when swap passes a limit and less than 10% of memory is free, so the memory is freed:

- **While hosting**, always, at 4.5 GB unless `--max-swap` sets another limit. It waits for requests in progress, stops the server, waits 15 s, and starts it again.
- **In chat and agent work**, only with `--max-swap` (`4.5`, `4.5GB`, `512MB`). It checks after each reply; the server starts again with the next message.

Swap alone would mislead it: the system takes pages back from swap only when their owner uses them again, so the figure stays high after the server stops. Free memory comes back at once. When it does not, other applications hold the memory, and the guard pauses until it is free again rather than reload the model again and again.

## Context window

Nothing is trimmed while the prompt fits in `contextWindow - maxTokens`. Past that, pi-lite trims to 60% of the budget in one go, oldest first:

1. reasoning of all but the two most recent steps (a step is one model response and its tool results);
2. long tool calls and results of those steps. A call with long arguments, such as a file it wrote, becomes a note in the model's own words, such as `(Earlier tool call left out to save context: wrote src/app.ts (120 lines)…)`; a long result keeps its first lines and says how many were left out;
3. whole old turns, never the one in progress;
4. in one long turn that still does not fit, older steps of that turn.

When steps or turns are left out, the task message also carries a short work log built from them: the files written and edited, with line counts and failures, files changed through bash, the plan file the model read, the last test run and its result, and the files earlier tasks changed. With the notes and the log, a model that lost the details still knows what it already did.

Compacted steps never show placeholders where tool arguments were: small models copy those into the files they write. The transcript and the session file are never changed; trimming only shapes what each request sends.

A trimmed message looks the same in every later request, so trimming happens rarely and llama.cpp re-evaluates the prompt only then. That re-evaluation is the cost: at 20 tokens/s of prompt processing, about a minute per 1,200 tokens kept. When a request would leave less than 1,024 tokens (or `maxTokens`, if smaller) for the reply even after trimming, the run stops with a "Context full" error instead of sending it.

`/compact` goes further on request. It asks the loaded model which older tool calls and results are still needed ("Jev" evaluation, adapted from [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)), in one request limited to half the context window, and cuts the rest the same way. Esc cancels it; if the model cannot answer, the rule above decides. Automatic trimming never makes this request, so it never delays a reply or displaces llama.cpp's cached prompt.

Each tool result is capped at about a fifth of `contextWindow - maxTokens`, about 7 KB for a 20k window with 8k reserved. Command output longer than 30 lines is also saved to a file named in the result, so the model can search it instead of running the command again.

## Layout

```
packages/lite          the app
  src/cli.ts           flags and print mode
  src/config/          models.yml loader, sampling presets
  src/llm/             llama.cpp client (fetch and SSE), llama-server manager, swap monitor
  src/agent/           agent loop
  src/tools/           read, edit, write, bash, web_search, web_fetch
  src/context.ts       context window trimming
  src/work-log.ts      the work log sent with trimmed tasks
  src/jev/             /compact: asks the model which tool results are still needed
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
- **Written for pi-lite:** the llama.cpp client (based on pi's OpenAI-compatible client, rebuilt on plain `fetch`), llama-server management and hosting, the models.yml loader, sampling presets, context trimming and the work log, modes, the web tools, the memory guard, sessions, the system prompt, and the interactive app.
- **Adapted from fast-jev-compaction:** `/compact`'s questions and decisions follow [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT), answered by the local model instead of the hosted Jev service.
- **Removed:** cloud providers and OAuth, the model catalog, extensions and package management, remote sessions, summary-based compaction, telemetry, and pi's other packages.

pi-lite is not affiliated with or endorsed by the pi project. Both are released under the MIT License, and [LICENSE](LICENSE) keeps pi's copyright notice alongside pi-lite's.
