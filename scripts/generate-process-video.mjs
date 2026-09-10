import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { pickUnusedPainting, downloadImage } from './lib/met-api.mjs';
import { generateProcessScript } from './lib/process-script.mjs';
import { generateStageImage } from './lib/gemini-image.mjs';
import { generateNarrationAudio } from './lib/gemini-tts.mjs';
import { assembleProcessVideo } from './lib/video-builder.mjs';
import { uploadVideo, uploadCaptions, uploadThumbnail } from './lib/youtube-upload.mjs';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
// 기존 "숨은 의미" 영상(generate-video.mjs)과 같은 목록(data/used-paintings.json)을
// 공유합니다 — 이제 두 형식은 같은 그림에 대해 "그리는 방법" 쇼츠와 "숨은 의미" 쇼츠로
// 짝지어 만들어지므로(generate-duo-video.mjs), 그림 하나가 어느 한쪽에서든 이미 쓰였으면
// 다른 쪽에서도 다시 뽑히지 않도록 선정 목록 자체를 통합했습니다. 사람이 보는 로그
// (data/log.md vs data/log-process.md)는 형식별로 분리된 채 유지합니다.
const USED_PATH = path.join(ROOT, 'data', 'used-paintings.json');
const LOG_PATH = path.join(ROOT, 'data', 'log-process.md');

function loadUsed() {
  if (!fs.existsSync(USED_PATH)) return [];
  return JSON.parse(fs.readFileSync(USED_PATH, 'utf8'));
}

function saveUsed(list) {
  fs.mkdirSync(path.dirname(USED_PATH), { recursive: true });
  fs.writeFileSync(USED_PATH, JSON.stringify(list, null, 2) + '\n');
}

function appendLog({ painting, uploadResult }) {
  if (!fs.existsSync(LOG_PATH)) {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.writeFileSync(LOG_PATH, '| 날짜 | 그림 | 작가 | 영상 |\n| --- | --- | --- | --- |\n');
  }
  const today = new Date().toISOString().slice(0, 10);
  const row = `| ${today} | ${painting.title} | ${painting.artistDisplayName} | [${uploadResult.videoId}](${uploadResult.studioUrl}) |\n`;
  fs.appendFileSync(LOG_PATH, row);
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

// "숨은 의미" 파이프라인과 같은 이유로(민감한 소재라 Claude가 응답을 거부하는 경우), 대본
// 생성이 실패한 그림은 건너뛰고 다른 그림으로 재시도합니다. 이 파이프라인에는 별도의
// "소재 적합성" 사전 심사가 없으므로(제작 과정 재현은 인물 수/서사 밀도와 무관하게 대부분의
// 그림에 적용 가능) 시도 횟수는 원래 기본값인 4를 그대로 씁니다.
const MAX_PAINTING_ATTEMPTS = 4;

// YouTube 제목/설명에 항상 고정으로 붙이는 공개 고지 문구입니다. Claude가 나레이션에서
// 추정 어조를 쓰도록 지시하긴 하지만, "이건 상상 재현입니다"라는 사실 자체는 모델의 협조
// 여부와 무관하게 항상 보장돼야 하므로 코드에서 강제로 붙입니다 (인트로 화면 카드에도
// video-builder.mjs의 assembleProcessVideo()가 동일하게 고정 문구를 넣습니다).
const DISCLOSURE_TITLE_SUFFIX = ' (AI-Imagined Process)';
const DISCLOSURE_PARAGRAPH =
  '⚠️ This video imagines how this painting might have been created. It is a speculative, AI-assisted ' +
  'recreation based on the finished artwork and general knowledge of period painting techniques — not a ' +
  'documented historical record of the artist\'s actual process. The sketch and underpainting-stage images ' +
  'shown are AI-generated illustrations, not archival documents.';

function buildFinalTitle(claudeTitle) {
  const maxBase = 90 - DISCLOSURE_TITLE_SUFFIX.length;
  const base = claudeTitle.length > maxBase ? `${claudeTitle.slice(0, maxBase - 1)}…` : claudeTitle;
  return `${base}${DISCLOSURE_TITLE_SUFFIX}`;
}

function buildFinalDescription(claudeDescription, techniqueBasis) {
  const techniqueLine = techniqueBasis ? `\n\nTechnique basis for this reconstruction: ${techniqueBasis}` : '';
  return (
    `${DISCLOSURE_PARAGRAPH}\n\n${claudeDescription}${techniqueLine}\n\n` +
    'Finished painting image: public domain, via The Metropolitan Museum of Art (metmuseum.org), CC0.'
  );
}

/**
 * 영상 하나(그림 선정 -> "제작 과정 상상" 대본 -> 스케치/밑칠 단계 이미지 생성 -> 나레이션
 * -> 영상 조립 -> YouTube 업로드)를 처음부터 끝까지 만듭니다. scripts/generate-video.mjs
 * (숨은 의미 파이프라인)와 구조는 비슷하지만 완전히 별도의 파이프라인입니다.
 *
 * @returns {Promise<{ painting: object, script: object, uploadResult: object } | null>}
 */
export async function generateOneProcessVideo() {
  const workDir = path.join(ROOT, 'output', `process-run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(workDir, { recursive: true });

  const usedList = loadUsed();
  let painting = null;
  let script = null;
  let imagePath, visionPath;

  for (let attempt = 1; attempt <= MAX_PAINTING_ATTEMPTS; attempt++) {
    console.log(`[generate-process] 메트로폴리탄 미술관에서 아직 쓰지 않은 명화를 고르는 중... (시도 ${attempt}/${MAX_PAINTING_ATTEMPTS})`);
    const usedIds = usedList.map((u) => u.objectID);
    const candidate = await pickUnusedPainting(usedIds);

    if (!candidate) {
      console.log('[generate-process] 하이라이트로 지정된 유럽 회화 작품을 모두 소진했습니다.');
      fs.rmSync(workDir, { recursive: true, force: true });
      return null;
    }

    console.log(`[generate-process] 선정: "${candidate.title}" — ${candidate.artistDisplayName} (${candidate.objectDate})`);

    imagePath = path.join(workDir, 'original.jpg');
    visionPath = path.join(workDir, 'vision.jpg');
    const imageBuffer = await downloadImage(candidate.primaryImage);
    fs.writeFileSync(imagePath, imageBuffer);
    await makeVisionCopy(imagePath, visionPath);

    console.log('[generate-process] Claude에게 그림을 보여주고 "어떻게 그려졌을지" 상상 대본을 받는 중...');
    try {
      script = await generateProcessScript({
        painting: candidate,
        imageBufferForVision: fs.readFileSync(visionPath),
        imageMediaType: 'image/jpeg',
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.CLAUDE_MODEL,
      });
      painting = candidate;
      break;
    } catch (err) {
      if (err.code !== 'CONTENT_REFUSAL') {
        console.error(`[generate-process] "${candidate.title}" 대본 생성 중 그림과 무관한 오류 발생 — 바로 중단합니다: ${err.message}`);
        fs.rmSync(imagePath, { force: true });
        fs.rmSync(visionPath, { force: true });
        fs.rmSync(workDir, { recursive: true, force: true });
        throw err;
      }
      console.warn(`[generate-process] "${candidate.title}" 대본 생성 실패(민감한 소재로 추정), 다른 그림으로 넘어갑니다: ${err.message}`);
      usedList.push({
        objectID: candidate.objectID,
        title: candidate.title,
        artistDisplayName: candidate.artistDisplayName,
        skippedAt: new Date().toISOString(),
        skipped: true,
        reason: String(err.message).slice(0, 300),
      });
      saveUsed(usedList);
      fs.rmSync(imagePath, { force: true });
      fs.rmSync(visionPath, { force: true });
    }
  }

  if (!painting) {
    throw Object.assign(
      new Error(`${MAX_PAINTING_ATTEMPTS}개 그림을 시도했지만 모두 민감한 소재로 추정되어 대본 생성에 실패했습니다.`),
      { code: 'CONTENT_REFUSAL' }
    );
  }

  console.log(`[generate-process] 대본 완성 — 제목: "${script.youtube.title}"`);
  console.log(`[generate-process] 근거(techniqueBasis): ${script.techniqueBasis}`);

  const { uploadResult } = await buildAndUploadProcessVideo({ painting, script, imagePath, visionPath, workDir });

  usedList.push({
    objectID: painting.objectID,
    title: painting.title,
    artistDisplayName: painting.artistDisplayName,
    usedAt: new Date().toISOString(),
    videoIdProcess: uploadResult.videoId,
  });
  saveUsed(usedList);
  appendLog({ painting, uploadResult });

  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      `VIDEO_TITLE=${script.youtube.title}\nVIDEO_ID=${uploadResult.videoId}\nPAINTING_TITLE=${painting.title}\n`
    );
  }

  return { painting, script, uploadResult };
}

/**
 * "제작 과정" 대본(script) + 이미 선정된 그림/이미지(원본, vision용 축소본)로부터 스케치/
 * 밑칠/마무리 진행 컷 이미지 생성 -> 나레이션 오디오 생성 -> 영상 조립 -> YouTube 업로드
 * (영상/자막/썸네일)까지 처리합니다. generateOneProcessVideo()가 내부적으로 이 함수를
 * 쓰고, generate-duo-video.mjs(그림 하나로 두 쇼츠를 만드는 오케스트레이터)도 그림 선정을
 * 직접 한 뒤 이 함수를 재사용합니다 — 그래서 그림 선정/대본 생성 로직은 이 함수에 없고,
 * 호출자가 이미 만든 painting/script/imagePath/visionPath를 받기만 합니다.
 *
 * workDir은 호출자가 만들어서 넘겨야 하고, 성공/실패와 무관하게 이 함수가 끝나면서
 * (finally) 삭제합니다 — 호출자는 그 안의 파일을 이 함수 호출 이후에 쓰면 안 됩니다.
 *
 * @returns {Promise<{ uploadResult: object }>}
 */
export async function buildAndUploadProcessVideo({ painting, script, imagePath, visionPath, workDir }) {
  let uploadResult;
  try {
    console.log('[generate-process] AI로 스케치/밑칠/마무리 직전 단계의 진행 컷들을 순서대로 생성하는 중 (Gemini)...');
    const visionBuffer = fs.readFileSync(visionPath);
    const FINAL_TARGET_LABEL =
      'Reference A — the finished painting (the final target this reconstruction should lead toward). Preserve this exact composition and subject positions throughout.';
    const PREVIOUS_STEP_LABEL =
      'Reference B — the current progress state from the immediately previous step. Continue building on THIS image incrementally — do not restart from scratch or revert progress already made.';

    // 전체 파이프라인에 걸쳐 하나로 이어지는 체이닝입니다 — sketch의 마지막 컷이
    // underpainting의 첫 컷으로, underpainting의 마지막 컷이 refine의 첫 컷으로 그대로
    // 이어집니다 (스테이지가 바뀐다고 새로 시작하지 않음). 완성작(visionBuffer)은 항상
    // 함께 참고 이미지로 줘서 스타일/구도가 드리프트하지 않게 붙잡아둡니다.
    let previousStepBuffer = null;
    let previousStepMediaType = null;

    for (let i = 0; i < script.segments.length; i++) {
      const seg = script.segments[i];
      if (!seg.usesGeneratedImage) {
        // 실제 사진 세그먼트(identify/reference/finish)는 원본 고화질 이미지를 그대로 씁니다.
        seg.imagePaths = [imagePath];
        continue;
      }

      const stepPaths = [];
      for (let s = 0; s < seg.steps.length; s++) {
        const referenceImages = [{ buffer: visionBuffer, mediaType: 'image/jpeg', label: FINAL_TARGET_LABEL }];
        if (previousStepBuffer) {
          referenceImages.push({ buffer: previousStepBuffer, mediaType: previousStepMediaType, label: PREVIOUS_STEP_LABEL });
        }

        const stepPath = path.join(workDir, `seg-${i}-${seg.stage}-step-${s}.png`);
        const result = await generateStageImage({
          referenceImages,
          prompt: seg.steps[s],
          apiKey: process.env.GEMINI_API_KEY,
          model: process.env.GEMINI_IMAGE_MODEL,
          outPath: stepPath,
        });
        stepPaths.push(result.path);
        previousStepBuffer = fs.readFileSync(result.path);
        previousStepMediaType = result.mediaType;
      }
      seg.imagePaths = stepPaths;
      console.log(`[generate-process]   "${seg.stage}" 단계 진행 컷 ${stepPaths.length}개 생성 완료`);
    }

    console.log('[generate-process] 각 세그먼트 나레이션 오디오 생성 중 (Gemini TTS)...');
    for (let i = 0; i < script.segments.length; i++) {
      const seg = script.segments[i];
      const audioPath = path.join(workDir, `seg-${i}-audio.wav`);
      const { durationSec } = await generateNarrationAudio({
        text: seg.narration,
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_TTS_MODEL,
        voice: process.env.GEMINI_TTS_VOICE,
        outPath: audioPath,
      });
      seg.audioPath = audioPath;
      seg.durationSec = durationSec;
      console.log(`[generate-process]   세그먼트 ${i + 1}/${script.segments.length} 오디오 완료 (${durationSec.toFixed(1)}초)`);
    }

    console.log('[generate-process] ffmpeg로 영상 조립 중...');
    const { finalPath: finalVideoPath, srtPath, thumbnailPath } = await assembleProcessVideo({
      finishedImagePath: imagePath,
      segments: script.segments,
      painting,
      title: script.youtube.title,
      workDir: path.join(workDir, 'assembly'),
    });
    console.log(`[generate-process] 영상 완성: ${finalVideoPath}`);

    const privacyStatus = process.env.YOUTUBE_PRIVACY_STATUS || 'private';
    console.log(`[generate-process] YouTube에 "${privacyStatus}" 상태로 업로드 중...`);
    uploadResult = await uploadVideo({
      filePath: finalVideoPath,
      title: buildFinalTitle(script.youtube.title),
      description: buildFinalDescription(script.youtube.description, script.techniqueBasis),
      tags: script.youtube.tags,
      privacyStatus,
      containsSyntheticMedia: true,
      clientId: process.env.YOUTUBE_CLIENT_ID,
      clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
      refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
    });
    console.log(`[generate-process] 업로드 완료! 검토용 링크: ${uploadResult.studioUrl}`);

    console.log('[generate-process] 자막(CC) 트랙 업로드 중...');
    try {
      await uploadCaptions({
        videoId: uploadResult.videoId,
        srtPath,
        clientId: process.env.YOUTUBE_CLIENT_ID,
        clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
        refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
      });
      console.log('[generate-process] 자막 업로드 완료.');
    } catch (err) {
      console.warn(`[generate-process] 자막 업로드 실패 (영상은 정상 업로드됨): ${err.message}`);
    }

    console.log('[generate-process] 썸네일 업로드 중...');
    try {
      await uploadThumbnail({
        videoId: uploadResult.videoId,
        thumbnailPath,
        clientId: process.env.YOUTUBE_CLIENT_ID,
        clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
        refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
      });
      console.log('[generate-process] 썸네일 업로드 완료.');
    } catch (err) {
      console.warn(`[generate-process] 썸네일 업로드 실패 (영상은 정상 업로드됨): ${err.message}`);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  return { uploadResult };
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, 'generate-process-video.mjs');
if (isMainModule) {
  generateOneProcessVideo().catch((err) => {
    console.error('[generate-process] 실패:', err);
    process.exit(1);
  });
}
