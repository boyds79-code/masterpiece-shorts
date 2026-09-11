// 메트로폴리탄 미술관(The Met) Open Access API 래퍼.
// 문서: https://metmuseum.github.io/ — API 키가 필요 없고, 반환되는 이미지/데이터는
// isPublicDomain === true 인 경우 CC0(저작권 없음)로 명시되어 있습니다.
// 우리는 이 필드를 반드시 다시 한번 확인해서, 퍼블릭 도메인이 아닌 작품은 절대 쓰지 않습니다.

const BASE = 'https://collectionapi.metmuseum.org/public/collection/v1';

// 유럽 회화(11)를 기본으로 하되, 필요하면 다른 부서도 추가할 수 있게 배열로 둡니다.
// isHighlight=true 는 Met이 자체적으로 "대표작/명작"으로 큐레이션한 작품만 걸러줍니다 —
// 우리가 임의로 유명한지 판단하지 않고 미술관의 큐레이션을 신뢰하는 방식입니다.
const DEPARTMENT_IDS = [11]; // European Paintings

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Met API 요청 실패 (${res.status}): ${url}`);
  }
  return res.json();
}

// 하이라이트(명작) 유화 작품의 objectID 목록을 가져옵니다.
export async function searchHighlightPaintingIds() {
  const ids = new Set();
  for (const deptId of DEPARTMENT_IDS) {
    const url = `${BASE}/search?isHighlight=true&hasImages=true&departmentIds=${deptId}&q=painting`;
    const data = await fetchJson(url);
    for (const id of data.objectIDs || []) ids.add(id);
  }
  return [...ids];
}

export async function getObject(objectId) {
  return fetchJson(`${BASE}/objects/${objectId}`);
}

// European Paintings(11) 부서로 검색을 좁혀도, 조각적 요소가 있는 패널/제단화나
// 틀(프레임)처럼 실제로는 회화가 아닌 오브제가 드물게 섞여 있을 수 있습니다 — 이 채널은
// "명화(그림)"만 다루므로, classification/objectName 필드로 실제 회화인지 한 번 더
// 확인하고 조각/구조물류로 분류된 작품은 명시적으로 제외합니다.
const NON_PAINTING_KEYWORDS = [
  'sculpture',
  'statue',
  'bust',
  'relief',
  'architecture',
  'architectural',
  'structure',
];

function isActualPainting(obj) {
  const classification = (obj.classification || '').toLowerCase();
  const objectName = (obj.objectName || '').toLowerCase();
  const combined = `${classification} ${objectName}`;
  if (NON_PAINTING_KEYWORDS.some((kw) => combined.includes(kw))) return false;
  return combined.includes('painting');
}

// 실제로 영상 소재로 쓸 수 있는 조건을 만족하는지 검증합니다.
export function isUsable(obj) {
  return Boolean(
    obj &&
      obj.isPublicDomain === true &&
      obj.primaryImage &&
      obj.primaryImage.length > 0 &&
      obj.title &&
      obj.artistDisplayName &&
      isActualPainting(obj)
  );
}

export async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`이미지 다운로드 실패 (${res.status}): ${url}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// 아직 쓰지 않은 명화 하나를 고릅니다. usedIds는 data/used-paintings.json의 objectID 목록.
export async function pickUnusedPainting(usedIds) {
  const usedSet = new Set(usedIds);
  const allIds = await searchHighlightPaintingIds();
  // 매번 같은 순서로 훑으면 항상 앞쪽 것만 걸릴 수 있으니 섞어서 훑습니다.
  const shuffled = [...allIds].sort(() => Math.random() - 0.5);

  for (const id of shuffled) {
    if (usedSet.has(id)) continue;
    let obj;
    try {
      obj = await getObject(id);
    } catch (err) {
      console.warn(`[met-api] objectID ${id} 조회 실패, 건너뜀:`, err.message);
      continue;
    }
    if (!isUsable(obj)) continue;
    return obj;
  }
  return null; // 모든 하이라이트 작품을 다 썼음 (department 추가를 고려할 시점)
}
