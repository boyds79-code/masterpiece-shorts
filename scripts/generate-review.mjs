import './lib/load-env.mjs';
import fs from 'node:fs';
import path from 'node:path';

import { selectPaintingAndScript } from './generate-video.mjs';
import { startReviewServer } from './lib/review-server.mjs';
import { loadUsed, saveUsed } from './lib/used-log.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * "숨은 의미" 영상의 그림 선정 + 대본(세그먼트별 확대 위치 bbox 포함) 생성까지만 하고
 * 멈춥니다. 나레이션/영상 조립/업로드는 하지 않고, 대신 확대 위치를 브라우저에서 드래그로
 * 검토/수정한 뒤 버튼 하나로 바로 나머지까지 실행할 수 있는 작은 로컬 서버를 띄웁니다
 * (브라우저가 자동으로 열립니다). 터미널로 다시 돌아갈 필요 없이 그 화면에서
 * "저장" -> "실행하기"만 누르면 됩니다.
 *
 * 이 그림은 대본이 나오는 즉시 data/used-paintings.json에 "리뷰 예약중"으로 표시해서,
 * 자동 스케줄(daily-video.yml 등)이 검토 중인 같은 그림을 또 뽑아가지 않게 합니다. 리뷰를
 * 끝까지 진행하지 않고 버리기로 했다면 data/used-paintings.json에서 reservedForReview:
 * true인 해당 항목을 직접 지워서 그 그림을 다시 후보로 되돌릴 수 있습니다.
 */
async function main() {
  const reviewDir = path.join(ROOT, 'output', `review-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(reviewDir, { recursive: true });

  let selection;
  try {
    selection = await selectPaintingAndScript({ workDir: reviewDir });
  } catch (err) {
    fs.rmSync(reviewDir, { recursive: true, force: true });
    throw err;
  }

  if (!selection) {
    fs.rmSync(reviewDir, { recursive: true, force: true });
    console.log('[generate-review] 더 이상 만들 수 있는(아직 안 쓴) 명화가 없어서 여기서 멈춥니다.');
    return;
  }

  const { painting, script, imagePath } = selection;

  // 자동 스케줄이 리뷰 중인 그림을 또 뽑아가지 않도록 바로 예약 표시.
  const usedList = loadUsed();
  usedList.push({
    objectID: painting.objectID,
    title: painting.title,
    artistDisplayName: painting.artistDisplayName,
    reservedAt: new Date().toISOString(),
    reservedForReview: true,
  });
  saveUsed(usedList);

  fs.writeFileSync(path.join(reviewDir, 'painting.json'), JSON.stringify(painting, null, 2) + '\n');
  fs.writeFileSync(path.join(reviewDir, 'script.json'), JSON.stringify(script, null, 2) + '\n');

  console.log('\n[generate-review] 검토 준비 완료.');
  console.log(`[generate-review]   그림: "${painting.title}" — ${painting.artistDisplayName}`);
  console.log(`[generate-review]   세그먼트: ${script.segments.length}개`);

  startReviewServer({ reviewDir, imageFile: path.basename(imagePath) });
}

main().catch((err) => {
  console.error('[generate-review] 실패:', err);
  process.exit(1);
});
