# model-router

> **Source:** this folder lives in
> [jev-model-routing](https://github.com/tcruz1978-afk/jev-model-routing),
> `plugins/jev-skill-suggestion/skills/model-router/scripts/`. Other repos keep
> synced copies (tc-ventures: `tools/model-router/`, refreshed by
> `scripts/sync-skill-copies.sh`); edit it here, never in a copy.

Sends a prompt to the right model on [OpenRouter](https://openrouter.ai).
[Jev](https://typesafe.ai) decides which model a prompt deserves, and one
OpenRouter key reaches both closed models (Claude, GPT, Gemini) and open-weight
ones (DeepSeek, Qwen, Kimi, GLM, MiniMax, Nemotron). No dependencies: Node 18+.

## How it picks a model

1. `--model <id>` uses exactly that model.
2. Otherwise **Jev** (TypeSafe's decision model) decides two things: what kind
   of task it is (`code`, `reasoning`, `writing`, `long_context`, `quick`,
   `general`) and which tier it deserves (`quality`, `balanced`, `cheap`).
   `--prefer` fixes the tier and `--category` fixes the kind, so Jev isn't
   asked about those; with both (or `--category` with `--free`) Jev isn't
   called at all. OpenRouter serves Jev itself (its System One API), so
   the OpenRouter key is all it needs.
3. If Jev can't answer (error, over 2 seconds, or under 35% confident), a
   small OpenRouter chat model answers the same questions instead: GPT-6 Luna,
   or Qwen 3.8 Flash with `--open` (`decider` in `routes.json`, or set
   `ROUTER_DECIDER_MODEL`). If that fails too, keyword and length heuristics
   decide (tier `balanced`). `--no-jev` skips straight to the heuristics. The
   output says which one decided.
4. `routes.json` maps the kind and tier to up to three models, tried in order
   through OpenRouter's fallback routing, with `openrouter/auto` last.
5. `--open` keeps only open-weight models and drops `openrouter/auto`, which
   could pick a closed one.
6. When a model later in the list answers instead of the first one (it was
   down, rate-limited, refused the request, or cost more than the remaining
   credit allows), the CLI prints a note on stderr and `complete()` returns the
   skipped model as `fallbackFrom` (`null` otherwise). OpenRouter doesn't say
   why it skipped a model, so the router reads the account's and the key's
   credit (free `/credits` and `/key` endpoints) and names the one that ran out
   as `creditShort`: `'account'` (no credit left: add credits) or `'key'` (its
   spending limit is used up: raise it).
7. A brief provider error (429, 502, 503 or 504, including one OpenRouter puts
   inside a 200 response) is retried once after 2 seconds; `retried: true`
   says so.

Every completion is sent with `max_tokens` (1000 by default, `--max-tokens`
or `maxTokens` to change it). Without a cap OpenRouter reserves the model's whole
output limit against the key's credit limit and can refuse even a tiny prompt
with a 402. The default keeps that reservation small while leaving room for
reasoning models, which spend a few hundred tokens thinking before they answer.
When an answer hits the cap it is cut short (or empty, if thinking used it all):
the CLI prints a note on stderr and `complete()` returns `truncated: true`.

## Providers you already pay for

`owned` in `routes.json` lists the providers the owner already pays for by
subscription: `openai` (a ChatGPT plan) and `google` (a Gemini Enterprise
seat). A subscription isn't an API key, so its work goes to that provider's
own agent (Codex, Gemini CLI) instead; OpenRouter is never paid for it twice.

- Paid routes drop those providers' models, and `openrouter/auto` (it could
  pick one), then top up from the category's other tiers, nearest first. The
  output says `skipped openai, google (already paid for)`.
- Naming an owned model (or `openrouter/auto`) with `--model` is refused.
- The stand-in decider moves from `gpt-6-luna` to the open decider.
- `--allow-owned` pays OpenRouter anyway for one call; `ROUTER_OWNED=openai,x-ai`
  replaces the list and `ROUTER_OWNED=none` turns the rule off.
- Free models cost nothing and are left alone.

## When credit runs out

If OpenRouter answers 402 (out of credit: the account's balance, or the key's
spending limit), the router doesn't fail:
the routing decision moves to a free model (`openrouter/free`), and the answer
goes to free models for the same kind of task (`free` in `routes.json`). The
output notes the switch. `--free` uses free models from the start. Jev itself
has no free version, so while credit is at zero the free model decides instead.
Free models are rate-limited by OpenRouter: 20 requests a minute, and 50 a day
(1,000 a day once $10 of credit has been bought). A `--model` you name falls
back too, and the reason says `<model> is out of credit`; pass `--strict`
(`strict: true` from code) to get that model or an error instead, as the
tc-ventures review gate does to keep each reviewer in its own model family.

## Track record

Every OpenRouter request records how each model did: the one that answered
(with its time), and the ones the request passed over or that errored as
failures. Running out of credit and the daily free limit are the account's
doing, so they aren't held against a model; a retried request counts once.
Records live in `~/.model-router/stats.json` (`ROUTER_STATS_FILE` to move it,
`ROUTER_STATS=off` to turn it off): each model's last 20 requests, and only
the last 7 days count.

Free routes are ranked by it: the models answering most reliably lately
first, then the faster. A model needs 3 requests on record before its record
moves it; until then it keeps its place from `routes.json`, as do models with
no record. `openrouter/free` keeps its slot. `node router.mjs
stats` shows every model's record; the output notes "ranked by track record"
when the order changed.

Once a route's first choice keeps answering, nothing else on it gets tried,
so a backup could never build the record to move up. About 1 in 10 free
requests therefore explores: the free model with the thinnest record (under 3
requests) goes first, the usual first choice second, and the result notes
"exploring". A failed try falls back as usual and still counts. Dry runs and
`overview` never explore. `--no-explore` or `ROUTER_EXPLORE=off` turns it off.

`overview` lists every model the router can use in one table: paid and free
ones from `routes.json`, and local ones when Ollama answers. For each: how
many routes use it (counting `--open` variants), the routes it's first
choice for (`reasoning(q,b*)`: quality and, only with `--open`, balanced),
and its track record. Models `routes.json` lists but no route reaches show as
`unused`. `--json` gives the full route lists.

## Judgement quotient

Every pick Jev (or its stand-in) makes, the category and the tier, is logged
to the judgement-quotient (JQ) log with the confidence it came with, and the
output shows its `jqId` (`[model · reason · jqId category 1a2b3c4d, tier
5e6f7a8b]`; `--json` has it on each pick). The log is one JSON line per call
in the format of tc-ventures' `tools/jq/jq.mjs` (written by `jq-log.mjs`,
which the jev-skill-suggestion hook shares): `JQ_LOG_FILE` if set, else the
project's shared folder (`/mnt/project-files/judgement-quotient/`) when it
exists, else `~/.jq/decisions.jsonl`; `JQ_LOG=off` turns it off, and tests and
`--dry-run` never write to it. It never holds the prompt's text.

Recording whether a pick held turns "did it answer" into "was it right":
`node tools/jq/jq.mjs outcome <jqId> kept|overruled [--answer <right>]`, then
`node tools/jq/jq.mjs report` shows the figures (run both from tc-ventures,
where `tools/jq` lives).

**JQ levels.** A level (1 to 5) says how often the work must be right: 1 →
31%, 2 → 69%, 3 → 93.3%, 4 → 99.38%, 5 → 99.977% (the Six Sigma table,
copied from `jq.mjs`). Under a level, Jev's pick counts only when its
confidence is at least that share, otherwise the heuristics decide; and the
tier never drops below the level's floor (levels 1–2 any, 3 balanced, 4–5
quality). An explicit `--prefer` still wins. The reason line says which level
applied.

- `--jq <1-5>` sets the level directly.
- `--team <name>` uses the team's level from the owner's private teams file:
  `JQ_TEAMS_FILE`, else `./tools/jq/teams.json` in the current directory, else
  `~/.jq/teams.json`. An unknown team is an error that names the teams there
  are; with no teams file, `--team` says where to put one. The file looks like
  `{"teams": {"<name>": {"level": 3, "source": "who set it, and where"}},
  "default": {"level": 2, "source": "..."}}`. Teams and levels are the owner's
  word, cited; none ship with the router.
- With neither, the teams file's `default` level applies when it sets one
  (the reason line says `default JQ <n>`); with no default, no level applies.

## Local models (Ollama)

`--local` sends the prompt to [Ollama](https://ollama.com) on this machine instead
of OpenRouter: no key, no credit, nothing leaves the machine (unless Jev decides
the category; pass `--category` or `--no-jev` to stay fully offline).

- Routes build themselves from what's pulled, so there's no list to keep in
  step with `ollama list`: pull a model and it's used. Models are ranked by
  size (Ollama's `parameter_size`, else the tag, like `9b` or `0.8b`): the
  largest first for code, reasoning, long_context and writing; a mid-size one
  first for general; the smallest of at least 1B first for quick. Up to three
  per route. Embedding models (`nomic-embed-text`, `mxbai-embed-large`,
  `all-minilm`, `bge-*`) can't chat and are never used.
- To pin a route instead, list Ollama model names under that category in
  `local` in `routes.json`. A name without a tag (`qwen3`) matches any pulled
  tag of it (`qwen3:8b`); a tagged name must match exactly. Pinned models that
  aren't pulled are skipped with a note; if none is pulled, a pulled chat
  model answers instead.
- Requests go to Ollama's own `/api/chat` with thinking off (`think: false`):
  small reasoning models such as `qwen3.5:2b` can think past any token cap
  without answering. `--think` turns it back on (worth it on the larger
  models for hard reasoning); a model with no thinking mode is simply asked
  again without the setting.
- Ollama has no fallback list of its own, so the router tries each model in
  turn. Local requests allow 4000 tokens by default rather than 1000: they
  cost nothing, and reasoning models think before they answer
  (`--max-tokens` still overrides). A model gets 3 minutes to answer (`--timeout <seconds>` to change it;
  the first request to a model also loads it, and reasoning models think
  first); past that its request is cancelled and the next model is tried. The
  output says which models were skipped and why.
- Ollama is reached at `OLLAMA_BASE_URL`, else Ollama's own `OLLAMA_HOST`, else
  `http://localhost:11434`. If it isn't running, the router says so.
- `check --local` shows what's pulled and which models each route will use
  (auto or pinned);
  `sweep --local` runs every category one at a time (a local Ollama runs one
  model at a time), and `sweep --dry-run --local` lists the routes.
- Credit, free models and the paid tiers don't apply to `--local`; the
  fallback, cut-off and dry-run notes do.

## Setup

- Put your keys in environment variables, in the cloud environment's settings or
  in your shell locally. Never commit them.
  - `OPENROUTER_API_KEY`: required, and enough on its own (it covers Jev too).
    On Claude Code on the web (Pro/Max), store the key as an environment **API
    credential** for `openrouter.ai` instead and set `OPENROUTER_AUTH=proxy`:
    requests then go out without a key and the agent proxy adds it, so no
    session ever sees it.
  - `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`: optional, to reach Jev directly
    instead of through OpenRouter.
- The network has to allow `openrouter.ai` (plus `api.typesafe.ai` or
  `ai-gateway.vercel.sh` if you use those keys).
- Behind an HTTPS proxy (Claude Code cloud sessions), set `NODE_USE_ENV_PROXY=1`:
  Node's built-in `fetch` ignores `HTTPS_PROXY` otherwise, and OpenRouter
  answers 403.

## Use

```sh
node router.mjs "Refactor this function: ..."
node router.mjs "Draft a launch email" --prefer quality
node router.mjs "Explain RLS in Postgres" --open --prefer cheap
node router.mjs "anything" --model deepseek/deepseek-r1
node router.mjs "Summarise this report" --max-tokens 1000  # room for a longer answer
node router.mjs "Solve x^2 = 9" --dry-run   # show the route, call nothing
node router.mjs sweep "Say hello" --open     # every category × tier, as a table
node router.mjs sweep --dry-run --open       # every route's model list, no calls, no cost
node router.mjs sweep "Say hello" --free     # live, on free models only ($0)
node router.mjs "Explain this regex" --local --category code  # on your own Ollama
node router.mjs check --local                # which local models are pulled, per route
node router.mjs stats                        # each model's track record
node router.mjs overview                     # every model: its routes, first choices, record
node router.mjs check                        # are the configured models still live?
node router.mjs models qwen                  # browse OpenRouter's catalog
```

From code:

```js
import { complete, route } from './router.mjs'
const { text, model } = await complete('Summarise this contract: ...', { prefer: 'cheap', open: true })
```

`sweep` sends the prompt down every route (6 categories × 3 tiers, narrowed
with `--category`, `--prefer` or `--free`), 4 at a time (`--concurrency <n>`;
more trips providers' rate limits), and prints, per route, the first choice,
the model that answered, the time, and whether it fell back, ran out of credit
(and which: account or key), was retried or was cut off; a failed route shows
its error in place of the answer. It makes one paid request per route; with
`--free` they cost nothing, and `--dry-run` lists the routes without calling
anything. Exits 1 if any route errored.

## Keeping it current

Model IDs change. Run `check` now and then and edit `routes.json`: add a model
under `models` (with `"open": true` if it is open-weight), then list it in the
routes you want. Tests: `node --test router.test.mjs jq-log.test.mjs` in this folder.
