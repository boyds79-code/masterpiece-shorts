// "숨은 의미" 대본을 만들기 전에, 후보 디테일(6~10개) 중 실제로 영상에 넣을 것들을
// 사람이 먼저 보고 고르는 화면입니다. lib/review-server.mjs가 이 HTML을 서빙하고,
// "이 디테일들로 확인" 버튼은 fetch로 같은 서버의 /confirm-candidates를 호출해서
// (1) 고른 디테일로 최종 대본(나레이션 확정)을 만들고 (2) 성공하면 화면을 새로고침해서
// 기존 확대 위치(bbox)/패닝 검토 화면(review-editor.mjs)으로 넘어갑니다.
//
// 후보가 10개 가까이 나왔는데 전부 쓸 만해서 하나의 영상에 다 욱여넣고 싶지 않을 때를
// 위해 "두 편으로 나누기" 모드도 지원합니다 — 켜면 체크박스 대신 카드를 클릭할 때마다
// 1부 -> 2부 -> 미선택으로 순환하는 방식으로 바뀌고, "이렇게 두 편으로 만들기"를 누르면
// /confirm-candidates-split을 호출해서 이 폴더는 1부로, 새로 만들어진 옆 폴더는 2부로
// 각각 독립적인 대본을 만듭니다(review-server.mjs 참고).

import { escapeHtml } from './review-editor.mjs';

const PALETTE = ['#e0554c', '#3f8ee0', '#e0a83f', '#7c4fe0', '#3fae7d', '#e0559c', '#5f7ee0', '#c98a2c', '#4fa8a0', '#a05fe0'];
const PART1_COLOR = '#3f8ee0';
const PART2_COLOR = '#e0a83f';

/**
 * @param {object} params
 * @param {object} params.painting - Met API painting 객체
 * @param {{ candidates: Array<{id,focus,gridPosition,bbox,teaser,recommended}> }} params.candidates
 * @param {string} [params.imageFile]
 * @param {string[]|null} [params.previousFocuses] - "다시 고르기"로 되돌아온 경우, 직전에
 *   확정했던 대본에서 실제로 쓰인 디테일들의 focus 문구 목록. 있으면 이 목록과 focus가
 *   일치하는 후보를 기본 체크로 표시합니다(추천값 대신). 없으면(첫 실행) 기존처럼
 *   recommended만 기본 체크합니다.
 * @returns {string}
 */
export function buildCandidatePickerHtml({ painting, candidates, imageFile = 'original.jpg', previousFocuses = null }) {
  const list = candidates.candidates;
  const dataJson = JSON.stringify(list).replace(/</g, '\\u003c');
  const recommendedCount = list.filter((c) => c.recommended).length;
  const isReset = Array.isArray(previousFocuses) && previousFocuses.length > 0;
  const previousFocusesJson = JSON.stringify(isReset ? previousFocuses : []).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>숨은 이야기 고르기 — ${escapeHtml(painting?.title || '')}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Pretendard, sans-serif;
    background: #f5f4f0;
    color: #1f1c17;
  }
  header {
    padding: 14px 20px;
    background: #1f1c17;
    color: #f5f4f0;
  }
  header h1 { font-size: 16px; margin: 0 0 2px; font-weight: 600; }
  header p { margin: 4px 0 0; font-size: 13px; color: #cfc9bd; line-height: 1.5; }
  .layout {
    display: flex;
    gap: 20px;
    padding: 20px;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .stage {
    flex: 1 1 420px;
    max-width: 720px;
    position: sticky;
    top: 20px;
  }
  .stage-inner {
    position: relative;
    width: 100%;
    background: #000;
    overflow: hidden;
    border-radius: 6px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.25);
  }
  .stage-inner img { display: block; width: 100%; height: 100%; user-select: none; -webkit-user-drag: none; }
  .marker {
    position: absolute;
    border: 2px solid;
    border-radius: 3px;
    pointer-events: none;
    opacity: 0.25;
    transition: opacity 0.15s ease, border-color 0.15s ease;
  }
  .marker.active { opacity: 1; }
  .marker.part1 { border-color: ${PART1_COLOR} !important; color: ${PART1_COLOR} !important; }
  .marker.part2 { border-color: ${PART2_COLOR} !important; color: ${PART2_COLOR} !important; }
  .marker .num {
    position: absolute;
    top: -20px;
    left: -2px;
    font-size: 11px;
    font-weight: 700;
    color: #fff;
    padding: 1px 6px;
    border-radius: 3px;
    white-space: nowrap;
  }
  .cards {
    flex: 1 1 420px;
    max-width: 560px;
  }
  .guide {
    background: #fff;
    border-radius: 6px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.1);
    padding: 14px 16px;
    margin-bottom: 14px;
    font-size: 13px;
    line-height: 1.6;
    color: #444;
  }
  .guide b { color: #1f1c17; }
  .counter-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
    flex-wrap: wrap;
  }
  #counter {
    font-weight: 700;
    font-size: 14px;
    padding: 3px 10px;
    border-radius: 12px;
    background: #eee;
  }
  #counter.good { background: #e9f7ef; color: #1f6f43; }
  #counter.warn { background: #fdf3e3; color: #a5691a; }
  #counter.bad { background: #fdecea; color: #c0392b; }
  #counter1, #counter2 {
    font-weight: 700;
    font-size: 14px;
    padding: 3px 10px;
    border-radius: 12px;
    background: #eee;
  }
  .toggle-row { margin-top: 10px; }
  #splitToggleBtn {
    background: #eee;
    color: #333;
  }
  #splitToggleBtn.on {
    background: #1f1c17;
    color: #fff;
  }
  .card {
    background: #fff;
    border-radius: 6px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    padding: 12px 14px;
    margin-bottom: 10px;
    display: flex;
    gap: 10px;
    cursor: pointer;
    border: 2px solid transparent;
  }
  .card:hover { box-shadow: 0 1px 8px rgba(0,0,0,0.15); }
  .card.checked { border-color: currentColor; }
  .card.part1 { border-color: ${PART1_COLOR}; background: #f3f8fe; }
  .card.part2 { border-color: ${PART2_COLOR}; background: #fdf8ee; }
  .card input[type="checkbox"] {
    margin-top: 3px;
    width: 16px;
    height: 16px;
    flex: none;
    cursor: pointer;
  }
  .card .body { flex: 1; min-width: 0; }
  .card .title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .card .idx {
    display: inline-block;
    width: 20px;
    height: 20px;
    line-height: 20px;
    text-align: center;
    border-radius: 50%;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    flex: none;
  }
  .card .focus { font-weight: 700; font-size: 14px; }
  .card .badge {
    font-size: 10.5px;
    font-weight: 700;
    color: #1f6f43;
    background: #e9f7ef;
    padding: 1px 7px;
    border-radius: 3px;
  }
  .card .group-badge {
    font-size: 10.5px;
    font-weight: 700;
    color: #fff;
    padding: 1px 8px;
    border-radius: 10px;
  }
  .card .group-badge.part1 { background: ${PART1_COLOR}; }
  .card .group-badge.part2 { background: ${PART2_COLOR}; }
  .card .group-badge.none { background: #bbb; }
  .card .teaser { font-size: 13px; color: #555; margin-top: 6px; line-height: 1.5; }
  .toolbar {
    position: sticky;
    bottom: 0;
    background: #fff;
    border-top: 1px solid #eee;
    padding: 12px 0;
    margin-top: 8px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  button {
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    padding: 9px 16px;
    border-radius: 5px;
    border: none;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  #confirmBtn { background: #1f6f43; color: #fff; }
  #confirmBtn:hover:not(:disabled) { background: #185735; }
  #status { font-size: 12.5px; color: #666; }
  #status.err { color: #c0392b; }
  #log {
    display: none;
    margin: 10px 0 0;
    padding: 10px 12px;
    background: #1f1c17;
    color: #d7d2c7;
    border-radius: 5px;
    font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    max-height: 200px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  #log.show { display: block; }
  #banner {
    margin: 10px 0 0;
    padding: 10px 12px;
    border-radius: 5px;
    font-size: 13px;
    line-height: 1.5;
    display: none;
  }
  #banner.show { display: block; }
  #banner.err { background: #fdecea; color: #c0392b; }
</style>
</head>
<body>
<header>
  <h1>숨은 이야기 고르기 — ${escapeHtml(painting?.title || '(제목 없음)')}${painting?.artistDisplayName ? ' · ' + escapeHtml(painting.artistDisplayName) : ''}</h1>
  <p>Claude가 이 그림에서 찾은 후보 디테일 ${list.length}개입니다. 실제로 영상에 넣고 싶은 것만 체크하고 아래 "이 디테일들로 확인"을 누르면, 고른 디테일들로 나레이션을 작성한 뒤 지금 보시는 화면 대신 확대 위치/패닝을 검토하는 화면으로 넘어갑니다.</p>
</header>
<div class="layout">
  <div class="stage">
    <div class="stage-inner" id="stage">
      <img id="img" src="${imageFile}" alt="painting" />
    </div>
  </div>
  <div class="cards">
    <div class="guide">
      ${isReset ? '<b>직전에 확정했던 디테일들을 다시 체크해뒀어요.</b> 잘못 들어간 것만 체크 해제하고, 빠진 게 있으면 추가로 체크한 뒤 다시 확인을 눌러주세요.<br><br>' : ''}<b>몇 개를 고르면 좋을까요?</b> 완성된 영상은 도입·맥락·마무리(고정 3구간) + 여기서 고른 디테일 개수로 구성되고, 전체 나레이션은 항상 약 170~230단어(70~95초) 안팎으로 맞춰집니다. 디테일을 너무 적게 고르면(1~2개) 밋밋하고, 너무 많이 고르면(8개 이상) 하나당 설명할 시간이 급격히 줄어들어요. <b>4~6개</b>를 추천하고, 3~7개면 무난합니다. ${isReset ? '' : `Claude가 특히 강하다고 판단한 ${recommendedCount}개는 미리 체크해뒀어요 — 그대로 확인하셔도 되고 자유롭게 바꾸셔도 됩니다.`} 후보가 전부 쓸 만해서 하나로 합치기 아깝다면, 아래 "두 편으로 나누기"를 눌러서 두 편의 영상으로 나눠 만들 수도 있습니다.
      <div class="counter-row" id="counterRow">
        <span id="counter">0개 선택됨</span>
        <span id="counterNote" style="font-size:12.5px;color:#888;"></span>
      </div>
      <div class="counter-row" id="counterPairRow" style="display:none;">
        <span id="counter1">1부 0개</span>
        <span id="counter2">2부 0개</span>
        <span id="counterNote2" style="font-size:12.5px;color:#888;"></span>
      </div>
      <div class="toggle-row">
        <button id="splitToggleBtn" type="button">두 편으로 나누기</button>
      </div>
    </div>
    <div id="cardList"></div>
    <div class="toolbar">
      <button id="confirmBtn">이 디테일들로 확인</button>
      <span id="status"></span>
    </div>
    <div id="banner"></div>
    <pre id="log"></pre>
  </div>
</div>

<script id="candidate-data" type="application/json">${dataJson}</script>
<script id="previous-focuses-data" type="application/json">${previousFocusesJson}</script>
<script>
(function () {
  const CANDIDATES = JSON.parse(document.getElementById('candidate-data').textContent);
  const PREVIOUS_FOCUSES = JSON.parse(document.getElementById('previous-focuses-data').textContent);
  const PALETTE = ${JSON.stringify(PALETTE)};

  const stage = document.getElementById('stage');
  const cardList = document.getElementById('cardList');
  const counterEl = document.getElementById('counter');
  const counterNoteEl = document.getElementById('counterNote');
  const counterRowEl = document.getElementById('counterRow');
  const counterPairRowEl = document.getElementById('counterPairRow');
  const counter1El = document.getElementById('counter1');
  const counter2El = document.getElementById('counter2');
  const counterNote2El = document.getElementById('counterNote2');
  const splitToggleBtn = document.getElementById('splitToggleBtn');
  const confirmBtn = document.getElementById('confirmBtn');
  const statusEl = document.getElementById('status');
  const bannerEl = document.getElementById('banner');
  const logEl = document.getElementById('log');

  // "다시 고르기"로 되돌아온 경우 직전 선택(focus 문구로 역매칭)을 기본 체크로, 아니면
  // 기존처럼 Claude 추천을 기본 체크로 표시합니다. (단일 영상 모드에서만 씁니다.)
  const previousFocusSet = new Set(PREVIOUS_FOCUSES);
  const selected = previousFocusSet.size > 0
    ? new Set(CANDIDATES.filter((c) => previousFocusSet.has(c.focus)).map((c) => c.id))
    : new Set(CANDIDATES.filter((c) => c.recommended).map((c) => c.id));
  const markerEls = {}; // id -> element
  const cardEls = {}; // id -> { el, checkbox, badge }

  // 두 편으로 나누기 모드 상태. 0=미선택, 1=1부, 2=2부. 체크박스(selected)와는 별도로
  // 관리합니다 — 모드를 껐다 켜도 서로 간섭하지 않습니다.
  let splitMode = false;
  const groupAssignment = {};
  CANDIDATES.forEach((c) => { groupAssignment[c.id] = 0; });

  function fmtPercent(v) { return (v * 100) + '%'; }

  function buildMarkers() {
    CANDIDATES.forEach((c, i) => {
      const color = PALETTE[i % PALETTE.length];
      const el = document.createElement('div');
      el.className = 'marker';
      el.style.color = color;
      el.style.borderColor = color;
      el.style.left = fmtPercent(c.bbox.x);
      el.style.top = fmtPercent(c.bbox.y);
      el.style.width = fmtPercent(c.bbox.w);
      el.style.height = fmtPercent(c.bbox.h);
      const num = document.createElement('div');
      num.className = 'num';
      num.style.background = color;
      num.textContent = String(i + 1);
      el.appendChild(num);
      stage.appendChild(el);
      markerEls[c.id] = el;
    });
  }

  function updateCounter() {
    const n = selected.size;
    counterEl.textContent = n + '개 선택됨';
    counterEl.className = n >= 3 && n <= 7 ? 'good' : (n < 2 ? 'bad' : 'warn');
    if (n < 2) {
      counterNoteEl.textContent = '최소 2개 이상 선택해주세요.';
    } else if (n < 3) {
      counterNoteEl.textContent = '조금 적을 수 있어요 — 4~6개를 추천합니다.';
    } else if (n <= 7) {
      counterNoteEl.textContent = '';
    } else {
      counterNoteEl.textContent = '조금 많을 수 있어요 — 디테일당 설명이 짧아질 수 있습니다.';
    }
    confirmBtn.disabled = n < 2;
  }

  function paintCounterPill(el, ok) {
    el.style.background = ok ? '#e9f7ef' : '#fdecea';
    el.style.color = ok ? '#1f6f43' : '#c0392b';
  }

  function updateSplitCounters() {
    const ids = Object.keys(groupAssignment);
    const n1 = ids.filter((id) => groupAssignment[id] === 1).length;
    const n2 = ids.filter((id) => groupAssignment[id] === 2).length;
    counter1El.textContent = '1부 ' + n1 + '개';
    counter2El.textContent = '2부 ' + n2 + '개';
    paintCounterPill(counter1El, n1 >= 2);
    paintCounterPill(counter2El, n2 >= 2);
    counterNote2El.textContent = (n1 < 2 || n2 < 2) ? '1부, 2부 각각 최소 2개 이상 선택해주세요.' : '';
    confirmBtn.disabled = n1 < 2 || n2 < 2;
  }

  function setChecked(id, checked) {
    if (checked) selected.add(id); else selected.delete(id);
    markerEls[id].classList.toggle('active', checked);
    cardEls[id].el.classList.toggle('checked', checked);
    cardEls[id].checkbox.checked = checked;
    updateCounter();
  }

  function applyModeVisuals() {
    CANDIDATES.forEach((c) => {
      const entry = cardEls[c.id];
      const marker = markerEls[c.id];
      if (splitMode) {
        entry.checkbox.style.display = 'none';
        entry.badge.style.display = 'inline-block';
        entry.el.classList.remove('checked', 'part1', 'part2');
        marker.classList.remove('part1', 'part2');
        const g = groupAssignment[c.id] || 0;
        if (g === 1) {
          entry.el.classList.add('part1');
          marker.classList.add('part1', 'active');
          entry.badge.textContent = '1부';
          entry.badge.className = 'group-badge part1';
        } else if (g === 2) {
          entry.el.classList.add('part2');
          marker.classList.add('part2', 'active');
          entry.badge.textContent = '2부';
          entry.badge.className = 'group-badge part2';
        } else {
          marker.classList.remove('active');
          entry.badge.textContent = '미선택';
          entry.badge.className = 'group-badge none';
        }
      } else {
        entry.checkbox.style.display = '';
        entry.badge.style.display = 'none';
        entry.el.classList.remove('part1', 'part2');
        marker.classList.remove('part1', 'part2');
        const checked = selected.has(c.id);
        entry.checkbox.checked = checked;
        entry.el.classList.toggle('checked', checked);
        marker.classList.toggle('active', checked);
      }
    });
  }

  function cycleGroup(id) {
    const cur = groupAssignment[id] || 0;
    groupAssignment[id] = (cur + 1) % 3;
    applyModeVisuals();
    updateSplitCounters();
  }

  function buildCards() {
    CANDIDATES.forEach((c, i) => {
      const color = PALETTE[i % PALETTE.length];
      const div = document.createElement('div');
      div.className = 'card';
      div.style.color = color;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(c.id);

      const body = document.createElement('div');
      body.className = 'body';
      body.innerHTML =
        '<div class="title-row">' +
        '<span class="idx" style="background:' + color + '">' + (i + 1) + '</span>' +
        '<span class="focus"></span>' +
        (c.recommended ? '<span class="badge">Claude 추천</span>' : '') +
        '<span class="group-badge none" style="display:none;"></span>' +
        '</div>' +
        '<div class="teaser"></div>';
      body.querySelector('.focus').textContent = c.focusKo || c.focus;
      body.querySelector('.teaser').textContent = c.teaserKo || c.teaser;
      const badge = body.querySelector('.group-badge');

      div.appendChild(checkbox);
      div.appendChild(body);
      div.classList.toggle('checked', checkbox.checked);

      function toggle() { setChecked(c.id, !selected.has(c.id)); }
      checkbox.addEventListener('click', (e) => e.stopPropagation());
      checkbox.addEventListener('change', () => setChecked(c.id, checkbox.checked));
      div.addEventListener('click', () => {
        if (splitMode) cycleGroup(c.id); else toggle();
      });

      cardList.appendChild(div);
      cardEls[c.id] = { el: div, checkbox, badge };
    });
  }

  splitToggleBtn.addEventListener('click', () => {
    splitMode = !splitMode;
    splitToggleBtn.textContent = splitMode ? '한 편으로 합치기' : '두 편으로 나누기';
    splitToggleBtn.classList.toggle('on', splitMode);
    counterRowEl.style.display = splitMode ? 'none' : 'flex';
    counterPairRowEl.style.display = splitMode ? 'flex' : 'none';
    confirmBtn.textContent = splitMode ? '이렇게 두 편으로 만들기' : '이 디테일들로 확인';
    statusEl.textContent = '';
    statusEl.className = '';
    applyModeVisuals();
    if (splitMode) updateSplitCounters(); else updateCounter();
  });

  function showBanner(kind, html) {
    bannerEl.className = 'show ' + kind;
    bannerEl.innerHTML = html;
  }

  function appendLogLine(text) {
    logEl.classList.add('show');
    logEl.textContent += (logEl.textContent ? '\\n' : '') + text;
    logEl.scrollTop = logEl.scrollHeight;
  }

  confirmBtn.addEventListener('click', async () => {
    if (splitMode) {
      const part1Ids = Object.keys(groupAssignment).filter((id) => groupAssignment[id] === 1);
      const part2Ids = Object.keys(groupAssignment).filter((id) => groupAssignment[id] === 2);
      if (part1Ids.length < 2 || part2Ids.length < 2) return;
      confirmBtn.disabled = true;
      statusEl.textContent = '';
      statusEl.className = '';
      logEl.textContent = '';
      logEl.classList.remove('show');
      bannerEl.classList.remove('show');
      statusEl.textContent = '1부 ' + part1Ids.length + '개, 2부 ' + part2Ids.length + '개로 각각 대본을 작성하는 중... (1부가 끝나면 이 화면이 넘어가고, 2부는 완료되면 새 브라우저 탭이 자동으로 열립니다. 몇 분 걸릴 수 있어요)';
      try {
        const res = await fetch('/confirm-candidates-split', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ part1Ids: part1Ids, part2Ids: part2Ids }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || ('요청 실패 (' + res.status + ')'));
        }
        // 1부 완료는 /events의 script-ready로, 2부는 새 탭이 알아서 열리는 것으로 확인합니다.
      } catch (err) {
        statusEl.textContent = err.message;
        statusEl.className = 'err';
        confirmBtn.disabled = false;
      }
      return;
    }

    if (selected.size < 2) return;
    confirmBtn.disabled = true;
    statusEl.textContent = '';
    statusEl.className = '';
    logEl.textContent = '';
    logEl.classList.remove('show');
    bannerEl.classList.remove('show');
    statusEl.textContent = '선택한 ' + selected.size + '개로 대본을 작성하는 중... (몇십 초 걸릴 수 있어요)';
    try {
      const res = await fetch('/confirm-candidates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selectedIds: Array.from(selected) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || ('요청 실패 (' + res.status + ')'));
      }
      // 실제 생성은 /events SSE로 진행 상황이 오고, 끝나면 아래 es.onmessage가 새로고침합니다.
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'err';
      confirmBtn.disabled = false;
    }
  });

  const es = new EventSource('/events');
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'log') {
      appendLogLine(msg.text);
    } else if (msg.type === 'script-ready') {
      statusEl.textContent = '완료! 확대 위치 검토 화면으로 이동합니다...';
      statusEl.className = '';
      location.reload();
    } else if (msg.type === 'error') {
      statusEl.textContent = '실패';
      statusEl.className = 'err';
      showBanner('err', '대본 생성 중 오류가 발생했습니다: ' + escapeForHtml(msg.message));
      confirmBtn.disabled = false;
    }
  };

  function escapeForHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  buildMarkers();
  buildCards();
  CANDIDATES.forEach((c) => {
    markerEls[c.id].classList.toggle('active', selected.has(c.id));
  });
  updateCounter();
})();
</script>
</body>
</html>
`;
}
