// 지금 설정(Met REGIONS + AIC)으로 "아직 안 쓴" 명화 후보가 각 부서/소스별로 몇 개나
// 남아있는지 보여주는 진단 스크립트입니다. masterpiece-shorts 실행 흐름에는 끼지 않고,
// 사용자가 "앞으로 얼마나 더 만들 수 있나" 궁금할 때 직접 실행해보는 용도입니다.
//
//   node scripts/check-pool-size.mjs
//
// Met API 자체에 짧게 여러 번 요청하므로, 너무 자주 돌리면 met-api.mjs가 걱정하는 바로
// 그 403 차단에 기여할 수 있습니다 — 궁금할 때 가끔 한 번씩만 돌려보세요.
import './lib/load-env.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const USED_PATH = path.join(ROOT, 'data', 'used-paintings.json');

const MET_BASE = 'https://collectionapi.metmuseum.org/public/collection/v1';
const DEPARTMENTS = [
  { id: 11, name: 'European Paintings', region: 'western' },
  { id: 15, name: 'The Robert Lehman Collection', region: 'western' },
  { id: 21, name: 'Modern Art', region: 'western' },
  { id: 6, name: 'Asian Art', region: 'eastern' },
];

function loadUsedMetIds() {
  if (!fs.existsSync(USED_PATH)) return new Set();
  const list = JSON.parse(fs.readFileSync(USED_PATH, 'utf8'));
  const ids = list.map((u) => String(u.objectID));
  const nums = ids
    .filter((id) => !id.includes(':') || id.startsWith('met:'))
    .map((id) => Number(id.includes(':') ? id.slice(4) : id));
  return new Set(nums);
}

async function fetchDeptHighlightIds(deptId) {
  const url = `${MET_BASE}/search?isHighlight=true&hasImages=true&departmentIds=${deptId}&q=painting`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; masterpiece-shorts/1.0; pool-size check)' },
  });
  if (!res.ok) throw new Error(`${url} 실패 (${res.status})`);
  const data = await res.json();
  return data.objectIDs || [];
}

async function main() {
  const usedMetIds = loadUsedMetIds();
  console.log(`[check-pool-size] data/used-paintings.json 기준, Met에서 이미 쓴 작품: ${usedMetIds.size}개\n`);

  let totalWesternUnused = 0;
  let totalEasternUnused = 0;

  for (const dept of DEPARTMENTS) {
    let ids;
    try {
      ids = await fetchDeptHighlightIds(dept.id);
    } catch (err) {
      console.error(`[check-pool-size] 부서 ${dept.id} (${dept.name}) 조회 실패: ${err.message}`);
      continue;
    }
    const unused = ids.filter((id) => !usedMetIds.has(id));
    console.log(
      `부서 ${dept.id} (${dept.name}, ${dept.region}): 하이라이트 총 ${ids.length}개 중 안 쓴 것 ${unused.length}개`
    );
    if (dept.region === 'western') totalWesternUnused += unused.length;
    else totalEasternUnused += unused.length;
    // Met 요청 사이에 살짝 쉬어서 짧은 시간에 몰리지 않게 합니다.
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`\n서양(western) 합계 안 쓴 후보: ${totalWesternUnused}개`);
  console.log(`동양(eastern) 합계 안 쓴 후보: ${totalEasternUnused}개`);
  console.log(
    '\n참고: 이 숫자들은 "isUsable() 재검증(실제 회화인지, 이미지가 있는지 등)" 전의 원시 후보 수라서,\n' +
      '실제로 끝까지 통과해서 쓸 수 있는 개수는 이보다 조금 적을 수 있습니다. 또한 Met이 가끔 관리하는\n' +
      '작품 목록 자체는 서서히 바뀌므로(새 하이라이트 추가 등), 이 숫자는 "지금 이 순간" 기준입니다.\n' +
      'AIC(Art Institute of Chicago)는 Met이 차단되거나 소진됐을 때만 쓰이는 대체 소스라서 여기 집계에는\n' +
      '포함하지 않았습니다 — AIC 쪽은 공개 도메인 회화 자체가 훨씬 많아서 당분간 소진 걱정은 적습니다.'
  );
}

main().catch((err) => {
  console.error('[check-pool-size] 실패:', err);
  process.exit(1);
});
