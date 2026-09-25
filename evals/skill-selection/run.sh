#!/usr/bin/env bash
# Checks that Jev picks the right skill: sends each prompt in cases.tsv
# (expected skill <TAB> prompt; "none" = no skill should be attached) to a
# headless Claude Code with the plugin loaded, reads the plugin's decision
# lines from the debug log, and scores them. Claude's own Skill tool is off,
# so any skill comes from Jev. Needs OPENROUTER_API_KEY or OPENROUTER_AUTH=proxy.
#
#   evals/skill-selection/run.sh [project dir, default .] [cases.tsv]
#
# Run it from (or point it at) the project whose skills you want in play:
# project skills only exist there. Costs one small Claude call per case
# (haiku, one turn, no tools) plus ~$0.00001 of Jev per decision.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$(cd "$HERE/../../plugins/jev-skill-suggestion" && pwd)"
PROJECT="${1:-.}"
CASES="${2:-$HERE/cases.tsv}"
LOG="$(mktemp)"
pass=0; total=0
printf '%-4s %-36s %-36s %s\n' ok want got prompt
while IFS=$'\t' read -r want prompt; do
  [ -z "$want" ] && continue
  total=$((total + 1))
  : > "$LOG"
  ( cd "$PROJECT" && timeout 180 env CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 CLAUDE_CODE_PLUGIN_DIRS="$PLUGIN" \
      claude -p "$prompt" --debug-file "$LOG" --max-turns 1 --model haiku \
      --disallowedTools "Edit,Write,Bash,NotebookEdit,Skill" < /dev/null > /dev/null 2>&1 )
  decided="$(grep -a -o '\[jev-skill-suggestion\] \(jev\|backup[^:]*\|built-in classifier\):' "$LOG" | head -1 | sed 's/.*\] //; s/:$//')"
  got="$(grep -a -o 'suggesting /[^:]*' "$LOG" | head -1 | sed 's#suggesting /##')"
  [ -z "$got" ] && got=none
  ok=FAIL
  if [ "$got" = "$want" ] && [ "$decided" = "jev" ]; then ok=PASS; pass=$((pass + 1)); fi
  printf '%-4s %-36s %-36s %s%s\n' "$ok" "$want" "$got" "$prompt" "$([ "$decided" = jev ] || echo "  [decided by: ${decided:-nothing}]")"
done < "$CASES"
rm -f "$LOG"
echo "$pass/$total passed (a pass needs the right skill AND the decision made by Jev)"
[ "$pass" = "$total" ]
