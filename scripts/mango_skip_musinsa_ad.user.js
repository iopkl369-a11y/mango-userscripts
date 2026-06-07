// ==UserScript==
// @name         무신사 주문완료 광고 스킵 (Edge 전용)
// @namespace    mango_order
// @version      0.1.0
// @description  무신사 주문완료 페이지(/order/result/*)에서 3·2·1 카운트다운 광고 오버레이를 강제 스킵해 바로 주문 내역을 보여준다. ※ Edge 브라우저에만 설치.
// @author       PA
// @match        https://www.musinsa.com/order/result/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/iopkl369-a11y/mango-userscripts/main/scripts/mango_skip_musinsa_ad.user.js
// @downloadURL  https://raw.githubusercontent.com/iopkl369-a11y/mango-userscripts/main/scripts/mango_skip_musinsa_ad.user.js
// ==/UserScript==

(function () {
  'use strict';

  // 실행 확인용 로그 (콘솔에서 '[mango_order]'로 검색)
  console.log('[mango_order][skip-ad] v0.1.0 loaded @', location.href);

  // ── 1) 타이머 압축 ──────────────────────────────────────────────────────────
  // 카운트다운(setInterval 1초 틱)과 3초 후 오버레이 해제(setTimeout)를 즉시 발화시킨다.
  // 250ms 이상 지연만 ~20ms로 줄여, 마이크로 타이머(<250ms)는 건드리지 않는다.
  const SLOW_MS = 250;   // 이 값 이상이면 '느린' 타이머로 보고 압축
  const FAST_MS = 20;    // 압축 후 지연
  const _setTimeout = window.setTimeout.bind(window);
  const _setInterval = window.setInterval.bind(window);

  window.setTimeout = function (fn, delay, ...rest) {
    return _setTimeout(fn, (typeof delay === 'number' && delay >= SLOW_MS) ? FAST_MS : delay, ...rest);
  };
  window.setInterval = function (fn, delay, ...rest) {
    return _setInterval(fn, (typeof delay === 'number' && delay >= SLOW_MS) ? FAST_MS : delay, ...rest);
  };

  // ── 2) CSS 시간 0화 ─────────────────────────────────────────────────────────
  // 링 카운트다운 애니메이션·오버레이 페이드아웃을 즉시 완료시킨다.
  // head가 아직 없을 수 있으므로 documentElement에 주입한다 (document-start).
  const style = document.createElement('style');
  style.textContent =
    '*, *::before, *::after {' +
    ' animation-duration: 0s !important;' +
    ' animation-delay: 0s !important;' +
    ' transition-duration: 0s !important;' +
    ' transition-delay: 0s !important;' +
    '}';
  document.documentElement.appendChild(style);
})();
