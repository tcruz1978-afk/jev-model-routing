/**
 * The page's words: turns the checks (checks.mjs) into the plain-English top
 * block a busy owner reads in thirty seconds — one line per check, a verdict,
 * a spend line and a "What to do" list — plus each check's short detail
 * panel. No arithmetic here beyond rounding; every number comes from
 * checks.mjs.
 *
 * Like checks.mjs it runs in node (tests) and in the page: dashboard.mjs
 * inlines it after checks.mjs, dropping the import line and `export`.
 * Visible text must pass BANNED (see the tests): no code, paths, internal
 * terms or statistics jargon. Click-by-click steps ("Show me how") are the
 * only place a value to paste may appear.
 */
import { DAY, TARGETS, TARGET_NOTES, actionsFor, fmtTime, hostMatch, n0, pct, periodFor, periodStart, usd, whenPlain } from './checks.mjs'

/** Words that must never show in the top block or the action list. */
export const BANNED = [
  /CLAUDE_CODE/i, /README/i, /\bjev\.\w/i, /skillOverrides/i, /\bhooks?\b/i, /decision log/i, /\bsessions?\b/i,
  /\bhosts?\b/i, /API-equivalent/i, /\bBrier\b/i, /reconcil/i, /unattributed/i, /(^|[\s(])n\s?=/i, /(^|\s)n(\s|$)/,
  /\bpp\b/, /denominator/i, /\bwindow\b/i, /\.jsonl?\b/i, /\.mjs\b/i, /subagent/i, /\bnull\b/, /undefined/, /NaN/,
]

export const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** Money rounded for the top of the page: $47, $9.29, $0.56, "under $0.01". Exact figures live in the details. */
export function usdTop(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—'
  if (x === 0) return '$0'
  if (Math.abs(x) < 0.01) return 'under $0.01'
  if (Math.abs(x) >= 10) return '$' + Math.round(x).toLocaleString('en-US')
  return '$' + x.toFixed(2)
}

export const machine = (h) => (h === 'cloud' ? 'Claude in the cloud' : String(h ?? '').startsWith('local:') ? `your PC (${h.slice(6)})` : String(h ?? '').startsWith('local') ? 'your PC' : 'an unnamed machine')
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
const time = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
const dayTime = (t, end) => (Math.floor(t / DAY) === Math.floor(end / DAY) ? time(t) : fmtTime(t).replace(/ [A-Z]{2,5}$/, ''))

/** Plain words for the chosen period and the one before it. */
export function periodWords(days) {
  if (days === 1) return { cur: 'the last 24 hours', prev: 'the 24 hours before' }
  return { cur: `the last ${days} days`, prev: `the ${days} days before` }
}

const STATE_WORD = { pass: 'Passing', attention: 'Needs attention', partial: 'Partly checked', untracked: 'Not checked yet', thin: 'Too few to judge', neutral: 'No target', stale: 'Out of date' }
const ICON = { pass: '✓', attention: '✕', partial: '◐', untracked: '–', thin: '–', neutral: '–', stale: '–' }
const SIGNAL_WORDS = {
  'typed-after': 'then you typed a different skill',
  'claude-loaded-other': 'then Claude used a different skill',
  'picked-then-corrected': 'then you pushed back',
  'dropped-decisive': 'but it dropped a pick it was sure of',
}

/** "Comparison with the 7 days before: …" or "You'll see a comparison from Oct 10." */
function compareLine(R, days, end, text) {
  if (!R.coverage.prevTracked) {
    const when = R.coverage.prevStarts ? whenPlain(R.coverage.prevStarts, end) : 'later'
    return `You'll see a comparison with ${periodWords(days).prev} from ${when}: this page started collecting ${dayTime(R.coverage.since, end)}.`
  }
  return text ? `${cap(periodWords(days).prev)}: ${text}.` : `${cap(periodWords(days).prev)}: nothing to compare.`
}

/**
 * One plain line per check, and its detail panel. `opts`: { days, end, host }.
 * Row: { id, state, icon, word, name, figure, about, compare, examples, todo, who, how, note }.
 */
export function plainChecks(R, { days, end, host = 'all', stale = false, builtAgo = '' } = {}) {
  const acts = actionsFor(R.checks, { stale: false, end, prevStarts: R.coverage.prevStarts, host, limit: Infinity })
  const actFor = (id) => acts.find((a) => a.check === id)
  const rows = []
  for (const c of R.checks) {
    const f = c.facts ?? {}
    const st = c.state
    const row = { id: c.id, state: st, examples: [], note: '' }
    if (c.id === 'jev-deciding') {
      const rate = f.prompts ? f.decided / f.prompts : null
      row.name = st === 'attention' ? `Jev's picks are missing for ${rate < 0.5 ? 'most' : 'some'} requests` : st === 'pass' ? 'Jev is picking skills for your requests' : 'Jev picking skills for your requests'
      row.figure = st === 'untracked' ? 'no requests yet' : st === 'thin' ? 'too few requests to judge' : `${pct(rate)} of requests · target ${pct(TARGETS.decideRate)}`
      row.about = `Jev picks the right skill for each of your requests. This counts how many of your requests got a pick from Jev within 2 minutes: ${n0(f.decided)} of ${n0(f.prompts)}.`
      row.compare = compareLine(R, days, end, f.prev?.prompts ? `${pct(f.prev.decided / f.prev.prompts)} (${n0(f.prev.decided)} of ${n0(f.prev.prompts)})` : '')
      if (f.prompts) row.examples.push(`Your last request: ${dayTime(f.lastPrompt, end)}. Jev's last pick: ${f.lastDecision ? dayTime(f.lastDecision, end) : 'none in this period'}.`)
      if (f.quiet && f.lastDecision) row.examples.push(`Jev stopped after ${dayTime(f.lastDecision, end)}: ${n0(f.afterLast)} of your requests since then got no pick.`)
      if (f.unmatched) row.examples.push(`Jev still suggested a skill ${n0(f.unmatched)} ${f.unmatched === 1 ? 'time' : 'times'} without it being recorded here.`)
    } else if (c.id === 'jev-picking') {
      const rate = f.decisions ? f.misses / f.decisions : null
      row.name = st === 'attention' ? 'Jev is choosing the wrong skill too often' : st === 'pass' ? 'Jev is choosing the right skills' : 'Jev choosing the right skills'
      row.figure = st === 'untracked' ? 'no picks yet' : st === 'thin' ? 'too few picks to judge' : st === 'partial' ? `${pct(rate)} wrong · partly checked` : `${pct(rate)} wrong · target ${pct(TARGETS.missRate)}`
      row.about = `How often Jev's pick looked wrong — you typed a different skill, Claude used another one, or you pushed back: ${n0(f.misses)} of ${n0(f.decisions)} picks.`
      row.compare = compareLine(R, days, end, f.prevDecisions ? `${pct(f.prevMisses / f.prevDecisions)} wrong (${n0(f.prevMisses)} of ${n0(f.prevDecisions)})` : '')
      if (st === 'partial' && f.last) row.examples.push(`Only Jev's picks up to ${dayTime(f.last, end)} could be checked; later requests had no pick to check.`)
      for (const m of f.recent ?? []) row.examples.push(`${dayTime(m.t, end)}: Jev picked ${m.pick ?? 'nothing'}, ${SIGNAL_WORDS[m.signal] ?? 'and it looked wrong'}${m.expected ? ` (${m.expected} looked right)` : ''}.`)
    } else if (c.id === 'skills') {
      const refused = f.refused ?? []
      row.name = st === 'attention' ? 'Claude was blocked from some skills' : 'Claude can use its skills'
      row.figure = st === 'untracked' ? "hasn't used a skill yet" : st === 'attention' ? `${n0(refused.length)} of ${n0(f.calls)} blocked · target 0` : `none of ${n0(f.calls)} blocked · target 0`
      row.about = `Each time Claude tried to use a skill and whether it was allowed: ${n0(refused.length)} of ${n0(f.calls)} were blocked.`
      row.compare = compareLine(R, days, end, f.prevCalls ? `${n0(f.prevRefused)} of ${n0(f.prevCalls)} blocked` : '')
      if (refused.length) {
        row.examples.push(`Blocked: ${[...new Set(refused.map((r) => r.skill))].join(', ')}.`)
        row.examples.push(`Last blocked at ${dayTime(Math.max(...refused.map((r) => r.t)), end)}.`)
      }
    } else if (c.id === 'landing') {
      row.name = st === 'attention' ? "Too many of your requests aren't landing" : st === 'pass' ? 'Your requests are landing' : 'Your requests landing'
      row.figure = st === 'untracked' ? 'no finished requests yet' : st === 'thin' ? 'too few finished requests to judge' : `${pct(f.rate)} · target ${pct(TARGETS.landRate)}`
      row.about = `A request lands when your next message doesn't push back ("no", "still broken"). It's read from your wording, so treat it as a rough guide: ${n0(f.landed)} of ${n0(f.known)} landed.`
      row.compare = compareLine(R, days, end, f.prev?.known ? `${pct(f.prev.rate)} (${n0(f.prev.landed)} of ${n0(f.prev.known)})` : '')
      if (f.open) row.examples.push(`${n0(f.open)} ${f.open === 1 ? 'request is' : 'requests are'} still waiting for your next message.`)
    } else if (c.id === 'router') {
      row.name = st === 'attention' ? 'The model router is failing too often' : st === 'pass' ? 'The model router is working' : 'The model router'
      row.figure = st === 'untracked' ? 'not used yet' : st === 'thin' ? 'too few uses to judge' : `${pct(f.rate)} failing · target ${pct(TARGETS.routerRate)}`
      row.about = `The model router asks another AI model (through OpenRouter) when you want one. This counts answers that failed or came from a backup model: ${n0(f.errors + f.fallbacks)} of ${n0(f.n)}.`
      row.compare = compareLine(R, days, end, f.prev?.n ? `${pct(f.prev.rate)} failing (${n0(f.prev.n)} uses)` : '')
      if (f.last) row.examples.push(`Last used at ${dayTime(f.last.t, end)}: ${f.last.model ?? 'a model'} answered${f.last.ok ? '' : ', but it failed or used a backup'}.`)
    } else if (c.id === 'openrouter') {
      const k = c.facts
      row.name = st === 'attention' ? 'OpenRouter credit is running low' : st === 'pass' ? 'OpenRouter has enough credit' : 'OpenRouter credit'
      row.figure = !k ? 'not checked yet' : `${usdTop(k.credits ?? k.limitLeft)} left${st === 'attention' ? ' · under 10%' : ''}`
      row.about = k ? `What's left on your OpenRouter account, shared by all your machines: ${usd(k.credits)} of ${usd(k.total)}. Checked at ${dayTime(k.asOf, end)}.` : "This page hasn't been able to read your OpenRouter balance recently."
      row.compare = !k ? '' : k.earlierCredit === null ? `You'll see how this changed once the page has a check from ${periodWords(days).prev.replace('the ', '')} ago.` : `${cap(periodWords(days).prev.replace(' before', ' ago'))}: ${usd(k.earlierCredit)} left.`
      if (k && Number.isFinite(k.limit)) row.examples.push(`Spending cap: ${usd(k.limitLeft)} of ${usd(k.limit)} left${k.limitReset ? ` (resets ${k.limitReset})` : ''}.`)
      const sp = spendExplain(c, end)
      if (sp) row.examples.push(sp)
    } else if (c.id === 'reporting') {
      const quiet = f.quiet ?? []
      row.name = st === 'attention' ? 'A machine stopped reporting' : st === 'pass' ? 'All your machines are reporting' : 'Your machines reporting'
      row.figure = st === 'attention' ? `${cap(quiet.map((q) => machine(q.h)).join(', '))} went quiet` : st === 'pass' ? `${n0(f.now.length)} reporting` : !R.coverage.prevTracked && R.coverage.prevStarts ? `starts ${whenPlain(R.coverage.prevStarts, end)}` : 'nothing to compare yet'
      row.about = 'Which of your machines sent their usage in this period, so this page sees everything.'
      row.compare = compareLine(R, days, end, f.prevHosts ? `${n0(f.prevHosts)} ${f.prevHosts === 1 ? 'machine' : 'machines'} reported` : '')
      for (const x of f.now ?? []) row.examples.push(`${cap(machine(x.h))}: last heard from at ${dayTime(x.last, end)}.`)
      for (const q of quiet) row.examples.push(`${cap(machine(q.h))}: nothing since ${dayTime(q.last, end)}.`)
      if (!f.everLocal && host !== 'cloud') row.examples.push("Your PC: hasn't reported yet.")
    }
    if (stale) row.state = 'stale'
    const a = actFor(c.id)
    row.todo = st === 'pass' ? 'Nothing to do.' : a ? a.text : 'Nothing to do.'
    row.who = st === 'pass' || !a ? 'Nothing' : a.who
    if (a?.how) row.how = a.how
    row.icon = ICON[row.state]
    row.word = STATE_WORD[row.state]
    rows.push(row)
  }
  // Most important first: needs attention, partly checked, passing, then not judged yet.
  const rank = { attention: 0, partial: 1, pass: 2, thin: 3, untracked: 3, neutral: 3, stale: 0 }
  return rows.map((r, i) => ({ r, i, k: rank[stale ? R.checks[i].state : r.state] ?? 3 })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.r)
}

/** The OpenRouter spend, explained in plain words (the tooltip and detail line). */
export function spendExplain(creditCheck, end) {
  const rec = creditCheck?.reconciliation
  if (!rec || rec.usage === null) return ''
  const when = { daily: 'today', weekly: 'this week', monthly: 'this month' }[rec.period]
  if (!rec.reconcilable) return `OpenRouter says you've spent ${usd(rec.usage)} ${when}. This page started collecting part-way through, so it can't yet say what that went on.`
  const rest = rec.unattributed
  return `OpenRouter says you've spent ${usd(rec.usage)} ${when}: ${usd(rec.routed)} on the model router's answers, and ${usd(Math.max(0, rest))} on everything else — mostly Jev choosing skills, which isn't priced one by one.` +
    (rec.closes ? '' : ' The router figures add up to more than OpenRouter reports; trust OpenRouter.')
}

/** "2 need attention", "All clear", "Nothing needs attention", or "Out of date — built 8 days ago". */
export function verdictPlain(R, { stale = false, builtAgo = '', host = 'all' } = {}) {
  const judged = R.checks.filter((c) => c.targeted && !(host !== 'all' && c.account))
  const att = judged.filter((c) => c.state === 'attention').length
  const open = judged.filter((c) => ['untracked', 'thin', 'partial'].includes(c.state)).length
  if (stale) return { state: 'stale', text: `Out of date — built ${builtAgo} ago`, sub: 'Every figure below is from then, not now.' }
  if (att) return { state: 'attention', text: `${n0(att)} need${att === 1 ? 's' : ''} attention`, sub: open ? `${n0(open)} can't be judged yet` : '' }
  if (open) return { state: 'untracked', text: 'Nothing needs attention', sub: `${n0(open)} can't be judged yet` }
  return { state: 'pass', text: 'All clear', sub: '' }
}

/**
 * "This week  Claude $47 (at pay-as-you-go prices) · OpenRouter $0.56".
 * The period is the one OpenRouter reports for the chosen range (UTC day,
 * week or month), and Claude is summed over exactly the same span.
 */
export function spendPlain(R, rows, { days, end, host = 'all' }) {
  const period = periodFor(days)
  const from = periodStart(end, period)
  const claude = rows.filter((r) => r.k === 'api' && r.t >= from && r.t <= end && hostMatch(r.h, host)).reduce((a, r) => a + (Number.isFinite(r.c) ? r.c : 0), 0)
  const credit = R.checks.find((c) => c.id === 'openrouter')
  const rec = credit?.reconciliation
  const or = rec && rec.usage !== null ? usdTop(rec.usage) : null
  return {
    label: { daily: 'Today', weekly: 'This week', monthly: 'This month' }[period],
    claude: usdTop(claude),
    claudeExact: usd(claude),
    openrouter: or,
    tooltip: spendExplain(credit, end) || "OpenRouter hasn't been checked recently.",
  }
}

const whoWord = (w) => (w === 'Nothing' ? 'Clears on its own' : w)

/** The numbered "What to do" list. */
export function actionsHtml(all) {
  // Only things someone has to do are listed; the ones that sort themselves
  // out get one quiet line, so the list never says "nothing to do" as a to-do.
  const actions = all.filter((a) => a.who !== 'Nothing')
  const selfClearing = all.length - actions.length
  const quiet = selfClearing
    ? `<p class="none">${selfClearing === 1 ? '1 other item clears' : `${selfClearing} other items clear`} on ${selfClearing === 1 ? 'its' : 'their'} own — open the checks below to see why.</p>`
    : ''
  if (!actions.length) return '<p class="none">Nothing to do.</p>' + quiet
  return '<ol class="todo">' + actions.map((a) =>
    `<li><span class="act">${escHtml(a.text)}</span> <span class="who who-${escHtml(a.who.toLowerCase())}">${escHtml(whoWord(a.who))}</span>` +
    `<span class="done">Done when ${escHtml(a.doneWhen)}</span>` +
    (a.how ? `<details class="how"><summary>Show me how</summary><ol>${a.how.map((s) => `<li>${escHtml(s)}</li>`).join('')}</ol></details>` : '') +
    '</li>').join('') + '</ol>' + quiet
}

/**
 * The health strip: the seven checks as one row of pills, each opening to its
 * short panel. A check someone has to act on (You or Claude) carries its
 * "What to do" right beside its pill, with "Show me how" when there are
 * steps; the rest say nothing to do.
 */
export function checksHtml(rows) {
  const acts = (r) => r.state !== 'pass' && r.who && r.who !== 'Nothing' && r.todo && r.todo !== 'Nothing to do.'
  return '<ul class="checks">' + rows.map((r) =>
    `<li class="${acts(r) ? 'has-todo' : ''}"><details class="check st-${escHtml(r.state)}" data-id="${escHtml(r.id)}">` +
    `<summary><span class="ico" role="img" aria-label="${escHtml(r.word)}" title="${escHtml(r.word)}">${escHtml(r.icon)}</span>` +
    `<span class="name">${escHtml(r.name)}</span><span class="figure">${escHtml(r.figure)}</span><span class="chev" aria-hidden="true">›</span></summary>` +
    `<div class="panel"><p>${escHtml(r.about)}</p>${r.compare ? `<p class="muted">${escHtml(r.compare)}</p>` : ''}` +
    (r.examples.length ? '<ul>' + r.examples.map((e) => `<li>${escHtml(e)}</li>`).join('') + '</ul>' : '') +
    (acts(r) ? '' : `<p class="todo-line muted">${escHtml(r.todo === 'Nothing to do.' || r.state === 'pass' ? 'Nothing to do.' : r.todo)}</p>`) +
    '</div></details>' +
    (acts(r)
      ? `<div class="pill-todo"><b>What to do:</b> ${escHtml(r.todo)} <span class="who who-${escHtml(r.who.toLowerCase())}">${escHtml(r.who)}</span>` +
        (r.how ? `<details class="how"><summary>Show me how</summary><ol>${r.how.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ol></details>` : '') +
        '</div>'
      : '') +
    '</li>').join('') + '</ul>'
}

/** Which of the owner's targets (TARGET_NOTES) each check is held to. */
const TARGET_OF = { 'jev-deciding': 0, 'jev-picking': 1, skills: 2, landing: 3, router: 4, openrouter: 5, reporting: 7 }

/**
 * The Health tab: each check full size — its state, figure, what it counts,
 * the comparison, examples, the target it is held to, and what to do (with
 * "Show me how" when there are steps). Same rows as checksHtml.
 */
export function checkCardsHtml(rows) {
  return '<div class="hcards">' + rows.map((r) => {
    const acts = r.state !== 'pass' && r.who && r.who !== 'Nothing' && r.todo && r.todo !== 'Nothing to do.'
    const target = TARGET_OF[r.id] === undefined ? '' : TARGET_NOTES[TARGET_OF[r.id]]
    return `<article class="hcard st-${escHtml(r.state)}" id="check-${escHtml(r.id)}">` +
      `<div class="hc-head"><span class="ico" role="img" aria-label="${escHtml(r.word)}" title="${escHtml(r.word)}">${escHtml(r.icon)}</span>` +
      `<h3>${escHtml(r.name)}</h3><span class="hc-state">${escHtml(r.word)}</span></div>` +
      `<p class="hc-figure">${escHtml(r.figure)}</p>` +
      `<p>${escHtml(r.about)}</p>${r.compare ? `<p class="muted">${escHtml(r.compare)}</p>` : ''}` +
      (r.examples.length ? '<ul>' + r.examples.map((e) => `<li>${escHtml(e)}</li>`).join('') + '</ul>' : '') +
      (target ? `<p class="hc-target"><b>Target:</b> ${escHtml(target)}.</p>` : '') +
      `<div class="hc-todo${acts ? ' act' : ''}"><b>What to do:</b> ${escHtml(acts ? r.todo : r.state === 'pass' ? 'Nothing to do.' : r.todo)}` +
      (acts ? ` <span class="who who-${escHtml(r.who.toLowerCase())}">${escHtml(r.who)}</span>` : '') +
      (acts && r.how ? `<details class="how"><summary>Show me how</summary><ol>${r.how.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ol></details>` : '') +
      '</div></article>'
  }).join('') + '</div>'
}

/** Text a reader sees, from generated HTML: tags dropped; "Show me how" steps left out, and closed panels too when `collapsed`. */
export function visibleText(html, { collapsed = false } = {}) {
  let h = String(html).replace(/<details class="how">[\s\S]*?<\/details>/g, ' ')
  if (collapsed) h = h.replace(/<div class="panel">[\s\S]*?<\/div><\/details>/g, '</details>')
  return h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()
}

/** Banned words found in some text: [] when clean. */
export function bannedIn(text) {
  return BANNED.filter((re) => re.test(text)).map(String)
}
