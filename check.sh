#!/usr/bin/env bash
#
# 배포 전 검증 가드 — scripts/*.user.js 를 GitHub에 push 하기 전에 돌린다.
# 통과(exit 0)해야만 안전. 하나라도 걸리면 실패(exit 1)하고 무엇이 문제인지 출력한다.
#
# 검사 항목:
#   1. PII 유출   : 실명·회사번호 등 개인정보가 공개 코드에 섞였는지 (가장 중요)
#   2. 플레이스홀더: __GH_USER__ 처럼 치환 안 된 토큰 (오늘 naver 사고)
#   3. NUL/인코딩 : 파일이 깨져 binary 가 됐는지 (오늘 naver 사고)
#   4. 자동업데이트: @updateURL/@downloadURL 이 자기 자신 raw 주소로 정확한지
#   5. 메타       : @name·@version 존재
#   6. 문법       : node --check 통과
#
# 사용법:  ./check.sh        (repo 루트에서 실행)

set -u
cd "$(dirname "$0")"

# ── 배포 대상 좌표(여기만 바꾸면 됨) ─────────────────────────────
GH_USER="iopkl369-a11y"
REPO="mango-userscripts"
BRANCH="main"
# PII 차단 목록은 이 파일(check.deny)에서 읽는다. check.deny 자체는 .gitignore 되어
# 공개 repo에 올라가지 않는다(실명·번호가 가드 코드로 새는 것 방지). 한 줄에 한 토큰, #은 주석.
DENY_FILE="$(dirname "$0")/check.deny"
PII=()
if [ -f "$DENY_FILE" ]; then
  while IFS= read -r line; do
    line="${line%%#*}"; line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -n "$line" ] && PII+=("$line")
  done < "$DENY_FILE"
fi
# ────────────────────────────────────────────────────────────────

if [ "${#PII[@]}" = "0" ]; then
  printf '\033[33m⚠ PII 차단 목록(check.deny)이 비어있음 — PII 검사 건너뜀. check.deny.example 참고해 만드세요.\033[0m\n'
fi

fail=0
note() { printf '  \033[31m✗ %s\033[0m\n' "$1"; fail=1; }

for f in scripts/*.user.js; do
  base=$(basename "$f")
  echo "● $base"

  # 1. PII 유출 — NUL이 섞여 binary 로 보여도 놓치지 않도록 NUL 제거 후 검사
  clean=$(tr -d '\000' < "$f")
  for p in "${PII[@]}"; do
    if printf '%s' "$clean" | grep -qF "$p"; then note "PII 유출: '$p' 발견 — 공개 코드에서 제거(또는 mango_config로 분리)"; fi
  done

  # 2. 치환 안 된 플레이스홀더 (__UPPERCASE__) — 배포 치환은 헤더에서만 일어나므로
  #    UserScript 메타 헤더 블록만 검사한다(본문 CSS 클래스명 등 오탐 방지).
  header=$(sed '/==\/UserScript==/q' "$f")
  if printf '%s' "$header" | grep -qE '__[A-Z][A-Z0-9_]*__'; then
    note "플레이스홀더 미치환: $(printf '%s' "$header" | grep -oE '__[A-Z][A-Z0-9_]*__' | sort -u | tr '\n' ' ')"
  fi

  # 3. NUL 바이트(파일 손상)
  nul=$(tr -cd '\000' < "$f" | wc -c | tr -d ' ')
  [ "$nul" = "0" ] || note "NUL 바이트 ${nul}개 — 파일 손상(binary). NUL 제거 필요"

  # 4. @updateURL / @downloadURL 정확성
  want="https://raw.githubusercontent.com/${GH_USER}/${REPO}/${BRANCH}/scripts/${base}"
  for key in updateURL downloadURL; do
    got=$(grep -m1 "@${key}" "$f" | awk '{print $NF}')
    if [ -z "$got" ]; then
      note "@${key} 없음 — 자동업데이트 안 됨"
    elif [ "$got" != "$want" ]; then
      note "@${key} 불일치
        기대: $want
        실제: $got"
    fi
  done

  # 5. 필수 메타
  grep -q '@name' "$f"    || note "@name 없음"
  grep -q '@version' "$f" || note "@version 없음"

  # 6. 문법
  node --check "$f" 2>/dev/null || note "node --check 실패(문법 오류)"
done

echo
if [ "$fail" = "0" ]; then
  printf '\033[32m✓ 전체 통과 — push 안전\033[0m\n'
else
  printf '\033[31m✗ 검증 실패 — 위 항목을 고친 뒤 다시 실행하세요(push 금지)\033[0m\n'
fi
exit "$fail"
