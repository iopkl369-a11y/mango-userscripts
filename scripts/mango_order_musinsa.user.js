// ==UserScript==
// @name         더망고 무신사 주소 한방입력 (Edge 전용)
// @namespace    mango_order
// @version      0.9.4
// @description  더망고 주문정보의 배송지(수령인·연락처·주소·상세주소·배송요청)를 무신사 배송지 폼에 단축키(Alt+A)로 한 번에 옮긴다. 카카오 우편번호 검색·도로명 선택, 저장하기·목록선택·변경하기까지 자동. ※ Edge 브라우저에만 설치.
// @author       PA
// @match        https://tmg2533.cafe24.com/*
// @match        https://www.musinsa.com/*
// @match        https://postcode.map.kakao.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/iopkl369-a11y/mango-userscripts/main/scripts/mango_order_musinsa.user.js
// @downloadURL  https://raw.githubusercontent.com/iopkl369-a11y/mango-userscripts/main/scripts/mango_order_musinsa.user.js
// ==/UserScript==

(function () {
  'use strict';

  // 실행 확인용 로그 (콘솔에서 '[mango_order]'로 검색)
  console.log('[mango_order][musinsa] v0.9.4 loaded @', location.href, 'top=', window.top === window);

  // ── 정책 상수 ──────────────────────────────────────────────────────────────
  // 무신사는 안심번호(050x)를 못 받으므로 회사 번호로 대체. 회사번호는 팀 설정값에서 읽는다
  // (공개 코드엔 번호 없음). "⚙ 망고설정"(mango_config)에서 1회 입력 → localStorage['mango_config'].companyPhone
  function companyPhone() {
    try { return JSON.parse(localStorage.getItem('mango_config') || '{}').companyPhone || ''; } catch (e) { return ''; }
  }

  // 상세주소 괄호 안에서 '삭제 대상'으로 보는 건물/아파트 키워드 (musinsa_order.py _BLD_KW 동일)
  const BLD_KW = ['아파트', 'apt', '빌라', '빌딩', '빌', '타워', '맨션', '맨숀', '오피스텔',
    '하우스', '팰리스', '펠리스', '캐슬', '자이', '푸르지오', '래미안',
    '힐스테이트', '더샵', '메르디앙', '리슈빌', '쉐르빌', '코아루',
    '파라디아', '센트럴', '파크'];

  const STORE_KEY = 'mo_order';          // 담긴 주문(배송지) JSON
  const PENDING_KEY = 'mo_pending_road'; // 카카오에 넘길 {addr, zip}
  const PENDING_SELECT_KEY = 'mo_pending_select'; // 저장 후 목록에서 고를 {name, addr}

  // ── 공통 유틸 ──────────────────────────────────────────────────────────────
  const norm = (s) => (s || '').replace(/\s/g, '').toLowerCase();

  /** React 제어 입력에 값 주입 — 네이티브 setter + input/change 이벤트 */
  function setNativeValue(el, value) {
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value == null ? '' : String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /** 안심번호(050x)면 회사 번호로 대체, 아니면 숫자만 (musinsa_order.py _phone_for_musinsa 동일).
   *  회사번호 미설정 시 대체 없이 원본 유지(빈 값 입력 방지). */
  function phoneForMusinsa(raw) {
    const digits = (raw || '').replace(/\D/g, '');
    if (digits.startsWith('050')) return companyPhone() || digits;
    return digits;
  }

  /** 주소에서 '도로명+건물번호' 핵심 토큰 (결과 매칭용) */
  function roadToken(addr) {
    const m = (addr || '').match(/([가-힣\dA-Za-z]+(?:로|길)\d*[가-힣]*\s*\d+(?:-\d+)?)/);
    return m ? m[1].trim() : (addr || '');
  }

  /** address1이 번지/도로명 없이 '…동/리' 등으로 끝나는 불완전 주소인가 (네이버/SSG 스크립트와 동일) */
  function isIncompleteAddr1(addr) {
    const t = (addr || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    if (/(로|길)\s*\d/.test(t)) return false;                          // 도로명+건물번호 있음
    if (/[가-힣0-9](동|리|읍|면|가)\s*(산\s*)?\d/.test(t)) return false; // 지번(동/리 뒤 번지) 있음
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
    if (!m) return { ok: false, fixed: false };
    // 도로명 보완이면 끝의 행정동/리 토큰을 뗀다(도로명과 섞이면 검색이 깨짐).
    // 번지 보완이면 동/리를 남긴다(지번은 동/리가 있어야 위치가 특정됨).
    let base = a1.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (road) base = base.replace(/\s*[가-힣0-9]+(동|리|읍|면|가)$/, '').trim();
    o.주소 = (base + ' ' + m[1]).trim();
    o.상세주소 = d.replace(m[1], '').replace(/\s{2,}/g, ' ').trim(); // 보완에 쓴 토큰은 상세주소에서 제거(중복 방지)
    return { ok: true, fixed: true };
  }

  /** 괄호 안 내용이 (삭제 대상인) 동/리 지명 또는 건물명처럼 보이는가 */
  function looksLikePlaceOrBuilding(s) {
    const t = (s || '').trim();
    if (!t) return false;
    // 쉼표/공백으로 쪼갠 토큰 중 '한글+동/리/읍/면/가'로 끝나는 행정동명이 있으면 삭제 대상.
    // (아파트 '102동'처럼 숫자+동은 제외해 보존)
    const toks = t.split(/[,\s]+/).filter(Boolean);
    if (toks.some((tk) => /[가-힣](동|리|읍|면|가)$/.test(tk))) return true;
    return BLD_KW.some((kw) => t.includes(kw));
  }

  /** 상세주소 정리 — 괄호 안 동/건물명 삭제, 단 고객이 직접 넣은 괄호는 유지
   *  (musinsa_order.py _clean_detail_address 동일 규칙) */
  function cleanDetailAddress(detail) {
    const raw = (detail || '').trim();
    if (!raw) return '';
    // 괄호 안이 법정동/건물명이면 위치 무관 삭제. 지명·건물 키워드 없는 고객 메모는 보존.
    return raw.replace(/\([^)]*\)/g, (m) =>
      looksLikePlaceOrBuilding(m.slice(1, -1).trim()) ? '' : m
    ).replace(/\s{2,}/g, ' ').trim();
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
    // 배송요청사항 — 라벨 다음 셀/형제 텍스트 (cafe24_order.extract_shipping 폴백 동일)
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
      // 실행은 됐는데 필드를 못 읽음 → 진단: 화면의 비어있지 않은 입력칸 name=값 목록 표시
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
      // 우하단 고정 — 위쪽 주문목록(옵션·가격·수량)을 가리지 않음
      b.style.cssText = 'position:fixed;z-index:2147483647;right:14px;bottom:14px;' +
        'border-radius:10px;background:#1f7a3d;color:#fff;font:12px/1.5 -apple-system,sans-serif;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:340px;white-space:pre-wrap;cursor:pointer';
      document.body.appendChild(b);
    }
    const full = `✓ 주소 담김 (무신사에서 Alt+A)\n${order.수령인} · ${order.우편번호}\n${order.주소}\n${cleanDetailAddress(order.상세주소)}\n(클릭하면 접힘/펼침)`;
    const mini = `✓ 담김: ${order.수령인}`;
    const setFull = () => { b.textContent = full; b.style.padding = '10px 14px'; b.style.opacity = '1'; b._mini = false; };
    const setMini = () => { b.textContent = mini; b.style.padding = '5px 10px'; b.style.opacity = '0.8'; b._mini = true; };
    setFull();
    clearTimeout(b._t);
    b._t = setTimeout(setMini, 4000); // 4초 뒤 자동 축소
    b.onclick = () => { clearTimeout(b._t); b._mini ? setFull() : setMini(); };
  }

  // ── 2) 무신사: Alt+A 로 배송지 폼 채우기 ────────────────────────────────────
  /** 동일 출처(무신사) 프레임 중 배송지 추가 폼이 든 document 찾기 */
  function findFormDoc() {
    const docs = [document];
    try { docs.push(window.top.document); } catch (e) { /* noop */ }
    try {
      for (const f of window.top.frames) {
        try { if (f.document) docs.push(f.document); } catch (e) { /* cross-origin */ }
      }
    } catch (e) { /* noop */ }
    for (const d of docs) {
      try { if (d.querySelector("input[name='name']")) return d; } catch (e) { /* noop */ }
    }
    return null;
  }

  /** 동일 출처(무신사) 프레임 중 배송지 '목록'(.order-address-item)이 든 document 찾기 */
  function findListDoc() {
    const docs = [document];
    try { docs.push(window.top.document); } catch (e) { /* noop */ }
    try {
      for (const f of window.top.frames) {
        try { if (f.document) docs.push(f.document); } catch (e) { /* cross-origin */ }
      }
    } catch (e) { /* noop */ }
    for (const d of docs) {
      try { if (d.querySelector('.order-address-item')) return d; } catch (e) { /* noop */ }
    }
    return null;
  }

  /** doc 안에서 정확히 label 텍스트인 버튼/링크를 찾아 클릭 (주소 찾기 탐색 패턴 재사용) */
  function clickByText(doc, label) {
    for (const b of doc.querySelectorAll("button, a, [role='button']")) {
      if ((b.textContent || '').trim() === label) { b.click(); return true; }
    }
    return false;
  }

  /** 우편번호 칸이 채워질 때까지 폴링. expectedZip 있으면 일치 검증.
   *  반환: {ok, zip, reason} (musinsa_order.py _fill_address 라인 593~601 검증과 동일 취지) */
  async function waitZipFilled(doc, expectedZip, timeout = 12000) {
    const wantZip = (expectedZip || '').replace(/\D/g, '');
    const readZip = () => {
      let el = doc.querySelector("input[name='zipcode1']");
      if (!el) {
        // fallback: 화면 첫 주소 input (이미지 화면1의 우편번호 칸)
        el = doc.querySelector("input[name='address1'], input[readonly]");
      }
      return el ? (el.value || '').trim() : '';
    };
    const t0 = Date.now();
    for (;;) {
      const zip = readZip();
      if (zip) {
        const got = zip.replace(/\D/g, '');
        if (wantZip && got && got !== wantZip) {
          return { ok: false, zip, reason: `우편번호 불일치(더망고 ${wantZip} ≠ 무신사 ${got})` };
        }
        return { ok: true, zip };
      }
      if (Date.now() - t0 > timeout) return { ok: false, zip: '', reason: '우편번호 미입력(타임아웃)' };
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** 배송지 목록에서 (수령인 이름 + 도로명) 일치 항목 선택 (musinsa_order.py _select_address_in_list 포팅).
   *  무신사 라디오는 커스텀이라 항목 컨테이너의 .order-address-item__information 을 클릭한다.
   *  기본배송지(명의자 본인)가 선택돼 있으므로 반드시 고객 주소를 골라야 한다. */
  async function selectAddressInList(doc, name, addr) {
    const road = norm(roadToken(addr));
    const nName = norm(name);
    // 라디오(항목당 1개)를 기준으로 항목 블록을 잡는다 — 클래스명 의존/과다매칭 회피
    const itemBlock = (radio) => {
      let b = radio;
      for (let i = 0; i < 10 && b; i++) {
        if (norm(b.innerText || b.textContent || '').includes(nName)) return b;
        b = b.parentElement;
      }
      return null;
    };
    // 자식 중 같은 이름을 포함하는 더 작은 블록이 없으면 = 이 el이 이름의 '최소 항목 블록'
    const isMinBlock = (el) => {
      for (const c of el.children) {
        if (norm(c.innerText || c.textContent || '').includes(nName)) return false;
      }
      return true;
    };
    const tryOnce = () => {
      const cands = [];
      // A) 라디오 기준 (표준 input/role 라디오가 있으면 가장 신뢰도 높음)
      for (const r of doc.querySelectorAll("input[type='radio'], [role='radio']")) {
        const block = itemBlock(r);
        if (!block) continue;
        cands.push({ click: r, text: norm(block.innerText || block.textContent || '') });
      }
      // B) 라디오로 못 찾으면(커스텀 라디오 대비) 이름이 든 최소 항목 블록을 직접 클릭
      if (!cands.length) {
        for (const el of doc.querySelectorAll("li, [class*='item'], [class*='address']")) {
          const text = norm(el.innerText || '');
          if (!text.includes(nName) || !isMinBlock(el)) continue;
          const click = el.querySelector("input[type='radio'], [role='radio']")
            || el.querySelector("[class*='information']") || el;
          cands.push({ click, text });
        }
      }
      // 1) 이름+도로명 둘 다(동명이인 구분), 없으면 2) 이름만
      let pick = road && cands.find((c) => c.text.includes(nName) && c.text.includes(road));
      if (!pick) pick = cands.find((c) => c.text.includes(nName));
      if (pick) { pick.click.click(); return { ok: true, cands }; }
      return { ok: false, cands };
    };
    let last = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = tryOnce();
      if (res.ok) { await new Promise((r) => setTimeout(r, 800)); return true; }
      if (res.cands.length) last = res.cands;
      await new Promise((r) => setTimeout(r, 800));
    }
    // 진단: 매칭 실패 시 이름 후보 텍스트를 콘솔에 덤프 ('[mango_order]'로 검색)
    try {
      const dump = (last || []).map((c) => c.text.slice(0, 50));
      console.warn('[mango_order] 주소목록 선택 실패 — 찾는값 name=%o road=%o\n이름후보(%d):\n%s',
        name, road, dump.length, dump.join('\n'));
    } catch (e) { /* noop */ }
    return false;
  }

  /** 배송 요청사항(선택) → 직접입력 → textarea 채우기 (best-effort) */
  async function fillDeliveryRequest(doc, memo) {
    memo = (memo || '').trim();
    if (!memo) return;
    const sel = doc.querySelector("[class*='order-address-select']");
    if (!sel) return;
    sel.click();
    // '직접입력' 항목 대기 후 클릭
    let direct = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 3000 && !direct) {
      for (const el of doc.querySelectorAll('*')) {
        if ((el.textContent || '').trim() === '직접입력' && el.children.length === 0) { direct = el; break; }
      }
      if (!direct) await new Promise((r) => setTimeout(r, 150));
    }
    if (direct) direct.click();
    const ta = await waitFor(doc, "textarea[placeholder*='최대 50'], textarea[placeholder*='입력가능'], textarea[placeholder*='입력 가능']", 3000);
    if (ta) setNativeValue(ta, memo.slice(0, 50));
  }

  async function fillMusinsaAddress() {
    const raw = GM_getValue(STORE_KEY, '');
    if (!raw) { toast('담긴 주문이 없어요.\n더망고에서 주문정보를 먼저 여세요.', false); return; }
    const o = JSON.parse(raw);

    // 주소가 '…동'으로 끝나는 불완전 주소면 상세주소의 도로명/번지로 보완. 못 하면 중단(오주소 입력 방지).
    const fx = fixIncompleteAddr(o);
    if (!fx.ok) { toast(`주소가 불완전해요(번지/도로명 없음): ${o.주소}\n상세주소에서도 못 찾아 중단 — 직접 입력하세요.`, false); return; }
    if (fx.fixed) toast(`불완전 주소 보완 검색: ${o.주소}`);

    const doc = findFormDoc();
    if (!doc) { toast("배송지 추가 폼이 안 보여요.\n'배송지 변경 → 배송지 추가하기' 후 Alt+A.", false); return; }

    const nameEl = doc.querySelector("input[name='name']");
    const mobileEl = doc.querySelector("input[name='mobile']");
    const addr2El = doc.querySelector("input[name='address2']");

    if (nameEl) setNativeValue(nameEl, o.수령인);
    if (mobileEl) setNativeValue(mobileEl, phoneForMusinsa(o.연락처));
    // 상세주소가 비어 있으면 '-' 입력 (빈 값이면 저장 진행이 멈춤)
    if (addr2El) setNativeValue(addr2El, cleanDetailAddress(o.상세주소) || '-');

    await fillDeliveryRequest(doc, o.배송메모);

    // 카카오에 넘길 도로명/우편번호 저장 후 '주소 찾기' 실행
    GM_setValue(PENDING_KEY, JSON.stringify({ addr: o.주소, zip: o.우편번호 }));
    clickByText(doc, '주소 찾기');

    toast(`입력 완료: ${o.수령인}\n주소검색 자동 진행 중…`);

    // ── 카카오로 우편번호가 채워질 때까지 대기 → 검증 → 저장하기 ──
    const zipRes = await waitZipFilled(doc, o.우편번호, 12000);
    if (!zipRes.ok) {
      toast(`자동 저장 중단 — ${zipRes.reason}\n주소를 직접 선택한 뒤 저장하세요.`, false);
      return;
    }

    // ⚠️ 저장하기를 누르면 배송지 '목록' 페이지로 풀 네비게이션(리로드)되어 이 스크립트
    //    컨텍스트가 사라진다. → 목록에서 고를 대상을 저장해두고, 새로 뜬 목록 페이지에서
    //    musinsaListAutoSelect()가 선택→변경하기를 이어받는다.
    GM_setValue(PENDING_SELECT_KEY, JSON.stringify({ name: o.수령인, addr: o.주소 }));
    if (!clickByText(doc, '저장하기')) {
      GM_setValue(PENDING_SELECT_KEY, '');
      toast('저장하기 버튼을 못 찾음 — 수동 확인.', false);
      return;
    }
    toast(`저장 중… 목록에서 ${o.수령인} 자동 선택 예정`);
  }

  /** 저장 직후 새로 뜬 배송지 '목록' 페이지에서 대상 주소를 선택하고 변경하기까지. */
  async function musinsaListAutoSelect() {
    if (window.top !== window) return; // 최상위 프레임에서만 (iframe이 인계 키를 먼저 소비하지 않도록)
    const raw = GM_getValue(PENDING_SELECT_KEY, '');
    if (!raw) return;
    // 폼(추가) 페이지면 아직 목록 전이라 스킵 — 곧 목록 페이지에서 다시 호출된다.
    if (/\/addresses\/add/.test(location.href)) return;
    let pend;
    try { pend = JSON.parse(raw); } catch (e) { GM_setValue(PENDING_SELECT_KEY, ''); return; }
    if (!pend || !pend.name) { GM_setValue(PENDING_SELECT_KEY, ''); return; }

    const listDoc = findListDoc() || document;
    const ok = await selectAddressInList(listDoc, pend.name, pend.addr);
    GM_setValue(PENDING_SELECT_KEY, ''); // 성공/실패 무관 1회만 시도
    if (!ok) {
      toast(`목록에서 '${pend.name}' 주소를 못 골랐어요 — 직접 선택 후 변경하기.`, false);
      return;
    }
    if (!clickByText(listDoc, '변경하기')) {
      toast('변경하기 버튼을 못 찾음 — 직접 눌러주세요.', false);
      return;
    }
    toast(`배송지 적용 완료: ${pend.name}`);
  }

  function showMusinsaBadge() {
    if (window.top !== window) return; // 최상위 프레임에만
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
    if (raw) {
      const o = JSON.parse(raw);
      b.textContent = `담긴 주문: ${o.수령인}\nAlt+A → 배송지 자동 입력`;
    } else {
      b.textContent = '담긴 주문 없음\n더망고 주문정보를 먼저 여세요';
    }
  }

  // ── 3) 카카오 우편번호 iframe: 자동 검색 + 도로명 결과 선택 ───────────────────
  function kakaoAutoSearch() {
    const raw = GM_getValue(PENDING_KEY, '');
    if (!raw) return;
    let pend;
    try { pend = JSON.parse(raw); } catch (e) { return; }
    if (!pend || !pend.addr) return;
    // ⚠️ 검색 버튼을 누르면 결과 '페이지'로 전환되며 스크립트가 다시 로드된다.
    //    그래서 PENDING을 미리 소비하지 않고, 결과를 '선택'한 뒤에만 비운다.
    const road = norm(roadToken(pend.addr));

    const step = () => {
      // 1) 결과(.link_post)가 있으면 선택 → 끝
      const items = document.querySelectorAll('a.link_post, .link_post');
      if (items.length) {
        const cands = [...items].filter((it) => !/link_english|link_btn_map|link_infomation/.test(it.className || ''));
        // 도로명 우선: '로/길 + 공백 + 숫자' 패턴(도로명 링크)을 먼저 고른다.
        const isRoad = (it) => /(로|길)\s+\d/.test(it.textContent || '');
        const roadCands = cands.filter(isRoad);
        const byToken = (arr) => arr.find((it) => road && norm(it.textContent).includes(road));
        const target = byToken(roadCands) || roadCands[0] || byToken(cands) || cands[0];
        if (target) { target.click(); GM_setValue(PENDING_KEY, ''); return true; }
      }
      // 2) 검색창이 비어 있으면 주소 입력 후 검색 실행 (→ 결과 페이지로 전환)
      const inp = document.querySelector('#region_name, input.tf_keyword');
      if (inp && !(inp.value || '').trim()) {
        setNativeValue(inp, pend.addr);
        const btn = document.querySelector('button.btn_search');
        if (btn) btn.click();
        else inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      }
      return false;
    };

    const t0 = Date.now();
    const loop = () => {
      let done = false;
      try { done = step(); } catch (e) { /* noop */ }
      if (done) return;
      if (Date.now() - t0 > 9000) return; // 타임아웃 — 사람이 직접 선택
      setTimeout(loop, 250);
    };
    loop();
  }

  // ── 라우팅 ──────────────────────────────────────────────────────────────────
  const host = location.hostname;
  if (host.endsWith('cafe24.com')) {
    captureFromCafe24();
  } else if (host === 'postcode.map.kakao.com') {
    kakaoAutoSearch();
  } else if (host.endsWith('musinsa.com')) {
    // 저장 직후 새로 뜬 목록 페이지면 자동 선택→변경하기 이어받기
    musinsaListAutoSelect();
    window.addEventListener('keydown', (e) => {
      // Alt+A — 배송지 한방입력
      if (e.altKey && (e.key === 'a' || e.key === 'A' || e.code === 'KeyA')) {
        e.preventDefault();
        fillMusinsaAddress();
      }
    }, true);
    showMusinsaBadge();
    // SPA라 화면 전환 시 배지 갱신
    setInterval(showMusinsaBadge, 4000);
  }
})();
