#!/usr/bin/env bash
# Report whether this private fork needs an upstream sync.
#
# Read-only apart from fetching remote refs: it never changes a branch, the
# working tree, or anything on a remote. Answers the question the
# `sync-upstream` skill would otherwise have to investigate by hand.
#
#   scripts/check-upstream-sync.sh [--no-fetch]

set -euo pipefail

UPSTREAM_REMOTE="upstream-sync"
UPSTREAM_REF="${UPSTREAM_REMOTE}/main"
ORIGIN_MAIN="origin/main"
ORIGIN_DEV="origin/dev"
MAX_LISTED_COMMITS=15

fetch=true
for arg in "$@"; do
  case "$arg" in
    --no-fetch) fetch=false ;;
    -h | --help)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [ -t 1 ]; then
  bold=$'\033[1m' dim=$'\033[2m' green=$'\033[32m' yellow=$'\033[33m' red=$'\033[31m' reset=$'\033[0m'
else
  bold='' dim='' green='' yellow='' red='' reset=''
fi

cd "$(git rev-parse --show-toplevel)"

for remote in origin "$UPSTREAM_REMOTE"; do
  if ! git remote get-url "$remote" >/dev/null 2>&1; then
    echo "${red}No '${remote}' remote in this checkout.${reset}" >&2
    exit 1
  fi
done

if [ "$fetch" = true ]; then
  echo "${dim}Fetching origin and ${UPSTREAM_REMOTE}...${reset}"
  git fetch --quiet --prune origin
  git fetch --quiet --prune "$UPSTREAM_REMOTE"
fi

for ref in "$UPSTREAM_REF" "$ORIGIN_MAIN" "$ORIGIN_DEV"; do
  if ! git rev-parse --verify --quiet "$ref" >/dev/null; then
    echo "${red}Missing ref '${ref}'. Fetch the remotes and retry.${reset}" >&2
    exit 1
  fi
done

describe() { git log -1 --format="%h  %ad  %s" --date=short "$1"; }
count() { git rev-list --count "$1..$2"; }

upstream_ahead_of_main=$(count "$ORIGIN_MAIN" "$UPSTREAM_REF")
main_ahead_of_upstream=$(count "$UPSTREAM_REF" "$ORIGIN_MAIN")
upstream_missing_from_dev=$(count "$ORIGIN_DEV" "$UPSTREAM_REF")

echo
echo "${bold}Upstream sync check${reset}  ${dim}$(git remote get-url "$UPSTREAM_REMOTE")${reset}"
echo
printf '  %-22s %s\n' "$UPSTREAM_REF" "$(describe "$UPSTREAM_REF")"
printf '  %-22s %s\n' "$ORIGIN_MAIN" "$(describe "$ORIGIN_MAIN")"
printf '  %-22s %s\n' "$ORIGIN_DEV" "$(describe "$ORIGIN_DEV")"

if git rev-parse --verify --quiet main >/dev/null; then
  local_main_behind=$(count main "$ORIGIN_MAIN")
  local_main_ahead=$(count "$ORIGIN_MAIN" main)
  if [ "$local_main_ahead" -gt 0 ]; then
    echo
    echo "  ${red}Local main has ${local_main_ahead} commit(s) not on ${ORIGIN_MAIN}.${reset}"
    echo "  ${dim}main is a mirror-only branch; investigate before syncing.${reset}"
  elif [ "$local_main_behind" -gt 0 ]; then
    echo
    echo "  ${dim}Local main is ${local_main_behind} commit(s) behind ${ORIGIN_MAIN} (the sync fast-forwards it).${reset}"
  fi
fi

if [ "$main_ahead_of_upstream" -gt 0 ]; then
  echo
  echo "  ${red}${ORIGIN_MAIN} has ${main_ahead_of_upstream} commit(s) not in ${UPSTREAM_REF}.${reset}"
  echo "  ${dim}The mirror has diverged. Do not run a routine sync; investigate first.${reset}"
fi

echo
if [ "$upstream_missing_from_dev" -eq 0 ] && [ "$upstream_ahead_of_main" -eq 0 ]; then
  echo "  ${green}Up to date.${reset} No upstream commits are missing from ${ORIGIN_MAIN} or ${ORIGIN_DEV}."
  echo
  exit 0
fi

if [ "$upstream_ahead_of_main" -gt 0 ]; then
  echo "  ${yellow}${upstream_ahead_of_main}${reset} upstream commit(s) not yet mirrored to ${ORIGIN_MAIN}."
fi
if [ "$upstream_missing_from_dev" -gt 0 ]; then
  echo "  ${yellow}${upstream_missing_from_dev}${reset} upstream commit(s) not yet merged into ${ORIGIN_DEV}."
fi

if [ "$upstream_missing_from_dev" -gt 0 ]; then
  echo
  echo "  ${bold}Pending upstream commits${reset} ${dim}(newest first)${reset}"
  git log --format="    %h  %ad  %s" --date=short --max-count="$MAX_LISTED_COMMITS" \
    "${ORIGIN_DEV}..${UPSTREAM_REF}"
  if [ "$upstream_missing_from_dev" -gt "$MAX_LISTED_COMMITS" ]; then
    echo "    ${dim}... and $((upstream_missing_from_dev - MAX_LISTED_COMMITS)) more${reset}"
  fi

  echo
  echo "  ${bold}Files they touch${reset} ${dim}(top 10 by change count)${reset}"
  git diff --numstat "${ORIGIN_DEV}...${UPSTREAM_REF}" |
    awk '{ print $1 + $2, $3 }' |
    sort -rn |
    head -10 |
    awk '{ printf "    %6s  %s\n", $1, $2 }'

  merge_base=$(git merge-base "$ORIGIN_DEV" "$UPSTREAM_REF")
  overlap_count=$(comm -12 \
    <(git diff --name-only "$merge_base" "$UPSTREAM_REF" | sort -u) \
    <(git diff --name-only "$merge_base" "$ORIGIN_DEV" | sort -u) |
    { grep -c . || true; })
  echo
  echo "  ${bold}Fork overlap${reset}: ${overlap_count} file(s) touched by both fork and upstream since the merge base"

  echo
  echo "  ${bold}Predicted conflicts${reset} ${dim}(git merge-tree; the worktree is untouched)${reset}"
  merge_status=0
  merge_output=$(git merge-tree --write-tree --no-messages --name-only "$ORIGIN_DEV" "$UPSTREAM_REF" 2>/dev/null) || merge_status=$?
  if [ "$merge_status" -eq 0 ]; then
    echo "    ${green}None — the merge is predicted to apply cleanly.${reset}"
  elif [ "$merge_status" -eq 1 ]; then
    conflict_paths=$(printf '%s\n' "$merge_output" | tail -n +2 | sort -u)
    conflict_count=$(printf '%s\n' "$conflict_paths" | { grep -c . || true; })
    echo "    ${yellow}${conflict_count}${reset} path(s) predicted to conflict:"
    printf '%s\n' "$conflict_paths" | sed 's/^/      /'
    if [ "$conflict_count" -ge 15 ]; then
      echo
      echo "    ${yellow}Broad merge${reset} ${dim}— expect a long resolution phase; plan the sync accordingly.${reset}"
    fi
  else
    echo "    ${dim}merge-tree failed (exit ${merge_status}); no prediction available.${reset}"
  fi
fi

echo
echo "  ${bold}Sync needed.${reset} Start a thread on ${ORIGIN_DEV} and run the ${bold}/sync-upstream${reset} skill."
echo
