import './lib/load-env.mjs';
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
  // bboxTo(패닝/틸트 도착 지점)는 켜져 있는 구간에만 존재하므로 있을 때만 clamp합니다.
  for (const seg of script.segments) {
    seg.bbox = clampBbox(seg.bbox);
    if (seg.bboxTo) seg.bboxTo = clampBbox(seg.bboxTo);
  }

  console.log(`[build-from-review] "${painting.title}" — ${painting.artistDisplayName} (${script.segments.length}개 세그먼트) 빌드를 시작합니다.`);

  // 이전 시도가 실패했더라도(예: YouTube 인증 오류) keepOnFailure 덕에 영상 자체는 남아있을
  // 수 있습니다. 그 영상이 "지금 script.json과 정확히 같은 내용"으로 만들어진 것이면
  // 나레이션/영상조립을 또 돌리지 않고 업로드부터 재시도합니다 — 실제로 비용이 드는 Gemini
  // TTS/Anthropic 호출을 인증 오류 때문에 또 낭비하지 않기 위해서입니다. bbox를 고쳐서
  // script.json 내용이 달라졌다면 오래된 영상을 재사용하면 안 되므로 처음부터 다시 만듭니다.
  //
  // mtime이 아니라 내용을 비교합니다: 리뷰 화면의 "실행하기" 버튼은 매번 먼저 /save를
  // 호출해서 실제 내용이 바뀌지 않았어도 script.json의 mtime을 새로 갱신하기 때문에, mtime
  // 비교로는 브라우저 버튼 흐름에서 재사용이 항상 무효화되어 버립니다.
  const assemblyDir = path.join(resolvedDir, 'assembly');
  const finalVideoPath = path.join(assemblyDir, 'final.mp4');
  const srtPath = path.join(assemblyDir, 'captions.srt');
  const thumbnailPath = path.join(assemblyDir, 'thumbnail.jpg');
  const scriptSnapshotPath = path.join(assemblyDir, 'script-snapshot.json');

  let resumeFrom = null;
  if ([finalVideoPath, srtPath, thumbnailPath, scriptSnapshotPath].every((p) => fs.existsSync(p))) {
    const previousSnapshot = fs.readFileSync(scriptSnapshotPath, 'utf8');
    const currentSnapshot = JSON.stringify(script);
    if (previousSnapshot === currentSnapshot) {
      resumeFrom = { finalVideoPath, srtPath, thumbnailPath };
      console.log('[build-from-review] 이전 시도에서 만든 영상이 지금 script.json과 내용이 같아 재사용합니다 — 업로드부터 재시도합니다.');
    } else {
      console.log('[build-from-review] script.json 내용이 그 사이에 바뀌어 있어, 이전 영상은 재사용하지 않고 처음부터 다시 만듭니다.');
    }
  }
  if (!resumeFrom) {
    console.log('[build-from-review] 나레이션 생성 -> 영상 조립 -> YouTube 업로드까지 몇 분 걸릴 수 있어요.');
  }

  // buildAndUploadHiddenMeaningVideo는 성공하면 workDir을 통째로 지웁니다(리뷰 폴더를 그대로
  // workDir로 넘기므로 원본 이미지/대본까지 함께 정리되어, generateOneVideo()가
  // output/run-*/을 정리하는 것과 동일하게 산출물이 남지 않습니다). keepOnFailure: true라서
  // 실패하면 대신 폴더를 남겨서 위 재사용 로직으로 다시 시도할 수 있게 합니다.
  const { uploadResult } = await buildAndUploadHiddenMeaningVideo({
    painting,
    script,
    imagePath,
    workDir: resolvedDir,
    keepOnFailure: true,
    resumeFrom,
  });

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
