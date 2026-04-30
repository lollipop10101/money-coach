#!/bin/bash
ACTION="${1:-start}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$DIR/alert.pid"
LOG="$DIR/logs/alert.log"

start() {
  if [ -f "$PIDFILE" ] && kill -0 $(cat "$PIDFILE") 2>/dev/null; then
    echo "Alert already running PID $(cat $PIDFILE)"
    return 1
  fi
  echo "Starting NAVI Alert..."
  cd "$DIR"
  nohup node alert.mjs >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  echo "Started PID $!"
}

stop() {
  [ -f "$PIDFILE" ] && kill $(cat "$PIDFILE") 2>/dev/null && rm -f "$PIDFILE" && echo "Stopped"
}

case "$ACTION" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 1; start ;;
  *) echo "Usage: navi-alert {start|stop|restart}" ;;
esac
