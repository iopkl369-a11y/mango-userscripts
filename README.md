# mango-userscripts

더망고(Cafe24) 발주 자동화용 Tampermonkey 유저스크립트 모음 — **팀 배포용 공개 저장소**.

설치는 → **[설치 페이지(install.html)](https://iopkl369-a11y.github.io/mango-userscripts/install.html)** 를 팀원에게 공유하세요.

## 스크립트

| 파일 | 단축키 | 설치 브라우저 | 기능 |
|---|---|---|---|
| `mango_config.user.js` | — | 전부 | **팀 설정(코드표·회사번호)** 입력 UI. 좌하단 ⚙ 버튼. 다른 스크립트가 이 값을 읽음 |
| `mango_memo.user.js` | Opt+W / Opt+Q | 전부 | 출처 사이트 한방캡처(주문번호·금액·결제일시) + 더망고 간단입력 |
| `mango_order_musinsa.user.js` | Alt+A | Edge | 무신사 배송지 한방입력(+카카오 우편번호) |
| `mango_order_ssg.user.js` | Alt+A / Alt+D | Brave | SSG 배송지 한방입력 |
| `mango_order_naver.user.js` | Alt+A / Alt+D | Chrome/Brave | 네이버페이 배송지 한방입력 |
| `mango_skip_musinsa_ad.user.js` | — | 무신사 쓰는 곳 | 주문완료 광고 오버레이 즉시 스킵 |

## 민감정보 분리 (중요)

실명·회사번호 등 PII는 **코드에 없습니다.** `mango_config.user.js`의 ⚙ 설정에 팀이 직접 입력하는
JSON(브라우저 로컬 저장)에만 들어갑니다. 형식은 [`team-config.example.json`](team-config.example.json) 참고.
**실제 값은 이 저장소에 커밋하지 말고 팀 채팅으로만 공유**하세요.

설정 흐름: 메인 스크립트들은 page `localStorage['mango_config']`(JSON)을 읽고, `mango_config.user.js`가
GM 저장값을 각 도메인 localStorage로 미러합니다.

## 자동 업데이트

각 스크립트 헤더의 `@updateURL`/`@downloadURL`이 이 저장소 raw를 가리켜, 코드 수정·push 시
팀원 Tampermonkey가 자동 갱신합니다. (공개 저장소라 raw 인증 불필요)

## 개발

원본은 `~/projects/mango_order/userscript/`. 여기 `scripts/`는 PII를 분리한 배포본입니다.
수정 후 `node --check scripts/*.user.js`로 문법 확인, version 올리고 push하면 배포됩니다.
