import fs from 'node:fs';
import path from 'node:path';

// "숨은 의미" 파이프라인이 공통으로 쓰는 data/used-paintings.json, data/log.md 읽기/쓰기를
// 한 곳에 모아둔 모듈입니다. generate-video.mjs(자동 실행), generate-review.mjs(리뷰용
// 대본만 생성), build-from-review.mjs(리뷰 확정 후 영상 제작)가 모두 이 모듈을 씁니다 —
// 세 스크립트가 각자 파일을 열고 닫으면 "같은 그림을 리뷰 중인데 자동 실행이 또 뽑아가는"
// 것처럼 상태가 어긋날 수 있어서, 로직을 한 군데로 모았습니다.

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const USED_PATH = path.join(ROOT, 'data', 'used-paintings.json');
const LOG_PATH = path.join(ROOT, 'data', 'log.md');

export function loadUsed() {
  if (!fs.existsSync(USED_PATH)) return [];
  return JSON.parse(fs.readFileSync(USED_PATH, 'utf8'));
}

export function saveUsed(list) {
  fs.mkdirSync(path.dirname(USED_PATH), { recursive: true });
  fs.writeFileSync(USED_PATH, JSON.stringify(list, null, 2) + '\n');
}

// objectID가 이미 목록에 있으면 그 항목을 새 필드로 덮어쓰고(merge), 없으면 새로 추가합니다.
// 리뷰 흐름에서 "리뷰 예약(reservedForReview) -> 빌드 완료(usedAt/videoIdMeaning)"로
// 같은 항목을 업데이트할 때 씁니다.
export function upsertUsed(list, entry) {
  const idx = list.findIndex((u) => u.objectID === entry.objectID);
  if (idx === -1) {
    list.push(entry);
  } else {
    list[idx] = { ...list[idx], ...entry };
  }
  return list;
}

export function appendLog({ painting, uploadResult }) {
  const today = new Date().toISOString().slice(0, 10);
  const row = `| ${today} | ${painting.title} | ${painting.artistDisplayName} | [${uploadResult.videoId}](${uploadResult.studioUrl}) |\n`;
  fs.appendFileSync(LOG_PATH, row);
}
