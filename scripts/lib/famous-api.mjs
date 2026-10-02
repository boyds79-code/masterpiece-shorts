// 유명도 기준으로 손으로 고른 "반드시 먼저 보여주고 싶은" 명화 목록을 관리하는 모듈.
//
// 왜 필요한가: Met/AIC는 공식 API로 접근 가능한 소장품 안에서만 고를 수 있어서, 사람들이
// 실제로 가장 많이 아는 명화들(클림트의 "키스", 다빈치의 "모나리자", 다비드의 "나폴레옹"
// 등) 중 상당수는 애초에 그 두 소장처에 없습니다. 이 모듈은 Wikimedia Commons(세계
// 미술관들의 퍼블릭 도메인 이미지를 모아놓은 곳)에서 이미지를 가져오는, 손으로 큐레이션한
// 세 번째 소스입니다.
//
// data/famous-paintings.json에 목록을 적어두면, painting-source.mjs가 Met/AIC보다 먼저
// 이 목록에서 "아직 안 쓴 작품"을 파일에 적힌 순서대로 골라 씁니다 — 화제성을 빨리 만들고
// 싶다는 요구에 맞춰, 유명한 작품부터 소진하고 그 다음에야 Met/AIC 자동 선정으로
// 넘어갑니다. 목록 순서 = 우선순위이므로, 더 보여주고 싶은 작품을 파일 위쪽으로 옮기면
// 됩니다.
//
// 저작권 참고: 이 목록에 넣는 작품은 전부 작가 사후 70년 이상 지났거나(예: 클림트 1918년
// 사망, 뭉크 1944년 사망) 소장 미술관이 직접 퍼블릭 도메인으로 공개한 작품만 골라야
// 합니다. 새 항목을 추가할 때 license 필드에 왜 퍼블릭 도메인인지 간단히 메모해두세요.
//
// generate-video.mjs의 재시도 루프(pickPaintingAndProduce)는 적합성 판단에서 거절된
// 그림을 바로 usedList에 skipped:true로 기록하고 저장하므로, 이 목록에서 어떤 그림이
// 거절되더라도 painting-source.mjs를 거쳐 usedIds에 자동으로 반영되어 같은 실행 안에서도
// 두 번 뽑히지 않습니다 — Met/AIC와 동일한 안전장치를 그대로 물려받습니다.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const LIST_PATH = path.join(ROOT, 'data', 'famous-paintings.json');

// Wikimedia Commons는 요청자를 식별할 수 있는 User-Agent를 요구합니다(없으면 차단될 수
// 있음) — 프로젝트 연락처를 명시합니다.
const USER_AGENT = 'masterpiece-shorts/1.0 (https://github.com/boyds79-code/masterpiece-shorts; contact: boyds79@gmail.com)';

const MIN_REQUEST_INTERVAL_MS = 1100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

async function throttledFetch(url, extraHeaders = {}) {
  const waitMs = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  lastRequestAt = Date.now();
  return fetch(url, { headers: { 'User-Agent': USER_AGENT, ...extraHeaders } });
}

function loadFamousList() {
  if (!fs.existsSync(LIST_PATH)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(LIST_PATH, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.warn(`[famous-api] ${LIST_PATH} 파싱 실패, 큐레이션 목록 없이 진행합니다: ${err.message}`);
    return [];
  }
}

// Wikimedia Commons 파일 "페이지" 제목(예: "Gustav_Klimt_016.jpg")으로 실제 이미지
// 다운로드 URL을 조회합니다 — 파일 페이지는 이미지 자체가 아니라서, 매번 API로 진짜
// 파일 URL(upload.wikimedia.org...)을 물어봐야 합니다. 파일이 재업로드/이름변경되는
// 드문 경우에도 항상 최신 URL을 받을 수 있습니다.
async function resolveCommonsImageUrl(commonsFile) {
  const params = new URLSearchParams({
    action: 'query',
    titles: `File:${commonsFile}`,
    prop: 'imageinfo',
    iiprop: 'url|mime',
    format: 'json',
    origin: '*',
  });
  const res = await throttledFetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, {
    Accept: 'application/json',
  });
  if (!res.ok) throw new Error(`Wikimedia Commons API 요청 실패 (${res.status}): ${commonsFile}`);
  const data = await res.json();
  const pages = data.query?.pages || {};
  const page = Object.values(pages)[0];
  if (page?.missing !== undefined) {
    throw new Error(`Wikimedia Commons에 "${commonsFile}" 파일이 없습니다 (파일명이 바뀌었을 수 있음).`);
  }
  const url = page?.imageinfo?.[0]?.url;
  if (!url) throw new Error(`Wikimedia Commons에서 "${commonsFile}"의 이미지 URL을 찾지 못했습니다.`);
  return url;
}

// 나머지 파이프라인(met-api.mjs/aic-api.mjs와 동일한 형태)이 기대하는 공통 객체 형태로
// 변환합니다 — anthropic.mjs, video-builder.mjs 등은 그림이 어느 소스에서 왔는지 신경
// 쓸 필요가 없습니다.
function adaptFamousEntry(entry, resolvedImageUrl) {
  return {
    objectID: `wiki:${entry.id}`,
    source: 'wiki',
    region: entry.region || 'western',
    sourceMuseumName: entry.sourceMuseumName,
    title: entry.title,
    artistDisplayName: entry.artistDisplayName,
    artistDisplayBio: entry.artistDisplayBio || '',
    objectDate: entry.objectDate || '',
    medium: entry.medium || '',
    dimensions: entry.dimensions || '',
    culture: entry.culture || '',
    department: entry.department || '',
    classification: 'Painting',
    objectName: 'Painting',
    creditLine: entry.creditLine || '',
    isPublicDomain: true,
    primaryImage: resolvedImageUrl,
    objectURL: entry.objectURL,
  };
}

// 큐레이션 목록에서 아직 안 쓴 작품을 "파일에 적힌 순서대로" 하나 고릅니다 — 순서가 곧
// 우선순위이므로, 더 보여주고 싶은 작품을 파일 위쪽으로 옮기면 됩니다.
//
// @param {string[]} usedWikiIds - painting-source.mjs가 'wiki:' 접두어를 뗀 뒤의 id
//   문자열 목록으로 걸러서 넘겨줍니다.
export async function pickUnusedFamousPainting(usedWikiIds) {
  const list = loadFamousList();
  const usedSet = new Set(usedWikiIds);

  for (const entry of list) {
    if (!entry.id) continue;
    if (usedSet.has(entry.id)) continue;
    if (!entry.commonsFile) {
      console.warn(`[famous-api] "${entry.id}" 항목에 commonsFile이 없어 건너뜁니다.`);
      continue;
    }
    try {
      const imageUrl = await resolveCommonsImageUrl(entry.commonsFile);
      return adaptFamousEntry(entry, imageUrl);
    } catch (err) {
      console.warn(`[famous-api] "${entry.id}" 이미지 조회 실패, 다음 후보로 넘어갑니다: ${err.message}`);
      continue;
    }
  }
  return null;
}

export async function downloadImage(url) {
  const res = await throttledFetch(url);
  if (!res.ok) throw new Error(`이미지 다운로드 실패 (${res.status}): ${url}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
