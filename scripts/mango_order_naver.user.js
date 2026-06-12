// ==UserScript==
// @name         더망고 네이버페이 주소 한방입력 (Chrome/Brave)
// @namespace    mango_order
// @version      0.4.8
// @description  더망고 주문정보의 배송지를 담고, 네이버페이 주문서에서 Alt+A로 배송지 신규입력(수령인·연락처(안심번호 그대로)·주소검색·상세주소)→저장→목록선택까지 자동. Alt+D는 폼 진단 덤프. ※ 네이버 전용 브라우저(Chrome/Brave)에 설치.
// @author       PA
// @match        https://tmg2533.cafe24.com/*
// @match        https://*.pay.naver.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/iopkl369-a11y/mango-userscripts/main/scripts/mango_order_naver.user.js
// @downloadURL  https://raw.githubusercontent.com/iopkl369-a11y/mango-userscripts/main/scripts/mango_order_naver.user.js
// ==/UserScript==

(function () {
  'use strict';

  // 실행 확인용 로그 (콘솔에서 '[mango_order]'로 검색)
  console.log('[mango_order][naver] v0.4.8 loaded @', location.href, 'top=', window.top === window);

  // ── 정책 상수 ──────────────────────────────────────────────────────────────
  // 상세주소 괄호 안에서 '삭제 대상'으로 보는 건물/아파트 키워드 (musinsa_order.py _BLD_KW 동일)
  const BLD_KW = ['아파트', 'apt', '빌라', '빌딩', '빌', '타워', '맨션', '맨숀', '오피스텔',
    '하우스', '팰리스', '펠리스', '캐슬', '자이', '푸르지오', '래미안',
    '힐스테이트', '더샵', '메르디앙', '리슈빌', '쉐르빌', '코아루',
    '파라디아', '센트럴', '파크'];

  // ⚠️ 네이버는 안심번호(050x)를 그대로 받으므로 회사번호 대체 없음 (무신사/SSG와 다른 점).
  //    연락처는 숫자만 뽑아 그대로 입력한다.

  const STORE_KEY = 'mo_order';   // 담긴 주문(배송지) JSON

  // ── 공통 유틸 (무신사/SSG 스크립트와 동일) ──────────────────────────────────
  /** React/일반 입력에 값 주입 — 네이티브 setter + _valueTracker 강제 mismatch + input/change.
   *  ⚠️ 네이버폼은 React가 _valueTracker로 값 변경을 추적해, 트래커를 안 어긋내면 onChange를
   *     무시한다(값이 DOM엔 보이지만 React 상태엔 안 들어가 '미입력'으로 저장 실패). */
  function setNativeValue(el, value) {
    if (!el) return false;
    value = value == null ? '' : String(value);
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    // 트래커 보유값을 새 값과 다르게 만들어 React가 '변경됨'으로 인식하게 한다
    try { if (el._valueTracker) el._valueTracker.setValue(value + ' '); } catch (e) { /* noop */ }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /** <select>에서 값/텍스트가 일치하는 option 선택 */
  function setSelectValue(sel, want) {
    if (!sel) return false;
    want = (want || '').trim();
    for (const opt of sel.options) {
      if ((opt.value || '').trim() === want || (opt.textContent || '').trim() === want) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  /** 연락처 — 숫자만 (네이버는 안심번호 050x도 그대로 입력) */
  function phoneDigits(raw) {
    return (raw || '').replace(/\D/g, '');
  }

  /** 주소의 검증용 핵심 토큰 — 도로명+건물번호 또는 동/리+번지. 없으면 null (무신사/SSG 스크립트와 동일) */
  function addrParts(addr) {
    const t = (addr || '').replace(/\s*\([^)]*\)\s*/g, ' ');
    let m = t.match(/(\S*(?:로|길))\s*(\d+(?:-\d+)?)(?=\s|$|,)/);
    if (m) return { key: m[1], num: m[2] };
    m = t.match(/(\S*[가-힣](?:동|리|읍|면|가))\s*((?:산\s*)?\d+(?:-\d+)?)(?=\s|$|,)/);
    if (m) return { key: m[1], num: m[2] };
    return null;
  }

  /** 후보 텍스트가 핵심 토큰과 '번호 경계까지' 일치하는가 — 42는 42-8/420과 다른 주소 */
  function matchesAddr(text, parts) {
    if (!parts) return false;
    const esc = (s) => norm(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(esc(parts.key) + esc(parts.num) + '(?![\\d-])').test(norm(text));
  }

  /** 상세주소 괄호 안의 건물명(행정동 제외) — 검색 결과 후보가 여럿일 때 보조 판별용 */
  function buildingHint(detail) {
    const m = (detail || '').match(/\(([^)]*)\)/);
    if (!m) return '';
    const tok = m[1].split(',').map((s) => s.trim())
      .find((s) => s && !/[가-힣](동|리|읍|면|가)$/.test(s));
    return tok ? norm(tok) : '';
  }

  /** 주소검색어 — 괄호 '(송도동, …)' 제거 (SSG ssgSearchKeyword와 동일 취지) */
  function searchKeyword(addr) {
    return (addr || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  /** address1이 번지/건물번호 없이 끝나는 불완전 주소인가 (무신사/SSG 스크립트와 동일)
   *  숫자 뒤 경계(공백/끝/쉼표)를 요구해 '부평대로278번길'(로+278 오인) 같은 도로명 자체 숫자를 배제. */
  function isIncompleteAddr1(addr) {
    const t = (addr || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    if (/(로|길)\s*\d+(?:-\d+)?(?=\s|$|,)/.test(t)) return false;                          // 도로명+건물번호 있음
    if (/[가-힣0-9](동|리|읍|면|가)\s*(?:산\s*)?\d+(?:-\d+)?(?=\s|$|,)/.test(t)) return false; // 지번(동/리 뒤 번지) 있음
    return true;
  }

  /** 불완전 address1을 상세주소의 도로명/번지로 보완(o를 직접 수정). 보완 불가면 ok=false.
   *  ⚠️ 불완전 주소('…동')로 그대로 검색하면 엉뚱한 주소가 선택·입력되므로, 보완 실패 시 반드시 중단한다. */
  function fixIncompleteAddr(o) {
    const a1 = (o.주소 || '').trim();
    if (!isIncompleteAddr1(a1)) return { ok: true, fixed: false };
    const d = (o.상세주소 || '').trim();
    const road = d.match(/([가-힣\dA-Za-z]+(?:로|길)\d*[가-힣]*\s*\d+(?:-\d+)?)/);
    const jibun = road ? null : d.match(/((?:산\s*)?\d+(?:-\d+)?\s*번지)/);
    const m = road || jibun;
    if (!m) {
      // 상세주소에 도로명/번지가 없어도, addr1이 '…로/…길'(도로명)로 끝나고 상세주소가 순수 숫자
      // 토큰('42'/'42-8')으로 시작하면 그 숫자를 건물번호로 본다(예: '부평대로278번길' + '42, 102동…').
      const lead = d.match(/^(\d+(?:-\d+)?)(?=[\s,(]|$)/);
      let b = a1.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
      b = b.replace(/\s*[가-힣0-9]+(동|리|읍|면|가)$/, '').trim();
      if (!lead || !/(로|길)$/.test(b)) return { ok: false, fixed: false };
      o.주소 = b + ' ' + lead[1];
      o.상세주소 = d.slice(lead[1].length).replace(/^[\s,]+/, '').trim();
      return { ok: true, fixed: true };
    }
    // 도로명 보완이면 끝의 행정동/리 토큰을 뗀다(도로명과 섞이면 검색이 깨짐).
    // 번지 보완이면 동/리를 남긴다(지번은 동/리가 있어야 위치가 특정됨).
    let base = a1.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (road) base = base.replace(/\s*[가-힣0-9]+(동|리|읍|면|가)$/, '').trim();
    o.주소 = (base + ' ' + m[1]).trim();
    o.상세주소 = d.replace(m[1], '').replace(/\s{2,}/g, ' ').trim(); // 보완에 쓴 토큰은 상세주소에서 제거(중복 방지)
    return { ok: true, fixed: true };
  }

  /** 여러 라벨 후보 중 먼저 찾히는 클릭 대상 반환 */
  function findClickableByTextAny(labels) {
    for (const l of labels) { const el = findClickableByText(l); if (el) return el; }
    return null;
  }

  /** 텍스트가 일치하는 클릭 대상이 나타날 때까지 폴링 */
  async function waitForText(label, timeout = 5000) {
    const t0 = Date.now();
    for (;;) {
      const el = findClickableByText(label);
      if (el) return el;
      if (Date.now() - t0 > timeout) return null;
      await sleep(150);
    }
  }

  /** 텍스트(부분 포함)가 든 말단 요소 찾기 — 드롭다운 placeholder 등 */
  function findByTextContains(re) {
    for (const e of document.querySelectorAll("*")) {
      if (e.children.length === 0 && re.test(e.textContent || '') && isVisible(e)) {
        return e.closest("button, a, [role='button'], [class*='select'], div") || e;
      }
    }
    return null;
  }

  const Q = (sel) => document.querySelector(sel);
  const hasZip = (s) => /\b\d{5}\b/.test(s || '');

  /** 모달 안 '빈 곳'(제목 등 입력칸 아닌 영역)을 실제 클릭 — 네이버 폼은 이 클릭으로 다음 단계가 뜬다 */
  function clickEmptyArea() {
    let t = null;
    for (const el of document.querySelectorAll('strong, h1, h2, h3, b')) {
      const tx = (el.textContent || '').trim();
      if (/주세요$/.test(tx) && tx.length < 24 && !el.querySelector('input')) { t = el; break; }
    }
    if (!t) t = document.querySelector("[class*='InputDeliveryAddress_article'], [class*='Modal'], [class*='modal']");
    if (t) realClick(t);
  }

  /** 네이티브 setter + 트래커 mismatch로 값 1회 설정(이벤트는 호출자가 발생) */
  function nativeSet(el, val) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
    try { if (el._valueTracker) el._valueTracker.setValue(val + ' '); } catch (e) { /* noop */ }
  }

  /** React가 props에 보관한 핸들러(onChange/onBlur 등)를 '직접' 호출.
   *  ⚠️ 네이버 상세주소: onChange로 controlled value는 들어가지만 '저장 검증용 폼 상태'는
   *     onBlur에서 커밋된다 → onChange + onBlur 둘 다 직접 호출해야 인정된다. */
  function reactFireProp(el, name) {
    try {
      const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
      const props = key ? el[key] : null;
      if (props && typeof props[name] === 'function') {
        props[name]({
          target: el, currentTarget: el, type: name.slice(2).toLowerCase(), bubbles: true,
          preventDefault() {}, stopPropagation() {}, persist() {},
          isDefaultPrevented: () => false, isPropagationStopped: () => false,
          relatedTarget: null, nativeEvent: { target: el },
        });
        return true;
      }
    } catch (e) { /* noop */ }
    return false;
  }

  /** React 입력에 값 넣기 — 1순위 execCommand('insertText')(브라우저 네이티브 입력이라 React가 확실히
   *  인식·상태에 반영), 실패하면 per-char 타이핑으로 폴백. commit=true면 폴백에서 마지막 글자 굳히기용
   *  공백을 남긴다. ⚠️ 합성 value 주입은 네이버 상세주소 React 상태에 안 들어간다 → execCommand가 핵심. */
  async function typeReact(el, text, commit) {
    text = String(text == null ? '' : text);
    el.focus();
    try { el.select(); } catch (e) { /* noop */ } // 기존 값 전체선택 → insertText가 덮어씀
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!(ok && norm(el.value) === norm(text))) {
      // ── 폴백: per-char 타이핑 + 트래커 mismatch ──
      let cur = '';
      nativeSet(el, '');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      for (const ch of text) {
        cur += ch;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        nativeSet(el, cur);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
        await sleep(10);
      }
      if (commit) { // 마지막 글자 굳히기용 트레일링 공백(남김)
        cur += ' ';
        nativeSet(el, cur);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ' ', inputType: 'insertText' }));
      }
    }
    reactFireProp(el, 'onChange'); // controlled value 갱신
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // 저장 검증용 폼 상태는 onBlur에서 커밋된다 → focusout + onBlur 직접 호출
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    reactFireProp(el, 'onBlur');
  }

  /** 한 필드: 실제클릭→한글자씩 타이핑→blur→'빈곳' 클릭(다음 단계 유도) */
  async function fillStep(sel, val, commit) {
    const el = await waitFor(document, sel, 4000);
    if (!el) return false;
    realClick(el);
    await typeReact(el, val, commit);
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    clickEmptyArea();
    await sleep(400);
    return true;
  }

  /** ⓒ폼 순차 입력 — 받는이 → 연락처 → 배송지 별명 → 상세주소(재확인). 단계마다 빈곳 클릭. */
  async function naverFillForm(o) {
    await fillStep('#receiver', o.수령인);
    // 연락처 칸은 '빈곳 클릭' 후 노출될 수 있음
    if (!Q('#contact-1')) { clickEmptyArea(); await waitFor(document, '#contact-1', 4000); }
    await fillStep('#contact-1', phoneDigits(o.연락처)); // 안심번호(0507 등)도 그대로
    if (Q('#delivery-name')) await fillStep('#delivery-name', o.수령인);
    // 상세주소: ⓑ→ⓒ로 전달됐으면 채워져 있음. 비어 있으면(전달 실패) ⓒ에서 직접 입력.
    // (execCommand는 ⓒ에서도 정상 인식 — 옛 setNativeValue로 깨지던 것과 다름)
    const dt = Q('#address-detail');
    if (dt && !(dt.value || '').trim()) await fillStep('#address-detail', detailOrDash(o));
  }

  /** 버튼이 비활성(disabled/aria-disabled/클래스) 상태인가 */
  const isBtnDisabled = (b) => !b || b.disabled || b.getAttribute('aria-disabled') === 'true' || /disabled/i.test(b.className || '');

  /** 라벨 후보 버튼이 '활성'으로 나타날 때까지 폴링(비활성이면 빈곳 클릭으로 단계 진행 재유도) */
  async function waitEnabledButton(labels, timeout = 5000) {
    const t0 = Date.now();
    for (;;) {
      const b = findClickableByTextAny(labels);
      if (b && !isBtnDisabled(b)) return b;
      clickEmptyArea();
      if (Date.now() - t0 > timeout) return null;
      await sleep(350);
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s/g, '').toLowerCase();

  /** 합성 .click()이 안 먹는 요소에 실제 마우스 이벤트 시퀀스를 발생 */
  function realClick(el) {
    if (!el) return false;
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) => {
      try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (e) { /* noop */ }
    });
    return true;
  }

  const isVisible = (el) => !!(el && (el.offsetParent !== null || el.getClientRects().length));

  /** 보이는 요소 중 텍스트가 정확히 일치하는 클릭 대상 찾기(버튼/링크 우선, div도 폴백) */
  function findClickableByText(txt) {
    for (const b of document.querySelectorAll("button, a, [role='button'], input[type=button], input[type=submit]")) {
      if (((b.textContent || b.value || '').trim()) === txt && isVisible(b)) return b;
    }
    for (const e of document.querySelectorAll('*')) {
      if (e.children.length === 0 && (e.textContent || '').trim() === txt && isVisible(e)) {
        return e.closest("button, a, [role='button']") || e;
      }
    }
    return null;
  }

  /** selector가 나타날 때까지 폴링 */
  function waitFor(doc, selector, timeout = 6000, interval = 150) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        let el = null;
        try { el = doc.querySelector(selector); } catch (e) { /* noop */ }
        if (el) return resolve(el);
        if (Date.now() - t0 > timeout) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  /** 화면 우하단 토스트 */
  function toast(msg, ok = true) {
    let box = document.getElementById('mo-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'mo-toast';
      box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:340px;' +
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

  /** 괄호 안 내용이 (삭제 대상인) 동/리 지명 또는 건물명처럼 보이는가 */
  function looksLikePlaceOrBuilding(s) {
    const t = (s || '').trim();
    if (!t) return false;
    const toks = t.split(/[,\s]+/).filter(Boolean);
    if (toks.some((tk) => /[가-힣](동|리|읍|면|가)$/.test(tk))) return true;
    return BLD_KW.some((kw) => t.includes(kw));
  }

  /** 상세주소 정리 — 괄호 안 동/건물명 삭제, 단 고객이 직접 넣은 괄호는 유지
   *  (musinsa_order.py _clean_detail_address / SSG·무신사 스크립트와 동일 규칙) */
  function cleanDetailAddress(detail) {
    const raw = (detail || '').trim();
    if (!raw) return '';
    // 괄호 안이 법정동/건물명이면 위치 무관 삭제. 지명·건물 키워드 없는 고객 메모는 보존.
    return raw.replace(/\([^)]*\)/g, (m) =>
      looksLikePlaceOrBuilding(m.slice(1, -1).trim()) ? '' : m
    ).replace(/\s{2,}/g, ' ').trim();
  }

  /** 입력용 상세주소 — 비어 있으면 '-' (상세주소가 비면 다음 단계로 못 넘어가 흐름이 멈춤) */
  const detailOrDash = (o) => cleanDetailAddress(o.상세주소) || '-';

  // ── 1) 더망고: 주문정보에서 배송지 자동 담기 (무신사/SSG와 동일) ──────────────
  /** 라벨 텍스트가 일치하는 칸의 같은 행/다음 칸 input 값을 찾는다(필드명 모를 때 폴백). */
  function labelValue(labelTexts) {
    for (const el of document.querySelectorAll('td,th,label,b,strong,span,div')) {
      const t = (el.textContent || '').trim();
      if (!labelTexts.includes(t)) continue;
      const tr = el.closest('tr');
      if (tr) {
        const inp = tr.querySelector("input[type='text'],input[type='tel'],input:not([type]),textarea");
        if (inp && (inp.value || '').trim()) return inp.value.trim();
      }
      const td = el.closest('td');
      if (td && td.nextElementSibling) {
        const inp2 = td.nextElementSibling.querySelector('input,textarea');
        if (inp2 && (inp2.value || '').trim()) return inp2.value.trim();
      }
    }
    return '';
  }

  function captureFromCafe24() {
    if (!/admin_order_view\.php/i.test(location.href)) return; // 주문정보 페이지에서만
    const val = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.value || '').trim() : '';
    };
    let memo = '';
    const labels = document.querySelectorAll('td,th,div,span,b,strong,label');
    for (const el of labels) {
      const t = (el.textContent || '').trim();
      if (t === '배송요청사항' || t === '배송 요청사항') {
        const sib = el.nextElementSibling;
        if (sib && (sib.textContent || '').trim()) { memo = sib.textContent.trim(); break; }
        const td = el.closest('td');
        if (td && td.nextElementSibling && (td.nextElementSibling.textContent || '').trim()) {
          memo = td.nextElementSibling.textContent.trim(); break;
        }
      }
    }
    const order = {
      수령인: val("input[name='buyer_name3']") || labelValue(['수령인', '수령인명', '받는분']),
      연락처: val("input[name='buyer_tel4']") || labelValue(['연락처', '휴대폰', '휴대폰번호', '핸드폰']),
      우편번호: val("input[name='zipcode']") || labelValue(['우편번호']),
      주소: val("input[name='addr1']") || labelValue(['주소']),
      상세주소: val("input[name='addr2']") || labelValue(['상세주소']),
      배송메모: memo,
      담은시각: new Date().toLocaleString('ko-KR'),
    };
    if (order.수령인 || order.주소) {
      GM_setValue(STORE_KEY, JSON.stringify(order));
      showCafe24Badge(order);
    } else {
      const found = [];
      for (const inp of document.querySelectorAll('input[type=text],input[type=tel],input:not([type]),textarea')) {
        const v = (inp.value || '').trim();
        if (v && v.length < 40) found.push(`${inp.name || '(no-name)'} = ${v}`);
      }
      showCafe24Diag(found.slice(0, 14));
    }
  }

  function showCafe24Diag(lines) {
    let b = document.getElementById('mo-badge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'mo-badge';
      b.style.cssText = 'position:fixed;z-index:2147483647;right:14px;top:14px;padding:10px 14px;' +
        'border-radius:10px;color:#fff;font:11px/1.45 ui-monospace,monospace;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:360px;white-space:pre-wrap';
      document.body.appendChild(b);
    }
    b.style.background = '#b4232a';
    b.textContent = '⚠ 주소 필드 자동인식 실패 — 아래 입력칸 이름을 알려주세요:\n\n' + (lines.join('\n') || '(비어있지 않은 입력칸 없음)');
  }

  function showCafe24Badge(order) {
    let b = document.getElementById('mo-badge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'mo-badge';
      b.style.cssText = 'position:fixed;z-index:2147483647;right:14px;bottom:14px;' +
        'border-radius:10px;background:#1f7a3d;color:#fff;font:12px/1.5 -apple-system,sans-serif;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:340px;white-space:pre-wrap;cursor:pointer';
      document.body.appendChild(b);
    }
    const full = `✓ 주소 담김 (네이버에서 Alt+A / Alt+D 진단)\n${order.수령인} · ${order.우편번호}\n${order.주소}\n${cleanDetailAddress(order.상세주소)}\n(클릭하면 접힘/펼침)`;
    const mini = `✓ 담김: ${order.수령인}`;
    const setFull = () => { b.textContent = full; b.style.padding = '10px 14px'; b.style.opacity = '1'; b._mini = false; };
    const setMini = () => { b.textContent = mini; b.style.padding = '5px 10px'; b.style.opacity = '0.8'; b._mini = true; };
    setFull();
    clearTimeout(b._t);
    b._t = setTimeout(setMini, 4000);
    b.onclick = () => { clearTimeout(b._t); b._mini ? setFull() : setMini(); };
  }

  // ── 2) 네이버: 진단 모드 (Alt+D) — 배송지 폼 셀렉터·주소검색 방식 덤프 ─────────
  /** 동일 출처 프레임들을 모아 각 document에서 폼 요소를 수집 */
  function collectDocs() {
    const out = [{ doc: document, label: 'top/this' }];
    try {
      for (const f of window.top.frames) {
        try { if (f.document && f.document !== document) out.push({ doc: f.document, label: 'iframe ' + (f.frameElement && f.frameElement.src || '') }); } catch (e) { /* cross-origin */ }
      }
    } catch (e) { /* noop */ }
    return out;
  }

  function dumpNaverForm() {
    const lines = [];
    const add = (s) => lines.push(s);
    add('===== 네이버페이 배송지 폼 진단 =====');
    add('url: ' + location.href);
    add('top? ' + (window.top === window));
    add('');

    // iframe 목록 (주소검색이 iframe/팝업인지 판별의 핵심)
    const ifr = document.querySelectorAll('iframe');
    add('[iframes] ' + ifr.length + '개');
    ifr.forEach((f, i) => add(`  iframe#${i} src=${f.src || '(없음)'} id=${f.id || ''} name=${f.name || ''}`));
    add('');

    collectDocs().forEach(({ doc, label }) => {
      add('───── document: ' + label + ' ─────');
      // 입력칸
      const inputs = doc.querySelectorAll("input[type=text],input[type=tel],input[type=search],input:not([type]),textarea,select");
      add('[inputs] ' + inputs.length + '개');
      inputs.forEach((el) => {
        const tag = el.tagName.toLowerCase();
        const v = (el.value || '').trim();
        add(`  <${tag}> name=${el.name || ''} id=${el.id || ''} ph="${el.placeholder || ''}" ${v ? 'val(len=' + v.length + ')' : ''}`);
      });
      // 버튼/링크 중 주소·우편·검색·배송 관련만
      const btns = doc.querySelectorAll("button,a,[role='button'],input[type=button],input[type=submit]");
      const KW = /우편|주소|검색|배송지|찾기|추가|변경|등록|받는|수령|신규/;
      const hits = [];
      btns.forEach((b) => {
        const t = ((b.textContent || b.value || '').trim()).replace(/\s+/g, ' ');
        if (t && KW.test(t) && t.length < 24) hits.push(`  [btn] "${t}" id=${b.id || ''} class=${(b.className || '').toString().slice(0, 40)}`);
      });
      add('[buttons(주소/우편/배송 관련)] ' + hits.length + '개');
      hits.slice(0, 30).forEach(add);
      // 전체 버튼(라벨+클래스) — 저장/등록/선택/적용 등 KW에 안 걸리는 버튼 파악용
      const allBtns = [];
      btns.forEach((b) => {
        const t = ((b.textContent || b.value || '').trim()).replace(/\s+/g, ' ');
        if (t && t.length < 24) allBtns.push(`  [btn] "${t}" class=${(b.className || '').toString().slice(0, 46)}`);
      });
      add('[all buttons] ' + allBtns.length + '개');
      allBtns.slice(0, 40).forEach(add);
      // 주소처럼 보이는 결과행 후보 (주소검색 결과 DOM 파악용)
      const rows = [];
      doc.querySelectorAll("li, a, tr, p, span, div").forEach((el) => {
        if (el.children.length > 3) return; // 컨테이너 제외, 말단 위주
        const t = ((el.textContent || '').trim()).replace(/\s+/g, ' ');
        if (t && t.length < 70 && /(로|길)\s*\d|[가-힣]+(시|군|구)\s/.test(t)) {
          rows.push(`  <${el.tagName.toLowerCase()}> class=${(el.className || '').toString().slice(0, 45)} "${t.slice(0, 55)}"`);
        }
      });
      add('[주소형 결과행 후보] ' + rows.length + '개');
      rows.slice(0, 25).forEach(add);
      // 결과행 outerHTML(클릭 핸들러 파악용) — 우편번호 5자리 포함 tr/li 앞 3개
      const htmlRows = [...doc.querySelectorAll('tr, li')].filter((r) => /\d{5}/.test(r.textContent || '')).slice(0, 3);
      add('[결과행 outerHTML] ' + htmlRows.length + '개');
      htmlRows.forEach((r) => add('  ' + (r.outerHTML || '').replace(/\s+/g, ' ').slice(0, 320)));
      add('');
    });

    showNaverDiagPanel(lines.join('\n'));
    console.log('[mango_order][NAVER-DIAG]\n' + lines.join('\n'));
  }

  /** 덤프 결과를 복사 가능한 textarea 패널로 표시 */
  function showNaverDiagPanel(text) {
    let wrap = document.getElementById('mo-diag');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'mo-diag';
      wrap.style.cssText = 'position:fixed;z-index:2147483647;right:14px;top:14px;width:420px;max-height:70vh;' +
        'display:flex;flex-direction:column;background:#111;color:#fff;border-radius:10px;padding:10px;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.4);font:12px/1.4 -apple-system,sans-serif';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px';
      head.innerHTML = '<b>네이버페이 폼 진단 — 전체 선택해 복사</b>';
      const close = document.createElement('span');
      close.textContent = '✕';
      close.style.cssText = 'cursor:pointer;padding:0 6px';
      close.onclick = () => wrap.remove();
      head.appendChild(close);
      const ta = document.createElement('textarea');
      ta.id = 'mo-diag-ta';
      ta.style.cssText = 'flex:1;min-height:300px;width:100%;box-sizing:border-box;background:#000;color:#0f0;' +
        'border:1px solid #333;border-radius:6px;font:11px/1.4 ui-monospace,monospace;resize:vertical;padding:8px';
      wrap.appendChild(head);
      wrap.appendChild(ta);
      document.body.appendChild(wrap);
    }
    const ta = document.getElementById('mo-diag-ta');
    ta.value = text;
    ta.focus();
    ta.select();
  }

  // ── 3) 네이버: Alt+A 로 배송지 신규입력 → 저장 → 목록선택 (v0.2) ─────────────
  // 네이버페이 /order/delivery 는 SPA(같은 URL에서 뷰 전환, iframe 없음).
  // ⚠️ 순서: [목록]'배송지 신규입력' → [주소검색]먼저 뜸 → 검색·도로명 선택 →
  //         [폼]#receiver/#contact-1/#address-detail 등장 → 입력 → '저장' → [목록]선택.

  /** 주소검색: (필요 시 열고) 검색어 입력·검색 → 도로명 결과 선택 → 입력 폼 등장 대기 */
  async function naverAddressSearch(o) {
    // 주소검색 화면이 아직 아니면 '주소검색' 버튼으로 연다(폼에서 주소만 다시 잡을 때)
    let inp = Q("input[placeholder*='도로명']");
    if (!inp) {
      const openBtn = findClickableByText('주소검색');
      if (openBtn) { realClick(openBtn); try { openBtn.click(); } catch (e) { /* noop */ } }
      inp = await waitFor(document, "input[placeholder*='도로명']", 6000);
    }
    if (!inp) return false;

    const kw = searchKeyword(o.주소);
    inp.focus();
    setNativeValue(inp, kw);
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    const searchBtn = findClickableByText('검색');
    if (searchBtn) { realClick(searchBtn); try { searchBtn.click(); } catch (e) { /* noop */ } }

    const got = await waitFor(document, 'li.AddressSearchList_item__wuxp8', 8000);
    if (!got) return false;
    await sleep(300);

    // 결과 중 '도로명/지번+번호'가 경계까지 정확히 일치하는 항목만 후보로 (42 ≠ 42-8/420).
    // ⚠️ 일치 항목이 없으면 선택하지 않고 실패 반환 — 엉뚱한 첫 결과가 입력되는 것 방지.
    const parts = addrParts(o.주소);
    const hint = buildingHint(o.상세주소);
    const wantZip = (o.우편번호 || '').replace(/\D/g, '');
    const items = [...document.querySelectorAll('li.AddressSearchList_item__wuxp8')];
    // ⚠️ 매칭은 li 전체가 아닌 주소 줄(<p>) 단위로 — li 텍스트는 우편번호 등 숫자가 주소 뒤에 붙어
    //    공백 제거 후 번호 경계 검사가 실패할 수 있다(무신사 카카오 새 UI와 동일 함정). p 없으면 구 동작.
    const liAddrLines = (li) => { const ps = li.querySelectorAll('p'); return ps.length ? [...ps].map((p) => p.textContent) : [li.textContent]; };
    const matched = items.filter((li) => liAddrLines(li).some((t) => matchesAddr(t, parts)));
    if (!matched.length) {
      console.warn('[mango_order][naver] 일치하는 검색 결과 없음 — 검색어:', kw,
        '\n후보:', items.map((li) => (li.textContent || '').slice(0, 60)));
      return false;
    }
    // 일치가 여럿이면 상세주소의 건물명·우편번호가 보이는 항목 우선
    const score = (li) => {
      const t = norm(li.textContent);
      return (hint && t.includes(hint) ? 2 : 0) + (wantZip && t.includes(wantZip) ? 1 : 0);
    };
    matched.sort((a, b) => score(b) - score(a));
    const pick = matched[0];
    // 결과행의 '선택' 버튼을 누른다(주소 텍스트 클릭이 아님). 없으면 주소 텍스트로 폴백.
    let sel = [...pick.querySelectorAll("button, a, [role='button']")].find((b) => (b.textContent || '').trim() === '선택');
    if (!sel) sel = findClickableByText('선택');
    const target = sel || pick.querySelector('p.AddressSearchList_address__4OJzp') || pick;
    realClick(target);
    try { target.click(); } catch (e) { /* noop */ }

    // 도로명 선택 후 '상세주소를 알려주세요'(#address-detail) 단계 등장 대기
    return !!(await waitFor(document, '#address-detail', 8000));
  }

  /** 저장 후 목록(배송지 목록)에서 방금 추가한 주소(이름+우편번호)의 '선택' 버튼 클릭 */
  async function selectNaverInList(o) {
    const list = await waitFor(document, 'li.DeliveryList_item__RmUJU', 8000);
    if (!list) { toast('저장됨. 목록에서 방금 배송지를 직접 선택하세요.', false); return; }
    await sleep(400);

    const nName = norm(o.수령인);
    const wantZip = (o.우편번호 || '').replace(/\D/g, '');
    const detail = norm(cleanDetailAddress(o.상세주소));
    const items = [...document.querySelectorAll('li.DeliveryList_item__RmUJU')];
    // 이름+우편번호 일치 항목들 중 상세주소까지 맞는 걸 우선(중복 구분). '선택됨' 여부는 무관.
    const matches = items.filter((li) => {
      const t = li.textContent || '';
      return norm(t).includes(nName) && (!wantZip || t.includes(wantZip));
    });
    const match = (detail && matches.find((li) => norm(li.textContent || '').includes(detail))) || matches[0];

    if (!match) { toast(`목록에서 ${o.수령인} 자동선택 실패 — 직접 '선택'하세요.`, false); return; }

    // 이미 '선택됨'이면 = 주문 배송지로 적용된 상태 → 창만 닫고 종료
    if (/선택됨/.test(match.textContent || '')) {
      const closeBtn = findClickableByText('창닫기');
      if (closeBtn) { realClick(closeBtn); try { closeBtn.click(); } catch (e) { /* noop */ } }
      toast(`배송지 적용 완료(이미 선택됨): ${o.수령인}\n금액·주소 확인 후 직접 결제.`);
      return;
    }

    // 항목 내 '선택' 버튼 클릭(적용+창닫힘)
    const pickBtn = [...match.querySelectorAll("button, a, [role='button']")].find((b) => (b.textContent || '').trim() === '선택');
    if (!pickBtn) {
      const area = match.querySelector('.DeliveryList_section-address__2hVS_') || match;
      realClick(area); try { area.click(); } catch (e) { /* noop */ }
      toast(`${o.수령인} 항목의 '선택' 버튼을 못 찾았어요 — 직접 눌러주세요.`, false);
      return;
    }
    realClick(pickBtn);
    try { pickBtn.click(); } catch (e) { /* noop */ }
    toast(`배송지 적용: ${o.수령인}\n금액·주소 확인 후 직접 결제.`);
  }

  async function runNaverFlow() {
    const raw = GM_getValue(STORE_KEY, '');
    if (!raw) { toast('담긴 주문이 없어요.\n더망고 주문정보를 먼저 여세요.', false); return; }
    const o = JSON.parse(raw);

    // 0) 주소가 '…동'으로 끝나는 불완전 주소면 상세주소의 도로명/번지로 보완. 못 하면 중단(오주소 입력 방지).
    const fx = fixIncompleteAddr(o);
    if (!fx.ok) { toast(`주소가 불완전해요(번지/도로명 없음): ${o.주소}\n상세주소에서도 못 찾아 중단 — 직접 입력하세요.`, false); return; }
    if (fx.fixed) toast(`불완전 주소 보완 검색: ${o.주소}`);

    // 1) 주소가 선택된 단계(#address-detail 존재)에 도달시킨다.
    //    네이버: '배송지 신규입력' → 주소검색 → 도로명 선택 → ⓑ'상세주소를 알려주세요'(#address-detail).
    if (!Q('#address-detail')) {
      if (!Q("input[placeholder*='도로명']")) {
        const newBtn = findClickableByText('배송지 신규입력');
        if (newBtn) { realClick(newBtn); try { newBtn.click(); } catch (e) { /* noop */ } }
        if (!await waitFor(document, "input[placeholder*='도로명']", 6000)) {
          toast("주소검색 화면을 못 열었어요.\n'배송지 신규입력'을 누른 뒤 Alt+A.", false);
          return;
        }
      }
      if (!await naverAddressSearch(o)) {
        toast('주소 자동검색 실패 — 직접 검색·선택한 뒤 다시 Alt+A.', false);
        return;
      }
    } else if (Q('#receiver')) {
      // 이미 수령인 폼인데 주소가 안 잡혔으면 주소검색만 다시 진행
      const addrBox = Q('.InputDeliveryAddress_address__P__9H');
      if ((!addrBox || !hasZip(addrBox.textContent)) && !await naverAddressSearch(o)) {
        setNativeValue(Q('#address-detail'), detailOrDash(o));
        toast('주소 자동검색 실패 — 주소검색에서 직접 선택 후 저장하세요.\n(상세주소는 채워둠)', false);
        return;
      }
    }

    // 2) 상세주소 입력 (ⓑ'상세주소를 알려주세요') — 필드를 실제 클릭('누르고')한 뒤 타이핑+commit.
    //    ⚠️ ⓒ폼에선 절대 상세주소를 건드리지 않는다 — 여기 ⓑ에서만 입력해야 인식된다.
    const dtB = await waitFor(document, '#address-detail', 4000);
    if (dtB) {
      realClick(dtB);
      await typeReact(dtB, detailOrDash(o), true);
      dtB.dispatchEvent(new Event('blur', { bubbles: true })); // 확인 전 commit 유도
      await sleep(300);
    }

    // 3) ⓑ단계(=수령인 폼 아직 없음, '확인'으로 넘어감)면 확인 → ⓒ수령인 폼 등장
    if (!Q('#receiver')) {
      await sleep(250); // 입력 이벤트가 '확인' 활성화에 반영될 시간
      const okBtn = findClickableByText('확인');
      if (okBtn) { realClick(okBtn); try { okBtn.click(); } catch (e) { /* noop */ } }
      if (!await waitFor(document, '#receiver', 8000)) {
        toast("'확인' 후 수령인 폼을 못 찾았어요.\n직접 진행 후 다시 Alt+A.", false);
        return;
      }
    }

    // 4) ⓒ수령인 폼 — 네이버는 '빈곳 클릭'마다 다음 단계가 떠서 필드마다 클릭+입력+빈곳클릭
    await naverFillForm(o);
    toast(`입력 완료: ${o.수령인}\n'저장하기' 활성화 대기 중…`);

    // 5) '저장하기'가 활성화되면 클릭 (라벨은 '저장하기')
    const saveBtn = await waitEnabledButton(['저장하기', '저장', '등록하기', '등록'], 6000);
    if (!saveBtn) {
      toast("'저장하기'가 아직 비활성이에요.\n연락처(안심번호 0507 등) 형식 때문일 수 있어요 — 확인 후 직접 저장.", false);
      return;
    }
    realClick(saveBtn);
    try { saveBtn.click(); } catch (e) { /* noop */ }

    // 6) 저장 후 목록에서 방금 주소 선택·적용
    await selectNaverInList(o);
  }

  // ── 주문 페이지(/ordersheet): 배송메모 = 더망고 배송요청사항 ──────────────────
  // 흐름: '배송메모를 선택해주세요' 드롭다운 → 모달 '직접 입력하기' → textarea 입력.
  async function fillNaverMemo() {
    const raw = GM_getValue(STORE_KEY, '');
    if (!raw) { toast('담긴 주문이 없어요.\n더망고 주문정보를 먼저 여세요.', false); return; }
    const o = JSON.parse(raw);
    const memo = (o.배송메모 || '').trim();
    if (!memo) { toast('배송요청사항이 없어 건너뜁니다.\n(필요하면 직접 선택하세요)'); return; }

    // 1) '배송메모를 선택해주세요' 드롭다운 열기
    //    ('출입방법을 설정할 수 있어요'가 있으면 라벨이 '추가 요청사항…'으로 뜬다 — 출입방법은 무시하고 진행)
    const opener = findByTextContains(/배송메모를 선택해주세요|배송메모|추가\s*요청사항/) || findClickableByText('배송메모를 선택해주세요');
    if (!opener) { toast("'배송메모' 칸을 못 찾았어요 — 직접 선택하세요.", false); return; }
    realClick(opener); try { opener.click(); } catch (e) { /* noop */ }

    // 2) 모달에서 '직접 입력하기' (모달에 따라 '직접 입력' 등 변형 라벨 폴백)
    let direct = await waitForText('직접 입력하기', 4000);
    if (!direct) direct = findClickableByTextAny(['직접입력하기', '직접 입력', '직접입력']);
    if (!direct) { toast("'직접 입력하기'를 못 찾았어요 — 직접 선택하세요.", false); return; }
    realClick(direct); try { direct.click(); } catch (e) { /* noop */ }

    // 3) textarea에 배송요청사항 입력 (React → typeReact: execCommand+onChange+onBlur)
    const ta = await waitFor(document, "textarea[placeholder*='입력해주세요'], textarea[placeholder*='입력']", 4000);
    if (!ta) { toast('메모 입력칸을 못 찾았어요 — 직접 입력하세요.', false); return; }
    realClick(ta);
    await typeReact(ta, memo);
    toast(`배송메모 입력 완료:\n${memo.slice(0, 30)}\n금액·주소 확인 후 직접 결제.`);
  }

  function showNaverBadge() {
    if (window.top !== window) return;
    if (/^\/authentication\//.test(location.pathname)) { // 결제 비밀번호/인증 페이지엔 배지 안 띄움
      const old = document.getElementById('mo-badge');
      if (old) old.remove();                             // SPA 이동 후 남은 배지 정리
      return;
    }
    const raw = GM_getValue(STORE_KEY, '');
    let b = document.getElementById('mo-badge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'mo-badge';
      b.style.cssText = 'position:fixed;z-index:2147483647;right:14px;bottom:14px;padding:9px 13px;' +
        'border-radius:10px;background:#222;color:#fff;font:12px/1.5 -apple-system,sans-serif;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:300px;white-space:pre-wrap';
      document.body.appendChild(b);
    }
    const who = raw ? `담긴 주문: ${JSON.parse(raw).수령인}\n` : '담긴 주문 없음\n';
    const what = /\/ordersheet/.test(location.pathname) ? 'Alt+A 배송메모 입력' : 'Alt+A 배송지 입력';
    b.textContent = who + what + ' · Alt+D 진단';
  }

  // ── 라우팅 ──────────────────────────────────────────────────────────────────
  const host = location.hostname;
  if (host.endsWith('cafe24.com')) {
    captureFromCafe24();
  } else if (host.endsWith('pay.naver.com')) {
    window.addEventListener('keydown', (e) => {
      if (!e.altKey) return;
      // Alt+A — 주문 페이지면 배송메모, 배송지 화면이면 배송지 입력
      if (e.key === 'a' || e.key === 'A' || e.code === 'KeyA') {
        e.preventDefault();
        if (/\/ordersheet/.test(location.pathname)) fillNaverMemo();
        else runNaverFlow();
      }
      // Alt+D — 네이버페이 폼 진단 덤프
      if (e.key === 'd' || e.key === 'D' || e.code === 'KeyD') {
        e.preventDefault();
        dumpNaverForm();
      }
    }, true);
    showNaverBadge();
    setInterval(showNaverBadge, 4000);
  }
})();
