// ==UserScript==
// @name         더망고 팀 설정 (코드표·회사번호)
// @namespace    mango_order
// @version      1.1.0
// @description  팀 공통 설정값(결제자 코드표·회사번호)을 한 번만 붙여넣어 저장하면 다른 망고 스크립트가 읽어 쓴다. 민감정보(실명·번호)는 공개 코드에 없고 이 설정(브라우저 로컬)에만 들어간다. 설정 완료 시 좌하단 버튼은 숨기며, Alt+Shift+M로 편집기를 다시 연다(미설정 시 ⚠ 버튼 표시).
// @author       PA
// @match        https://tmg2533.cafe24.com/*
// @match        https://www.musinsa.com/*
// @match        https://*.ssg.com/*
// @match        https://*.pay.naver.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @updateURL    https://raw.githubusercontent.com/iopkl369-a11y/mango-userscripts/main/scripts/mango_config.user.js
// @downloadURL  https://raw.githubusercontent.com/iopkl369-a11y/mango-userscripts/main/scripts/mango_config.user.js
// @run-at       document-start
// ==/UserScript==

// 다른 스크립트는 이 값을 page localStorage['mango_config'](JSON)에서 읽는다.
//   { "companyPhone": "01012345678", "codes": [ { "code":"ㅏ","platform":"무신사","name":"홍길동","pay":"카드" }, ... ] }
// 실제 값은 공개 repo에 올리지 않고 팀 채팅으로만 공유 → 각자 이 버튼에 1회 붙여넣기.

(function () {
  'use strict';

  const GM_KEY = 'mango_team_config'; // GM 저장(영구) — JSON 문자열
  const LS_KEY = 'mango_config';      // page localStorage 미러(메인 스크립트가 읽음)

  function rawConfig() { return GM_getValue(GM_KEY, '') || ''; }
  function parseConfig() { try { return JSON.parse(rawConfig() || '{}'); } catch (e) { return {}; } }

  /** GM 저장값을 이 도메인 localStorage에 미러(메인 스크립트가 도메인별 localStorage에서 읽음) */
  function mirror() { try { localStorage.setItem(LS_KEY, rawConfig()); } catch (e) { /* noop */ } }
  mirror(); // document-start: 메인 스크립트가 읽기 전에 즉시 반영

  // ── UI ────────────────────────────────────────────────────────────────────────
  function toast(msg, ok) {
    let box = document.getElementById('mango-cfg-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'mango-cfg-toast';
      box.style.cssText = 'position:fixed;z-index:2147483647;left:14px;bottom:64px;max-width:340px;' +
        'padding:10px 14px;border-radius:10px;font:13px/1.4 -apple-system,sans-serif;color:#fff;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.25);white-space:pre-wrap';
      document.body.appendChild(box);
    }
    box.style.background = ok === false ? '#b4232a' : '#1f7a3d';
    box.textContent = msg;
    box.style.opacity = '1';
    clearTimeout(box._t);
    box._t = setTimeout(() => { box.style.opacity = '0'; }, 3500);
  }

  function statusText() {
    const c = parseConfig();
    const n = Array.isArray(c.codes) ? c.codes.length : 0;
    const phone = c.companyPhone ? '설정됨' : '없음';
    return `코드표 ${n}개 · 회사번호 ${phone}`;
  }

  function openEditor() {
    if (document.getElementById('mango-cfg-modal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'mango-cfg-modal';
    wrap.style.cssText = 'position:fixed;z-index:2147483647;inset:0;background:rgba(0,0,0,.35);' +
      'display:flex;align-items:center;justify-content:center';
    const cur = rawConfig();
    let pretty = cur;
    try { pretty = JSON.stringify(JSON.parse(cur || '{}'), null, 2); } catch (e) { /* 원문 유지 */ }
    wrap.innerHTML =
      '<div style="background:#fff;color:#222;width:560px;max-width:92vw;border-radius:14px;' +
      'padding:18px 18px 14px;box-shadow:0 12px 40px rgba(0,0,0,.3);font:13px/1.5 -apple-system,sans-serif">' +
      '<div style="font-weight:700;font-size:15px;margin-bottom:6px">⚙ 망고 팀 설정</div>' +
      '<div style="color:#666;margin-bottom:8px">팀 채팅으로 받은 설정 JSON을 붙여넣고 저장하세요. ' +
      '(이 브라우저에만 저장 · 공개 repo엔 없음)</div>' +
      '<textarea id="mango-cfg-ta" spellcheck="false" style="width:100%;height:300px;box-sizing:border-box;' +
      'font:12px/1.5 ui-monospace,monospace;border:1px solid #ccc;border-radius:8px;padding:10px"></textarea>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">' +
      '<button id="mango-cfg-cancel" style="padding:8px 14px;border:0;border-radius:8px;cursor:pointer;' +
      'background:#eef0f4;color:#333">취소</button>' +
      '<button id="mango-cfg-save" style="padding:8px 16px;border:0;border-radius:8px;cursor:pointer;' +
      'background:#1f7a3d;color:#fff">저장</button></div></div>';
    document.body.appendChild(wrap);
    const ta = wrap.querySelector('#mango-cfg-ta');
    ta.value = pretty;
    ta.focus();
    wrap.querySelector('#mango-cfg-cancel').onclick = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    wrap.querySelector('#mango-cfg-save').onclick = () => {
      let obj;
      try { obj = JSON.parse(ta.value || '{}'); } catch (e) { toast('JSON 형식 오류:\n' + e.message, false); return; }
      const json = JSON.stringify(obj);
      GM_setValue(GM_KEY, json);
      mirror();
      wrap.remove();
      renderButton();
      toast('저장됨 · ' + statusText());
    };
  }

  function renderButton() {
    const ok = (parseConfig().codes || []).length > 0;
    let btn = document.getElementById('mango-cfg-btn');
    if (ok) { if (btn) btn.remove(); return; } // 설정 완료 시 버튼 숨김 (Alt+Shift+M로 편집)
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'mango-cfg-btn';
      btn.style.cssText = 'position:fixed;z-index:2147483646;left:14px;bottom:14px;' +
        'padding:7px 11px;border:0;border-radius:9px;cursor:pointer;background:#33363d;color:#fff;' +
        'font:12px/1 -apple-system,sans-serif;box-shadow:0 3px 12px rgba(0,0,0,.25)';
      btn.onclick = openEditor;
      document.body.appendChild(btn);
    }
    btn.textContent = '⚙ 망고설정 ⚠  ' + statusText();
    btn.title = '팀 설정값이 비어 있습니다 — 클릭해 붙여넣기 (Alt+Shift+M)';
  }

  // 배지가 숨겨져 있어도 편집기를 다시 열 수 있게 — Alt+Shift+M
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyM') { e.preventDefault(); openEditor(); }
  }, true);

  function init() { mirror(); renderButton(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
