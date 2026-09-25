# jev-model-routing

A Claude Code plugin that puts [Jev](https://openrouter.ai/typesafe), TypeSafe's
decision model, in charge of two choices, using one OpenRouter API key:

- **Which skill to load.** Instead of sending Claude the whole skill list on
  every prompt, Jev picks at most one skill and attaches it. If Jev can't
  answer, an OpenRouter chat model picks. Claude Code's built-in classifier is
  the last resort.
- **Which model answers.** The bundled `model-router` skill sends a prompt to the
  best OpenRouter model for it. Jev decides the kind of task and how much model
  it needs, and OpenRouter runs it. There are cheap, balanced and quality tiers,
  and an open-weight-only mode.

## Install

1. **Claude Code 2.1.278 or newer**, started with function hooks on:
   ```sh
   export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
   ```
2. **Your OpenRouter key** in the environment. Create one at
   https://openrouter.ai/settings/keys, and never commit it:
   ```sh
   export OPENROUTER_API_KEY=sk-or-v1-...
   ```
3. **Add the marketplace and install** from inside Claude Code:
   ```
   /plugin marketplace add tcruz1978-afk/jev-model-routing
   /plugin install jev-skill-suggestion@jev-model-routing
   ```
   The install notes that the options aren't set yet. They're all optional,
   and `OPENROUTER_API_KEY` alone is enough.
4. **Restart Claude Code.** The first prompt logs
   `[jev-skill-suggestion] ready on typesafe (https://openrouter.ai/api/v1/systemone)`.
5. **Optional:** run `/jev-skill-suggestion:setup` to hide your skills from
   Claude's listing (`/context` then counts them at 0). Jev keeps loading the
   one each prompt needs, and `/jev-skill-suggestion:setup restore` undoes it.

### Claude Code on the web

Set these in the cloud environment's settings, not in chat:

- The OpenRouter key. On Pro/Max, the most secure option is an **API credential**: name it `OpenRouter`, allowed website `openrouter.ai`, header `Authorization` with prefix `Bearer`. Then set `OPENROUTER_AUTH=proxy`, and sessions never see the key. Otherwise set `OPENROUTER_API_KEY`.
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`
- `NODE_USE_ENV_PROXY=1`, so the model router's Node `fetch` uses the proxy
- Network access: allow `openrouter.ai`

## Using the model router

Ask Claude something like "have the cheapest open-source model draft this" or
"which model should handle this refactor?". Claude then runs the skill's
script. You can also run it directly:

```sh
node <plugin>/skills/model-router/scripts/router.mjs "Refactor this function" --prefer quality
node <plugin>/skills/model-router/scripts/router.mjs "Summarise this" --open --prefer cheap
node <plugin>/skills/model-router/scripts/router.mjs "anything" --dry-run
```

## How decisions fall back

| Step | Skill selection | Model selection |
|---|---|---|
| 1 | Jev (OpenRouter, or TypeSafe / Vercel AI Gateway if you set their keys) | Jev (same) |
| 2 | OpenRouter chat model (`openai/gpt-6-luna` by default) | OpenRouter chat model (`gpt-6-luna`, or `qwen3.8-flash` with `--open`) |
| 3 | Claude Code's built-in classifier | Keyword rules |

## Options

All optional. Set them with `/plugin` → configure, or under `pluginConfigs` in
`~/.claude/settings.json`, keyed by `jev-skill-suggestion@jev-model-routing`:

- `typesafeApiKey` and `typesafeBaseUrl`: call TypeSafe (or another System One
  endpoint) directly.
- `gatewayApiKey`: use the Vercel AI Gateway.
- `fallbackApiKey`, `fallbackBaseUrl` and `fallbackModel`: the backup chat
  model.
- `inject`, `hideListing`, `rerank`, `shortlist`, `gateThreshold`,
  `fitsThreshold`, `alwaysListed`, `neverSuggested`, `timeoutMs`,
  `logDecisions`: see
  [the plugin's README](plugins/jev-skill-suggestion/README.md).

For the model router, `ROUTER_DECIDER_MODEL` overrides the backup model and
`scripts/routes.json` holds the model lists.

## What leaves your machine

With a key set, each prompt's text and your skills' names and descriptions go
to Jev, and short excerpts of shortlisted skills go on a second request. If Jev
doesn't answer, the prompt and skill list go to the backup model. The model
router sends your prompt to the models it picks. Everything goes through
OpenRouter unless you configure another backend. Nothing is sent without a key.

## Tests

```sh
cd plugins/jev-skill-suggestion && bun test tests
node --test plugins/jev-skill-suggestion/skills/model-router/scripts/router.test.mjs
```

## Credits

The skill-selection hook is based on the `jev-skill-suggestion` mod from
[claude-code-templates](https://github.com/davila7/claude-code-templates) (MIT)
and follows TypeSafe's skill-suggestion cookbook. Jev is made by
[TypeSafe](https://docs.typesafe.ai) and served by
[OpenRouter](https://openrouter.ai/docs/guides/community/jev).
