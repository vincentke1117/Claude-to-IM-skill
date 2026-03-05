#!/usr/bin/env bash
set -euo pipefail
CTI_HOME="$HOME/.claude-to-im"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$CTI_HOME/runtime/bridge.pid"
STATUS_FILE="$CTI_HOME/runtime/status.json"
LOG_FILE="$CTI_HOME/logs/bridge.log"

ensure_dirs() { mkdir -p "$CTI_HOME"/{data,logs,runtime,data/messages}; }

ensure_built() {
  local need_build=0
  if [ ! -f "$SKILL_DIR/dist/daemon.mjs" ]; then
    need_build=1
  else
    # Rebuild if any src file is newer than the bundle
    local newest_src
    newest_src=$(find "$SKILL_DIR/src" -name '*.ts' -newer "$SKILL_DIR/dist/daemon.mjs" 2>/dev/null | head -1)
    if [ -n "$newest_src" ]; then
      need_build=1
    fi
  fi
  if [ "$need_build" = "1" ]; then
    echo "Building daemon bundle..."
    (cd "$SKILL_DIR" && npm run build)
  fi
}

# Clean environment for subprocess isolation.
# CTI_ENV_ISOLATION=strict (default): strip CLAUDECODE + ANTHROPIC_* from parent env.
# CTI_ENV_ISOLATION=inherit: only strip CLAUDECODE.
clean_env() {
  unset CLAUDECODE 2>/dev/null || true

  # Read runtime from config
  local runtime
  runtime=$(grep "^CTI_RUNTIME=" "$CTI_HOME/config.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'" | tr -d '"' || true)
  runtime="${runtime:-claude}"

  local mode="${CTI_ENV_ISOLATION:-strict}"
  if [ "$mode" = "strict" ]; then
    # Strip ANTHROPIC_* in codex mode, OPENAI_* in claude mode
    case "$runtime" in
      codex)
        while IFS='=' read -r name _; do
          case "$name" in ANTHROPIC_*) unset "$name" 2>/dev/null || true ;; esac
        done < <(env)
        ;;
      claude)
        if [ "${CTI_ANTHROPIC_PASSTHROUGH:-}" != "true" ]; then
          while IFS='=' read -r name _; do
            case "$name" in ANTHROPIC_*) unset "$name" 2>/dev/null || true ;; esac
          done < <(env)
        fi
        while IFS='=' read -r name _; do
          case "$name" in OPENAI_*) unset "$name" 2>/dev/null || true ;; esac
        done < <(env)
        ;;
      auto)
        # In auto mode, keep both sets of env vars
        if [ "${CTI_ANTHROPIC_PASSTHROUGH:-}" != "true" ]; then
          while IFS='=' read -r name _; do
            case "$name" in ANTHROPIC_*) unset "$name" 2>/dev/null || true ;; esac
          done < <(env)
        fi
        ;;
    esac
  fi
}

case "${1:-help}" in
  start)
    ensure_dirs
    ensure_built
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Bridge already running (PID: $(cat "$PID_FILE"))"
      cat "$STATUS_FILE" 2>/dev/null
      exit 1
    fi
    clean_env
    nohup node "$SKILL_DIR/dist/daemon.mjs" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 2
    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Bridge started (PID: $(cat "$PID_FILE"))"
      cat "$STATUS_FILE" 2>/dev/null
    else
      echo "Failed to start bridge."
      echo ""
      echo "Recent logs:"
      tail -20 "$LOG_FILE"
      echo ""
      echo "Next steps:"
      echo "  1. Run diagnostics:  bash \"$SKILL_DIR/scripts/doctor.sh\""
      echo "  2. Check full logs:  bash \"$SKILL_DIR/scripts/daemon.sh\" logs 100"
      echo "  3. Rebuild bundle:   cd \"$SKILL_DIR\" && npm run build"
      exit 1
    fi
    ;;
  stop)
    if [ ! -f "$PID_FILE" ]; then echo "No bridge running"; exit 0; fi
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID"
      for i in $(seq 1 10); do
        kill -0 "$PID" 2>/dev/null || break
        sleep 1
      done
      kill -0 "$PID" 2>/dev/null && kill -9 "$PID"
      echo "Bridge stopped"
    else
      echo "Bridge was not running (stale PID file)"
    fi
    rm -f "$PID_FILE"
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Bridge is running (PID: $(cat "$PID_FILE"))"
      cat "$STATUS_FILE" 2>/dev/null
    else
      echo "Bridge is not running"
      [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
    fi
    ;;
  logs)
    N="${2:-50}"
    tail -n "$N" "$LOG_FILE" 2>/dev/null | sed -E 's/(token|secret|password)(["\x27]?\s*[:=]\s*["\x27]?)[^ "]+/\1\2*****/gi'
    ;;
  *)
    echo "Usage: daemon.sh {start|stop|status|logs [N]}"
    ;;
esac
