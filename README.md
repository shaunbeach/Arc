# Arc

A terminal coding assistant for local models served by llama.cpp. It starts `llama-server` for the model you pick, gives the model tools to read, edit, and write files, run shell commands, and search and read the web, and keeps its prompt, memory use, and screen updates small.

Arc is a modified version of [pi](https://github.com/earendil-works/pi), the terminal coding agent by Mario Zechner and contributors. It keeps pi's agent loop, tools, and terminal UI library, and drops the cloud providers, logins, extensions, and telemetry. See [Origin and license](#origin-and-license).

- **Local models.** Models, ports, and llama-server arguments come from `models.yml`; the model runs on llama-server. The only other network requests come from the web tools, which `/web off` turns off.
- **Small prompt.** The system prompt and tool definitions take under 1,000 tokens (about 100 more with `/rag on`) and stay byte-identical until you switch mode, `/web`, or `/rag`, so llama.cpp reuses its KV cache.
- **Small process.** One Node process (about 60 MB resident) running a single 590 KB file. llama-server runs only while Arc does.
- **Three ways to work.** Agent mode changes code, plan mode researches and plans without changing files, chat mode just talks. Thinking and instruct sampling switch independently.
- **Built for long runs in small windows.** Trimming keeps a record of what it removes, so a model with a 16k window does not lose track of the files it wrote. See [Context window](#context-window).
- **Terminal friendly.** Renders on the main screen, so tmux and terminal scrollback keep working. Sessions are saved as append-only JSONL.

## Requirements

- Node.js 22.19 or later
- `llama-server` from llama.cpp on your `PATH`, or its path in `models.yml` (`llamaServer`) or `$LLAMA_SERVER`. On macOS, `brew install node llama.cpp` covers both.
- GGUF models

## Install

```bash
git clone https://github.com/shaunbeach/Arc.git arc
cd arc
npm ci --ignore-scripts
npm run build
ln -s "$PWD/packages/arc/dist/arc.js" ~/.local/bin/arc   # a symlink, so rebuilds apply at once
arc --init    # writes ~/.arc/models.yml; set your GGUF path in it
arc
```

The build is one bundled file with no dependencies. Arc is not on npm: the npm package named `arc` is an unrelated project, so do not `npm install -g arc`.

### Coming from pi-lite

Arc was called pi-lite. The first time `arc` runs, it moves `~/.pi-lite` to `~/.arc`, so sessions, logs, the last-used model, and models.yml carry over; quit any running pi-lite first. `PI_LITE_DIR`, `PI_MODELS`, and `PI_WEB_TIMEOUT_MS` still work alongside the new `ARC_DIR`, `ARC_MODELS`, and `ARC_WEB_TIMEOUT_MS`. The `pi-lite` command is gone: replace its symlink with the `arc` one above. The repository moved to `shaunbeach/Arc`; GitHub redirects the old address, and `git remote set-url origin https://github.com/shaunbeach/Arc.git` points a clone at the new one.

## models.yml

Arc reads `--models <path>`, else `$ARC_MODELS`, else `./models.yml`, else `~/.arc/models.yml`. `arc --init` writes a commented starter file to the last location. Only the `providers:` key is read, so the file can hold settings for other tools; to share one file, symlink it to `~/.arc/models.yml`.

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

Arc runs `llama-server -m <modelDir>/<id> <launchArgs>`, adding `--port` from `baseUrl` when it is missing, and waits for `/health`. It stops the server when you quit, switch models, or `/disconnect`. A running server that already serves the same GGUF is reused and is never stopped by Arc.

## Connecting to a model on another machine

A models.yml entry describes a GGUF that Arc can start. That does not work for a model running somewhere else: the path belongs to the other machine, and every change there -- a different quant, a wider window, a projector loaded -- has to be copied back by hand, or Arc refuses to attach.

`discover: true` describes no model at all. On connect Arc asks the server's `/props` what it is running and takes the answer:

```yaml
providers:
  remote:
    baseUrl: http://192.168.1.27:8080/v1   # or a tunnel: ssh -N -L 8081:127.0.0.1:8080 host
    auth: none
    discover: true
    name: Remote                           # what to type: /model Remote
```

```
Connected to Ornith-1.5-9B-Q4_K_M at http://192.168.1.27:8080 · ctx 65.5k · reply 8.2k · thinking · vision · b10809-5266f24da
```

The GGUF name, the context window, whether it loaded a projector, and whether its template supports thinking all come from the server, so the banner and footer name the real model and `read` attaches images only when it can. Start something else there and `/model Remote` again: it asks afresh. Arc never starts a server for such an entry: it says `Nothing is serving at ...` when the address is quiet, and `Lost the connection to ...` when a server that had answered stops or the route to it goes down.

`maxTokens` is the one thing `/props` does not advertise, being Arc's reply reserve rather than a server setting; left out it defaults to a quarter of the reported window, capped at 8192. Per-request variants are not discoverable either, so reasoning-effort levels still need one ordinary entry each.

## Sampling modes

| Mode | temperature | top_p | top_k | min_p | presence_penalty | Thinking |
|---|---|---|---|---|---|---|
| thinking | 1.0 | 0.95 | 20 | 0.0 | 0.0 | On. Reasoning from the current turn is sent back; older reasoning is dropped. |
| instruct | 0.7 | 0.80 | 20 | 0.0 | 1.5 | Off |

The presets live in `packages/arc/src/config/sampling.ts`. A model's `sampling:` block can override any field, including `thinkingHistory` (`none`, `turn`, or `all`), `reasoningEffort`, and `extra`, which merges arbitrary request fields.

## Usage

```bash
arc                                        # interactive session; pick a model with /model
arc -m 27b                                 # load a model at start: any unique part of its name
arc -m Qwen3.8 --mode instruct
arc -c                                     # continue the latest session in this directory
arc -r                                     # pick a saved session to resume
arc --serve 27b                            # host a model for other machines (see Hosting)
arc -m 27b --max-swap 6GB                  # guard memory during a long run (see Memory guard)
arc -p "run the tests and fix failures"    # one prompt, reply on stdout
arc --list-models                          # * marks the model -p uses without -m
arc --show-prompt                          # system prompt and tool definitions, with a token estimate
```

The startup banner lists this directory's five most recent sessions (three on a narrow terminal), numbered for `/resume`. An interactive session starts without a model; `/model` opens a picker, and a message sent before then opens it too. `-c`, `-r`, and `--session` load the model the session used.

| Command | Effect |
|---|---|
| `/model [name]` | Load or switch model (restarts llama-server). Without a name, opens a picker. A `discover` entry asks the server again. |
| `/mode [thinking\|instruct]` | Switch sampling mode. Without an argument, toggles. |
| `/agent`, `/plan`, `/chat` | Switch how the model works. See [Modes](#modes). |
| `/web [on\|off]` | Give the model the web tools, or take them away. Without an argument, toggles. |
| `/rag [on\|off]` | Let the model search your offline knowledge base. Without an argument, toggles. See [Knowledge base](#knowledge-base). |
| `/compact [threshold]` | Ask the model which old tool results it still needs, and cut the rest. See [Context window](#context-window). |
| `/serve [name]` | Host a model for other machines. See [Hosting](#hosting). |
| `/disconnect` | Stop llama-server and unload the model without exiting. |
| `/clear` | Clear the conversation and start a new session (also `/new`, `/cls`, `/reset`). |
| `/resume [number\|name\|id]` | Resume a saved session from this directory: its number in the banner's recent list, part of its `/name`, or its id. Without an argument, opens a picker. |
| `/name <text>` | Name this session. The banner and `/resume` show the name instead of the first message. |
| `/quit` | Exit. |

| Key | Effect |
|---|---|
| `esc` | Abort the running request, model load, or `/compact`; stop hosting |
| `ctrl+c` | Abort or stop hosting; otherwise clear the editor; otherwise exit |
| `ctrl+d` | Exit when the editor is empty |
| `shift+tab` | Switch sampling mode |

You can keep typing while the model works. Each message you send is queued, and the status line counts them ("2 queued"):

- When the model finishes a round of tool calls, the queued messages go in before its next step, so it reads them mid-task and can change course.
- When it finishes a reply without tool calls, they are sent next as a new message.
- While a model loads or `/compact` runs, they wait and go out when it is done.
- If you press `esc` to abort, they come back into the editor instead of being sent.

Commands such as `/web` or `/rag` are not queued: they run right away, and a change to the model's tools takes effect with your next message.

The footer shows the model, the sampling mode, `[plan]` or `[chat]`, `[no web]`, `[rag]`, and what the model is doing. Sessions are stored in `~/.arc/sessions/` (set `ARC_DIR` to move them), and llama-server output goes to `~/.arc/logs/llama-server.log`.

## Modes

| Mode | Tools | Use it to |
|---|---|---|
| agent | read, edit, write, bash, web_search, web_fetch | change code, run commands and tests |
| plan | read, web_search, web_fetch | research the project and write a plan, without changing files |
| chat | web_search, web_fetch | talk, look things up |

Each mode has its own system prompt. With `/rag on`, every mode also gets `kb_search`. The mode and the `/web` and `/rag` settings are saved with the session, so `-c` resumes where you left off; `/clear` starts again in agent mode with the web tools on and the knowledge base off.

## Web tools

`web_search` searches DuckDuckGo, or Tavily or Brave when `TAVILY_API_KEY` or `BRAVE_API_KEY` is set. `web_fetch` reads one page:

- HTML becomes Markdown with absolute links, so the model can follow them. Text, JSON, and XML come back as they are.
- Long pages come in parts; the result says which `start` continues it.
- Other files, such as PDFs, images, and archives, are saved to `$TMPDIR/arc-fetch/`, and the model is told where, so it can extract them with bash or `read` an image.
- In plan and chat modes, where the web tools are all the model has, `web_fetch` refuses loopback and private addresses, including through redirects, so a page cannot steer the model into your local network. Agent mode reaches them, as bash could anyway.

`ARC_WEB_TIMEOUT_MS` changes the request timeout (30 s for pages, 20 s for searches). `/web off` removes both tools and every mention of them from the prompt.

## Knowledge base

`/rag on` gives the model `kb_search`, which searches offline [ZIM archives](https://wiki.openzim.org/): Wikipedia, DevDocs, and the rest of [library.kiwix.org](https://library.kiwix.org). It needs `kiwix-serve` from [kiwix-tools](https://download.kiwix.org/release/kiwix-tools/) and a folder of `.zim` files, named in `models.yml`:

```yaml
rag:
  zimFolder: ~/Documents/RAG_Databases
  # kiwixServe: /usr/local/bin/kiwix-serve   # when it is not on PATH
```

- **Searching** returns five results with short snippets, about 1,200 tokens. It combines kiwix's full-text ranking with title matches, so "deepest point of the atlantic ocean" puts *Atlantic Ocean* first.
- **Reading** an article returns only the parts that match the question: the opening paragraphs, then the best-matching sections, up to a fifth of the room in the context window (about 7,000 characters for a 20k window), without links, citation marks, info boxes, or reference lists. A whole Wikipedia article can hold 40,000 tokens; the result names the sections it left out, so the model can ask for one.
- **Cost.** About 100 tokens per request while it is on (about 300 in chat mode with the web off, where the chat template adds its tool instructions), nothing while it is off. kiwix-serve starts with `/rag on`, takes about 70 MB, answers searches in a few hundredths of a second, and stops with `/rag off` or when Arc exits. Its output goes to `~/.arc/logs/kiwix-serve.log`.

## Hosting

`/serve [name]` or `arc --serve [name]` runs llama-server for the model on `0.0.0.0`, so other machines can use it at the address shown, such as `http://192.168.1.20:8080/v1`. A panel above the editor shows the server's log; esc or ctrl+c stops it. Arc refuses to host on a port another llama-server already holds. Stop hosting before sending prompts.

## Memory guard

When memory runs short, the system moves it to swap on disk, and a model that keeps growing slows everything down. The guard stops the model's server when swap passes a limit and less than 10% of memory is free, so the memory is freed:

- **While hosting**, always, at 4.5 GB unless `--max-swap` sets another limit. It waits for requests in progress, stops the server, waits 15 s, and starts it again.
- **In chat and agent work**, only with `--max-swap` (`4.5`, `4.5GB`, `512MB`). It checks after each reply; the server starts again with the next message.

Swap alone would mislead it: the system takes pages back from swap only when their owner uses them again, so the figure stays high after the server stops. Free memory comes back at once. When it does not, other applications hold the memory, and the guard pauses until it is free again rather than reload the model again and again.

## Context window

Nothing is trimmed while the prompt fits in `contextWindow - maxTokens`. Past that, Arc trims to 60% of the budget in one go, oldest first:

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
packages/arc          the app
  src/cli.ts           flags and print mode
  src/config/          models.yml loader, sampling presets
  src/llm/             llama.cpp client (fetch and SSE), llama-server manager, swap monitor, /props discovery
  src/agent/           agent loop
  src/tools/           read, edit, write, bash, web_search, web_fetch, kb_search
  src/rag/             kiwix-serve, and cutting articles down to the parts that match
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

Arc began as a fork of [earendil-works/pi](https://github.com/earendil-works/pi) at commit `08dc60bc5` (September 2026) and was cut down to a llama.cpp-only harness. This repository starts with a fresh history; pi's repository holds the history of the code Arc inherits.

- **Adapted from pi:** the agent loop and its event stream, tool-argument validation, streaming JSON parsing, the read, edit, write, and bash tools (including edit's fuzzy matching and output truncation), and pi-tui, pi's terminal UI library, trimmed to what Arc uses (`packages/tui`).
- **Written for Arc:** the llama.cpp client (based on pi's OpenAI-compatible client, rebuilt on plain `fetch`), llama-server management and hosting, the models.yml loader, sampling presets, context trimming and the work log, modes, the web tools, the memory guard, sessions, the system prompt, and the interactive app.
- **Adapted from fast-jev-compaction:** `/compact`'s questions and decisions follow [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT), answered by the local model instead of the hosted Jev service.
- **Removed:** cloud providers and OAuth, the model catalog, extensions and package management, remote sessions, summary-based compaction, telemetry, and pi's other packages.

Arc is not affiliated with or endorsed by the pi project. Both are released under the MIT License, and [LICENSE](LICENSE) keeps pi's copyright notice alongside Arc's.
