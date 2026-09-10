import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { pickUnusedPainting, downloadImage } from './lib/met-api.mjs';
import { evaluatePaintingSuitability, generateVideoScript } from './lib/anthropic.mjs';
import { generateProcessScript } from './lib/process-script.mjs';
import { buildAndUploadHiddenMeaningVideo } from './generate-video.mjs';
import { buildAndUploadProcessVideo } from './generate-process-video.mjs';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
// "숨은 의미"(generate-video.mjs)와 "제작 과정"(generate-process-video.mjs) 두 파이프라인이
// 이제 같은 그림을 짝지어 쓰므로, 그림 선정 제외 목록(data/used-paintings.json)을 그대로
// 공유합니다. 사람이 보는 로그는 형식별로 나눠서 각자의 파일에 한 줄씩 남깁니다.
const USED_PATH = path.join(ROOT, 'data', 'used-paintings.json');
const MEANING_LOG_PATH = path.join(ROOT, 'data', 'log.md');
const PROCESS_LOG_PATH = path.join(ROOT, 'data', 'log-process.md');

function loadUsed() {
  if (!fs.existsSync(USED_PATH)) return [];
  return JSON.parse(fs.readFileSync(USED_PATH, 'utf8'));
}

function saveUsed(list) {
  fs.mkdirSync(path.dirname(USED_PATH), { recursive: true });
  fs.writeFileSync(USED_PATH, JSON.stringify(list, null, 2) + '\n');
}

function appendMeaningLog({ painting, uploadResult }) {
  const today = new Date().toISOString().slice(0, 10);
  const row = `| ${today} | ${painting.title} | ${painting.artistDisplayName} | [${uploadResult.videoId}](${uploadResult.studioUrl}) |\n`;
  fs.appendFileSync(MEANING_LOG_PATH, row);
}

function appendProcessLog({ painting, uploadResult }) {
  if (!fs.existsSync(PROCESS_LOG_PATH)) {
    fs.mkdirSync(path.dirname(PROCESS_LOG_PATH), { recursive: true });
    fs.writeFileSync(PROCESS_LOG_PATH, '| 날짜 | 그림 | 작가 | 영상 |\n| --- | --- | --- | --- |\n');
  }
  const today = new Date().toISOString().slice(0, 10);
  const row = `| ${today} | ${painting.title} | ${painting.artistDisplayName} | [${uploadResult.videoId}](${uploadResult.studioUrl}) |\n`;
  fs.appendFileSync(PROCESS_LOG_PATH, row);
}

async function makeVisionCopy(originalPath, outPath) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', originalPath,
    '-vf', "scale='min(1568,iw)':'min(1568,ih)':force_original_aspect_ratio=decrease",
    '-q:v', '3',
    outPath,
  ]);
}

// 이 오케스트레이터는 그림 하나에 대해 "숨은 의미" 대본과 "제작 과정" 대본이 둘 다 성공해야
// 그 그림을 확정합니다 — 한쪽만 성공하고 다른 쪽이 실패하면(민감한 소재 등으로 Claude가
// 거부) 그 그림은 통째로 건너뛰고 스킵 기록을 남긴 뒤 다른 그림으로 재시도합니다. "숨은
// 의미" 쪽의 사전 적합성 심사(다인물/서사/상징 밀도)까지 통과해야 하므로 기준을 만족하는
// 그림이 상대적으로 드뭅니다 — 재시도 횟수를 넉넉히 8로 둡니다.
const MAX_PAINTING_ATTEMPTS = 8;

/**
 * 그림 하나를 골라 "숨은 의미" 쇼츠와 "그리는 방법(제작 과정 상상 재현)" 쇼츠, 두 개를
 * 순서대로 만들어 YouTube에 업로드합니다. 그림 선정 + 두 대본 생성은 이 함수가 직접
 * 하고(같은 그림이어야 하므로), 실제 영상 조립/업로드는 각 파이프라인의
 * buildAndUploadHiddenMeaningVideo() / buildAndUploadProcessVideo()를 재사용합니다.
 *
 * @returns {Promise<{ painting: object, meaningScript: object, processScript: object,
 *   meaningUpload: object, processUpload: object } | null>}
 *   성공하면 결과 정보를 반환하고, 시도 가능한 그림을 다 소진해서 더 만들 게 없으면 null을
 *   반환합니다.
 */
export async function generateDuoVideo() {
  const usedList = loadUsed();
  let painting = null;
  let imagePath, visionPath;
  let meaningScript = null;
  let processScript = null;
  let selectionWorkDir = null;

  for (let attempt = 1; attempt <= MAX_PAINTING_ATTEMPTS; attempt++) {
    console.log(`[generate-duo] 메트로폴리탄 미술관에서 아직 쓰지 않은 명화를 고르는 중... (시도 ${attempt}/${MAX_PAINTING_ATTEMPTS})`);
    const usedIds = usedList.map((u) => u.objectID);
    const candidate = await pickUnusedPainting(usedIds);

    if (!candidate) {
      console.log('[generate-duo] 하이라이트로 지정된 유럽 회화 작품을 모두 소진했습니다.');
      if (selectionWorkDir) fs.rmSync(selectionWorkDir, { recursive: true, force: true });
      return null;
    }

    console.log(`[generate-duo] 선정: "${candidate.title}" — ${candidate.artistDisplayName} (${candidate.objectDate})`);

    selectionWorkDir = path.join(ROOT, 'output', `duo-select-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(selectionWorkDir, { recursive: true });
    const candidateImagePath = path.join(selectionWorkDir, 'original.jpg');
    const candidateVisionPath = path.join(selectionWorkDir, 'vision.jpg');
    const imageBuffer = await downloadImage(candidate.primaryImage);
    fs.writeFileSync(candidateImagePath, imageBuffer);
    await makeVisionCopy(candidateImagePath, candidateVisionPath);

    const skip = (reason) => {
      usedList.push({
        objectID: candidate.objectID,
        title: candidate.title,
        artistDisplayName: candidate.artistDisplayName,
        skippedAt: new Date().toISOString(),
        skipped: true,
        reason: String(reason).slice(0, 300),
      });
      saveUsed(usedList); // 같은 그림을 다음 실행에서 또 뽑지 않도록 바로 저장
      fs.rmSync(selectionWorkDir, { recursive: true, force: true });
      selectionWorkDir = null;
    };

    console.log('[generate-duo] Claude에게 이 그림이 "숨은 의미" 포맷에 맞는 소재인지(다인물/서사/상징 밀도) 먼저 확인하는 중...');
    let suitability;
    try {
      suitability = await evaluatePaintingSuitability({
        imageBufferForVision: fs.readFileSync(candidateVisionPath),
        imageMediaType: 'image/jpeg',
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.CLAUDE_MODEL,
      });
    } catch (err) {
      console.warn(`[generate-duo] 적합성 판단 실패, 건너뛰지 않고 계속 진행합니다: ${err.message}`);
      suitability = { suitable: true };
    }

    if (!suitability.suitable) {
      console.warn(
        `[generate-duo] "${candidate.title}" 은(는) 소재가 단조로워(인물 수: ${suitability.figureCount ?? '?'}) 건너뜁니다: ${suitability.reason || ''}`
      );
      skip(`[낮은 서사/상징 밀도, 인물 수 ${suitability.figureCount ?? '?'}] ${suitability.reason || ''}`);
      continue;
    }

    console.log('[generate-duo] Claude에게 그림을 보여주고 "숨은 의미" 대본을 받는 중...');
    try {
      meaningScript = await generateVideoScript({
        painting: candidate,
        imageBufferForVision: fs.readFileSync(candidateVisionPath),
        imagePath: candidateVisionPath,
        imageMediaType: 'image/jpeg',
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.CLAUDE_MODEL,
      });
    } catch (err) {
      if (err.code !== 'CONTENT_REFUSAL') {
        console.error(
          `[generate-duo] "${candidate.title}" 숨은 의미 대본 생성 중 그림과 무관한 오류 발생 — 바로 중단합니다: ${err.message}`
        );
        fs.rmSync(selectionWorkDir, { recursive: true, force: true });
        throw err;
      }
      console.warn(`[generate-duo] "${candidate.title}" 숨은 의미 대본 생성 실패(민감한 소재로 추정), 다른 그림으로 넘어갑니다: ${err.message}`);
      skip(err.message);
      continue;
    }

    console.log('[generate-duo] Claude에게 그림을 보여주고 "그리는 방법" 대본을 받는 중...');
    try {
      processScript = await generateProcessScript({
        painting: candidate,
        imageBufferForVision: fs.readFileSync(candidateVisionPath),
        imageMediaType: 'image/jpeg',
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.CLAUDE_MODEL,
      });
    } catch (err) {
      if (err.code !== 'CONTENT_REFUSAL') {
        console.error(
          `[generate-duo] "${candidate.title}" 제작 과정 대본 생성 중 그림과 무관한 오류 발생 — 바로 중단합니다: ${err.message}`
        );
        fs.rmSync(selectionWorkDir, { recursive: true, force: true });
        throw err;
      }
      // 숨은 의미 대본은 이미 성공했지만, 두 쇼츠를 같은 그림으로 짝지어야 하므로 이
      // 그림은 통째로 포기하고 다른 그림으로 다시 시도합니다.
      console.warn(`[generate-duo] "${candidate.title}" 제작 과정 대본 생성 실패(민감한 소재로 추정), 다른 그림으로 넘어갑니다: ${err.message}`);
      skip(err.message);
      meaningScript = null;
      continue;
    }

    painting = candidate;
    imagePath = candidateImagePath;
    visionPath = candidateVisionPath;
    break;
  }

  if (!painting) {
    throw Object.assign(
      new Error(`${MAX_PAINTING_ATTEMPTS}개 그림을 시도했지만 모두 소재가 부적합하거나 대본 생성에 실패해서 짝지을 그림을 찾지 못했습니다.`),
      { code: 'CONTENT_REFUSAL' }
    );
  }

  console.log(`[generate-duo] 그림 확정: "${painting.title}" — 두 쇼츠 생성을 시작합니다.`);

  let meaningUpload, processUpload;
  try {
    console.log('[generate-duo] === (1/2) "숨은 의미" 쇼츠 제작 중 ===');
    const meaningWorkDir = path.join(ROOT, 'output', `duo-meaning-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(meaningWorkDir, { recursive: true });
    const meaningResult = await buildAndUploadHiddenMeaningVideo({
      painting,
      script: meaningScript,
      imagePath,
      workDir: meaningWorkDir,
    });
    meaningUpload = meaningResult.uploadResult;
    console.log(`[generate-duo] "숨은 의미" 쇼츠 업로드 완료: ${meaningUpload.studioUrl}`);

    console.log('[generate-duo] === (2/2) "그리는 방법" 쇼츠 제작 중 ===');
    const processWorkDir = path.join(ROOT, 'output', `duo-process-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(processWorkDir, { recursive: true });
    const processResult = await buildAndUploadProcessVideo({
      painting,
      script: processScript,
      imagePath,
      visionPath,
      workDir: processWorkDir,
    });
    processUpload = processResult.uploadResult;
    console.log(`[generate-duo] "그리는 방법" 쇼츠 업로드 완료: ${processUpload.studioUrl}`);
  } finally {
    // imagePath/visionPath는 selectionWorkDir 안에 있습니다 — 두 buildAndUpload*() 호출은
    // 각자 자기 자신의 workDir만 정리하므로, 원본/vision 이미지가 담긴 selectionWorkDir는
    // 둘 다 끝난(성공/실패 무관) 뒤 여기서 정리합니다.
    if (selectionWorkDir) fs.rmSync(selectionWorkDir, { recursive: true, force: true });
  }

  usedList.push({
    objectID: painting.objectID,
    title: painting.title,
    artistDisplayName: painting.artistDisplayName,
    usedAt: new Date().toISOString(),
    videoIdMeaning: meaningUpload.videoId,
    videoIdProcess: processUpload.videoId,
  });
  saveUsed(usedList);
  appendMeaningLog({ painting, uploadResult: meaningUpload });
  appendProcessLog({ painting, uploadResult: processUpload });

  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      `MEANING_VIDEO_TITLE=${meaningScript.youtube.title}\nMEANING_VIDEO_ID=${meaningUpload.videoId}\n` +
        `PROCESS_VIDEO_TITLE=${processScript.youtube.title}\nPROCESS_VIDEO_ID=${processUpload.videoId}\n` +
        `PAINTING_TITLE=${painting.title}\n`
    );
  }

  return { painting, meaningScript, processScript, meaningUpload, processUpload };
}

// 이 파일을 직접 실행했을 때만(`npm run generate:duo`) 한 번 돌립니다.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, 'generate-duo-video.mjs');
if (isMainModule) {
  generateDuoVideo().catch((err) => {
    console.error('[generate-duo] 실패:', err);
    process.exit(1);
  });
}
