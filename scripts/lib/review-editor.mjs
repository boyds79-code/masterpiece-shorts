// "숨은 의미" 대본의 각 구간 확대 위치(bbox)를 사람이 직접 드래그/리사이즈로 수정할 수 있는
// 정적 HTML 편집기를 만듭니다. generate-review.mjs가 이 HTML을 리뷰 폴더에
// original.jpg와 나란히 저장해두면, 사용자가 브라우저에서 그 파일을 그냥 열어서 씁니다
// (서버/빌드 과정 없이 file:// 로 바로 동작하는 순수 정적 페이지).

const MIN_SIZE = 0.12; // scripts/lib/anthropic.mjs의 MIN_SIZE와 맞춰둠 — 너무 작은 crop 방지

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * @param {object} params
 * @param {object} params.script - generateVideoScript()가 반환한 전체 대본 객체
 *   ({ youtube, segments: [{ narration, focus, gridPosition, bbox }, ...] })
 * @param {object} params.painting - Met API painting 객체 (title, artistDisplayName 등)
 * @param {string} [params.imageFile] - 이미지 파일명(같은 폴더에 있어야 함). 기본 'original.jpg'.
 * @returns {string} 완성된 editor.html 문자열
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
    background: currentColor;
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
    position: sticky;
    top: 0;
    background: #fff;
    border-bottom: 1px solid #eee;
    z-index: 2;
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
  #exportBtn { background: #1f6f43; color: #fff; }
  #exportBtn:hover { background: #185735; }
  #resetBtn { background: #eee; color: #333; }
  #resetBtn:hover { background: #e2e2e2; }
  #status { font-size: 12.5px; color: #1f6f43; margin-left: 4px; align-self: center; }
</style>
</head>
<body>
<header>
  <h1>확대 위치(bbox) 검토 — ${escapeHtml(painting?.title || '(제목 없음)')}${painting?.artistDisplayName ? ' · ' + escapeHtml(painting.artistDisplayName) : ''}</h1>
  <p>박스를 드래그해서 옮기고, 오른쪽 아래 동그란 손잡이로 크기를 조절하세요. 회색 점선은 "전체 화면" 구간(도입/맥락/마무리)이라 수정할 필요가 없습니다. 다 고쳤으면 오른쪽 위 "script.json 내보내기"를 누르세요.</p>
</header>
<div class="layout">
  <div class="stage">
    <div class="stage-inner" id="stage">
      <img id="img" src="${imageFile}" alt="painting" />
    </div>
  </div>
  <div class="sidebar">
    <div class="toolbar">
      <button id="exportBtn">script.json 내보내기</button>
      <button id="resetBtn">전체 되돌리기</button>
      <span id="status"></span>
    </div>
    <div id="segList"></div>
  </div>
</div>

<script id="review-data" type="application/json">${dataJson}</script>
<script>
(function () {
  const ORIGINAL = JSON.parse(document.getElementById('review-data').textContent);
  const MIN_SIZE = ${MIN_SIZE};
  const PALETTE = ['#e0554c', '#3f8ee0', '#e0a83f', '#7c4fe0', '#3fae7d', '#e0559c', '#5f7ee0', '#c98a2c'];

  function isFull(b) { return b.w >= 0.9 && b.h >= 0.9; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function fmt(b) { return 'x=' + b.x.toFixed(2) + ' y=' + b.y.toFixed(2) + ' w=' + b.w.toFixed(2) + ' h=' + b.h.toFixed(2); }

  // working: 화면에서 편집 중인 사본 (bbox만 다룸). narration/focus 등 나머지 필드는
  // export 시 ORIGINAL을 deep-copy해서 bbox만 덮어씁니다.
  let working = ORIGINAL.segments.map((s) => ({ ...s.bbox }));

  const stage = document.getElementById('stage');
  const img = document.getElementById('img');
  const segList = document.getElementById('segList');
  const statusEl = document.getElementById('status');

  // 박스 DOM 엘리먼트는 한 번만 만들고, 이후에는 스타일/텍스트만 갱신합니다 — 드래그 도중
  // 엘리먼트를 통째로 재생성하면 진행 중인 포인터 캡처가 끊겨서 드래그가 중간에 멈춥니다.
  const boxEls = [];   // index -> { el, coordsEl }
  const segEls = [];   // index -> sidebar row element

  function applyBoxStyle(i) {
    const { el, coordsEl } = boxEls[i];
    const b = working[i];
    el.style.left = (b.x * 100) + '%';
    el.style.top = (b.y * 100) + '%';
    el.style.width = (b.w * 100) + '%';
    el.style.height = (b.h * 100) + '%';
    coordsEl.textContent = fmt(b);
    const mini = segEls[i]?.querySelector('.coords-mini');
    if (mini) mini.textContent = fmt(b);
  }

  function selectSegment(i) {
    boxEls.forEach(({ el }, idx) => el.classList.toggle('selected', idx === i));
    segEls.forEach((el, idx) => el.classList.toggle('selected', idx === i));
  }

  function buildBoxes() {
    stage.querySelectorAll('.box').forEach((el) => el.remove());
    boxEls.length = 0;

    ORIGINAL.segments.forEach((seg, i) => {
      const full = isFull(working[i]);
      const color = PALETTE[i % PALETTE.length];
      const el = document.createElement('div');
      el.className = 'box';
      el.style.color = color;

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

      // 전체 화면(도입/맥락/마무리) 박스는 화면 가장자리까지 꽉 차서, 박스 바깥쪽에 붙는
      // 번호표/좌표 라벨이 stage-inner의 overflow:hidden에 잘려 보입니다. 어차피 수정
      // 대상도 아니므로 이 라벨들은 디테일(non-full) 박스에만 붙입니다 — 사이드바에
      // "전체 화면" 표시로 충분합니다.
      const coords = document.createElement('div');
      coords.className = 'coords';

      if (!full) {
        const tag = document.createElement('div');
        tag.className = 'tag';
        tag.textContent = String(i + 1);
        el.appendChild(tag);
        el.appendChild(coords);

        const handle = document.createElement('div');
        handle.className = 'handle';
        el.appendChild(handle);
        attachDrag(el, i);
        attachResize(handle, i);
      }

      stage.appendChild(el);
      boxEls.push({ el, coordsEl: coords });
      applyBoxStyle(i);
    });
  }

  function attachDrag(boxEl, i) {
    boxEl.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('handle')) return; // 리사이즈 핸들 쪽은 attachResize가 처리
      e.preventDefault();
      selectSegment(i);
      boxEl.setPointerCapture(e.pointerId);
      const rect = stage.getBoundingClientRect();
      const b0 = { ...working[i] };
      const startX = e.clientX, startY = e.clientY;

      function onMove(ev) {
        const dx = (ev.clientX - startX) / rect.width;
        const dy = (ev.clientY - startY) / rect.height;
        working[i] = {
          ...working[i],
          x: clamp(b0.x + dx, 0, 1 - b0.w),
          y: clamp(b0.y + dy, 0, 1 - b0.h),
        };
        applyBoxStyle(i);
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

  function attachResize(handle, i) {
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      selectSegment(i);
      handle.setPointerCapture(e.pointerId);
      const rect = stage.getBoundingClientRect();
      const b0 = { ...working[i] };
      const startX = e.clientX, startY = e.clientY;

      function onMove(ev) {
        const dx = (ev.clientX - startX) / rect.width;
        const dy = (ev.clientY - startY) / rect.height;
        working[i] = {
          ...working[i],
          w: clamp(b0.w + dx, MIN_SIZE, 1 - b0.x),
          h: clamp(b0.h + dy, MIN_SIZE, 1 - b0.y),
        };
        applyBoxStyle(i);
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

  function buildSidebar() {
    segList.innerHTML = '';
    segEls.length = 0;
    ORIGINAL.segments.forEach((seg, i) => {
      const full = isFull(working[i]);
      const div = document.createElement('div');
      div.className = 'seg';
      div.innerHTML =
        '<span class="idx' + (full ? ' full' : '') + '" style="' + (full ? '' : 'background:' + PALETTE[i % PALETTE.length]) + '">' + (i + 1) + '</span>' +
        '<span class="focus"></span>' +
        (full ? '<div class="full-note">전체 화면 (도입/맥락/마무리) — 수정 불필요</div>' : '<div class="coords-mini" style="font-size:11px;color:#888;margin-top:2px;"></div>') +
        '<div class="narration"></div>';
      div.querySelector('.focus').textContent = seg.focus || '(focus 없음)';
      div.querySelector('.narration').textContent = seg.narration || '';
      const mini = div.querySelector('.coords-mini');
      if (mini) mini.textContent = fmt(working[i]);
      div.addEventListener('click', () => selectSegment(i));
      segList.appendChild(div);
      segEls.push(div);
    });
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  document.getElementById('exportBtn').addEventListener('click', () => {
    const out = JSON.parse(JSON.stringify(ORIGINAL));
    out.segments.forEach((seg, i) => {
      seg.bbox = {
        x: Math.round(working[i].x * 10000) / 10000,
        y: Math.round(working[i].y * 10000) / 10000,
        w: Math.round(working[i].w * 10000) / 10000,
        h: Math.round(working[i].h * 10000) / 10000,
      };
    });
    download('script.json', JSON.stringify(out, null, 2));
    statusEl.textContent = 'script.json 다운로드 완료 — 리뷰 폴더의 기존 script.json을 이 파일로 덮어써주세요.';
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    working = ORIGINAL.segments.map((s) => ({ ...s.bbox }));
    boxEls.forEach((_, i) => applyBoxStyle(i));
    buildSidebar();
    statusEl.textContent = '';
  });

  function init() {
    buildBoxes();
    buildSidebar();
  }

  if (img.complete) { init(); } else { img.addEventListener('load', init); }
})();
</script>
</body>
</html>
`;
}
