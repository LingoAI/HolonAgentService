#!/bin/sh
set -eu

skill_dir="${CODEX_HOME:?CODEX_HOME must be set}/skills"
mkdir -p "$skill_dir"

# /data is a persistent volume, so Skills installed under /root at image build
# time are hidden from the unprivileged Codex process unless copied here.
for skill in /opt/onchainos-skills/okx-*; do
  [ -f "$skill/SKILL.md" ] || continue
  name=${skill##*/}
  staged="$skill_dir/.$name.new"
  rm -rf "$staged"
  cp -R "$skill" "$staged"
  rm -rf "$skill_dir/$name"
  mv "$staged" "$skill_dir/$name"
done

test -f "$skill_dir/okx-ai/SKILL.md"

workspace_dir="${OKX_A2A_AI_CWD:?OKX_A2A_AI_CWD must be set}"
mkdir -p "$workspace_dir"
cp /opt/okx-a2a/AGENTS.md "$workspace_dir/.AGENTS.md.new"
mv "$workspace_dir/.AGENTS.md.new" "$workspace_dir/AGENTS.md"

exec "$@"
