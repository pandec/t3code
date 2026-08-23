#!/usr/bin/env bash
# One-glance status of all upstream contributions: preview PRs on the fork,
# upstream PRs and issues authored by the current gh account.
set -euo pipefail

FORK="pandec/t3code"
UPSTREAM="pingdotgg/t3code"

echo "== Preview PRs ($FORK, head upstream/*) =="
gh pr list -R "$FORK" --state all --limit 50 \
  --json number,title,headRefName,state,isDraft,url \
  --jq '.[] | select(.headRefName|startswith("upstream/"))
        | "\(.state)\(if .isDraft then " draft" else "" end)\t#\(.number)\t\(.headRefName)\t\(.title)"'

echo
echo "== Upstream PRs ($UPSTREAM, author @me) =="
gh pr list -R "$UPSTREAM" --author "@me" --state all --limit 50 \
  --json number,title,state,reviewDecision,updatedAt,url \
  --jq '.[] | "\(.state)\t#\(.number)\t\(.reviewDecision // "-")\tupdated \(.updatedAt[:10])\t\(.title)\n\t\(.url)"' \
  || echo "(none or query failed)"

echo
echo "== Upstream issues ($UPSTREAM, author @me) =="
gh issue list -R "$UPSTREAM" --author "@me" --state all --limit 50 \
  --json number,title,state,url \
  --jq '.[] | "\(.state)\t#\(.number)\t\(.title)\n\t\(.url)"' \
  || echo "(none or query failed)"
