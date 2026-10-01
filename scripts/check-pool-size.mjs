// 지금 설정(Met REGIONS + AIC)으로 "아직 안 쓴" 명화 후보가 얼마나 남아있는지 추정하는
// 진단 스크립트입니다. masterpiece-shorts 실행 흐름에는 끼지 않고, 사용자가 "앞으로 얼마나
// 더 만들 수 있나" 궁금할 때 직접 실행해보는 용도입니다.
//
//   node scripts/check-pool-size.mjs
//
// 2026-10-01: Met이 구버전 검색 API(v1 /search)를 오늘부로 폐기하고 v1.1/search로
// 교체해서, 이 스크립트도 새 엔드포인트(페이지네이션 포함)로 맞췄습니다.
//
// 그리고 department 필터 자체를 믿지 않습니다 — 실제 샘플링으로 확인해보니 (v1 시절) 같은
// 쿼리에 다른 department를 줘도 완전히 같은 결과가 나왔습니다. 대신:
//   1. "isHighlight=true&hasImages=true&q=painting" (부서 필터 없이) 전체 하이라이트
//      회화 후보 목록을 가져옵니다 (v1.1이라 여러 페이지로 나눠서 끝까지 가져옵니다).
//   2. 이미 쓴 Met 작품을 제외합니다.
//   3. 남은 후보 중 일부를 무작위로 샘플링해서, 각각 실제 /objects/{id}를 조회해 진짜
//      department 필드를 확인합니다 (검색 필터는 못 믿어도 개별 작품 조회의 department
//      필드는 정확합니다 — 실제 파이프라인(met-api.mjs)도 바로 이 필드로 최종 검증합니다).
//   4. 샘플에서 서양(European Paintings/Robert Lehman Collection/Modern and Contemporary
//      Art) 비율과 동양(Asian Art) 비율을 계산해서, 전체 후보 수에 그 비율을 곱해 대략적인
//      서양/동양 잔여량을 추정합니다.
//
// 개별 작품을 백여 개 조회하므로 1~2분 정도 걸릴 수 있고, Met API에 짧게 여러 번
// 요청하므로 너무 자주 돌리지 마세요.
import './lib/load-env.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const USED_PATH = path.join(ROOT, 'data', 'used-paintings.json');

const SEARCH_BASE = 'https://collectionapi.metmuseum.org/public/collection/v1.1';
const OBJECTS_BASE = 'https://collectionapi.metmuseum.org/public/collection/v1';
const USER_AGENT = 'Mozilla/5.0 (compatible; masterpiece-shorts/1.0; pool-size check)';
const SAMPLE_SIZE = 120;
const REQUEST_INTERVAL_MS = 900;
const SEARCH_PAGE_LIMIT = 500;
const SEARCH_MAX_OFFSET = 10000;

const WESTERN_DEPARTMENTS = ['European Paintings', 'Robert Lehman Collection', 'Modern and Contemporary Art'];
const EASTERN_DEPARTMENTS = ['Asian Art'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadUsedMetIds() {
  if (!fs.existsSync(USED_PATH)) return new Set();
  const list = JSON.parse(fs.readFileSync(USED_PATH, 'utf8'));
  const ids = list.map((u) => String(u.objectID));
  const nums = ids
    .filter((id) => !id.includes(':') || id.startsWith('met:'))
    .map((id) => Number(id.includes(':') ? id.slice(4) : id));
  return new Set(nums);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${url} 실패 (${res.status})`);
  return res.json();
}

// v1.1/search는 한 페이지(최대 500개)만 주고 total로 전체 개수를 알려주는 방식이라,
// 필요하면 offset을 늘려가며 전체를 끝까지 가져옵니다.
async function searchAllHighlightPaintings() {
  const ids = [];
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({
      isHighlight: 'true',
      hasImages: 'true',
      q: 'painting',
      limit: String(SEARCH_PAGE_LIMIT),
      offset: String(offset),
    });
    const data = await fetchJson(`${SEARCH_BASE}/search?${params.toString()}`);
    const pageIds = data.objectIDs || [];
    ids.push(...pageIds);
    const total = typeof data.total === 'number' ? data.total : ids.length;
    offset += SEARCH_PAGE_LIMIT;
    if (pageIds.length === 0 || ids.length >= total || offset >= SEARCH_MAX_OFFSET) return { ids, total };
  }
}

function sample(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

async function main() {
  const usedMetIds = loadUsedMetIds();
  console.log(`[check-pool-size] data/used-paintings.json 기준, Met에서 이미 쓴 작품: ${usedMetIds.size}개`);

  const { ids: allIds, total } = await searchAllHighlightPaintings();
  const unusedIds = allIds.filter((id) => !usedMetIds.has(id));

  console.log(`[check-pool-size] 전체 하이라이트 회화 후보: ${total}개 (수집 ${allIds.length}개), 그중 아직 안 쓴 것: ${unusedIds.length}개\n`);

  if (unusedIds.length === 0) {
    console.log('안 쓴 후보가 없습니다 — Met 쪽은 완전히 소진된 상태로 보입니다.');
    return;
  }

  const sampleIds = sample(unusedIds, Math.min(SAMPLE_SIZE, unusedIds.length));
  console.log(`[check-pool-size] ${sampleIds.length}개를 무작위로 뽑아 실제 department를 하나씩 확인합니다 (시간이 좀 걸려요)...\n`);

  const counts = { western: 0, eastern: 0, other: 0, dead: 0 };
  const deptBreakdown = {};

  for (let i = 0; i < sampleIds.length; i++) {
    const id = sampleIds[i];
    try {
      const obj = await fetchJson(`${OBJECTS_BASE}/objects/${id}`);
      const dept = obj.department || '(알 수 없음)';
      deptBreakdown[dept] = (deptBreakdown[dept] || 0) + 1;
      if (WESTERN_DEPARTMENTS.includes(dept)) counts.western++;
      else if (EASTERN_DEPARTMENTS.includes(dept)) counts.eastern++;
      else counts.other++;
    } catch (err) {
      counts.dead++;
    }
    if ((i + 1) % 20 === 0) console.log(`  ...${i + 1}/${sampleIds.length} 확인함`);
    await sleep(REQUEST_INTERVAL_MS);
  }

  const validSampleSize = sampleIds.length - counts.dead;
  console.log(`\n샘플 ${sampleIds.length}개 중 실제 조회 성공: ${validSampleSize}개, 조회 실패(404 등 죽은 링크): ${counts.dead}개\n`);

  console.log('샘플의 department 분포:');
  for (const [dept, count] of Object.entries(deptBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${dept}: ${count}개`);
  }

  if (validSampleSize === 0) {
    console.log('\n유효한 샘플이 없어 추정이 불가능합니다.');
    return;
  }

  const westernRatio = counts.western / validSampleSize;
  const easternRatio = counts.eastern / validSampleSize;
  const estWestern = Math.round(unusedIds.length * westernRatio);
  const estEastern = Math.round(unusedIds.length * easternRatio);

  console.log(`\n추정 서양(European Paintings + Robert Lehman Collection + Modern and Contemporary Art) 안 쓴 후보: 약 ${estWestern}개`);
  console.log(`추정 동양(Asian Art) 안 쓴 후보: 약 ${estEastern}개`);
  console.log(
    '\n참고: 이제 v1.1 검색은 departmentId로 실제 필터가 되긴 하지만, 이 스크립트는 여전히 부서\n' +
      '필터 없이 전체를 가져온 뒤 무작위 샘플 + 실제 department 필드 확인으로 비율을 추정합니다\n' +
      '(부서별로 따로 여러 번 조회하는 것보다 API 요청을 아낄 수 있어서입니다). 샘플 크기가 작을수록\n' +
      '오차가 커질 수 있습니다. 또한 Met 쪽이 소진되더라도 지금은 AIC(Art Institute of Chicago)가\n' +
      '같은 비율로 자동 보충하도록 구현되어 있어서, 실제로 "더 이상 영상을 못 만드는" 하드 스톱은\n' +
      '아닙니다 — Met의 고품질 큐레이션 풀이 줄어들고 AIC 비중이 늘어나는 시점을 가늠하는 용도로\n' +
      '보시면 됩니다.'
  );
}

main().catch((err) => {
  console.error('[check-pool-size] 실패:', err);
  process.exit(1);
});
