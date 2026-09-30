// Met API(기본 소스)와 AIC API(대체 소스)를 하나의 창구로 묶어주는 모듈.
// scripts/generate-video.mjs, generate-process-video.mjs, generate-longform-video.mjs는
// 이제 scripts/lib/met-api.mjs를 직접 쓰지 않고 이 파일의 pickUnusedPainting/downloadImage를
// 씁니다.
//
// 왜 필요한가: Met API가 짧은 기간에 여러 번 403(MET_BLOCKED)을 반환하면, 그 시점부터
// 한동안(보통 30분~몇 시간) 같은 IP의 요청이 계속 막힐 가능성이 큽니다. 그 상태에서
// 자동 스케줄이나 사람이 계속 재시도하면 오히려 차단이 길어질 수 있고, 무엇보다 그동안
// 영상을 하나도 만들 수 없습니다. 그래서:
//   1. Met이 MET_BLOCKED로 실패하면, data/.met-status.json에 "언제까지 Met을 쉴지"를
//      기록해두고, 즉시 대체 소스(AIC)로 넘어갑니다.
//   2. 그 이후 실행들은 쿨다운이 끝나기 전까지 Met을 아예 호출하지 않고 바로 AIC로
//      갑니다 — 차단 중인 API를 계속 두드리지 않기 위해서입니다.
//   3. 쿨다운이 끝나면 Met을 다시 정상적으로 시도하고, 성공하면 쿨다운 기록을 지웁니다.
//
// data/.met-status.json은 이 컴퓨터/네트워크(IP)에만 해당하는 임시 운영 상태라서 git에는
// 커밋하지 않습니다(.gitignore 참고) — 다른 환경에서 pull 받았을 때 남의 차단 상태를
// 그대로 물려받으면 안 되기 때문입니다.
import fs from 'node:fs';
import path from 'node:path';

import { pickUnusedPainting as pickUnusedMetPainting, downloadImage as downloadMetImage } from './met-api.mjs';
import { pickUnusedAicPainting, downloadImage as downloadAicImage } from './aic-api.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const STATUS_PATH = path.join(ROOT, 'data', '.met-status.json');

// Met이 안내하는 "30분~몇 시간" 중 보수적으로 2시간을 기본 쿨다운으로 씁니다.
const MET_BLOCK_COOLDOWN_MS = 2 * 60 * 60 * 1000;

function readMetStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  } catch {
    return { blockedUntil: null };
  }
}

function writeMetStatus(status) {
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
}

function isMetInCooldown() {
  const status = readMetStatus();
  if (!status.blockedUntil) return false;
  return new Date(status.blockedUntil).getTime() > Date.now();
}

function markMetBlocked() {
  const until = new Date(Date.now() + MET_BLOCK_COOLDOWN_MS).toISOString();
  writeMetStatus({ blockedUntil: until });
  console.warn(
    `[painting-source] Met API가 차단된 것으로 보여 ${until}까지 Met 요청을 건너뛰고 대체 소스(AIC)만 사용합니다.`
  );
}

function clearMetCooldownIfSet() {
  const status = readMetStatus();
  if (status.blockedUntil) writeMetStatus({ blockedUntil: null });
}

// data/used-paintings.json의 objectID는 두 가지 형태가 섞여 있을 수 있습니다:
//   - 접두어 없는 순수 숫자(문자열/숫자) — 이 기능을 추가하기 전, Met 전용이던 시절 기록.
//   - 'met:12345' / 'aic:6789' — 이 기능 이후 새로 저장되는 형태.
// 소스별로 걸러서 각 API가 이해하는 숫자 id 배열로 변환합니다.
function usedIdsForSource(usedIds, source) {
  const prefix = `${source}:`;
  return usedIds
    .filter((id) => {
      const s = String(id);
      if (s.includes(':')) return s.startsWith(prefix);
      return source === 'met'; // 접두어 없는 옛 기록은 전부 Met 것으로 간주합니다.
    })
    .map((id) => {
      const s = String(id);
      return Number(s.includes(':') ? s.slice(prefix.length) : s);
    });
}

export async function pickUnusedPainting(usedIds) {
  if (!isMetInCooldown()) {
    try {
      const metUsedIds = usedIdsForSource(usedIds, 'met');
      const obj = await pickUnusedMetPainting(metUsedIds);
      if (obj) {
        clearMetCooldownIfSet();
        return { ...obj, objectID: `met:${obj.objectID}`, source: 'met', sourceMuseumName: 'The Metropolitan Museum of Art (metmuseum.org)' };
      }
      console.warn('[painting-source] Met에서 아직 쓰지 않은 하이라이트 회화를 찾지 못해 대체 소스(AIC)를 시도합니다.');
    } catch (err) {
      if (err.code === 'MET_BLOCKED') {
        markMetBlocked();
      } else {
        throw err; // 진짜 버그일 수 있는 에러는 감추지 않고 그대로 올립니다.
      }
    }
  } else {
    console.warn('[painting-source] 최근 Met API 차단 기록이 있어 이번 실행은 Met을 건너뛰고 대체 소스(AIC)로 바로 진행합니다.');
  }

  console.log('[painting-source] 대체 소스(Art Institute of Chicago)에서 아직 쓰지 않은 명화를 고르는 중...');
  const aicUsedIds = usedIdsForSource(usedIds, 'aic');
  const aicObj = await pickUnusedAicPainting(aicUsedIds);
  if (!aicObj) {
    console.warn('[painting-source] 대체 소스(AIC)에서도 쓸 수 있는 새 작품을 찾지 못했습니다.');
    return null;
  }
  return aicObj;
}

export async function downloadImage(url) {
  if (url.includes('metmuseum.org')) return downloadMetImage(url);
  return downloadAicImage(url);
}
