#!/usr/bin/env bash
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3}"

repo_url="${1:?Pass the repository SSH URL.}"
deploy_branch="${2:-main}"
deploy_dir="${3:-/home/dev/MMB}"

fail() { printf 'Deploy stopped: %s\n' "$*" >&2; exit 1; }
[[ "$deploy_dir" = /* && "$deploy_dir" != / ]] || fail 'The deploy directory must be an absolute path other than /.'
[[ "$repo_url" = git@*:* || "$repo_url" = ssh://* ]] || fail 'Use an SSH Git remote.'

# Noninteractive SSH sessions do not always load the user's NVM setup.
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  set +u
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
  set -u
fi
for tool in git node pm2 flock; do command -v "$tool" >/dev/null || fail "Install $tool for the deploy user first."; done
git check-ref-format "refs/heads/$deploy_branch" >/dev/null
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) { console.error("Node.js 22.12 or newer is required."); process.exit(1); }'
if command -v corepack >/dev/null; then pnpm_cmd=(corepack pnpm);
elif command -v pnpm >/dev/null; then pnpm_cmd=(pnpm);
else fail 'Install pnpm or Corepack for the deploy user first.'; fi

mkdir -p "$(dirname "$deploy_dir")"
exec 9>"${deploy_dir}.deploy.lock"
flock -n 9 || fail 'Another bot deployment is already running.'

if [[ ! -d "$deploy_dir/.git" ]]; then
  # Permit a pre-provisioned .env, but never replace an unrelated directory.
  if [[ -d "$deploy_dir" ]] && [[ -n "$(find "$deploy_dir" -mindepth 1 -maxdepth 1 ! -name .env -print -quit)" ]]; then
    fail "$deploy_dir is not an empty Git checkout (only a pre-provisioned .env is allowed)."
  fi
  mkdir -p "$deploy_dir"
  git init --initial-branch="$deploy_branch" "$deploy_dir"
  git -C "$deploy_dir" remote add origin "$repo_url"
  git -C "$deploy_dir" fetch origin "$deploy_branch"
  if git -C "$deploy_dir" cat-file -e 'FETCH_HEAD:.env' 2>/dev/null; then fail 'The remote tracks .env; refusing to overwrite server secrets.'; fi
  git -C "$deploy_dir" checkout --track -B "$deploy_branch" "origin/$deploy_branch"
else
  [[ "$(git -C "$deploy_dir" remote get-url origin)" = "$repo_url" ]] || fail 'The server checkout has a different origin; it was preserved.'
  [[ "$(git -C "$deploy_dir" branch --show-current)" = "$deploy_branch" ]] || fail 'The server checkout is on a different branch; it was preserved.'
  git -C "$deploy_dir" diff --quiet && git -C "$deploy_dir" diff --cached --quiet || fail 'Commit or stash tracked server changes before deploying.'
  git -C "$deploy_dir" fetch origin "$deploy_branch"
  if git -C "$deploy_dir" cat-file -e 'FETCH_HEAD:.env' 2>/dev/null; then fail 'The remote tracks .env; refusing to overwrite server secrets.'; fi
  git -C "$deploy_dir" merge --ff-only FETCH_HEAD
fi

cd "$deploy_dir"
[[ -f .env ]] || fail "Create $deploy_dir/.env with the Discord and R2 configuration, then rerun this script."
chmod 600 .env
expected_pnpm="$(node -p 'require("./package.json").packageManager.replace(/^pnpm@/, "")')"
[[ "$("${pnpm_cmd[@]}" --version)" = "$expected_pnpm" ]] || fail "Use pnpm $expected_pnpm (Corepack selects the pinned project version)."

# Build tools are required on the server, but only the bot's workspace is selected.
"${pnpm_cmd[@]}" --filter '@mmb/discord-bot...' install --frozen-lockfile --prod=false
"${pnpm_cmd[@]}" --filter @mmb/discord-bot check
"${pnpm_cmd[@]}" --filter @mmb/discord-bot build
node apps/discord-bot/dist/index.js --check-config

# Fork-mode restart stops the previous instance before starting its replacement.
# A rolling/cluster reload would temporarily connect two copies of the bot.
pm2 startOrRestart "$deploy_dir/ecosystem.config.cjs" --only mmb-discord-bot --update-env 9>&-
pm2 save 9>&-
printf '\nBot build deployed at %s (%s); PM2 start/restart requested.\n' "$deploy_dir" "$(git rev-parse --short HEAD)"
printf 'Logs: pm2 logs mmb-discord-bot\n'
printf 'For reboot recovery, configure PM2 startup once for this user (see the bot README).\n'
