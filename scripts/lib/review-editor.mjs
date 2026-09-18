// "숨은 의미" 대본의 각 구간 확대 위치(bbox)를 사람이 직접 드래그/리사이즈로 수정할 수 있는
// 편집기 페이지를 만듭니다. lib/review-server.mjs가 이 HTML을 로컬 서버로 서빙합니다 —
// "저장"/"실행하기" 버튼이 실제로 디스크에 쓰고 빌드를 실행하려면 fetch로 같은 서버의
// /save, /build를 호출해야 하므로, 이 페이지는 file://로 직접 열지 않고 반드시
// review-server.mjs가 띄운 http://127.0.0.1:.../ 로만 접속해야 합니다.

const MIN_SIZE = 0.12; // scripts/lib/anthropic.mjs의 MIN_SIZE와 맞춰둠 — 너무 작은 crop 방지

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * @param {object} params
 * @param {object} params.script - generateVideoScript()가 반환한 전체 대본 객체
 *   ({ youtube, segments: [{ narration, focus, gridPosition, bbox }, ...] })
 * @param {object} params.painting - Met API painting 객체 (title, artistDisplayName 등)
 * @param {string} [params.imageFile] - 서버가 서빙하는 이미지 경로(같은 서버 기준 상대경로). 기본 'original.jpg'.
 * @returns {string} 완성된 편집기 HTML 문자열
 */
export function buildEditorHtml({ script, painting, imageFile = 'original.jpg' }) {
  const dataJson = JSON.stringify(script).replace(/</g, '\\u003c'); // </script> 조기 종료 방지

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>확대 위치 검토 — ${escapeHtml(painting?.title || '')}</title>
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
  header p { margin: 0; font-size: 13px; color: #cfc9bd; }
  .layout {
    display: flex;
    gap: 20px;
    padding: 20px;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .stage {
    flex: 1 1 480px;
    max-width: 900px;
  }
  .stage-inner {
    position: relative;
    width: 100%;
    background: #000;
    overflow: hidden;
    border-radius: 6px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.25);
    touch-action: none;
  }
  .stage-inner img { display: block; width: 100%; height: 100%; user-select: none; -webkit-user-drag: none; pointer-events: none; }
  .box {
    position: absolute;
    border: 2px solid;
    background: rgba(255,255,255,0.08);
    cursor: move;
  }
  .box.selected { box-shadow: 0 0 0 2px #fff, 0 0 0 4px currentColor; }
  .box .tag {
    position: absolute;
    top: -22px;
    left: -2px;
    font-size: 11px;
    font-weight: 700;
    color: #fff;
    /* 배경색은 JS에서 각 태그마다 직접 지정합니다(el.style.background) — 이 규칙
       안에서 currentColor를 쓰면 바로 위 color:#fff 때문에 흰색 위에 흰색이 되어
       버립니다(자기 자신의 color 값을 참조하므로 부모 박스 색이 아니라 흰색이 됨). */
    background: #333;
    padding: 2px 6px;
    border-radius: 3px;
    white-space: nowrap;
  }
  .box .coords {
    position: absolute;
    bottom: -20px;
    left: -2px;
    font-size: 10px;
    color: #fff;
    background: rgba(0,0,0,0.65);
    padding: 1px 5px;
    border-radius: 3px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .handle {
    position: absolute;
    right: -7px;
    bottom: -7px;
    width: 14px;
    height: 14px;
    background: currentColor;
    border: 2px solid #fff;
    border-radius: 50%;
    cursor: nwse-resize;
  }
  .box.to-box { background: rgba(255,255,255,0.03); }
  .pan-line {
    position: absolute;
    left: 0;
    top: 0;
    height: 2px;
    transform-origin: 0 0;
    opacity: 0.75;
    pointer-events: none;
  }
  .pan-row { margin-top: 8px; }
  .pan-toggle {
    font-size: 11px;
    font-weight: 600;
    padding: 4px 9px;
    border-radius: 4px;
    border: 1px solid #ccc;
    background: #f5f4f0;
    color: #444;
    cursor: pointer;
  }
  .pan-toggle:hover { background: #ece9e2; }
  .coords-mini.to-mini { color: #888; }
  .sidebar {
    flex: 1 1 340px;
    max-width: 420px;
    max-height: 80vh;
    overflow-y: auto;
    background: #fff;
    border-radius: 6px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.1);
  }
  .seg {
    padding: 12px 14px;
    border-bottom: 1px solid #eee;
    cursor: pointer;
  }
  .seg:hover { background: #faf9f6; }
  .seg.selected { background: #fff6e6; }
  .seg .idx {
    display: inline-block;
    width: 20px;
    height: 20px;
    line-height: 20px;
    text-align: center;
    border-radius: 50%;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    margin-right: 6px;
  }
  .seg .idx.full { background: #999; }
  .seg .focus { font-weight: 600; font-size: 13.5px; }
  .seg .narration { font-size: 12.5px; color: #555; margin-top: 4px; line-height: 1.4; }
  .seg .full-note { font-size: 11.5px; color: #999; margin-top: 4px; }
  .toolbar {
    padding: 10px 14px;
    display: flex;
    gap: 8px;
    align-items: center;
    position: sticky;
    top: 0;
    background: #fff;
    border-bottom: 1px solid #eee;
    z-index: 2;
    flex-wrap: wrap;
  }
  button {
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    padding: 8px 14px;
    border-radius: 5px;
    border: none;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  #saveBtn { background: #eee; color: #333; }
  #saveBtn:hover:not(:disabled) { background: #e2e2e2; }
  #buildBtn { background: #1f6f43; color: #fff; }
  #buildBtn:hover:not(:disabled) { background: #185735; }
  #status { font-size: 12.5px; color: #666; margin-left: 2px; }
  #status.ok { color: #1f6f43; }
  #status.err { color: #c0392b; }
  #banner {
    margin: 0 14px 12px;
    padding: 10px 12px;
    border-radius: 5px;
    font-size: 13px;
    line-height: 1.5;
    display: none;
  }
  #banner.show { display: block; }
  #banner.ok { background: #e9f7ef; color: #1f6f43; }
  #banner.err { background: #fdecea; color: #c0392b; }
  #banner a { color: inherit; font-weight: 700; }
  #log {
    display: none;
    margin: 0 14px 14px;
    padding: 10px 12px;
    background: #1f1c17;
    color: #d7d2c7;
    border-radius: 5px;
    font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    max-height: 220px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  #log.show { display: block; }
</style>
</head>
<body>
<header>
  <h1>확대 위치(bbox) 검토 — ${escapeHtml(painting?.title || '(제목 없음)')}${painting?.artistDisplayName ? ' · ' + escapeHtml(painting.artistDisplayName) : ''}</h1>
  <p>박스를 드래그해서 옮기고, 오른쪽 아래 동그란 손잡이로 크기를 조절하세요. 크기를 조절할 때는 항상 실제 영상 화면 비율(9:16)로 고정되므로, 박스 모양 그대로가 최종 영상에서 보일 확대 화면입니다. 겹쳐서 안 잡히면 오른쪽 목록에서 해당 번호를 클릭하면 그 박스가 맨 위로 올라와 바로 조작할 수 있습니다. 회색 점선은 "전체 화면" 구간(도입/맥락/마무리)이라 수정할 필요가 없습니다. 각 구간 아래의 "패닝(이동) 추가" 버튼을 누르면 점선 박스(도착 지점)가 하나 더 생깁니다 — 두 박스를 각각 원하는 위치/크기로 두면 시작 박스에서 도착 박스로 화면이 서서히 이동하는 패닝(또는 틸트) 영상이 만들어집니다. 두 박스를 잇는 얇은 선은 이동 방향을 보여주기 위한 안내선일 뿐, 실제 영상에는 나오지 않습니다.</p>
</header>
<div class="layout">
  <div class="stage">
    <div class="stage-inner" id="stage">
      <img id="img" src="${imageFile}" alt="painting" />
    </div>
  </div>
  <div class="sidebar">
    <div class="toolbar">
      <button id="saveBtn">저장</button>
      <button id="buildBtn">실행하기 (영상 만들기)</button>
      <span id="status"></span>
    </div>
    <div id="banner"></div>
    <pre id="log"></pre>
    <div id="segList"></div>
  </div>
</div>

<script id="review-data" type="application/json">${dataJson}</script>
<script>
(function () {
  const ORIGINAL = JSON.parse(document.getElementById('review-data').textContent);
  const MIN_SIZE = ${MIN_SIZE};
  const PALETTE = ['#e0554c', '#3f8ee0', '#e0a83f', '#7c4fe0', '#3fae7d', '#e0559c', '#5f7ee0', '#c98a2c'];
  // 최종 영상은 항상 이 크기(scripts/lib/video-builder.mjs의 WIDTH/HEIGHT)로 만들어집니다.
  // bbox로 자른 영역을 이 비율에 맞춰 늘린 뒤 가운데를 기준으로 남는 부분을 잘라내므로,
  // 박스가 이 비율이 아니면 편집기에 보이는 모양과 실제로 영상에 나오는 화면이 달라집니다.
  const OUTPUT_W = 1080;
  const OUTPUT_H = 1920;
  // 리사이즈 중 박스의 x:y(fraction) 비율을 이 값으로 고정하면, 그림 원본 픽셀 기준으로
  // 잘라낸 영역의 실제 가로:세로 픽셀 비율이 정확히 OUTPUT_W:OUTPUT_H가 됩니다 — 그림
  // 자체의 원본 가로/세로 픽셀 비율(imgNaturalWidth/Height)이 1:1이 아니므로 보정이
  // 필요합니다. 이미지가 로드된 뒤 init()에서 실제 값으로 다시 계산합니다.
  let lockedRatio = OUTPUT_W / OUTPUT_H; // w/h, 이미지 로드 전 임시값

  function isFull(b) { return b.w >= 0.9 && b.h >= 0.9; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function fmt(b) { return 'x=' + b.x.toFixed(2) + ' y=' + b.y.toFixed(2) + ' w=' + b.w.toFixed(2) + ' h=' + b.h.toFixed(2); }

  // working: 화면에서 편집 중인 사본 (bbox만 다룸). narration/focus 등 나머지 필드는
  // 저장 시 ORIGINAL을 deep-copy해서 bbox만 덮어씁니다.
  let working = ORIGINAL.segments.map((s) => ({ ...s.bbox }));
  // workingTo: 패닝/틸트가 켜진 구간의 "도착 지점" bbox. 패닝이 꺼진 구간은 null입니다.
  let workingTo = ORIGINAL.segments.map((s) => (s.bboxTo ? { ...s.bboxTo } : null));

  const stage = document.getElementById('stage');
  const img = document.getElementById('img');
  const segList = document.getElementById('segList');
  const statusEl = document.getElementById('status');
  const bannerEl = document.getElementById('banner');
  const logEl = document.getElementById('log');
  const saveBtn = document.getElementById('saveBtn');
  const buildBtn = document.getElementById('buildBtn');

  // 박스 DOM 엘리먼트는 한 번만 만들고, 이후에는 스타일/텍스트만 갱신합니다 — 드래그 도중
  // 엘리먼트를 통째로 재생성하면 진행 중인 포인터 캡처가 끊겨서 드래그가 중간에 멈춥니다.
  // (패닝이 꺼진 구간은 buildBoxes()가 통째로 다시 그리므로 여기서는 신경쓰지 않습니다.)
  const boxEls = [];   // index -> { from: {el, coordsEl}, to: null|{el, coordsEl}, line: null|HTMLElement }
  const segEls = [];   // index -> sidebar row element

  // 박스가 서로 겹칠 때 항상 "번호가 큰 것"이 위(DOM 순서상 나중에 그려짐)에 오는 문제를
  // 고치기 위해, 선택된 박스의 z-index를 매번 새 최댓값으로 올려서 항상 맨 위로 가져옵니다.
  // 처음엔 박스마다 순서대로 z-index(1..N)를 깔아두므로, 새로 선택한 박스를 "확실히"
  // 모두보다 위로 올리려면 그 최댓값보다 큰 값에서부터 시작해야 합니다.
  let topZ = ORIGINAL.segments.length + 1;

  // which: 'from'(시작 지점, 기존 단일 박스) 또는 'to'(패닝 도착 지점, 있을 때만).
  function applyBoxStyle(i, which) {
    const entry = boxEls[i];
    if (!entry) return;
    const target = which === 'to' ? entry.to : entry.from;
    const b = which === 'to' ? workingTo[i] : working[i];
    if (!target || !b) return;
    const { el, coordsEl } = target;
    el.style.left = (b.x * 100) + '%';
    el.style.top = (b.y * 100) + '%';
    el.style.width = (b.w * 100) + '%';
    el.style.height = (b.h * 100) + '%';
    coordsEl.textContent = fmt(b);
    if (which === 'to') {
      const toMini = segEls[i]?.querySelector('.to-mini');
      if (toMini) toMini.textContent = '도착: ' + fmt(b);
    } else {
      const mini = segEls[i]?.querySelector('.coords-mini:not(.to-mini)');
      if (mini) mini.textContent = fmt(b);
    }
    updatePanLine(i);
  }

  // 두 박스(from/to)의 중심을 잇는 안내선의 위치/길이/각도를 stage의 실제 렌더링
  // 크기(px) 기준으로 계산합니다 — 그림이 정사각형이 아니라서 %만으로는 각도가
  // 틀어지기 때문에 반드시 실제 픽셀 크기로 변환해야 합니다.
  function updatePanLine(i) {
    const entry = boxEls[i];
    if (!entry || !entry.line) return;
    const bFrom = working[i];
    const bTo = workingTo[i];
    if (!bFrom || !bTo) return;
    const rect = stage.getBoundingClientRect();
    const x0 = (bFrom.x + bFrom.w / 2) * rect.width;
    const y0 = (bFrom.y + bFrom.h / 2) * rect.height;
    const x1 = (bTo.x + bTo.w / 2) * rect.width;
    const y1 = (bTo.y + bTo.h / 2) * rect.height;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    entry.line.style.left = x0 + 'px';
    entry.line.style.top = y0 + 'px';
    entry.line.style.width = len + 'px';
    entry.line.style.transform = 'rotate(' + angle + 'deg)';
  }

  function selectSegment(i) {
    topZ += 1;
    boxEls.forEach((entry, idx) => {
      const isSel = idx === i;
      if (entry.from) {
        entry.from.el.classList.toggle('selected', isSel);
        if (isSel) entry.from.el.style.zIndex = String(topZ);
      }
      if (entry.to) {
        entry.to.el.classList.toggle('selected', isSel);
        if (isSel) entry.to.el.style.zIndex = String(topZ);
      }
    });
    segEls.forEach((el, idx) => el.classList.toggle('selected', idx === i));
  }

  function buildBoxes() {
    stage.querySelectorAll('.box, .pan-line').forEach((el) => el.remove());
    boxEls.length = 0;

    ORIGINAL.segments.forEach((seg, i) => {
      const full = isFull(working[i]);
      const color = PALETTE[i % PALETTE.length];
      const el = document.createElement('div');
      el.className = 'box';
      el.dataset.seg = String(i);
      el.dataset.which = 'from';
      el.style.color = color;
      el.style.zIndex = String(i + 1); // 처음엔 순서대로, 이후 선택할 때마다 앞으로 옴

      if (full) {
        el.style.borderStyle = 'dashed';
        el.style.borderColor = '#bbb';
        el.style.color = '#bbb';
        el.style.cursor = 'default';
        // 전체 화면(도입/맥락/마무리) 박스는 화면 대부분을 덮기 때문에, 클릭을 그냥
        // 통과시키지 않으면 그 아래/뒤에 겹쳐 있는 디테일 박스를 전혀 드래그할 수 없게
        // 됩니다 (특히 CLOSE 구간은 항상 맨 마지막에 그려져서 다른 모든 박스를 덮습니다).
        el.style.pointerEvents = 'none';
      } else {
        el.style.borderColor = color;
      }

      // 전체 화면 박스는 가장자리까지 꽉 차서, 박스 바깥쪽에 붙는 번호표/좌표 라벨이
      // stage-inner의 overflow:hidden에 잘려 보입니다. 어차피 수정 대상도 아니므로 이
      // 라벨들은 디테일(non-full) 박스에만 붙입니다 — 사이드바의 "전체 화면" 표시로 충분.
      const coords = document.createElement('div');
      coords.className = 'coords';

      let toEntry = null;
      let lineEl = null;

      if (!full) {
        const tag = document.createElement('div');
        tag.className = 'tag';
        tag.style.background = color;
        tag.textContent = String(i + 1) + (workingTo[i] ? ' →' : '');
        el.appendChild(tag);
        el.appendChild(coords);

        const handle = document.createElement('div');
        handle.className = 'handle';
        el.appendChild(handle);
        attachDrag(el, i, 'from');
        attachResize(handle, i, 'from');

        if (workingTo[i]) {
          const toEl = document.createElement('div');
          toEl.className = 'box to-box';
          toEl.dataset.seg = String(i);
          toEl.dataset.which = 'to';
          toEl.style.color = color;
          toEl.style.borderColor = color;
          toEl.style.borderStyle = 'dashed';
          toEl.style.zIndex = String(i + 1);

          const toTag = document.createElement('div');
          toTag.className = 'tag';
          toTag.style.background = color;
          toTag.textContent = String(i + 1) + ' 도착';
          toEl.appendChild(toTag);

          const toCoords = document.createElement('div');
          toCoords.className = 'coords';
          toEl.appendChild(toCoords);

          const toHandle = document.createElement('div');
          toHandle.className = 'handle';
          toEl.appendChild(toHandle);
          attachDrag(toEl, i, 'to');
          attachResize(toHandle, i, 'to');

          stage.appendChild(toEl);
          toEntry = { el: toEl, coordsEl: toCoords };

          lineEl = document.createElement('div');
          lineEl.className = 'pan-line';
          lineEl.dataset.seg = String(i);
          lineEl.style.background = color;
          stage.appendChild(lineEl);
        }
      }

      stage.appendChild(el);
      boxEls.push({ from: { el, coordsEl: coords }, to: toEntry, line: lineEl });
      applyBoxStyle(i, 'from');
      if (toEntry) applyBoxStyle(i, 'to');
    });
  }

  // which: 'from' 또는 'to' — 드래그 대상이 시작 박스인지 패닝 도착 박스인지.
  function attachDrag(boxEl, i, which) {
    boxEl.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('handle')) return; // 리사이즈 핸들 쪽은 attachResize가 처리
      e.preventDefault();
      selectSegment(i);
      boxEl.setPointerCapture(e.pointerId);
      const rect = stage.getBoundingClientRect();
      const store = which === 'to' ? workingTo : working;
      const b0 = { ...store[i] };
      const startX = e.clientX, startY = e.clientY;

      function onMove(ev) {
        const dx = (ev.clientX - startX) / rect.width;
        const dy = (ev.clientY - startY) / rect.height;
        store[i] = {
          ...store[i],
          x: clamp(b0.x + dx, 0, 1 - b0.w),
          y: clamp(b0.y + dy, 0, 1 - b0.h),
        };
        applyBoxStyle(i, which);
      }
      function onUp() {
        boxEl.releasePointerCapture(e.pointerId);
        boxEl.removeEventListener('pointermove', onMove);
        boxEl.removeEventListener('pointerup', onUp);
      }
      boxEl.addEventListener('pointermove', onMove);
      boxEl.addEventListener('pointerup', onUp);
    });
  }

  // which: 'from' 또는 'to' — 리사이즈 대상이 시작 박스인지 패닝 도착 박스인지.
  // 두 박스 모두 같은 lockedRatio(9:16)로 고정되어야 두 지점 사이를 이동하는 동안
  // 화면 비율이 어긋나지 않습니다.
  function attachResize(handle, i, which) {
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      selectSegment(i);
      handle.setPointerCapture(e.pointerId);
      const rect = stage.getBoundingClientRect();
      const store = which === 'to' ? workingTo : working;
      const b0 = { ...store[i] };
      const startX = e.clientX, startY = e.clientY;

      function onMove(ev) {
        const dx = (ev.clientX - startX) / rect.width;
        const dy = (ev.clientY - startY) / rect.height;
        const maxW = 1 - b0.x;
        const maxH = 1 - b0.y;
        // 가로/세로 중 사용자가 더 많이 움직인 쪽을 기준으로 크기를 정하고, 나머지 한
        // 변은 lockedRatio(9:16)에 맞춰 그대로 따라오게 합니다 — 대각선으로 자유롭게
        // 끌어도 항상 최종 영상 화면과 같은 비율을 유지합니다.
        const wFromX = b0.w + dx;
        const wFromY = (b0.h + dy) * lockedRatio;
        let w = Math.abs(dx) >= Math.abs(dy) ? wFromX : wFromY;
        w = clamp(w, MIN_SIZE, maxW);
        let h = w / lockedRatio;
        if (h > maxH) {
          h = maxH;
          w = clamp(h * lockedRatio, MIN_SIZE, maxW);
        } else if (h < MIN_SIZE) {
          h = MIN_SIZE;
          w = clamp(h * lockedRatio, MIN_SIZE, maxW);
        }
        store[i] = { ...store[i], w, h };
        applyBoxStyle(i, which);
      }
      function onUp() {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
      }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }

  // 패닝을 새로 켤 때 사용할 기본 도착 지점을 제안합니다.
  //  - 이미 잘라둔 디테일 박스: 크기는 그대로 두고 오른쪽으로 옮길 수 있는 만큼
  //    옮긴 위치(오른쪽에 여유가 없으면 왼쪽)를 기본 도착 지점으로 삼습니다.
  //  - "전체 화면" 박스: 패닝 자체가 불가능하므로(이미 꽉 차 있어 이동할 공간이 없음),
  //    먼저 최종 화면 비율(lockedRatio)에 맞는 폭으로 좁혀 왼쪽 끝에 시작 박스를 두고,
  //    오른쪽 끝을 도착 박스로 삼는 좌→우 패닝을 기본값으로 만듭니다.
  function defaultPanTarget(b) {
    if (isFull(b)) {
      let h = 1;
      let w = h * lockedRatio;
      if (w > 1) { w = 1; h = w / lockedRatio; }
      if (w < MIN_SIZE) { w = MIN_SIZE; h = w / lockedRatio; }
      if (h < MIN_SIZE) { h = MIN_SIZE; w = h * lockedRatio; }
      const y = clamp((1 - h) / 2, 0, 1 - h);
      return {
        from: { x: 0, y, w, h },
        to: { x: clamp(1 - w, 0, 1 - w), y, w, h },
      };
    }
    const maxShift = 1 - b.w - b.x;
    const shift = maxShift > 0.02 ? maxShift : -b.x;
    const toX = clamp(b.x + shift, 0, 1 - b.w);
    return { from: b, to: { ...b, x: toX } };
  }

  function togglePan(i) {
    if (workingTo[i]) {
      workingTo[i] = null;
    } else {
      const { from, to } = defaultPanTarget(working[i]);
      working[i] = from;
      workingTo[i] = to;
    }
    buildBoxes();
    buildSidebar();
    selectSegment(i);
  }

  function buildSidebar() {
    segList.innerHTML = '';
    segEls.length = 0;
    ORIGINAL.segments.forEach((seg, i) => {
      const full = isFull(working[i]);
      const hasPan = !!workingTo[i];
      const div = document.createElement('div');
      div.className = 'seg';
      div.innerHTML =
        '<span class="idx' + (full ? ' full' : '') + '" style="' + (full ? '' : 'background:' + PALETTE[i % PALETTE.length]) + '">' + (i + 1) + '</span>' +
        '<span class="focus"></span>' +
        (full ? '<div class="full-note">전체 화면 (도입/맥락/마무리) — 수정 불필요</div>' : '<div class="coords-mini" style="font-size:11px;color:#888;margin-top:2px;"></div>') +
        '<div class="narration"></div>' +
        (full ? '' :
          '<div class="pan-row">' +
          '<button class="pan-toggle" type="button">' + (hasPan ? '패닝 끄기' : '패닝(이동) 추가') + '</button>' +
          (hasPan ? '<div class="coords-mini to-mini" style="font-size:11px;margin-top:2px;"></div>' : '') +
          '</div>');
      div.querySelector('.focus').textContent = seg.focus || '(focus 없음)';
      div.querySelector('.narration').textContent = seg.narration || '';
      const mini = div.querySelector('.coords-mini:not(.to-mini)');
      if (mini) mini.textContent = fmt(working[i]);
      const toMini = div.querySelector('.to-mini');
      if (toMini) toMini.textContent = '도착: ' + fmt(workingTo[i]);
      const panBtn = div.querySelector('.pan-toggle');
      if (panBtn) {
        // 패닝 토글은 행 클릭(선택)과 별개의 동작이므로 클릭 이벤트가 상위 div로
        // 전파되지 않게 막습니다.
        panBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          togglePan(i);
        });
      }
      // 번호(행 전체)를 클릭하면 해당 박스를 선택 + 맨 위로 올립니다 — 겹쳐서 클릭하기
      // 어려운 박스도 이 목록을 통해 항상 잡을 수 있게 하는 용도입니다.
      div.addEventListener('click', () => selectSegment(i));
      segList.appendChild(div);
      segEls.push(div);
    });
  }

  function buildOutputJson() {
    const out = JSON.parse(JSON.stringify(ORIGINAL));
    out.segments.forEach((seg, i) => {
      seg.bbox = {
        x: Math.round(working[i].x * 10000) / 10000,
        y: Math.round(working[i].y * 10000) / 10000,
        w: Math.round(working[i].w * 10000) / 10000,
        h: Math.round(working[i].h * 10000) / 10000,
      };
      if (workingTo[i]) {
        seg.bboxTo = {
          x: Math.round(workingTo[i].x * 10000) / 10000,
          y: Math.round(workingTo[i].y * 10000) / 10000,
          w: Math.round(workingTo[i].w * 10000) / 10000,
          h: Math.round(workingTo[i].h * 10000) / 10000,
        };
      } else {
        delete seg.bboxTo;
      }
    });
    return out;
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind || '';
  }

  async function doSave() {
    const res = await fetch('/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildOutputJson()),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || ('저장 실패 (' + res.status + ')'));
    }
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    setStatus('저장 중...');
    try {
      await doSave();
      setStatus('저장했습니다 (' + new Date().toLocaleTimeString('ko-KR') + ')', 'ok');
    } catch (err) {
      setStatus(err.message, 'err');
    } finally {
      saveBtn.disabled = false;
    }
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

  buildBtn.addEventListener('click', async () => {
    buildBtn.disabled = true;
    saveBtn.disabled = true;
    setStatus('저장 후 실행합니다...');
    try {
      await doSave(); // 실행하기는 항상 최신 화면 상태를 먼저 저장한 뒤 그 파일로 빌드합니다.
      setStatus('빌드 시작...', 'ok');
      const res = await fetch('/build', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || ('실행 실패 (' + res.status + ')'));
      }
      logEl.textContent = '';
      logEl.classList.add('show');
    } catch (err) {
      setStatus(err.message, 'err');
      buildBtn.disabled = false;
      saveBtn.disabled = false;
    }
  });

  const es = new EventSource('/events');
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'log') {
      appendLogLine(msg.text);
    } else if (msg.type === 'done') {
      setStatus('완료', 'ok');
      const u = msg.uploadResult || {};
      showBanner('ok',
        '완료되었습니다! <a href="' + u.studioUrl + '" target="_blank" rel="noopener">YouTube에서 검토하기</a>' +
        '<br>잠시 후 이 화면의 서버가 종료됩니다 — 탭은 그냥 닫으셔도 됩니다.');
      buildBtn.disabled = true;
      saveBtn.disabled = true;
    } else if (msg.type === 'error') {
      setStatus('실패', 'err');
      showBanner('err', '실행 중 오류가 발생했습니다: ' + escapeForHtml(msg.message));
      buildBtn.disabled = false;
      saveBtn.disabled = false;
    }
  };

  function escapeForHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Claude가 처음 정한 박스는 이 비율(lockedRatio)에 맞지 않을 수 있습니다 — 리사이즈를
  // 아예 안 건드려도 처음부터 "이 박스 그대로면 최종 화면이 이렇게 나온다"를 정확히
  // 보여주기 위해, 넓이(w*h)는 최대한 유지하면서 모양만 lockedRatio에 맞게 가운데를
  // 기준으로 보정합니다.
  function normalizeToLockedRatio(b) {
    const area = Math.max(b.w * b.h, MIN_SIZE * MIN_SIZE);
    let h = Math.sqrt(area / lockedRatio);
    let w = h * lockedRatio;
    if (w > 1) { w = 1; h = w / lockedRatio; }
    if (h > 1) { h = 1; w = h * lockedRatio; }
    if (w < MIN_SIZE) { w = MIN_SIZE; h = w / lockedRatio; }
    if (h < MIN_SIZE) { h = MIN_SIZE; w = h * lockedRatio; }
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    return {
      x: clamp(cx - w / 2, 0, 1 - w),
      y: clamp(cy - h / 2, 0, 1 - h),
      w,
      h,
    };
  }

  function init() {
    // bbox는 그림 원본 이미지의 가로/세로(fraction)로 저장되는데, 이 원본 이미지 자체가
    // 정사각형이 아니므로(예: 세로로 긴 초상화, 가로로 넓은 풍경화), "잘라낸 픽셀 영역이
    // 9:16이 되는 fraction 비율"은 그림마다 다릅니다. 그림이 로드된 뒤 실제 픽셀 크기
    // (naturalWidth/Height)로 정확히 계산합니다.
    if (img.naturalWidth && img.naturalHeight) {
      lockedRatio = (OUTPUT_W * img.naturalHeight) / (OUTPUT_H * img.naturalWidth);
    }
    working = working.map((b) => (isFull(b) ? b : normalizeToLockedRatio(b)));
    workingTo = workingTo.map((b) => (b ? normalizeToLockedRatio(b) : null));
    buildBoxes();
    buildSidebar();
  }

  // 창 크기가 바뀌면(브라우저 리사이즈) stage의 실제 픽셀 크기가 달라지므로, 패닝
  // 안내선의 각도/길이도 다시 계산해야 어긋나지 않습니다.
  window.addEventListener('resize', () => {
    ORIGINAL.segments.forEach((_, i) => { if (workingTo[i]) updatePanLine(i); });
  });

  if (img.complete) { init(); } else { img.addEventListener('load', init); }
})();
</script>
</body>
</html>
`;
}
