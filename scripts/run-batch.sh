#!/bin/bash
# launchd가 매일 아침 자동으로 실행하는 스크립트입니다. 직접 실행할 일은 거의 없고,
# ~/Library/LaunchAgents의 plist가 정해진 시각에 이 스크립트를 실행합니다.
#
# launchd는 로그인 셸을 거치지 않기 때문에 .env를 직접 source해야 하고, npm/node
# 경로도 PATH에 없을 수 있어 아래에서 흔한 위치들을 미리 추가해둡니다.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

set -a
source "$PROJECT_DIR/.env"
set +a

LOG_DIR="$PROJECT_DIR/output"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/morning-batch-$(date +%Y%m%d-%H%M%S).log"

BATCH_COUNT="${MORNING_BATCH_COUNT:-8}"

if npm run generate:batch "$BATCH_COUNT" >"$LOG_FILE" 2>&1; then
  SUCCESS_COUNT=$(grep -oE '성공: [0-9]+개' "$LOG_FILE" | tail -1 || true)
  osascript -e "display notification \"${SUCCESS_COUNT:-완료}. 로그: $LOG_FILE\" with title \"Masterpiece Shorts 아침 배치\"" 2>/dev/null || true
else
  osascript -e "display notification \"오류 발생 — 로그를 확인하세요: $LOG_FILE\" with title \"Masterpiece Shorts 아침 배치 실패\"" 2>/dev/null || true
fi
