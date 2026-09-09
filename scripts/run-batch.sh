#!/bin/bash
# launchd가 "맥이 부팅/로그인될 때" 실행하는 스크립트입니다 (RunAtLoad). 정해진 시각이
# 아니라 부팅 시점에 걸어둔 이유: 밤에 맥을 완전히 꺼두는 습관이면 "매일 8시" 같은
# StartCalendarInterval은 그 시각에 맥이 꺼져 있으면 그냥 건너뛰고 다시 안 돌아오기
# 때문입니다. RunAtLoad는 몇 시에 켜시든 켜는 순간(부팅/로그인 직후) 바로 실행됩니다.
#
# launchd는 로그인 셸을 거치지 않기 때문에 .env를 직접 source해야 하고, npm/node
# 경로도 PATH에 없을 수 있어 아래에서 흔한 위치들을 미리 추가해둡니다.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# 부팅 직후엔 Wi-Fi/네트워크가 아직 안 붙어있을 수 있어서 살짝 여유를 둡니다.
sleep 45

LOG_DIR="$PROJECT_DIR/output"
mkdir -p "$LOG_DIR"

# 하루에 여러 번 재부팅해도 배치가 중복 실행되지 않도록, "오늘 이미 돌렸는지"를
# 파일 하나로 기록해둡니다. 같은 날 한 번 더 강제로 돌리고 싶으면 이 파일을 지우면 됩니다.
TODAY="$(date +%Y-%m-%d)"
MARKER_FILE="$LOG_DIR/.last-batch-date"
if [ -f "$MARKER_FILE" ] && [ "$(cat "$MARKER_FILE")" = "$TODAY" ]; then
  exit 0
fi
echo "$TODAY" >"$MARKER_FILE"

set -a
source "$PROJECT_DIR/.env"
set +a

LOG_FILE="$LOG_DIR/morning-batch-$(date +%Y%m%d-%H%M%S).log"
BATCH_COUNT="${MORNING_BATCH_COUNT:-8}"

if npm run generate:batch "$BATCH_COUNT" >"$LOG_FILE" 2>&1; then
  SUCCESS_COUNT=$(grep -oE '성공: [0-9]+개' "$LOG_FILE" | tail -1 || true)
  osascript -e "display notification \"${SUCCESS_COUNT:-완료}. 로그: $LOG_FILE\" with title \"Masterpiece Shorts 아침 배치\"" 2>/dev/null || true
else
  osascript -e "display notification \"오류 발생 — 로그를 확인하세요: $LOG_FILE\" with title \"Masterpiece Shorts 아침 배치 실패\"" 2>/dev/null || true
fi
