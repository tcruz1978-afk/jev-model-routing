---
name: model-router
description: Send a prompt to the best AI model on OpenRouter, chosen per task by Jev (TypeSafe's decision model), with cheap/balanced/quality tiers and an open-weight-only mode. Use this whenever the user wants a prompt answered by another model (GPT, Gemini, DeepSeek, Qwen, Kimi, GLM, Llama and others), asks which model is best for a task, wants to compare or route between models, wants an open-source model to answer, or wants a cheaper model for a job, even if they don't say "router" or "OpenRouter".
---

# Model router

`scripts/router.mjs` (next to this file) classifies a prompt, picks up to three
OpenRouter models for it from `scripts/routes.json`, and sends it with
OpenRouter's fallback routing. Jev decides the task kind (code, reasoning,
writing, long_context, quick, general) and the tier (quality, balanced, cheap);
if Jev can't answer, a small OpenRouter chat model decides, and keyword rules are
the last resort. The output always says which one decided and which model
answered, so pass that on to the user.

## Requirements

- `OPENROUTER_API_KEY` in the environment, or `OPENROUTER_AUTH=proxy` when the
  cloud environment's agent proxy adds the key (an API credential for `openrouter.ai`). Never ask the user to paste a key
  into the chat; if it's missing, tell them to set it where their environment
  variables live.
- Node 18+. Behind an HTTPS proxy (Claude Code on the web), prefix commands with
  `NODE_USE_ENV_PROXY=1`, or Node's `fetch` bypasses the proxy and gets a 403.

## Commands

Run from this skill's directory (use its absolute path):

```sh
node scripts/router.mjs "<prompt>"                    # Jev picks kind + tier
node scripts/router.mjs "<prompt>" --prefer cheap     # fix the tier: quality | balanced | cheap
node scripts/router.mjs "<prompt>" --open             # open-weight models only
node scripts/router.mjs "<prompt>" --model <id>       # a specific OpenRouter model
node scripts/router.mjs "<prompt>" --dry-run          # show the route, call nothing
node scripts/router.mjs "<prompt>" --json             # machine-readable result
node scripts/router.mjs check                         # are routes.json's models still live?
node scripts/router.mjs models <filter>               # browse OpenRouter's catalog
```

Other flags: `--category <kind>` fixes the task kind, `--system "..."` adds a
system prompt, `--no-jev` uses the keyword rules only.

## Doing it well

- Match the user's intent to flags: "cheapest" → `--prefer cheap`; "best
  possible" → `--prefer quality`; "open source" → `--open`; a named model →
  `--model`.
- Quote long prompts safely (write them to a file and use `"$(cat file)"`).
- Report the answer, the model that served it, and what decided the route.
- If `check` reports missing models, update `scripts/routes.json` (declare new
  models under `models` with `"open": true` when the weights are published).
