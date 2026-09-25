// 메트로폴리탄 미술관(The Met) Open Access API 래퍼.
// 문서: https://metmuseum.github.io/ — API 키가 필요 없고, 반환되는 이미지/데이터는
// isPublicDomain === true 인 경우 CC0(저작권 없음)로 명시되어 있습니다.
// 우리는 이 필드를 반드시 다시 한번 확인해서, 퍼블릭 도메인이 아닌 작품은 절대 쓰지 않습니다.

const BASE = 'https://collectionapi.metmuseum.org/public/collection/v1';

// 화가의 지역(서양/동양)별로 어떤 Met 부서를 볼지, 그리고 그 지역이 뽑힐 확률(가중치)을
// 정의합니다. isHighlight=true 는 Met이 자체적으로 "대표작/명작"으로 큐레이션한 작품만
// 걸러줍니다 — 우리가 임의로 유명한지 판단하지 않고 미술관의 큐레이션을 신뢰하는 방식입니다.
//
// weight는 서로 합이 1이 되지 않아도 상관없습니다(비율로 정규화해서 씀) — 여기서는
// 사용자가 요청한 "동양 1 : 서양 9" 비율을 그대로 반영했습니다. 나중에 부서를 더
// 추가하고 싶으면 이 객체에 항목을 늘리면 됩니다.
const REGIONS = {
  western: { departmentIds: [11], departmentNames: ['European Paintings'], weight: 9 },
  eastern: { departmentIds: [6], departmentNames: ['Asian Art'], weight: 1 },
};

// Met API는 짧은 시간에 요청이 몰리면 그 IP를 한동안 403으로 차단합니다. 차단된 상태에서
// 계속 다음 작품을 조회하면 403만 수십 번 쌓이면서 차단이 더 길어질 수 있어서, 아래 세 가지로
// 막습니다:
// 1. 모든 요청에 User-Agent를 붙여 봇으로 오인될 가능성을 줄입니다.
// 2. 요청 사이에 최소 간격(MIN_REQUEST_INTERVAL_MS)을 둬서 한꺼번에 몰리지 않게 합니다.
// 3. 403이 MAX_CONSECUTIVE_403번 연속으로 나오면 "차단 중"으로 보고 즉시 멈춥니다.
// 429/5xx나 일시적인 네트워크 끊김은 잠깐 기다렸다가 다시 시도합니다.
const USER_AGENT = 'Mozilla/5.0 (compatible; masterpiece-shorts/1.0; art-history video project)';
const MIN_REQUEST_INTERVAL_MS = 300;
const MAX_CONSECUTIVE_403 = 3;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;
let consecutive403 = 0;

async function throttledFetch(url) {
  const waitMs = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  lastRequestAt = Date.now();
  return fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, image/*;q=0.9, */*;q=0.8' } });
}

async function metFetch(url, label = 'Met API 요청') {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const backoff = 2000 * 2 ** (attempt - 1); // 2초, 4초
    let res;
    try {
      res = await throttledFetch(url);
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[met-api] 네트워크 오류(${err.cause?.code || err.message}), ${backoff / 1000}초 후 재시도...`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }

    if (res.status === 403) {
      consecutive403++;
      if (consecutive403 >= MAX_CONSECUTIVE_403) {
        throw Object.assign(
          new Error(
            `Met API가 ${consecutive403}번 연속으로 403(접근 거부)을 반환했습니다 — 요청이 몰려 일시적으로 차단된 상태로 보입니다. ` +
              '더 요청하면 차단이 길어질 수 있어 여기서 멈춥니다. 30분~몇 시간 뒤에 다시 실행하거나, 다른 네트워크(휴대폰 핫스팟 등)에서 실행하세요.'
          ),
          { code: 'MET_BLOCKED' }
        );
      }
      throw new Error(`${label} 실패 (403): ${url}`);
    }
    consecutive403 = 0;

    if (res.ok) return res;

    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
      console.warn(`[met-api] 일시 오류(${res.status}), ${backoff / 1000}초 후 재시도...`);
      await sleep(backoff);
      continue;
    }
    throw new Error(`${label} 실패 (${res.status}): ${url}`);
  }
}

async function fetchJson(url) {
  const res = await metFetch(url);
  return res.json();
}

// 특정 부서 ID들의 하이라이트(명작) 유화 작품 objectID 목록을 가져옵니다.
async function searchHighlightPaintingIdsForDepartments(departmentIds) {
  const ids = new Set();
  for (const deptId of departmentIds) {
    const url = `${BASE}/search?isHighlight=true&hasImages=true&departmentIds=${deptId}&q=painting`;
    const data = await fetchJson(url);
    for (const id of data.objectIDs || []) ids.add(id);
  }
  return [...ids];
}

// 하위 호환용 — 기존에 이 함수를 쓰던 코드가 있다면 서양 회화 목록을 그대로 돌려줍니다.
export async function searchHighlightPaintingIds() {
  return searchHighlightPaintingIdsForDepartments(REGIONS.western.departmentIds);
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
  const res = await metFetch(url, '이미지 다운로드');
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// REGIONS의 weight에 비례해서 지역 하나를 뽑습니다 (가중치 있는 랜덤 선택).
function pickRegionByWeight() {
  const entries = Object.entries(REGIONS);
  const total = entries.reduce((sum, [, r]) => sum + r.weight, 0);
  let r = Math.random() * total;
  for (const [region, def] of entries) {
    r -= def.weight;
    if (r < 0) return region;
  }
  return entries[0][0];
}

// 아직 쓰지 않은 명화 하나를 고릅니다. usedIds는 data/used-paintings.json의 objectID 목록.
//
// 먼저 REGIONS의 가중치대로 지역(서양/동양)을 하나 뽑고, 그 지역에 해당하는 부서에서만
// 찾습니다. Met API의 departmentIds 필터는 q=painting 같은 텍스트 검색과 함께 쓰면
// 완벽하게 걸러주지 않는 경우가 있어서(다른 부서 작품이 섞여 나올 수 있음), obj.department
// 값을 다시 한번 확인해 실제로 그 지역 부서가 맞는 작품만 채택합니다 — 그래야 가중치가
// 실제 결과 비율과 어긋나지 않습니다.
//
// 뽑은 지역에 남은(안 쓴) 작품이 없으면 다른 지역들도 순서대로 시도해서, 전체 하이라이트를
// 다 쓰기 전까지는 가능한 한 null을 반환하지 않도록 합니다.
export async function pickUnusedPainting(usedIds) {
  const usedSet = new Set(usedIds);
  const firstRegion = pickRegionByWeight();
  const regionOrder = [firstRegion, ...Object.keys(REGIONS).filter((r) => r !== firstRegion)];

  for (const region of regionOrder) {
    const def = REGIONS[region];
    const allIds = await searchHighlightPaintingIdsForDepartments(def.departmentIds);
    // 매번 같은 순서로 훑으면 항상 앞쪽 것만 걸릴 수 있으니 섞어서 훑습니다.
    const shuffled = [...allIds].sort(() => Math.random() - 0.5);

    for (const id of shuffled) {
      if (usedSet.has(id)) continue;
      let obj;
      try {
        obj = await getObject(id);
      } catch (err) {
        if (err.code === 'MET_BLOCKED') throw err; // 차단 중이면 더 두드리지 않고 바로 멈춤
        console.warn(`[met-api] objectID ${id} 조회 실패, 건너뜀:`, err.message);
        continue;
      }
      if (!isUsable(obj)) continue;
      if (!def.departmentNames.includes(obj.department)) continue;
      return obj;
    }
    console.warn(`[met-api] "${region}" 지역에서 쓸 수 있는 새 작품을 찾지 못해 다른 지역을 시도합니다.`);
  }
  return null; // 모든 지역의 하이라이트 작품을 다 썼음 (department 추가를 고려할 시점)
}