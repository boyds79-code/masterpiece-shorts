import fs from 'node:fs';
import path from 'node:path';

import { buildAndUploadHiddenMeaningVideo } from './generate-video.mjs';
import { clampBbox } from './lib/anthropic.mjs';
import { loadUsed, saveUsed, appendLog, upsertUsed } from './lib/used-log.mjs';

/**
 * generate-review.mjs가 만들어둔 리뷰 폴더(그림 이미지 + 대본 + 사람이 검토/수정한
 * script.json)를 이어받아서 나머지(나레이션 생성 -> 영상 조립 -> YouTube 업로드)를
 * 진행합니다. review-server.mjs의 "실행하기" 버튼과 이 파일 하단의 CLI 진입점이 둘 다
 * 이 함수를 씁니다 — 브라우저 버튼으로 실행하든 터미널에서 직접 실행하든 동작이 같습니다.
 *
 * script.json은 (버튼으로 저장했든, 직접 편집했든) 항상 디스크에서 새로 읽어옵니다.
 *
 * @returns {Promise<{ painting: object, uploadResult: object }>}
 */
export async function runBuildFromReviewDir(reviewDir) {
  const resolvedDir = path.resolve(reviewDir);
  const paintingPath = path.join(resolvedDir, 'painting.json');
  const scriptPath = path.join(resolvedDir, 'script.json');
  const imagePath = path.join(resolvedDir, 'original.jpg');

  for (const p of [paintingPath, scriptPath, imagePath]) {
    if (!fs.existsSync(p)) {
      throw new Error(`필요한 파일이 없습니다: ${p} — generate-review.mjs가 만든 리뷰 폴더가 맞는지 확인하세요.`);
    }
  }

  const painting = JSON.parse(fs.readFileSync(paintingPath, 'utf8'));
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));

  if (!Array.isArray(script.segments) || script.segments.length === 0) {
    throw new Error('script.json에 segments가 없습니다.');
  }
  // 저장된 값이라도 혹시 모를 실수(범위 밖 좌표 등)에 대비해 다시 clamp.
  for (const seg of script.segments) {
    seg.bbox = clampBbox(seg.bbox);
  }

  console.log(`[build-from-review] "${painting.title}" — ${painting.artistDisplayName} (${script.segments.length}개 세그먼트) 빌드를 시작합니다.`);
  console.log('[build-from-review] 나레이션 생성 -> 영상 조립 -> YouTube 업로드까지 몇 분 걸릴 수 있어요.');

  // buildAndUploadHiddenMeaningVideo는 끝나면(성공/실패 무관) workDir을 통째로 지웁니다 —
  // 리뷰 폴더를 그대로 workDir로 넘기면 원본 이미지/대본까지 함께 정리되어,
  // generateOneVideo()가 output/run-*/을 정리하는 것과 동일하게 산출물이 남지 않습니다.
  const { uploadResult } = await buildAndUploadHiddenMeaningVideo({ painting, script, imagePath, workDir: resolvedDir });

  const usedList = loadUsed();
  upsertUsed(usedList, {
    objectID: painting.objectID,
    title: painting.title,
    artistDisplayName: painting.artistDisplayName,
    usedAt: new Date().toISOString(),
    videoIdMeaning: uploadResult.videoId,
    reservedForReview: undefined,
    reservedAt: undefined,
  });
  saveUsed(usedList);
  appendLog({ painting, uploadResult });

  console.log(`\n[build-from-review] 완료! 검토용 링크: ${uploadResult.studioUrl}`);
  return { painting, uploadResult };
}

// 이 파일을 직접 실행했을 때만(`npm run build:review -- <폴더>`) CLI로 동작합니다.
// review-server.mjs의 "실행하기" 버튼은 위 runBuildFromReviewDir()를 직접 import해서 쓰므로
// 이 블록을 거치지 않습니다.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, 'build-from-review.mjs');
if (isMainModule) {
  const reviewDir = process.argv[2];
  if (!reviewDir) {
    console.error('사용법: npm run build:review -- <리뷰 폴더 경로>');
    console.error('예: npm run build:review -- output/review-1234567890-ab12c');
    process.exit(1);
  }
  runBuildFromReviewDir(reviewDir).catch((err) => {
    console.error('[build-from-review] 실패:', err);
    process.exit(1);
  });
}
