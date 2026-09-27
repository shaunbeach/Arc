# Arc quickstart

Arc is an AI assistant that runs in your Mac's Terminal and uses AI models
that run **on your own Mac**: no account, no subscription, nothing sent to
the cloud. It can chat, answer questions, search the web, and (in agent mode)
read and change files and run commands in a project folder.

This guide sets up Arc with a small, fast model. It takes about 20 minutes.
For a bigger, smarter model on an 8 GB Mac, use Gemma 4 afterwards: see
[Using Gemma 4](#using-gemma-4) at the end.

---

## What you need

- A Mac with Apple Silicon (M1 or newer), 8 GB of memory or more
- About 5 GB of free disk space
- If this repository is private: an invite from Shaun to your GitHub account

## 1. Install the tools (once)

Open **Terminal** (⌘-Space, type *Terminal*, press Return).

If you don't have **Homebrew** yet (`brew --version` says *command not
found*), install it. It asks for your Mac password; nothing shows while you
type it, which is normal:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

When it finishes, run the lines it prints under **Next steps**, then close and
reopen Terminal.

Then install Node.js (Arc is written in it), llama.cpp (runs the models), and
GitHub's tool:

```bash
brew install node llama.cpp gh
gh auth login
```

For `gh auth login`, choose **GitHub.com → HTTPS → Yes → Login with a web
browser**.

## 2. Download and build Arc

```bash
cd ~
gh repo clone shaunbeach/Arc arc
cd ~/arc
npm ci --ignore-scripts
npm run build
```

The last line should say `packages/arc/dist/arc.js (…KB)`.

## 3. Make the `arc` command

```bash
mkdir -p ~/.local/bin
ln -sf ~/arc/packages/arc/dist/arc.js ~/.local/bin/arc
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
arc --help
```

You should see Arc's help text. (If you already had `~/.local/bin` on your
PATH, the `echo` line is harmless.)

## 4. Download a model

Qwen 3.5 4B is a small, quick model (2.7 GB) that works well on 8 GB Macs:

```bash
mkdir -p ~/models
curl -L -o ~/models/Qwen3.5-4B-Q4_K_M.gguf \
  https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf
```

## 5. Tell Arc about it

This writes Arc's settings file, `~/.arc/models.yml`, in one go. Copy the whole
block, from `mkdir` down to `EOF`, into Terminal:

```bash
mkdir -p ~/.arc
cat > ~/.arc/models.yml <<'EOF'
providers:
  llamacpp:
    baseUrl: http://localhost:8080/v1
    auth: none
    modelDir: ~/models
    models:
      - id: Qwen3.5-4B-Q4_K_M.gguf
        name: Qwen3.5-4B
        reasoning: true
        contextWindow: 16384
        maxTokens: 4096
        launchArgs: ["--port", "8080", "--ctx-size", "16384", "--n-gpu-layers", "99", "--flash-attn", "on"]
EOF
```

If you already have a `~/.arc/models.yml`, this replaces it.

## 6. Start Arc

Arc works in the folder you start it in, so make a folder to play in:

```bash
mkdir -p ~/playground && cd ~/playground
arc -m Qwen3.5-4B
```

The first start takes a few seconds while the model loads. Then type a
message and press Return.

---

## Using Arc

| Type | What it does |
|---|---|
| `/agent` | **Default.** The model can read and change files and run commands in this folder, *without asking first* |
| `/plan` | Reads and researches, but changes nothing |
| `/chat` | Just talks (and searches the web) |
| `/mode instruct` | Answers straight away (faster) |
| `/mode thinking` | Thinks before answering (slower, better at hard problems) |
| `/web off` | No internet for the model |
| `/model` | Pick another model from your `models.yml` |
| `/clear` | Start a new conversation |
| `/resume` | Pick up an earlier conversation from this folder |
| `/quit` | Leave (or press Ctrl+D) |

- **Esc** stops the model mid-answer.
- `arc -c` continues the last conversation in the current folder.
- Conversations are saved in `~/.arc/sessions`.

**Be careful with agent mode.** The model runs commands on its own. Start Arc
in a project folder (never your home folder), keep backups of anything
important, and use `/chat` or `/plan` when you only want advice.

## Updating Arc

```bash
cd ~/arc
git pull
npm ci --ignore-scripts
npm run build
```

## Troubleshooting

| You see | Do this |
|---|---|
| `arc: command not found` | Run step 3 again, then open a new Terminal window. |
| `llama-server` not found | `brew install llama.cpp` |
| `Nothing is serving at http://localhost:…` | For a model that starts on its own server (like Gemma), that server isn't running. Start it first. |
| The Mac gets slow / beach balls | The model doesn't fit alongside everything else. Close other apps, or lower `contextWindow` and `--ctx-size` (keep the two equal). |
| `npm ci` errors about the Node version | `brew upgrade node` (Arc needs Node 22.19 or newer). |

---

## Using Gemma 4

Gemma 4 26B is much more capable than the 4B model above, and it can look at
images. A special engine lets it run on an **8 GB Mac**. Set it up with the
Gemma quickstart:
<https://github.com/shaunbeach/TurboField_optimized/blob/main/QUICKSTART.md>.
Its step 6 adds Gemma to the `models.yml` you made above, and then
`arc -m Gemma4` uses it.

Only run one big model at a time: before using Gemma, `/quit` any Arc session
that is running the 4B model.

For everything else (all the settings, hosting a model for another computer,
the supervisor), see [README.md](README.md).
