# Sourced helper: put Node >= 26 on PATH (repo engines; node:sqlite + .ts stripping).
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 26 ? 0 : 1)' 2>/dev/null; then
  for nvm in "${NVM_DIR:-$HOME/.nvm}/nvm.sh" /opt/nvm/nvm.sh; do
    [ -s "$nvm" ] && { . "$nvm" >/dev/null; nvm use 26 >/dev/null 2>&1 || nvm install 26 >/dev/null; break; }
  done
fi
node -e 'process.exit(+process.versions.node.split(".")[0] >= 26 ? 0 : 1)' \
  || { echo "node_26_required (found $(node -v 2>/dev/null))" >&2; exit 3; }
