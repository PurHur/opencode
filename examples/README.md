# Examples

Ready-to-adapt configuration and command templates for this opencode fork.

- **[`small-model-config.jsonc`](./small-model-config.jsonc)** — a heavily-commented
  example config for pointing opencode-fork at a small / local model over an
  OpenAI-compatible endpoint (e.g. a quantized 20-30B under llama.cpp), tuned so
  dynamic workflows and subagents behave. Pairs with
  [`../docs/small-model-guide.md`](../docs/small-model-guide.md).
- **[`opencode-commands/`](./opencode-commands/)** — slash-command templates that
  wrap the native `workflow` tool (`research.md`, `audit.md`, `refactor.md`). Copy
  any into your project's `.opencode/command/` (or global
  `~/.config/opencode/command/`) and invoke by filename; adjust the prompts,
  `agent`, and `model` to your setup. See
  [`../docs/native-orchestration.md`](../docs/native-orchestration.md).
