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

## Before you start

You need three things. Jev runs through OpenRouter, so one OpenRouter key covers everything.

1. **Claude Code** 2.1.278 or newer, on the web (claude.ai/code) or on your computer.
2. **An OpenRouter API key.** Sign up at [openrouter.ai](https://openrouter.ai), then go to
   **Settings → Keys → Create key**. Keep the key (`sk-or-v1-…`) private and never paste it
   into a chat.
3. **Some OpenRouter credit.** Add at least **$10** under **Settings → Credits**. A Jev
   decision costs about $0.00001, and $10 of lifetime credit also raises the free-model
   allowance from 50 to 1,000 requests a day.

This works in Claude Code only. Regular Claude app chats don't run plugins.

## Setup: Claude Code on the web

Set it up once on a cloud environment; every new session in that environment gets it.
These steps store the key as an **API credential**, so no session ever sees it. API
credentials are available on Pro and Max plans.

1. Open [claude.ai/code](https://claude.ai/code). Click the **cloud environment menu** in a
   session's title bar, hover your environment and click its **settings icon**. API
   credentials only appear when editing an environment that already exists.
2. **Network access:** choose **Custom** and add `openrouter.ai`, or choose **Full**.
3. **Setup script:** replace the contents with:
   ```bash
   git clone --depth 1 https://github.com/tcruz1978-afk/jev-model-routing /root/.claude/jev-model-routing || true
   ```
4. **Environment variables:** add these four lines exactly, with no spaces around `=` and no
   quotes. Don't put your key here.
   ```
   OPENROUTER_AUTH=proxy
   CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
   NODE_USE_ENV_PROXY=1
   CLAUDE_CODE_PLUGIN_DIRS=/root/.claude/jev-model-routing/plugins/jev-skill-suggestion
   ```
5. Click **Save changes**.
6. **API credentials:** click **Add credential** and fill in:
   - Credential type: **Bearer** (the default)
   - Name: `OpenRouter`
   - Allowed websites: `openrouter.ai`
   - Custom headers: leave Name `Authorization` and Prefix `Bearer`; paste your key as the **Value**
7. Click **Connect**.
8. **Start a new session.** Sessions that were already open don't pick up the changes.

No API credentials section (Team or Enterprise plans)? Use `OPENROUTER_API_KEY=sk-or-v1-…`
in step 4 instead of `OPENROUTER_AUTH=proxy`, and skip steps 6–7. Anyone who can use the
environment can read that value.

## Setup: Claude Code on your computer

1. Check `claude --version` is **2.1.278 or newer**.
2. Add two lines to your shell profile (`~/.zshrc` or `~/.bashrc`; on Windows, user
   environment variables), then open a new terminal:
   ```bash
   export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
   export OPENROUTER_API_KEY=sk-or-v1-your-key-here
   ```
3. Start `claude` and run:
   ```
   /plugin marketplace add tcruz1978-afk/jev-model-routing
   /plugin install jev-skill-suggestion@jev-model-routing
   ```
   The install says its options aren't set yet. They're all optional; the key from step 2
   is enough.
4. **Quit Claude Code and start it again.**
5. Optional: run `/jev-skill-suggestion:setup` to take your skills out of Claude's
   always-loaded list, so only Jev's pick is loaded. It asks before changing anything, and
   `/jev-skill-suggestion:setup restore` undoes it.

## Check it works

One prompt tests everything: Jev has to pick the plugin's own model-router skill, and the
router has to get a live answer through OpenRouter.

1. In a **new** session, type this yourself. The skill picker skips messages sent by
   automation or another session, by design.
   ```
   Send this prompt to the cheapest open-source model and show me its answer: say hello in five words
   ```
2. Approve the command if Claude Code asks.
3. It works if you get a short greeting, the name of the model that answered, and
   `decided by Jev (openrouter)`.

Day to day, nothing changes: ask for a spreadsheet, an animation or a deck, and Jev
attaches the matching skill. Plain questions get no skill, on purpose.

## Using the model router

Ask Claude something like "have the cheapest open-source model draft this" or
"which model should handle this refactor?". Claude then runs the skill's
script. You can also run it directly:

```sh
node <plugin>/skills/model-router/scripts/router.mjs "Refactor this function" --prefer quality
node <plugin>/skills/model-router/scripts/router.mjs "Summarise this" --open --prefer cheap
node <plugin>/skills/model-router/scripts/router.mjs "anything" --dry-run
```

## When credit runs out

If the OpenRouter key runs out of credit, skill selection and the model router
switch to OpenRouter's free models (`openrouter/free` and `:free` variants)
instead of failing. Jev has no free version, so a free model decides until you
add credit. Free models are rate-limited: 20 a minute, and 50 a day (1,000 a day
once you've bought $10 of credit).

## How decisions fall back

| Step | Skill selection | Model selection |
|---|---|---|
| 1 | Jev (OpenRouter, or TypeSafe / Vercel AI Gateway if you set their keys) | Jev (same) |
| 2 | OpenRouter chat model (`openai/gpt-6-luna` by default) | OpenRouter chat model (`gpt-6-luna`, or `qwen3.8-flash` with `--open`) |
| 3 | Claude Code's built-in classifier | Keyword rules |

## Troubleshooting

Most problems are a setting that didn't reach the session. Start a fresh session after
every settings change.

| What you see | What it means | Fix |
| --- | --- | --- |
| `OPENROUTER_API_KEY is not set` | No key, and no `OPENROUTER_AUTH=proxy` | Web: add `OPENROUTER_AUTH=proxy`. Computer: add the `export` line and open a new terminal |
| `401: Missing Authentication header` | The key variable exists but is empty | Re-check the line: no spaces, no quotes, nothing after the key |
| `401: No cookie auth credentials found` | No key reached OpenRouter | Web: the credential's allowed website must be exactly `openrouter.ai`, header `Authorization`, prefix `Bearer`. Sessions opened before you added it won't have it |
| `402`, or an "out of credit" note | No credit, or the key's spending limit is reached | Add credit or raise the key's limit at openrouter.ai; free models keep working meanwhile |
| `403` from OpenRouter, or timeouts | The network blocks `openrouter.ai` | Web: allow it under Network access, and keep `NODE_USE_ENV_PROXY=1` |
| "router.mjs not found" | The setup script didn't download the plugin | Web: check the setup script line and start a new session |
| No skill attached | Nothing fits (by design), or the plugin didn't load | Try the check prompt. If model-router isn't picked, check `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` and restart |
| Works in new sessions, not an old one | Plugins load when a session starts | Use a new session |

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

## Checking that Jev picks skills

`evals/skill-selection/run.sh [project dir]` sends each prompt in
`evals/skill-selection/cases.tsv` to a headless Claude Code with the plugin
loaded and Claude's own Skill tool turned off, then reads the plugin's decision
log. A case passes only if the right skill was attached **and** the log shows
Jev made the decision, not the backup model or the built-in classifier.
Expected answers are per project: the shipped cases assume the tc-ventures
skills (`motion-design`, `champion-blueprint`, synced `xlsx`/`pptx`), so edit
`cases.tsv` for yours. Each case costs one short Haiku call plus ~$0.00001 of Jev.

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
