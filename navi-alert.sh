#!/bin/bash
# NAVI Alert Manager - Start/Stop/Status script

ACTION="${1:-start}"
DIR="/home/zouiner/.openclaw/agents/manager/navi_tracker"
PIDFILE="$DIR/alert.pid"
LOG="$DIR/logs/alert.log"

start() {
  if [ -f "$PIDFILE" ] && kill -0 $(cat "$PIDFILE") 2>/dev/null; then
    echo "⚠️  Alert is already running (PID $(cat $PIDFILE))"
    return 1
  fi
  echo "🚀 Starting NAVI Alert..."
  mkdir -p "$DIR/logs"
  cd "$DIR"
  nohup node alert.mjs >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  echo "✅ Started (PID $!)"
}

stop() {
  if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID"
      rm -f "$PIDFILE"
      echo "🛑 Stopped"
    else
      rm -f "$PIDFILE"
      echo "⚠️  Process not running"
    fi
  else
    echo "⚠️  Not running"
  fi
}

status() {
  if [ -f "$PIDFILE" ] && kill -0 $(cat "$PIDFILE") 2>/dev/null; then
    echo "✅ Running (PID $(cat $PIDFILE))"
    tail -3 "$LOG" 2>/dev/null
  else
    echo "❌ Not running"
  fi
}

case "$ACTION" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  restart) stop; sleep 1; start ;;
  *) echo "Usage: navi-alert {start|stop|status|restart}" ;;
esac
