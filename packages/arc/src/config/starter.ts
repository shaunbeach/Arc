/** Written by `arc --init`. The README's models.yml section documents every field. */
export const STARTER_MODELS_YML = `# Arc models. Pick one with "arc -m <name>" or /model, and Arc
# starts llama-server with its launchArgs. Only "providers:" is read, so this
# file can also hold settings for other tools.
providers:
  llamacpp:
    baseUrl: http://localhost:8080/v1   # port must match --port in launchArgs
    auth: none
    modelDir: ~/models                  # base directory for relative ids
    # llamaServer: /opt/homebrew/bin/llama-server   # default: llama-server on PATH
    models:
      - id: Qwen3.8-27B-Q4_K_M.gguf     # GGUF file, relative to modelDir or an absolute path
        name: Qwen3.8-27B               # any unique part of it works with -m
        reasoning: true                 # the model has a thinking switch
        contextWindow: 16384            # keep equal to --ctx-size
        maxTokens: 4096                 # reply reserve; older context is trimmed to keep it free
        launchArgs: ["--port", "8080", "--ctx-size", "16384", "--n-gpu-layers", "99", "--flash-attn", "on"]
        # mode: instruct                # default: thinking for reasoning models
        # sampling:                     # per-mode overrides of the built-in presets
        #   thinking:
        #     extra:
        #       chat_template_kwargs:
        #         reasoning_effort: medium
`;
