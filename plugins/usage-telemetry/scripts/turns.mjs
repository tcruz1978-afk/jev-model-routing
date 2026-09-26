/**
 * Turns: one prompt you sent plus everything that happened in that session
 * until your next prompt — the main agent's and subagents' model calls and
 * tool calls. The unit the dashboard's "How the models are doing" section
 * counts, so a model is judged on whole requests, not single API calls.
 *
 * Runs at build time on the compact rows (see dashboard.mjs); the page gets
 * the finished turn rows and only filters and groups them.
 */

/** Model with the most output tokens among the main agent's calls, or null. */
function mainModelOf(api) {
  const out = new Map()
  for (const r of api) {
    if (!r.m || (r.a && r.a !== 'main')) continue
    out.set(r.m, (out.get(r.m) ?? 0) + (r.o ?? 0))
  }
  let best = null
  for (const [m, o] of out) if (best === null || o > out.get(best)) best = m
  return best
}

/**
 * Turn rows from compact rows (short keys, sorted or not). Each turn:
 *   t prompt time, s session index, h host, p project, cat category,
 *   m main model (null when no main-agent model call), ms models used,
 *   c Claude cost at API list prices (API-equivalent, not a bill; null when
 *   no call in the turn had a price), rc cost
 *   the model router's OpenRouter calls logged (billed; kept apart from c, the
 *   two are never added), o output tokens, dur ms from prompt to the turn's last event, tl tool
 *   calls, tf tool failures, sa subagents started, sk skills loaded, ak
 *   skills its model calls were attributed to,
 *   land true (your next prompt did not push back), false (it did), or null
 *   (no next prompt in the session yet: unknown).
 */
export function turnsFrom(rows) {
  const bySession = new Map()
  for (const r of rows) {
    if (r.s === undefined || r.s === null || r.s < 0) continue
    if (!bySession.has(r.s)) bySession.set(r.s, [])
    bySession.get(r.s).push(r)
  }
  const turns = []
  for (const list of bySession.values()) {
    list.sort((a, b) => a.t - b.t)
    const isPrompt = (r) => r.k === 'prompt' && (!r.a || r.a === 'main')
    const starts = []
    list.forEach((r, i) => isPrompt(r) && starts.push(i))
    starts.forEach((start, n) => {
      const prompt = list[start]
      const end = n + 1 < starts.length ? starts[n + 1] : list.length
      const body = list.slice(start + 1, end)
      const api = body.filter((r) => r.k === 'api')
      const routed = body.filter((r) => r.k === 'router.call')
      const tools = body.filter((r) => r.k === 'tool')
      const next = n + 1 < starts.length ? list[starts[n + 1]] : null
      const cost = api.reduce((a, r) => a + (r.c ?? 0), 0)
      const routedCost = routed.reduce((a, r) => a + (r.c ?? 0), 0)
      turns.push({
        t: prompt.t,
        s: prompt.s,
        h: prompt.h ?? '',
        ...(prompt.p ? { p: prompt.p } : {}),
        cat: prompt.cat ?? (prompt.sl ? 'command' : null),
        m: mainModelOf(api),
        ms: [...new Set(api.map((r) => r.m).filter(Boolean))],
        // null when no model call in the turn had a price: left out of medians, never $0.
        c: api.some((r) => Number.isFinite(r.c)) ? Math.round(cost * 1e6) / 1e6 : null,
        ...(routed.length ? { rc: Math.round(routedCost * 1e8) / 1e8 } : {}),
        o: api.reduce((a, r) => a + (r.o ?? 0), 0),
        dur: body.length ? body[body.length - 1].t - prompt.t : 0,
        tl: tools.length,
        tf: tools.filter((r) => r.ok === false).length,
        sa: tools.filter((r) => r.tl === 'Agent' || r.tl === 'Task').length,
        sk: [...new Set(tools.filter((r) => r.tl === 'Skill' && r.sk && r.ok !== false).map((r) => r.sk))],
        // Skills the turn's model calls worked for (set by attribute in checks.mjs, when it ran first).
        ak: [...new Set(api.map((r) => r.as).filter(Boolean))],
        land: next ? !next.cx : null,
      })
    })
  }
  return turns.sort((a, b) => a.t - b.t)
}
