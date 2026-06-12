// ==UserScript==
// @name         더망고 SSG 주소 진단 (Brave 전용)
// @namespace    mango_order
// @version      0.25.5
// @description  더망고 주문정보의 배송지를 담고, SSG '배송지 추가' 폼에서 Alt+A로 주소별칭 '직접입력' 전환→수령인·주소별칭·휴대폰(회사번호 고정)·상세주소 입력 + 우편번호 팝업 자동검색(괄호 제거·찾기 실행). 배송지 변경 후 결제화면 '택배배송 요청사항'에 배송메모 자동입력. 결제화면에서 Alt+A는 '주문자 정보 변경' 팝업을 열어 주문자명을 수령인명으로 교체. Alt+D는 폼 진단 덤프. ※ '새 배송지 추가'는 직접 누르고 폼에서 Alt+A. ※ Brave 브라우저에만 설치.
// @author       PA
// @match        https://tmg2533.cafe24.com/*
// @match        https://*.ssg.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/iopkl369-a11y/mango-userscripts/main/scripts/mango_order_ssg.user.js
// @downloadURL  https://raw.githubusercontent.com/iopkl369-a11y/mango-userscripts/main/scripts/mango_order_ssg.user.js
// ==/UserScript==

(function () {
  'use strict';

  // 실행 확인용 로그 (콘솔에서 '[mango_order]'로 검색)
  console.log('[mango_order][ssg] v0.25.5 loaded @', location.href, 'top=', window.top === window);

  // ── 정책 상수 ──────────────────────────────────────────────────────────────
  // 상세주소 괄호 안에서 '삭제 대상'으로 보는 건물/아파트 키워드 (musinsa_order.py _BLD_KW 동일)
  const BLD_KW = ['아파트', 'apt', '빌라', '빌딩', '빌', '타워', '맨션', '맨숀', '오피스텔',
    '하우스', '팰리스', '펠리스', '캐슬', '자이', '푸르지오', '래미안',
    '힐스테이트', '더샵', '메르디앙', '리슈빌', '쉐르빌', '코아루',
    '파라디아', '센트럴', '파크'];

  // SSG는 휴대폰을 회사 번호로 고정. 회사번호는 팀 설정값에서 읽는다(공개 코드엔 번호 없음).
  // "⚙ 망고설정"(mango_config)에서 1회 입력 → localStorage['mango_config'].companyPhone
  function companyPhone() {
    try { return JSON.parse(localStorage.getItem('mango_config') || '{}').companyPhone || ''; } catch (e) { return ''; }
  }

  const STORE_KEY = 'mo_order';            // 담긴 주문(배송지) JSON
  const PENDING_KEY = 'mo_pending_ssg';    // SSG 우편번호 팝업에 넘길 검색어 {kw}
  const APPLY_KEY = 'mo_ssg_apply';        // 배송지 목록에서 선택·변경할 대상 {name, zip, memo, ts}
  const MEMO_KEY = 'mo_ssg_memo';          // 결제화면 '택배배송 요청사항' 자동입력 대상 {memo, ts}
  const ORDERER_KEY = 'mo_ssg_orderer';    // 주문자정보 변경 팝업에서 주문자명을 교체할 대상 {name, ts}

  // ── 공통 유틸 ──────────────────────────────────────────────────────────────
  /** React/일반 입력에 값 주입 — 네이티브 setter + input/change 이벤트 */
  function setNativeValue(el, value) {
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value == null ? '' : String(value));
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

  /** SSG 우편번호 검색어 — 주소에서 괄호 '(금곡동, …아파트)'를 제거(있으면 검색 실패) */
  function ssgSearchKeyword(addr) {
    return (addr || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  /** address1이 번지/건물번호 없이 끝나는 불완전 주소인가 (네이버/무신사 스크립트와 동일)
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

  /** 주소의 검증용 핵심 토큰 — 도로명+건물번호 또는 동/리+번지. 없으면 null (네이버/무신사 스크립트와 동일) */
  function addrParts(addr) {
    const t = (addr || '').replace(/\s*\([^)]*\)\s*/g, ' ');
    let m = t.match(/(\S*(?:로|길))\s*(\d+(?:-\d+)?)(?=\s|$|,)/);
    if (m) return { key: m[1], num: m[2] };
    m = t.match(/(\S*[가-힣]\d*(?:동|리|읍|면|가))\s*((?:산\s*)?\d+(?:-\d+)?)(?=\s|$|,)/);
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
      .find((s) => s && !/[가-힣]\d*(동|리|읍|면|가)$/.test(s));
    return tok ? norm(tok) : '';
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
    // 쉼표/공백으로 쪼갠 토큰 중 '한글(+숫자)+동/리/읍/면/가'로 끝나는 행정동명이 있으면 삭제 대상('문래동6가' 포함).
    // (아파트 '102동'처럼 숫자로 시작하는 동은 제외해 보존 — 네이버/무신사 스크립트와 동일 규칙)
    const toks = t.split(/[,\s]+/).filter(Boolean);
    if (toks.some((tk) => /[가-힣]\d*(동|리|읍|면|가)$/.test(tk))) return true;
    return BLD_KW.some((kw) => t.includes(kw));
  }

  /** 상세주소 정리 — 괄호 안 동/건물명 삭제, 단 고객이 직접 넣은 괄호는 유지 */
  function cleanDetailAddress(detail) {
    const raw = (detail || '').trim();
    if (!raw) return '';
    // 괄호 안이 법정동/건물명이면 위치 무관 삭제. 지명·건물 키워드 없는 고객 메모는 보존.
    return raw.replace(/\([^)]*\)/g, (m) =>
      looksLikePlaceOrBuilding(m.slice(1, -1).trim()) ? '' : m
    ).replace(/\s{2,}/g, ' ').trim();
  }

  // ── 1) 더망고: 주문정보에서 배송지 자동 담기 ─────────────────────────────────
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
    const full = `✓ 주소 담김 (SSG에서 Alt+D 진단)\n${order.수령인} · ${order.우편번호}\n${order.주소}\n${cleanDetailAddress(order.상세주소)}\n(클릭하면 접힘/펼침)`;
    const mini = `✓ 담김: ${order.수령인}`;
    const setFull = () => { b.textContent = full; b.style.padding = '10px 14px'; b.style.opacity = '1'; b._mini = false; };
    const setMini = () => { b.textContent = mini; b.style.padding = '5px 10px'; b.style.opacity = '0.8'; b._mini = true; };
    setFull();
    clearTimeout(b._t);
    b._t = setTimeout(setMini, 4000);
    b.onclick = () => { clearTimeout(b._t); b._mini ? setFull() : setMini(); };
  }

  // ── 2) SSG: 진단 모드 (Alt+D) — 배송지 폼 셀렉터·우편번호 검색 방식 덤프 ────────
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

  function dumpSsgForm() {
    const lines = [];
    const add = (s) => lines.push(s);
    add('===== SSG 배송지 폼 진단 =====');
    add('url: ' + location.href);
    add('top? ' + (window.top === window));
    add('');

    // iframe 목록 (우편번호 검색이 iframe/팝업인지 판별의 핵심)
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
      const KW = /우편|주소|검색|배송지|찾기|추가|변경|등록|받는|수령/;
      const hits = [];
      btns.forEach((b) => {
        const t = ((b.textContent || b.value || '').trim()).replace(/\s+/g, ' ');
        if (t && KW.test(t) && t.length < 24) hits.push(`  [btn] "${t}" id=${b.id || ''} class=${(b.className || '').toString().slice(0, 40)}`);
      });
      add('[buttons(주소/우편/배송 관련)] ' + hits.length + '개');
      hits.slice(0, 30).forEach(add);
      // 주소처럼 보이는 결과행 후보 (우편번호 검색 결과 DOM 파악용)
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
      // 결과행 outerHTML(클릭 핸들러 파악용) — 우편번호 5자리 포함 tr 앞 3개
      const htmlRows = [...doc.querySelectorAll('tr')].filter((tr) => /\d{5}/.test(tr.textContent || '')).slice(0, 3);
      add('[결과행 outerHTML] ' + htmlRows.length + '개');
      htmlRows.forEach((tr) => add('  ' + (tr.outerHTML || '').replace(/\s+/g, ' ').slice(0, 320)));
      add('');
    });

    showSsgDiagPanel(lines.join('\n'));
    console.log('[mango_order][SSG-DIAG]\n' + lines.join('\n'));
  }

  /** 덤프 결과를 복사 가능한 textarea 패널로 표시 */
  function showSsgDiagPanel(text) {
    let wrap = document.getElementById('mo-diag');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'mo-diag';
      wrap.style.cssText = 'position:fixed;z-index:2147483647;right:14px;top:14px;width:420px;max-height:70vh;' +
        'display:flex;flex-direction:column;background:#111;color:#fff;border-radius:10px;padding:10px;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.4);font:12px/1.4 -apple-system,sans-serif';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px';
      head.innerHTML = '<b>SSG 폼 진단 — 전체 선택해 복사</b>';
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

  // ── 3) SSG: Alt+A 로 배송지 폼 채우기 ───────────────────────────────────────
  /** 배송지 입력 폼(shpplocForm)에 수령인·휴대폰·상세주소 입력 + 우편번호 검색어 준비 */
  async function fillSsgForm() {
    const raw = GM_getValue(STORE_KEY, '');
    if (!raw) { toast('담긴 주문이 없어요.\n더망고 주문정보를 먼저 여세요.', false); return; }
    const o = JSON.parse(raw);

    // 주소가 '…동'으로 끝나는 불완전 주소면 상세주소의 도로명/번지로 보완. 못 하면 중단(오주소 입력 방지).
    const fx = fixIncompleteAddr(o);
    if (!fx.ok) { toast(`주소가 불완전해요(번지/도로명 없음): ${o.주소}\n상세주소에서도 못 찾아 중단 — 직접 입력하세요.`, false); return; }
    if (fx.fixed) {
      GM_setValue(STORE_KEY, JSON.stringify(o)); // 우편번호 팝업(runSsgZipcd)이 STORE를 다시 읽으므로 보완 결과를 저장
      toast(`불완전 주소 보완 검색: ${o.주소}`);
    }

    const nameEl = document.querySelector('#rcptpeNm');
    if (!nameEl) {
      toast("배송지 입력 폼이 안 보여요.\n'새 배송지 추가'를 누른 폼에서 Alt+A.", false);
      return;
    }

    // ── 우편번호 팝업 먼저 열기 (반드시 await 이전!) ──
    // SSG 우편번호 검색은 window.open류라 Alt+A '키 제스처'가 살아있는 동안만 열린다.
    // 아래 '직접입력' await(sleep) 뒤로 미루면 제스처가 풀려 팝업이 차단되므로, 검색어 저장과 팝업 열기를 여기서 먼저 한다.
    const kw = ssgSearchKeyword(o.주소);
    GM_setValue(PENDING_KEY, JSON.stringify({ kw: kw, ts: Date.now() }));
    // 배송지 목록(shpplocList)에서 선택·변경할 대상 — 이름+우편번호로 매칭. 배송메모는 결제화면 자동입력용으로 함께 실어 보냄.
    GM_setValue(APPLY_KEY, JSON.stringify({ name: o.수령인, zip: o.우편번호, memo: o.배송메모 || '', ts: Date.now() }));
    openSsgZipPopup();

    // 주소 별칭을 '직접입력' 모드로 전환 — 기본값이 '우리집'이라 별칭칸이 고정/비활성이므로
    // 먼저 '직접입력' 토글을 눌러야 수령인 이름을 별칭으로 넣을 수 있다.
    const aliasDirectBtn = findClickableByText('직접입력');
    if (aliasDirectBtn) {
      realClick(aliasDirectBtn);
      try { aliasDirectBtn.click(); } catch (e) { /* noop */ }
      await sleep(200); // 별칭 입력칸 활성화 대기
    }

    setNativeValue(nameEl, o.수령인);
    // 주소 별칭에도 수령인 이름 (SSG 요구)
    setNativeValue(document.querySelector('#address_alias'), o.수령인);

    // 휴대폰: SSG는 항상 회사번호로 고정. 회사번호 미설정 시 건너뜀(빈 값 입력 방지)
    const cp = companyPhone();
    if (cp) {
      setSelectValue(document.querySelector('#hpno1'), cp.slice(0, 3));
      setNativeValue(document.querySelector('#hpno2'), cp.slice(3));
    } else {
      console.warn('[mango_order][ssg] 회사번호 미설정 — ⚙ 망고설정에서 companyPhone 입력 필요');
    }

    // 상세주소(괄호 정리) — 805동 901호 등. 비어 있으면 '-' (빈 값이면 저장 진행이 멈춤)
    setNativeValue(document.querySelector('#address_detail'), cleanDetailAddress(o.상세주소) || '-');

    toast(`입력 완료: ${o.수령인}\n우편번호 검색→선택→저장 자동 진행 중…`);

    // 팝업이 폼에 우편번호를 채워 돌아오면 폼 '저장' 클릭
    awaitSsgFormSave();
  }

  /** 우편번호 팝업이 폼에 우편번호를 반환하면 폼 '저장'을 누른다(같은 창에서 폴링) */
  async function awaitSsgFormSave() {
    const zipEl = document.querySelector('#address_zipcode');
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      if (zipEl && /\d{5}/.test(zipEl.value || '')) {
        await sleep(500); // 도로명/상세까지 반영될 시간
        const saveBtn = findClickableByText('저장');
        if (saveBtn) {
          // 저장은 '한 번만' 눌러야 한다 — realClick(마우스 시퀀스 click)+.click()+onclick을 함께 호출하면
          // SSG가 각 click을 개별 저장 요청으로 처리해 같은 배송지가 2건씩 등록된다(중복 저장).
          try { saveBtn.click(); } catch (e) { realClick(saveBtn); }
          toast('배송지 저장 → 목록에서 자동 선택·변경');
          return;
        }
      }
      await sleep(400);
    }
  }

  /** 폼의 '우편번호 검색' 돋보기/칸을 눌러 검색 팝업을 연다 (best-effort).
   *  SSG가 window.open류로 띄우므로 반드시 Alt+A '키 제스처 안에서'(await 이전) 호출해야 팝업 차단을 피한다. */
  function openSsgZipPopup() {
    const zip = document.querySelector('#address_zipcode');
    if (!zip) return false;
    const tryClick = (el) => { if (el) { try { el.click(); return true; } catch (e) { /* noop */ } } return false; };
    // 같은 래퍼(부모) 안의 버튼/링크(돋보기 아이콘)를 우선 클릭
    const parent = zip.parentElement;
    const icon = parent ? parent.querySelector("button, a, [role='button']") : null;
    return tryClick(icon) || tryClick(zip.nextElementSibling) || tryClick(zip);
  }

  // ── 4) SSG 우편번호 팝업(zipcd) 상태머신: 검색 → 결과선택 → 상세입력+저장 ──────
  // 같은 URL에서 화면이 단계별로 바뀌므로(새로고침 없음) 폴링으로 단계 감지.
  async function runSsgZipcd() {
    const raw = GM_getValue(PENDING_KEY, '');
    if (!raw) return;
    let pend;
    try { pend = JSON.parse(raw); } catch (e) { return; }
    if (!pend || !pend.kw) return;

    const order = JSON.parse(GM_getValue(STORE_KEY, '') || '{}');
    const detail = cleanDetailAddress(order.상세주소) || '-'; // 비어 있으면 '-' (빈 값이면 저장 진행이 멈춤)
    const parts = addrParts(pend.kw);
    const hint = buildingHint(order.상세주소);

    await waitFor(document, "input[name='searchKeyword']", 5000);

    const t0 = Date.now();
    let searched = false;
    let noMatchTicks = 0;
    while (Date.now() - t0 < 20000) {
      // Phase 3: 주소 선택됨 → 상세주소 입력 + '저장'
      const dtl = document.querySelector('#addrDtlInput');
      if (dtl && isVisible(dtl)) {
        if (detail && norm(dtl.value) !== norm(detail)) {
          dtl.focus();
          setNativeValue(dtl, detail);
          dtl.dispatchEvent(new Event('keyup', { bubbles: true }));
          await sleep(300); // '저장' 활성화 대기
        }
        const saveBtn = findClickableByText('저장');
        if (saveBtn) {
          try { saveBtn.click(); } catch (e) { realClick(saveBtn); } // 단일 클릭(중복 저장 방지)
          GM_setValue(PENDING_KEY, '');
          toast(`주소 저장 완료: ${pend.kw}\n${detail}`);
          return;
        }
      }

      // Phase 2: 검색 결과에서 '도로명/지번+번호'가 경계까지 정확히 일치하는 버튼만 클릭 (42 ≠ 42-8)
      //  결과행: <tr><th>도로명</th><td><button class=postcode_address_btn onclick="Zipcd.showZipcdDtl(this)">…</button></td><td>우편번호</td></tr>
      const addrBtns = [...document.querySelectorAll('button.postcode_address_btn')];
      const rowText = (b) => { const tr = b.closest('tr'); return tr ? tr.textContent || '' : ''; };
      // ⚠️ 매칭은 행 전체가 아닌 '주소 버튼' 텍스트로 — 행 텍스트는 주소 뒤에 우편번호 td가 붙어
      //    공백 제거 후 '…로167' + '57777'이 이어지면 번호 경계 검사가 실패한다(무신사 카카오 새 UI와 동일 함정).
      const matched = addrBtns.filter((b) => matchesAddr(b.textContent, parts));
      const btn = (hint && matched.find((b) => norm(rowText(b)).includes(hint))) || matched[0];
      if (btn) {
        // 인라인 onclick(Zipcd.showZipcdDtl) → 네이티브 click이 가장 확실, 안 되면 핸들러 직접 호출
        realClick(btn);
        try { btn.click(); } catch (e) { /* noop */ }
        try { if (typeof btn.onclick === 'function') btn.onclick.call(btn); } catch (e) { /* noop */ }
      } else if (addrBtns.length && ++noMatchTicks >= 4) {
        // ⚠️ 결과는 떴는데 일치 항목이 없으면 첫 결과를 누르지 않고 중단(오주소 입력 방지) — 사람이 직접 선택.
        GM_setValue(PENDING_KEY, '');
        toast(`일치하는 주소가 없어요 — 직접 선택하세요: ${pend.kw}`, false);
        return;
      }

      // Phase 1: 검색창 비어 있으면 검색어 입력 + '찾기'
      const inp = document.querySelector("input[name='searchKeyword']");
      if (inp && !(inp.value || '').trim() && !searched) {
        inp.focus();
        setNativeValue(inp, pend.kw);
        ['keydown', 'keypress', 'keyup', 'input'].forEach((type) =>
          inp.dispatchEvent(type === 'input'
            ? new Event('input', { bubbles: true })
            : new KeyboardEvent(type, { key: 'a', keyCode: 65, which: 65, bubbles: true })));
        await sleep(300);
        realClick(document.querySelector('.postcode_search_btn'));
        ['keydown', 'keypress', 'keyup'].forEach((type) =>
          inp.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })));
        searched = true;
      }

      await sleep(300);
    }
    toast(`자동 진행 중단(타임아웃): ${pend.kw}\n결과 선택/저장을 직접 해주세요.`, false);
  }

  // ── 5) SSG 배송지 관리(shpplocList): 방금 추가한 주소 선택 + '배송지 변경' ───────
  async function handleSsgList() {
    const raw = GM_getValue(APPLY_KEY, '');
    if (!raw) return;
    let ap;
    try { ap = JSON.parse(raw); } catch (e) { return; }
    if (!ap || !ap.name) return;
    if (ap.ts && Date.now() - ap.ts > 5 * 60 * 1000) { GM_setValue(APPLY_KEY, ''); return; } // 오래된 플래그 무시

    await waitFor(document, "input[type='radio']", 8000);
    await sleep(400);

    const zipTag = ap.zip ? `[${ap.zip}]` : '';
    // 이름 + 우편번호가 모두 들어간 '가장 구체적인(짧은)' 카드 = 해당 배송지 카드
    const cards = [...document.querySelectorAll('label, li, div')].filter((el) => {
      const t = el.textContent || '';
      return el.querySelector("input[type='radio']") && t.includes(ap.name) && (!zipTag || t.includes(zipTag));
    }).sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);

    const card = cards[0];
    if (!card) { toast(`목록에서 ${ap.name}${zipTag} 자동선택 실패\n직접 선택·변경하세요.`, false); return; }

    const radio = card.querySelector("input[type='radio']");
    if (radio) { try { radio.click(); } catch (e) { /* noop */ } realClick(radio); }
    await sleep(400);

    const changeBtn = findClickableByText('배송지 변경');
    if (changeBtn) {
      realClick(changeBtn);
      try { changeBtn.click(); } catch (e) { /* noop */ }
      try { if (typeof changeBtn.onclick === 'function') changeBtn.onclick.call(changeBtn); } catch (e) { /* noop */ }
      GM_setValue(APPLY_KEY, '');
      // 팝업이 닫히고 결제화면으로 포커스가 돌아오면 '택배배송 요청사항'을 자동입력하도록 플래그 무장(메모 있을 때만)
      if (ap.memo) GM_setValue(MEMO_KEY, JSON.stringify({ memo: ap.memo, ts: Date.now() }));
      toast(`배송지 적용 완료: ${ap.name} ${zipTag}` + (ap.memo ? '\n결제화면 배송요청사항 자동입력 대기 중…' : '\n금액·주소 확인 후 직접 결제'));
    } else {
      toast(`'배송지 변경' 버튼을 못 찾음 — 직접 눌러주세요.`, false);
    }
  }

  // ── 6) SSG 결제화면: '택배배송 요청사항'(네이티브 select)에 배송메모 자동입력 ──────
  // 결제화면 실측: 드롭다운 <select id="deliShppMemo_0">, 입력칸 <input id="deliShppMemoTxtArea_0" placeholder="50자 …">.
  /** select를 '직접 입력'으로 바꿔 입력칸을 노출시킨 뒤 메모(50자)를 채운다. */
  async function fillSsgDeliveryMemo(memo) {
    memo = String(memo || '').trim();
    if (!memo) return false;

    // '배송지 변경' 직후 결제화면이 비동기 재렌더될 수 있어 드롭다운 등장을 잠시 대기
    const sel = await waitFor(document, '#deliShppMemo_0, select[id^="deliShppMemo_"]', 4000);
    if (!sel) return false; // 결제화면이 아니거나 배송요청사항 드롭다운 없음

    // '직접 입력' 옵션 선택 → change 이벤트로 입력칸 노출
    if (!setSelectValue(sel, '직접 입력')) {
      const opt = [...sel.options].find((o) => /직접\s*입력/.test(o.textContent || ''));
      if (!opt) { toast('배송요청사항 자동입력 실패 — 직접 선택·입력하세요', false); return false; }
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 입력칸 등장 대기 후 메모 입력(필드 50자 제한 방어)
    const inp = await waitFor(document, '#deliShppMemoTxtArea_0, input[id^="deliShppMemoTxtArea_"]', 4000);
    if (!inp) { toast('배송요청사항 입력칸을 못 찾음 — 직접 입력하세요', false); return false; }
    inp.focus();
    setNativeValue(inp, memo.slice(0, 50));
    inp.dispatchEvent(new Event('keyup', { bubbles: true }));
    toast(`배송요청사항 입력 완료\n${memo.slice(0, 50)}`);
    return true;
  }

  /** MEMO_KEY가 무장돼 있으면 결제화면에서 1회 자동입력(중복/만료 가드). */
  async function maybeFillMemoOnCheckout() {
    if (window.top !== window) return;            // 메인 결제 창에서만
    const raw = GM_getValue(MEMO_KEY, '');
    if (!raw) return;
    let f;
    try { f = JSON.parse(raw); } catch (e) { GM_setValue(MEMO_KEY, ''); return; }
    if (!f || !f.memo) { GM_setValue(MEMO_KEY, ''); return; }
    if (f.ts && Date.now() - f.ts > 5 * 60 * 1000) { GM_setValue(MEMO_KEY, ''); return; } // 만료
    if (maybeFillMemoOnCheckout._busy) return;      // 동시 실행 가드
    maybeFillMemoOnCheckout._busy = true;
    try {
      const ok = await fillSsgDeliveryMemo(f.memo);
      if (ok) GM_setValue(MEMO_KEY, '');            // 성공 시에만 1회성 소진
    } finally { maybeFillMemoOnCheckout._busy = false; }
  }

  // ── 7) SSG 결제화면: '주문자 정보 변경' → 팝업에서 주문자명을 수령인명으로 교체 ──────
  /** 결제화면(ordPage)의 '주문자 정보 변경' 링크 찾기(공백 무시, 말단 텍스트가 정확히 일치하는 것만). */
  function findOrdererChangeTrigger() {
    for (const el of document.querySelectorAll("a, button, [role='button'], span, div, em, strong")) {
      const t = (el.textContent || '').replace(/\s+/g, '');
      // 화살표('>')가 CSS든 텍스트든 대응. 길이 제한으로 이메일 등이 섞인 부모 컨테이너 제외.
      if (t.includes('주문자정보변경') && t.length <= 10 && isVisible(el)) {
        return el.closest("a, button, [role='button']") || el;
      }
    }
    return null;
  }

  /** 주문자정보 변경 팝업에서 '주문자' 이름 입력칸 찾기 — 한글 이름값(이메일=@, 휴대폰=숫자라 구분) 우선, '주문자' 라벨 폴백. */
  function findOrdererNameInput() {
    const cands = document.querySelectorAll("input[type=text], input:not([type])");
    // 1) 한글 2~6자 값이 든 입력칸(현재 주문자명 = 명의자 본인)
    for (const el of cands) {
      if (isVisible(el) && /^[가-힣]{2,6}$/.test((el.value || '').trim())) return el;
    }
    // 2) '주문자' 라벨과 같은 행/형제의 입력칸 (값이 비어 있을 때 대비)
    for (const lab of document.querySelectorAll('th, td, label, span, div, dt, dd')) {
      if ((lab.textContent || '').trim() !== '주문자') continue;
      const scope = lab.closest('tr, li, dl, div');
      const inp = scope && scope.querySelector("input[type=text], input:not([type])");
      if (inp && isVisible(inp)) return inp;
    }
    return null;
  }

  /** 결제화면 Alt+A: '주문자 정보 변경' 팝업을 열고(키 제스처 안), 팝업에서 교체하도록 플래그 무장. */
  function openOrdererChangePopup() {
    const raw = GM_getValue(STORE_KEY, '');
    if (!raw) { toast('담긴 주문이 없어요.', false); return false; }
    const o = JSON.parse(raw);
    const name = (o.수령인 || '').trim();
    if (!name) { toast('담긴 주문의 수령인명이 비어 있어요.', false); return false; }

    const trigger = findOrdererChangeTrigger();
    if (!trigger) { toast("'주문자 정보 변경' 링크를 못 찾음.", false); return false; }

    // 팝업(ordUserInfoChangePop)은 window.open류 → Alt+A 키 제스처 안에서 단일 클릭으로 연다(중복 창 방지).
    GM_setValue(ORDERER_KEY, JSON.stringify({ name: name, ts: Date.now() }));
    try { trigger.click(); } catch (e) { realClick(trigger); }
    toast(`주문자정보 변경 팝업 여는 중…\n주문자명을 ${name}(으)로 교체합니다.`);
    return true;
  }

  /** 주문자정보 변경 팝업 로드 시: 무장된 ORDERER_KEY가 있으면 주문자명을 교체하고 '변경' 클릭. */
  async function applySsgOrdererName() {
    const raw = GM_getValue(ORDERER_KEY, '');
    if (!raw) return;
    GM_setValue(ORDERER_KEY, ''); // 1회성 소진
    let f;
    try { f = JSON.parse(raw); } catch (e) { return; }
    if (!f || !f.name) return;
    if (f.ts && Date.now() - f.ts > 60 * 1000) return; // 만료(1분)

    const nameInput = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 5000) {
        const el = findOrdererNameInput();
        if (el) return el;
        await sleep(200);
      }
      return null;
    })();
    if (!nameInput) { toast('주문자명 입력칸을 못 찾음 — 직접 변경하세요.', false); return; }

    nameInput.focus();
    setNativeValue(nameInput, f.name);

    // '변경' 버튼 단일 클릭(중복 제출 방지)
    const okBtn = findClickableByText('변경');
    if (okBtn) {
      try { okBtn.click(); } catch (e) { realClick(okBtn); }
      toast(`주문자명 변경: ${f.name}`);
    } else {
      toast(`주문자명 입력 완료(${f.name})\n'변경'을 직접 눌러주세요.`, false);
    }
  }

  function showSsgBadge() {
    if (window.top !== window) return;
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
    b.textContent = who + 'Alt+A 배송지 입력 · Alt+D 진단';
  }

  // ── 라우팅 ──────────────────────────────────────────────────────────────────
  const host = location.hostname;
  if (host.endsWith('cafe24.com')) {
    captureFromCafe24();
  } else if (host.endsWith('ssg.com')) {
    // 우편번호 검색 팝업이면 자동 진행(검색→결과선택→상세입력+저장)
    if (/\/addr\/popup\/zipcd\.ssg/i.test(location.pathname)) {
      runSsgZipcd();
    }
    // 배송지 관리 목록이면 방금 추가한 주소 선택 + 변경
    if (/\/comm\/popup\/shpplocList\.ssg/i.test(location.pathname)) {
      handleSsgList();
    }
    // 결제화면(ordPage)에서만: 배송지 변경 직후 무장된 MEMO_KEY가 있으면 '택배배송 요청사항' 자동입력
    if (/\/order\/ordPage/i.test(location.pathname)) {
      maybeFillMemoOnCheckout();
      // 배송지 변경 팝업이 닫히고 결제화면으로 포커스가 돌아오는 시점에도 시도(1회성+busy 가드로 중복 방지)
      window.addEventListener('focus', () => { maybeFillMemoOnCheckout(); });
    }
    // 주문자정보 변경 팝업이면 주문자명을 수령인명으로 교체 + '변경'
    if (/\/order\/ordUserInfoChangePop\.ssg/i.test(location.pathname)) {
      applySsgOrdererName();
    }
    window.addEventListener('keydown', (e) => {
      if (!e.altKey) return;
      // Alt+A — 결제화면이면 '주문자 정보 변경'(주문자명→수령인명), 그 외엔 배송지 폼 한방입력
      if (e.key === 'a' || e.key === 'A' || e.code === 'KeyA') {
        e.preventDefault();
        // 배송지 폼이 아니고(=수령인칸 없음) '주문자 정보 변경' 링크가 있으면 주문자명 교체 흐름
        if (!document.querySelector('#rcptpeNm') && findOrdererChangeTrigger()) {
          openOrdererChangePopup();
        } else {
          fillSsgForm();
        }
      }
      // Alt+D — SSG 폼 진단 덤프
      if (e.key === 'd' || e.key === 'D' || e.code === 'KeyD') {
        e.preventDefault();
        dumpSsgForm();
      }
    }, true);
    showSsgBadge();
    setInterval(showSsgBadge, 4000);
  }
})();
