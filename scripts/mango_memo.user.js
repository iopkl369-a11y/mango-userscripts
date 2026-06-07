// ==UserScript==
// @name         더망고 간단입력 (주문번호·금액·간단메모)
// @namespace    mango_order
// @version      0.8.1
// @description  무신사/SSG/네이버에서 주문번호·금액·결제일시를 복사하면(copy 이벤트로 자동 캡처), 더망고 주문목록(admin_getorder.php)에서 칸을 클릭한 행에 단축키(Alt+Q) 한 번으로 상품주문번호·구입금액·간단메모(결제자코드+결제일시)+주문상태(쿠팡=배송지입고완료/그외=해외현지배송중)+쿠팡건 택배사(삼성SDS)·송장(랜덤12자리)를 채운다. 쿠팡건은 송장 입력 직후 상단 "송장번호 마켓전송" 버튼을 자동 클릭한다. 나머지 저장/제출은 사람이 직접. 출처 사이트에서 Alt+W=한방캡처(주문번호·금액·결제일시 동시), Alt+S=캡처 진단(DOM 덤프). 무신사는 주문상세에서 Alt+W 시 거래명세서를 백그라운드로 읽어 3값 캡처, 네이버는 주문완료 결제상세칸(접히면 펼쳐서)에서 3값 캡처. ※ 기존 주소입력 스크립트와 병행 설치.
// @author       PA
// @match        https://tmg2533.cafe24.com/*
// @match        https://www.musinsa.com/*
// @match        https://*.ssg.com/*
// @match        https://*.pay.naver.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/iopkl369-a11y/mango-userscripts/main/scripts/mango_memo.user.js
// @downloadURL  https://raw.githubusercontent.com/iopkl369-a11y/mango-userscripts/main/scripts/mango_memo.user.js
// ==/UserScript==

(function () {
  'use strict';

  console.log('[mango_order][memo] v0.4.6 loaded @', location.href);

  // ── 저장소 키 ────────────────────────────────────────────────────────────────
  const PICK_KEY = 'mo_memo_pick'; // {주문번호, 금액, 결제일시, ts}
  const CODE_KEY = 'mo_memo_code'; // 현재 선택된 결제자 코드(자음/모음) 문자

  // ── 결제자 코드표 — 팀 설정값에서 로딩 (실명·카드 등 민감정보는 공개 코드에 두지 않음) ──
  // 코드(자음/모음) = (플랫폼 × 명의 × 결제수단) 조합. 실제 표는 "⚙ 망고설정"(mango_config) 1회 입력.
  //   localStorage['mango_config'] = { codes: [ { code, platform, name, pay }, ... ], companyPhone }
  function getCodes() {
    try {
      const c = JSON.parse(localStorage.getItem('mango_config') || '{}').codes;
      return Array.isArray(c) ? c : [];
    } catch (e) { return []; }
  }

  // ── 공통 유틸 (기존 스크립트와 동일 패턴) ───────────────────────────────────────
  /** React/일반 제어 입력에 값 주입 — 네이티브 setter + input/change 이벤트 */
  function setNativeValue(el, value) {
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value == null ? '' : String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /** <select>에서 옵션 텍스트가 substr를 포함하는 옵션을 선택(대소문자 무시) */
  function setSelectByText(sel, substr) {
    if (!sel) return false;
    const want = substr.replace(/\s/g, '').toLowerCase();
    for (const o of sel.options) {
      if ((o.textContent || '').replace(/\s/g, '').toLowerCase().includes(want)) {
        sel.value = o.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  /** 행 안에서 옵션 텍스트가 substrs 중 하나를 포함하는 <select>를 찾는다 */
  function findSelectByOption(row, substrs) {
    const wants = substrs.map((s) => s.replace(/\s/g, '').toLowerCase());
    for (const sel of row.querySelectorAll('select')) {
      for (const o of sel.options) {
        const t = (o.textContent || '').replace(/\s/g, '').toLowerCase();
        if (wants.some((w) => t.includes(w))) return sel;
      }
    }
    return null;
  }

  /** ms 대기 (async) */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 랜덤 n자리 숫자 문자열 */
  function randomDigits(n) {
    let s = '' + (1 + Math.floor(Math.random() * 9)); // 첫 자리는 1~9 (0 금지)
    for (let i = 1; i < n; i++) s += Math.floor(Math.random() * 10);
    return s;
  }

  /** 보이는 요소인가 (크기·visibility) */
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  /** 요소의 '직속' 텍스트만 (자식 요소 텍스트 제외) → 라벨/값 분리에 유리 */
  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.trim();
  }

  /** 요소까지의 안정적 CSS 경로 (id 만나면 멈춤, 최대 6단계, 동일태그면 nth-of-type) */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 6) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(seg + '#' + cur.id); break; }
      if (cur.className && typeof cur.className === 'string') {
        const cls = cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) seg += '.' + cls.join('.');
      }
      const parent = cur.parentElement;
      if (parent) {
        const sames = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sames.length > 1) seg += `:nth-of-type(${sames.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  /** 상단 툴바의 "송장번호 마켓전송" 버튼 찾기 (공백무시 정확매칭 → '마켓전송' 포함 폴백) */
  function findTransmitButton() {
    const sel = "button, a, [role='button'], input[type=button], input[type=submit]";
    const norm = (s) => (s || '').replace(/\s/g, '');
    const want = norm('송장번호 마켓전송');
    let fallback = null;
    for (const b of document.querySelectorAll(sel)) {
      if (!isVisible(b)) continue;
      const t = norm(b.textContent || b.value);
      if (t === want) return b;
      if (!fallback && t.includes('마켓전송')) fallback = b;
    }
    return fallback;
  }

  /** 행 맨 앞 대괄호 [쿠팡 | ...] 의 판매마켓이 쿠팡인가 */
  function isCoupang(row) {
    const m = (row.textContent || '').match(/\[([^|\]]+)\|/); // "[쿠팡 | fataladice1]"
    return m ? m[1].includes('쿠팡') : false;
  }

  /** 화면 우하단 토스트 */
  function toast(msg, ok = true) {
    let box = document.getElementById('mo-memo-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'mo-memo-toast';
      box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:96px;max-width:340px;' +
        'padding:10px 14px;border-radius:10px;font:13px/1.4 -apple-system,sans-serif;color:#fff;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.25);white-space:pre-wrap;transition:opacity .2s';
      document.body.appendChild(box);
    }
    box.style.background = ok ? '#1f7a3d' : '#b4232a';
    box.textContent = msg;
    box.style.opacity = '1';
    clearTimeout(box._t);
    box._t = setTimeout(() => { box.style.opacity = '0'; }, 3500);
  }

  // ── 값 분류 (형식으로 주문번호/금액/결제일시 판별) ─────────────────────────────
  const RE_DATETIME = /^\d{4}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}(?:\s+\d{1,2}:\d{2})?$/; // 2026.06.03 13:01
  const RE_AMOUNT = /^\d{1,3}(?:,\d{3})+$|^\d{1,9}$/;  // 콤마 숫자(31,750) 또는 9자리 이하 순수숫자
  const RE_ORDERNO_NUM = /^\d{10,}$/;                  // 무신사 등 10자리+ 순수숫자(202606031300580002)
  // SSG 등 영문/하이픈 섞인 식별자(20260602-3D4BF4): 8자+ & 숫자 1개+ & (영문 또는 하이픈) 포함
  const RE_ORDERNO_ALNUM = /^(?=.*\d)(?=.*[A-Za-z-])[0-9A-Za-z-]{8,}$/;

  /** 한 덩어리 텍스트를 한 줄로 보고 형식 분류 → 'order'|'amount'|'datetime'|null */
  function classify(text) {
    const t = (text || '').trim();
    if (!t) return null;
    if (RE_DATETIME.test(t)) return 'datetime';                          // 날짜 먼저
    if (RE_AMOUNT.test(t)) return 'amount';                              // 콤마/짧은 숫자
    if (RE_ORDERNO_NUM.test(t) || RE_ORDERNO_ALNUM.test(t)) return 'order'; // 긴 숫자 or 영문섞인 식별자
    return null;
  }

  function loadPick() {
    try { return JSON.parse(GM_getValue(PICK_KEY, '') || '{}'); } catch (e) { return {}; }
  }
  function savePick(p) { GM_setValue(PICK_KEY, JSON.stringify(p)); }

  /** 복사된 텍스트를 분류해 해당 슬롯에 저장. 저장됐으면 종류 반환. */
  function capture(text) {
    const kind = classify(text);
    if (!kind) return null;
    const p = loadPick();
    const t = (text || '').trim();
    if (kind === 'order') p.주문번호 = t;
    else if (kind === 'amount') p.금액 = t;
    else if (kind === 'datetime') p.결제일시 = t;
    p.ts = Date.now();
    savePick(p);
    return kind;
  }

  // ── A) 출처 사이트(무신사/SSG/네이버): 복사 캡처 ──────────────────────────────
  const KIND_LABEL = { order: '주문번호', amount: '금액', datetime: '결제일시' };
  function captureAndToast(txt) {
    const kind = capture(txt);
    if (kind) toast(`캡처: ${KIND_LABEL[kind]}\n${(txt || '').trim()}`);
    return kind;
  }

  function installCopyCapture() {
    // (1) 일반 복사: Cmd+C·우클릭복사·execCommand → copy 이벤트의 선택 텍스트
    document.addEventListener('copy', (e) => {
      let txt = '';
      try { txt = (window.getSelection() || '').toString(); } catch (err) { txt = ''; }
      if (!txt && e.clipboardData) { try { txt = e.clipboardData.getData('text'); } catch (err) { /* noop */ } }
      captureAndToast(txt);
    }, true);

    // (2) 클릭=자동복사(네이버 '주문번호 복사하기' 버튼 등 navigator.clipboard.writeText):
    //     copy 이벤트가 안 떠서, "복사 버튼을 눌렀을 때만" 클립보드를 읽어 캡처.
    //     (모든 클릭이 아니라 복사 트리거에 한정 — 일반 클릭은 무시)
    let lastClip = '';
    document.addEventListener('click', (e) => {
      const trg = e.target.closest && e.target.closest("button,a,[role='button']");
      if (!trg) return;
      const cls = trg.className || '';
      const txt = (trg.textContent || '');
      // 네이버 주문번호 복사 버튼, 또는 '복사' 문구 + 8자리+ 숫자가 든 복사 트리거만
      const isCopyTrigger = /OrderNumber_button-number/.test(cls) ||
        (/복사/.test(txt) && /\d{8,}/.test(txt));
      if (!isCopyTrigger) return;
      setTimeout(async () => {
        if (!navigator.clipboard || !navigator.clipboard.readText) return;
        let clip = '';
        try { clip = await navigator.clipboard.readText(); } catch (err) { return; }
        if (!clip || clip === lastClip) return; // 같은 값 반복 캡처/토스트 방지
        lastClip = clip;
        captureAndToast(clip);
      }, 120);
    }, true);

    console.log('[mango_order][memo] 복사 캡처 설치됨(copy + click)');
  }

  // ── B) 더망고 주문목록: 대상 행 찾기 ───────────────────────────────────────────
  // 목록(admin_getorder.php)은 주문마다 상품주문번호·구입금액·간단메모 칸이 한 세트씩 있다.
  // → "마지막으로 클릭(포커스)한 칸이 속한 주문 행"을 대상으로 삼는다.
  let lastRow = null;
  let panelExpanded = false; // 코드 선택 후 패널을 최소화(false=최소화/펼침 토글)

  /** el에서 위로 올라가며 상품주문번호 input + textarea를 모두 가진 최소 컨테이너(주문 행)를 찾는다. */
  function orderRowOf(el) {
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      if (cur.querySelector &&
          cur.querySelector('input[placeholder*="상품주문번호"]') &&
          cur.querySelector('textarea')) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function rememberRow(e) {
    const t = e.target;
    if (!t || !t.matches || !t.matches('input,textarea,select')) return;
    if (t.closest('#mo-memo-panel')) return; // 패널 버튼은 제외
    const row = orderRowOf(t);
    if (row) lastRow = row;
  }

  function currentCode() { return GM_getValue(CODE_KEY, ''); }

  /** 채우기 — 캡처값(부족하면 클립보드 폴백) + 현재 코드로 폼 입력. 저장은 안 함. */
  async function fillMango() {
    const p = loadPick();

    // 폴백: 누락분은 현재 클립보드 한 값으로 보충
    if ((!p.주문번호 || !p.금액 || !p.결제일시) && navigator.clipboard) {
      try {
        const clip = await navigator.clipboard.readText();
        const kind = classify(clip);
        if (kind === 'order' && !p.주문번호) p.주문번호 = clip.trim();
        if (kind === 'amount' && !p.금액) p.금액 = clip.trim();
        if (kind === 'datetime' && !p.결제일시) p.결제일시 = clip.trim();
      } catch (e) { /* 권한 없으면 무시 */ }
    }

    const code = currentCode();
    if (!code) { toast('결제자 코드를 먼저 선택하세요.\n(우하단 패널에서 버튼 클릭)', false); return; }

    // 대상 행 = 지금 포커스된 칸의 행, 없으면 마지막으로 클릭했던 행
    const row = (document.activeElement && orderRowOf(document.activeElement)) || lastRow;
    if (!row) { toast('채울 주문의 칸을 먼저 한 번 클릭하세요.\n(예: 상품주문번호 칸)', false); return; }

    const orderEl = row.querySelector('input[placeholder*="상품주문번호"]');
    const amountEl = row.querySelector('input[placeholder*="구입금액"], input[placeholder*="신고금액"]');
    const memoEl = row.querySelector('textarea');

    const missing = [];
    if (!p.주문번호) missing.push('주문번호');
    if (!p.금액) missing.push('금액');
    if (!p.결제일시) missing.push('결제일시');

    const done = [];
    if (orderEl && p.주문번호) { setNativeValue(orderEl, p.주문번호); done.push('상품주문번호'); }
    if (amountEl && p.금액) { setNativeValue(amountEl, p.금액); done.push('구입금액'); }
    if (memoEl) {
      const prev = (memoEl.value || '').trim();
      const add = `${code}\n${p.결제일시 || ''}`.trim();
      // 기존 메모는 최상단 유지, 새 내용(코드+결제일시)은 최하단에 추가
      const next = prev ? `${prev}\n${add}` : add;
      setNativeValue(memoEl, next);
      done.push('간단메모');
    }

    const fieldMiss = [];
    if (!orderEl) fieldMiss.push('상품주문번호칸');
    if (!amountEl) fieldMiss.push('구입금액칸');
    if (!memoEl) fieldMiss.push('간단메모칸');

    // ── 마켓별 주문상태 + (쿠팡 전용) 택배사·송장 ──────────────────────────────
    const coupang = isCoupang(row);
    const statusSel = findSelectByOption(row, ['배송지입고완료', '해외현지배송중']);
    const wantStatus = coupang ? '배송지입고완료' : '해외현지배송중';
    if (statusSel) {
      if (setSelectByText(statusSel, wantStatus)) done.push(`주문상태=${wantStatus}`);
      else fieldMiss.push(`주문상태(${wantStatus})`);
    } else { fieldMiss.push('주문상태칸'); }

    let trackFilled = false;
    if (coupang) {
      const courierSel = findSelectByOption(row, ['삼성', 'sds']);
      if (courierSel && setSelectByText(courierSel, '삼성')) done.push('택배사=삼성SDS');
      else fieldMiss.push('택배사(삼성SDS)');
      const trackEl = row.querySelector('input[placeholder*="국내송장번호"]');
      if (trackEl) { setNativeValue(trackEl, randomDigits(12)); done.push('국내송장번호'); trackFilled = true; }
      else fieldMiss.push('국내송장번호칸');
    }

    let msg = `[${coupang ? '쿠팡' : '그외'}] 입력: ${done.join(', ') || '없음'} (코드 ${code})`;
    if (missing.length) msg += `\n캡처 누락: ${missing.join(', ')}`;
    if (fieldMiss.length) msg += `\n폼 못 찾음: ${fieldMiss.join(', ')} → Alt+D로 확인`;
    toast(msg, fieldMiss.length === 0);

    // 다음 건과 섞이지 않게, 캡처값을 다 썼으면 비움
    if (!missing.length) savePick({});
    renderPanel();

    // 쿠팡 + 송장 입력 성공 시: 값 반영 여유(400ms) 후 "송장번호 마켓전송" 버튼 자동 클릭
    if (coupang && trackFilled) {
      setTimeout(() => {
        const btn = findTransmitButton();
        if (btn) { btn.click(); toast('송장번호 마켓전송 클릭됨'); }
        else toast('마켓전송 버튼을 못 찾음 — 화면 상단 툴바 확인', false);
      }, 400);
    }
  }

  // ── B) 더망고: 진단 (대상 행의 실제 placeholder/name/id 확인) ───────────────────
  function diagMango() {
    // 대상 행 = 포커스된 칸의 행 → 없으면 마지막 클릭 행 → 없으면 화면 첫 주문 행
    let row = (document.activeElement && orderRowOf(document.activeElement)) || lastRow;
    if (!row) {
      const anyOrderInput = document.querySelector('input[placeholder*="상품주문번호"]');
      row = anyOrderInput ? orderRowOf(anyOrderInput) : null;
    }
    if (!row) { showDiagPanel('주문 행을 못 찾음 — 상품주문번호 칸이 있는 행을 클릭한 뒤 다시 시도.'); return; }
    const lines = [];
    for (const f of row.querySelectorAll('input,textarea,select')) {
      const tag = f.tagName.toLowerCase();
      const type = f.type ? `:${f.type}` : '';
      lines.push(`${tag}${type} placeholder="${f.placeholder || ''}" name=${f.name || '-'} id=${f.id || '-'}`);
    }
    showDiagPanel(lines.join('\n') || '(행에 필드 없음)');
  }

  // ── A) 출처 사이트: 한방 캡처 (주문번호·금액·결제일시 동시) ──────────────────────
  /** 무신사: 주문번호는 URL, 결제일시·결제금액은 거래명세서(payment_receipt) HTML에서 읽어 3슬롯 캡처.
   *  거래명세서는 동일 출처(www.musinsa.com)라 팝업 없이 fetch로 읽는다. */
  async function captureMusinsa() {
    const m = location.pathname.match(/(\d{10,})/); // 주문상세/거래명세서 URL에 든 주문번호
    const orderno = m ? m[1] : null;
    if (!orderno) { toast('주문번호를 URL에서 못 찾음\n(주문상세 또는 거래명세서 페이지에서 실행)', false); return; }

    let doc = document;
    if (!/payment_receipt/.test(location.pathname)) {
      const url = `https://www.musinsa.com/order-service/my/order/payment_receipt/${orderno}?layout=popup`;
      toast('거래명세서 읽는 중…');
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      } catch (e) {
        toast('거래명세서 읽기 실패: ' + e.message + '\n팝업을 직접 열고 다시 Alt+W', false);
        return;
      }
    }

    // 거래명세서 dl 목록: dt=라벨, dd=값. 첫 날짜형식=결제일시, '결제'+'금액' 라벨=금액.
    let dt = '', amt = '';
    for (const li of doc.querySelectorAll('dl.financial-form__list')) {
      const desc = ((li.querySelector('.financial-form__description') || {}).textContent || '').trim();
      const term = ((li.querySelector('.financial-form__term') || {}).textContent || '').replace(/\s/g, '');
      if (!dt && RE_DATETIME.test(desc)) dt = desc;
      if (!amt && term.includes('결제') && term.includes('금액')) amt = desc.replace(/[^\d,]/g, '');
    }

    const got = [], miss = [];
    if (capture(orderno) === 'order') got.push('주문번호'); else miss.push('주문번호');
    if (amt && capture(amt) === 'amount') got.push('금액'); else miss.push('금액');
    if (dt && capture(dt) === 'datetime') got.push('결제일시'); else miss.push('결제일시');

    let msg = `한방캡처: ${got.join(', ') || '없음'}`;
    if (got.includes('주문번호')) msg += `\n${orderno}`;
    if (miss.length) msg += `\n못 읽음: ${miss.join(', ')} (Alt+S로 DOM 확인)`;
    toast(msg, miss.length === 0);
  }

  /** 네이버페이 주문완료(result) 페이지: 주문번호=URL, 결제일시·금액=결제상세칸(접혀 있으면 펼침).
   *  React 해시 클래스라 안정적인 클래스 접두사 [class*="..."]로 잡는다. */
  async function captureNaver() {
    const m = location.pathname.match(/(\d{10,})/); // /order/result/seller/2026060731063621
    const orderno = m ? m[1] : null;
    if (!orderno) { toast('주문번호를 URL에서 못 찾음', false); return; }

    // '결제상세' 제목을 앵커로, 위로 올라가 '승인일시'까지 포함하는 최소 컨테이너를 잡는다
    // (그 안에 금액 컬럼·승인일시가 다 들어옴 — 클래스 해시 무관). 폴백: PaymentSummary 접두사.
    const findDetail = () => {
      for (const el of document.querySelectorAll('*')) {
        if (ownText(el).replace(/\s/g, '') !== '결제상세') continue;
        let c = el.parentElement;
        for (let i = 0; i < 6 && c; i++) {
          if (/승인일시/.test(c.textContent || '')) return c;
          c = c.parentElement;
        }
      }
      const ps = document.querySelector('[class*="PaymentSummary_article"]');
      return (ps && /승인일시/.test(ps.textContent || '')) ? ps : null;
    };

    let detail = findDetail();
    if (!detail) {
      // 접힘 → 주문상품 행을 펼친다. '주문 상세 보기'(페이지이동)는 건드리지 않음.
      for (const el of document.querySelectorAll('button,[role="button"],strong,div,span')) {
        if (/^주문상품\s*\d+\s*건/.test(ownText(el))) { (el.closest('button,[role="button"]') || el).click(); break; }
      }
      await sleep(700);
      detail = findDetail();
    }

    let dt = '', amt = '';
    if (detail) {
      const txt = detail.textContent || '';
      const md = txt.match(/승인일시\s*[:：]?\s*(\d{4}\.\d{1,2}\.\d{1,2}\s+\d{1,2}:\d{2})/); // 결제(승인)일시
      if (md) dt = md[1];
      const ma = txt.match(/(\d{1,3}(?:,\d{3})+)\s*원/); // 결제상세 첫 금액 = 최종결제액(…간편결제 …원)
      if (ma) amt = ma[1];
    }

    const got = [], miss = [];
    if (capture(orderno) === 'order') got.push('주문번호'); else miss.push('주문번호');
    if (amt && capture(amt) === 'amount') got.push('금액'); else miss.push('금액');
    if (dt && capture(dt) === 'datetime') got.push('결제일시'); else miss.push('결제일시');

    let msg = `한방캡처: ${got.join(', ') || '없음'}`;
    if (got.includes('주문번호')) msg += `\n${orderno}`;
    if (miss.length) msg += `\n못 읽음: ${miss.join(', ')}\n(주문상품 화살표를 펼치고 다시 Opt+W)`;
    toast(msg, miss.length === 0);
  }

  /** SSG: 주문상세(orderInfoDetail)에서 주문번호(하이픈 표시형)·총결제금액을 읽고,
   *  결제일시(시간 포함)는 카드영수증 팝업(orderInfoCardReceiptPopup)을 백그라운드 fetch해 추출.
   *  같은 도메인(pay.ssg.com)이라 팝업 없이 읽는다. 영수증 실패 시 상세의 날짜(시간없음)로 폴백. */
  async function captureSsg() {
    const m = (location.href.match(/orordNo=([0-9A-Za-z]+)/) || []);
    const rawNo = m[1] || null;
    if (!rawNo) { toast('주문번호(orordNo)를 URL에서 못 찾음', false); return; }

    // 주문번호(더망고용 하이픈 표시형): 상세의 표시값 우선, 없으면 URL값을 8자+'-'+나머지로 합성
    const odrEl = document.querySelector('.codr_odrdeliv_odrnum');
    let orderno = odrEl ? ownText(odrEl).trim() : '';
    if (!/^[0-9A-Za-z]{6,}-/.test(orderno)) orderno = rawNo.length > 8 ? rawNo.slice(0, 8) + '-' + rawNo.slice(8) : rawNo;

    // 금액: '결제내역' 칸의 실제 결제수단 금액 우선(분할결제 시 실결제액), 없으면 '총 결제금액' 폴백.
    // 제목을 앵커로, 위로 올라가 '…,…원'을 포함하는 최소 컨테이너의 첫 금액을 읽는다(클래스 해시 무관).
    const amountUnderHeading = (headingNoSpace) => {
      for (const el of document.querySelectorAll('*')) {
        if (ownText(el).replace(/\s/g, '') !== headingNoSpace) continue;
        let c = el;
        for (let i = 0; i < 5 && c; i++) {
          const mm = (c.textContent || '').match(/(\d{1,3}(?:,\d{3})+)\s*원/);
          if (mm) return mm[1];
          c = c.parentElement;
        }
      }
      return '';
    };
    const amt = amountUnderHeading('결제내역') || amountUnderHeading('총결제금액');

    // 결제일시(시간 포함): 카드영수증 팝업을 fetch → '2026-06-07 15:50' 형태 td → '.'으로 통일
    let dt = '';
    try {
      const url = `https://pay.ssg.com/myssg/orderInfoCardReceiptPopup.ssg?orordNo=${rawNo}&receiptType=CARD`;
      const res = await fetch(url, { credentials: 'include' });
      if (res.ok) {
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        for (const td of doc.querySelectorAll('td')) {
          const t = (td.textContent || '').trim();
          if (/^\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}$/.test(t)) { dt = t.replace(/-/g, '.'); break; }
        }
      }
    } catch (e) { /* 아래 폴백 */ }
    if (!dt) { // 폴백: 상세페이지 날짜(시간 없음)
      const d = document.querySelector('.codr_odrdeliv_odrdate');
      const t = d ? ownText(d).trim() : '';
      if (RE_DATETIME.test(t)) dt = t;
    }

    const got = [], miss = [];
    if (capture(orderno) === 'order') got.push('주문번호'); else miss.push('주문번호');
    if (amt && capture(amt) === 'amount') got.push('금액'); else miss.push('금액');
    if (dt && capture(dt) === 'datetime') got.push('결제일시'); else miss.push('결제일시');

    let msg = `한방캡처: ${got.join(', ') || '없음'}`;
    if (got.includes('주문번호')) msg += `\n${orderno}`;
    if (miss.length) msg += `\n못 읽음: ${miss.join(', ')} (Alt+S로 DOM 확인)`;
    toast(msg, miss.length === 0);
  }

  /** 호스트로 라우팅 — 무신사·네이버·SSG 구현. */
  async function captureSource() {
    if (location.hostname.includes('musinsa.com')) return captureMusinsa();
    if (location.hostname.includes('pay.naver.com')) return captureNaver();
    if (location.hostname.includes('ssg.com')) return captureSsg();
    toast('이 사이트 한방캡처는 아직 미구현\nAlt+S로 덤프를 떠서 알려주세요.', false);
  }

  // ── A) 출처 사이트: 캡처 진단 (사이트별 정확 셀렉터 확정용 DOM 덤프) ──────────────
  // 현재 화면에서 주문번호/금액/주문일시 '값 후보'(형식분류)와 '라벨 후보'를 CSS경로와 함께 덤프.
  // 무신사 거래명세서처럼 별도 URL이면 그 페이지로 이동해 각각 Alt+S 하면 된다(스크립트가 거기서도 실행됨).
  function diagSource() {
    const LABELS = ['주문번호', '주문 번호', '주문일시', '주문 일시', '결제일시', '결제 일시',
      '승인일시', '승인 일시', '결제금액', '결제 금액', '총 결제금액', '총결제금액',
      '상품금액', '상품 금액', '거래명세서', '상세명세서', '명세서'];
    const SKIP = '#mo-memo-panel,#mo-memo-diag,#mo-memo-toast';
    const all = document.querySelectorAll('body *');

    const valLines = [];
    const seenVal = new Set();
    for (const el of all) {
      if (el.closest(SKIP) || !isVisible(el)) continue;
      const t = ownText(el);
      if (!t || t.length > 40) continue;
      const kind = classify(t);
      if (!kind) continue;
      const key = kind + '|' + t;
      if (seenVal.has(key)) continue;
      seenVal.add(key);
      valLines.push(`[${KIND_LABEL[kind]}] "${t}"  ←  ${cssPath(el)}`);
    }

    const labLines = [];
    const seenLab = new Set();
    for (const el of all) {
      if (el.closest(SKIP) || !isVisible(el)) continue;
      const t = ownText(el);
      if (!t || t.length > 30) continue;
      if (!LABELS.some((L) => t.includes(L))) continue;
      const sib = el.nextElementSibling;
      const near = sib ? (sib.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) : '';
      const line = `라벨 "${t}"  →  값?"${near}"  ←  ${cssPath(el)}`;
      if (seenLab.has(line)) continue;
      seenLab.add(line);
      labLines.push(line);
    }

    const out =
      `# ${location.hostname}\n# ${location.href}\n` +
      `\n## 값 후보(형식분류: 주문번호/금액/결제일시)\n` + (valLines.join('\n') || '(없음)') +
      `\n\n## 라벨 후보(라벨 텍스트 → 다음형제 값 추정)\n` + (labLines.join('\n') || '(없음)');
    showDiagPanel(out);
  }

  function showDiagPanel(text) {
    let box = document.getElementById('mo-memo-diag');
    if (!box) {
      box = document.createElement('div');
      box.id = 'mo-memo-diag';
      box.style.cssText = 'position:fixed;z-index:2147483647;left:14px;bottom:14px;width:520px;max-height:60vh;' +
        'overflow:auto;padding:10px 12px;border-radius:10px;background:#222;color:#eee;' +
        'font:11px/1.45 ui-monospace,monospace;box-shadow:0 4px 16px rgba(0,0,0,.35);white-space:pre-wrap';
      const ta = document.createElement('textarea');
      ta.id = 'mo-memo-diag-ta';
      ta.style.cssText = 'width:100%;height:40vh;margin-top:6px;font:11px/1.4 ui-monospace,monospace';
      box.appendChild(ta);
      document.body.appendChild(box);
    }
    const ta = document.getElementById('mo-memo-diag-ta');
    ta.value = text; ta.focus(); ta.select();
  }

  // ── B) 더망고: 플로팅 패널 (코드 선택 + 캡처상태) ──────────────────────────────
  function renderPanel() {
    let panel = document.getElementById('mo-memo-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'mo-memo-panel';
      panel.style.cssText = 'position:fixed;z-index:2147483646;right:14px;bottom:14px;width:230px;' +
        'padding:10px 12px;border-radius:12px;background:#fff;color:#222;' +
        'font:12px/1.4 -apple-system,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.22)';
      document.body.appendChild(panel);
    }
    const p = loadPick();
    const code = currentCode();
    const codes = getCodes();
    const mark = (v) => (v ? '✓' : '·');
    const sel = codes.find((c) => c.code === code);
    const status = `${mark(p.주문번호)} 주문번호　${mark(p.금액)} 금액　${mark(p.결제일시)} 일시`;
    // sel이 있어도 속성이 비면 undefined가 노출되므로 안전하게 합성
    const codeLabel = (s) => `${s && s.code ? s.code : (code || '?')} ${s && s.name ? s.name : '명의?'}`;

    // ── 최소화: 유효한 명의가 선택됐고 펼침 상태가 아닐 때 ──
    if (sel && !panelExpanded) {
      panel.style.width = 'auto';
      panel.innerHTML =
        `<div style="display:flex;align-items:center;gap:8px">` +
        `<button id="mo-memo-expand" title="코드 변경(펼치기)" ` +
        `style="padding:5px 9px;border:0;border-radius:7px;cursor:pointer;background:#2f6fed;color:#fff;` +
        `font:13px/1 -apple-system,sans-serif">${codeLabel(sel)} ▸</button>` +
        `<span style="color:#666;font-size:11px">${status}</span>` +
        `<button id="mo-memo-fill" style="padding:6px 12px;border:0;border-radius:7px;cursor:pointer;` +
        `background:#1f7a3d;color:#fff">채우기</button></div>`;
      panel.querySelector('#mo-memo-expand').onclick = () => { panelExpanded = true; renderPanel(); };
      panel.querySelector('#mo-memo-fill').onclick = () => fillMango();
      return;
    }

    // ── 펼침: 코드 선택 그리드 ──
    panel.style.width = '230px';
    if (!codes.length) {
      panel.innerHTML =
        `<div style="font-weight:700;margin-bottom:6px">간단입력</div>` +
        `<div style="color:#b4232a;line-height:1.5">팀 설정값이 비어 있습니다.<br>` +
        `좌하단 <b>⚙ 망고설정</b>에서 코드표를 1회 붙여넣으세요.</div>`;
      return;
    }
    const btns = codes.map((c) => {
      const on = c.code === code;
      const bg = on ? '#2f6fed' : '#eef0f4';
      const fg = on ? '#fff' : '#333';
      return `<button data-code="${c.code}" title="${c.platform} · ${c.name} · ${c.pay}" ` +
        `style="margin:2px;padding:5px 7px;border:0;border-radius:7px;cursor:pointer;` +
        `background:${bg};color:${fg};font:12px/1 -apple-system,sans-serif">` +
        `${c.code} <span style="opacity:.7">${c.name}</span></button>`;
    }).join('');

    panel.innerHTML =
      `<div style="font-weight:700;margin-bottom:6px">간단입력 ` +
      `<span style="font-weight:400;color:#888">행 칸 클릭→Alt+Q</span>` +
      (sel ? `<button id="mo-memo-collapse" title="접기(최소화)" style="float:right;border:0;border-radius:6px;cursor:pointer;background:#eef0f4;color:#555;padding:2px 9px;font:13px/1 -apple-system,sans-serif">▾ 접기</button>` : '') +
      `</div>` +
      `<div style="display:flex;flex-wrap:wrap;margin-bottom:8px">${btns}</div>` +
      `<div style="color:#555;border-top:1px solid #eee;padding-top:6px">${status}</div>` +
      `<div style="margin-top:8px;display:flex;gap:6px">` +
      `<button id="mo-memo-fill" style="flex:1;padding:6px;border:0;border-radius:7px;cursor:pointer;` +
      `background:#1f7a3d;color:#fff">채우기</button>` +
      `<button id="mo-memo-diag-btn" style="padding:6px 8px;border:0;border-radius:7px;cursor:pointer;` +
      `background:#666;color:#fff" title="필드 진단(Alt+D)">진단</button></div>`;

    panel.querySelectorAll('button[data-code]').forEach((b) => {
      // 코드 선택 → 저장하고 최소화
      b.onclick = () => { GM_setValue(CODE_KEY, b.getAttribute('data-code')); panelExpanded = false; renderPanel(); };
    });
    const col = panel.querySelector('#mo-memo-collapse');
    if (col) col.onclick = () => { panelExpanded = false; renderPanel(); };
    panel.querySelector('#mo-memo-fill').onclick = () => fillMango();
    panel.querySelector('#mo-memo-diag-btn').onclick = () => diagMango();
  }

  // ── 라우팅 ────────────────────────────────────────────────────────────────────
  const host = location.hostname;
  if (host.endsWith('cafe24.com')) {
    if (/admin_getorder\.php/i.test(location.href)) { // 주문목록 — 칸이 행마다 있는 화면
      renderPanel();
      setInterval(renderPanel, 4000); // 캡처 상태 주기적 갱신
      document.addEventListener('focusin', rememberRow, true); // 대상 행 추적
      window.addEventListener('keydown', (e) => {
        if (!e.altKey) return;
        if (e.key === 'q' || e.key === 'Q' || e.code === 'KeyQ') { e.preventDefault(); fillMango(); }
        if (e.key === 'd' || e.key === 'D' || e.code === 'KeyD') { e.preventDefault(); diagMango(); }
      }, true);
    }
  } else {
    // 무신사/SSG/네이버 — 복사 가로채 캡처 + Alt+S 진단(주소입력 스크립트의 Alt+A/Alt+D와 충돌 안 함)
    installCopyCapture();
    window.addEventListener('keydown', (e) => {
      if (!e.altKey) return;
      // Mac에서 Option+W='∑'·Option+S='ß'라 e.key가 아닌 e.code로 판별
      if (e.code === 'KeyW' || e.key === 'w' || e.key === 'W') { e.preventDefault(); captureSource(); }
      if (e.code === 'KeyS' || e.key === 's' || e.key === 'S') { e.preventDefault(); diagSource(); }
    }, true);
  }
})();
