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

## Default order

With no `--local`, `--free`, `--paid` or `--model`, Jev (held to the JQ
level's bar) decides the kind of task and the tier once, then the prompt goes
down this order until something answers:

1. **Local**: Ollama on this machine, when it is running.
2. **Subscriptions**: Claude Code (`claude -p`), Gemini CLI (`gemini -p`) or
   Codex (`codex exec`), when the route Jev picked names a Claude, Gemini or
   GPT model and that tool is installed. These run on the owner's own sign-in,
   already paid for (`agents` in `routes.json`).
3. **Free**: OpenRouter's free models.
4. **Paid**: the OpenRouter route for that tier.

A quality tier (Jev's pick, or a JQ level of 4–5) skips local and free. The
output ends with `answered via <step>`, and a `note: skipped ...` line says why
each earlier step didn't answer; pass both on. `--paid` goes straight to step 4.

## Commands

Run from this skill's directory (use its absolute path):

```sh
node scripts/router.mjs "<prompt>"                    # Jev picks kind + tier
node scripts/router.mjs "<prompt>" --prefer cheap     # fix the tier: quality | balanced | cheap
node scripts/router.mjs "<prompt>" --open             # open-weight models only
node scripts/router.mjs "<prompt>" --model <id>       # a specific OpenRouter model
node scripts/router.mjs "<prompt>" --dry-run          # show the route, call nothing
node scripts/router.mjs "<prompt>" --json             # machine-readable result
node scripts/router.mjs "<prompt>" --team <name>      # route for a team's JQ level
node scripts/router.mjs check                         # are routes.json's models still live?
node scripts/router.mjs models <filter>               # browse OpenRouter's catalog
```

Other flags: `--category <kind>` fixes the task kind, `--system "..."` adds a
system prompt, `--no-jev` uses the keyword rules only, `--free` uses free
models from the start, `--strict` keeps a named model even when out of credit.

## Providers already paid for

`openai`, `google` and `anthropic` are paid for by subscription (`owned` in
`routes.json`), so routes never send their models to OpenRouter and
`--model openai/...` is refused. When the user wants GPT, Gemini or
Claude specifically, that work belongs to Codex, Gemini CLI or Claude Code on
the owner's sign-in, not this router. Only pass `--allow-owned` when the user asks to pay
OpenRouter for it anyway.

## When credit runs out

Never stop or wait for credit. On a 402 the router switches to free models on
its own, a named `--model` included, and says so in its output; pass that on
("answered by <free model>, because the key is out of credit"). Add
`--strict` only when the exact model matters more than getting an answer.
Free models allow 20 requests a minute and 50 a day (1,000 once $10 of credit
has been bought): on a 429, wait a minute and retry, or name a free model
from another family (`--model <id>:free`).

A named free model that is refused (rate-limited, no longer free, or
restricted) is replaced by its own family, so a review gate's reviewers stay
theirs: the family's other free models first, then the same model paid
(cents), except for an owned family (`openai`, `google`, `anthropic`), whose
paid models stay the subscription's. A 402 that names in-flight requests is
retried once: the balance is fine once the running calls finish.

## Judgement quotient (JQ)

- `--jq <1-5>` or `--team <name>` sets how often the work must be right: the
  tier never drops below the level's floor (1–2 any, 3 balanced, 4–5 quality)
  and Jev's pick counts only when it is at least that sure. Teams come from
  the owner's private teams file (`JQ_TEAMS_FILE`, else `./tools/jq/teams.json`,
  else `~/.jq/teams.json`); with neither flag, its `default` level applies.
- Jev's category and tier picks are logged for scoring; the output shows
  their `jqId`. Pass it on so the user can record whether the pick held
  (`node tools/jq/jq.mjs outcome <jqId> kept|overruled`, in tc-ventures).
- Details: `scripts/README.md`.

## Doing it well

- Match the user's intent to flags: "cheapest" → `--prefer cheap`; "best
  possible" → `--prefer quality`; "open source" → `--open`; a named model →
  `--model`.
- Quote long prompts safely (write them to a file and use `"$(cat file)"`).
- Report the answer, the model that served it, and what decided the route.
- If `check` reports missing models, update `scripts/routes.json` (declare new
  models under `models` with `"open": true` when the weights are published).
