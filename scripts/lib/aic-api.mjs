// Art Institute of Chicago(AIC) Open Access API 래퍼.
// 문서: https://api.artic.edu/docs/ — API 키가 필요 없고(익명 요청은 분당 60회로 제한),
// is_public_domain === true 인 작품은 CC0(저작권 없음)로 명시되어 있습니다. Met API와
// 마찬가지로 이 필드를 다시 한번 확인해서, 퍼블릭 도메인이 아닌 작품은 절대 쓰지 않습니다.
//
// 이 모듈은 Met API가 일시 차단(MET_BLOCKED)되었을 때 scripts/lib/painting-source.mjs가
// 자동으로 전환하는 대체(fallback) 소스입니다. AIC는 Met의 isHighlight=true 같은 "명작
// 큐레이션" 플래그를 공식적으로 제공하지 않아서(is_boosted/boost_rank가 비슷한 역할을 할
// 것으로 보이지만, 이 프로젝트를 만든 샌드박스 환경에서는 실제 쿼리 결과를 직접 검증할
// 네트워크 접근이 막혀 있어 확실하지 않습니다), searchCandidateIds()가 여러 단계로 점점
// 더 느슨한 검색을 시도하고, 최종적으로는 각 작품을 개별 조회해 isUsable()로 다시
// 검증하는 방식으로 안전핰게 동작하도록 만들었습니다 — 서버 쪽 필터가 예상과 다르게
// 동작하더라도, 실제로 채택되는 작품은 항상 이 파일의 클라이언트 쪽 검증을 통과한
// 것만입니다.

const BASE = 'https://api.artic.edu/api/v1';
const IIIF_BASE = 'https://www.artic.edu/iiif/2';
const USER_AGENT = 'Mozilla/5.0 (compatible; masterpiece-shorts/1.0; art-history video project)';

// AIC는 익명 요청을 분당 60회로 제한합니다 — 여유 있게 초당 1회 미만으로 유지합니다.
const MIN_REQUEST_INTERVAL_MS = 1100;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

async function throttledFetch(url) {
  const waitMs = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  lastRequestAt = Date.now();
  return fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
}

async function aicFetch(url, label = 'AIC API 요청') {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const backoff = 2000 * 2 ** (attempt - 1); // 2초, 4초
    let res;
    try {
      res = await throttledFetch(url);
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[aic-api] 네트워크 오류(${err.cause?.code || err.message}), ${backoff / 1000}초 후 재시도...`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
    if (res.ok) return res;
    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
      console.warn(`[aic-api] 일시 오류(${res.status}), ${backoff / 1000}초 후 재시도...`);
      await sleep(backoff);
      continue;
    }
    throw new Error(`${label} 실패 (${res.status}): ${url}`);
  }
}

async function fetchJson(url) {
  const res = await aicFetch(url);
  return res.json();
}

async function runSearch(params) {
  const qs = new URLSearchParams(params).toString();
  const data = await fetchJson(`${BASE}/artworks/search?${qs}`);
  return (data.data || []).map((d) => d.id);
}

// 아직 쓰지 않은 후보 objectID 목록을 가져옵니다. 여러 단계로 점점 느슨하게 시도합니다:
// 1단계: 공개 도메인 + "부각(is_boosted)" 큐레이션 작품 (Met의 isHighlight와 가장 비슷한 개념).
// 2단계: 공개 도메인 + "painting" 텍스트 검색 (1단계가 비어 있을 때).
// 3단계: 텍스트 검색만 (그마저도 비어 있을 때) — 이 경우 개별 작품 조회 후 isUsable()에서
//        공개 도메인 여부를 다시 확인하므로 안전합니다.
async function searchCandidateIds() {
  try {
    const boosted = await runSearch({
      'query[term][is_public_domain]': 'true',
      'query[term][is_boosted]': 'true',
      limit: '100',
      fields: 'id',
    });
    if (boosted.length > 0) {
      console.log(`[aic-api] "부각(boosted)" 큐레이션 작품 후보 ${boosted.length}개를 찾았습니다.`);
      return boosted;
    }
    console.warn('[aic-api] "부각" 큐레이션 검색 결과가 없어, 일반 공개 회화 검색으로 넘어갑니다.');
  } catch (err) {
    console.warn(`[aic-api] "부각" 큐레이션 검색 실패(${err.message}), 일반 검색으로 넘어갑니다.`);
  }

  try {
    const broad = await runSearch({
      q: 'painting',
      'query[term][is_public_domain]': 'true',
      limit: '100',
      fields: 'id',
    });
    if (broad.length > 0) {
      console.log(`[aic-api] 공개 도메인 회화 후보 ${broad.length}개를 찾았습니다.`);
      return broad;
    }
    console.warn('[aic-api] 공개 도메인 필터 검색 결과도 없어, 텍스트 검색만으로 후보를 가져옵니다.');
  } catch (err) {
    console.warn(`[aic-api] 공개 도메인 필터 검색 실패(${err.message}), 텍스트 검색만으로 후보를 가져옵니다.`);
  }

  const fallback = await runSearch({ q: 'painting', limit: '100', fields: 'id' });
  console.log(`[aic-api] 텍스트 검색 후보 ${fallback.length}개를 찾았습니다 (개별 작품 조회 시 다시 검증합니다).`);
  return fallback;
}

const FIELDS = [
  'id',
  'title',
  'artist_display',
  'artist_title',
  'date_display',
  'medium_display',
  'dimensions',
  'credit_line',
  'department_title',
  'classification_titles',
  'artwork_type_title',
  'is_public_domain',
  'image_id',
  'main_reference_number',
].join(',');

async function getRawObject(id) {
  const data = await fetchJson(`${BASE}/artworks/${id}?fields=${FIELDS}`);
  return data.data;
}

// European Paintings(11) 부서로 좁혀도 조각/프레임류가 섞일 수 있는 Met과 마찬가지로,
// AIC의 classification_titles/artwork_type_title도 실제 회화인지 다시 한번 확인합니다.
const NON_PAINTING_KEYWORDS = [
  'sculpture',
  'print',
  'photograph',
  'drawing',
  'textile',
  'ceramic',
  'furniture',
  'sketch',
  'relief',
];

function isActualPainting(obj) {
  const classification = (obj.classification_titles || []).join(' ').toLowerCase();
  const artworkType = (obj.artwork_type_title || '').toLowerCase();
  const combined = `${classification} ${artworkType}`;
  if (NON_PAINTING_KEYWORDS.some((kw) => combined.includes(kw))) return false;
  return combined.includes('painting');
}

// met-api.mjs의 REGIONS(서양:동양 = 9:1)와 같은 비율을 AIC에서도 지키기 위해, department_title로
// 대략적인 지역을 분류합니다. AIC 소장품 자체가 서양 미술 비중이 훨씬 커서, 불확실하면
// western으로 처리합니다 — Met과 똑같이 정확한 지역 학술 분류가 목적이 아니라, 두 지역의
// 콘텐츠 비율이 한쪽으로 쏠리지 않게 하는 실용적인 장치입니다.
const EASTERN_DEPARTMENT_HINTS = ['asia', 'asian'];

function classifyRegion(obj) {
  const dept = (obj.department_title || '').toLowerCase();
  if (EASTERN_DEPARTMENT_HINTS.some((hint) => dept.includes(hint))) return 'eastern';
  return 'western';
}

// 실제로 영상 소재로 쓸 수 있는 조건을 만족하는지 검증합니다 (raw AIC 필드 기준).
export function isUsable(obj) {
  return Boolean(
    obj &&
      obj.is_public_domain === true &&
      obj.image_id &&
      obj.title &&
      (obj.artist_title || obj.artist_display) &&
      isActualPainting(obj)
  );
}

// Met 파이프라인 전체가 기대하는 공통 형태(objectID, title, artistDisplayName, primaryImage,
// objectURL, isPublicDomain 등)로 변환합니다 — 이렇게 해두면 anthropic.mjs, video-builder.mjs
// 등 나머지 코드는 그림이 Met에서 왔는지 AIC에서 왔는지 신경 쓸 필요가 없습니다.
export function adaptAicObject(obj) {
  return {
    objectID: `aic:${obj.id}`,
    source: 'aic',
    region: classifyRegion(obj),
    sourceMuseumName: 'The Art Institute of Chicago (artic.edu)',
    title: obj.title,
    artistDisplayName: obj.artist_title || (obj.artist_display || '').split('\n')[0] || 'Unknown',
    artistDisplayBio: obj.artist_display || '',
    objectDate: obj.date_display || '',
    medium: obj.medium_display || '',
    dimensions: obj.dimensions || '',
    culture: '',
    department: obj.department_title || '',
    classification: (obj.classification_titles || []).join(', '),
    objectName: obj.artwork_type_title || '',
    creditLine: obj.credit_line || '',
    isPublicDomain: obj.is_public_domain === true,
    primaryImage: `${IIIF_BASE}/${obj.image_id}/full/843,/0/default.jpg`,
    objectURL: `https://www.artic.edu/artworks/${obj.id}`,
  };
}

export async function downloadImage(url) {
  const res = await aicFetch(url, '이미지 다운로드');
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// 아직 쓰지 않은 명화 하나를 고릅니다. usedIds는 'aic:' 접두어를 뗀 뒤의 숫자 id 목록
// (painting-source.mjs가 소스별로 걸러서 넘겨줍니다).
//
// preferredRegion을 주면(painting-source.mjs가 met-api.mjs의 pickRegionByWeight()로 뽑은
// 지역을 그대로 넘겨줍니다) 1차로 그 지역에 맞는 작품만 찾고, 하나도 없으면 지역 상관없이
// 아무 작품이나 채택합니다 — "비율은 최대한 지키되, 그것 때문에 아예 못 만드는 일은 없게"
// 하려는 의도입니다.
export async function pickUnusedAicPainting(usedIds, { preferredRegion } = {}) {
  const usedSet = new Set(usedIds.map(Number));
  const allIds = await searchCandidateIds();
  const shuffled = [...allIds].sort(() => Math.random() - 0.5);

  const fallbackCandidates = [];
  for (const id of shuffled) {
    if (usedSet.has(id)) continue;
    let obj;
    try {
      obj = await getRawObject(id);
    } catch (err) {
      console.warn(`[aic-api] id ${id} 조회 실패, 건너뜀:`, err.message);
      continue;
    }
    if (!isUsable(obj)) continue;
    const adapted = adaptAicObject(obj);
    if (!preferredRegion || adapted.region === preferredRegion) return adapted;
    fallbackCandidates.push(adapted);
  }
  if (fallbackCandidates.length > 0) {
    console.warn(
      `[aic-api] 선호 지역(${preferredRegion})에 맞는 작품을 못 찾아, 다른 지역의 작품으로 대신합니다.`
    );
    return fallbackCandidates[0];
  }
  return null;
}
