#!/bin/bash
# A worktree for one porting job: nsh-spike's tip, detached, with the dependencies wired the way
# the main checkout has them (no install), so `nsh check`, `nsh test` and scripts/ui-tests.ts run.
# Each job works in its own, so their generated `.nsh/` files never collide.
#
#   bash apps/desktop-nsh/scripts/agent-worktree.sh <name>     → /Users/zhaodongsheng/my-projects/nsh-w/<name>
set -euo pipefail
name="${1:?a name}"
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
main="/Users/zhaodongsheng/my-projects/real-bot"
base="/Users/zhaodongsheng/my-projects/nsh-w"
dir="$base/$name"
mkdir -p "$base"
if [ ! -d "$dir" ]; then
  git -C "$repo" worktree add --detach "$dir" nsh-spike >/dev/null
fi
[ -e "$dir/node_modules" ] || ln -s "$main/node_modules" "$dir/node_modules"
for pkg in apps/messenger apps/daemon packages/protocol packages/remote; do
  rsync -a --exclude .vite "$main/$pkg/node_modules/" "$dir/$pkg/node_modules/"
done
rsync -a "$repo/apps/desktop-nsh/node_modules/" "$dir/apps/desktop-nsh/node_modules/"
echo "$dir"
