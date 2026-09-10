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
// 기존 "숨은 의미" 영상용 목록(data/used-paintings.json)과 완전히 분리된 파일을 씁니다 —
// 두 형식은 서로 다른 종류의 영상이라, 한쪽에서 이미 쓴 그림을 다른 쪽에서 다시 써도
// 콘텐츠가 겹치지 않습니다(같은 그림이라도 "숨은 디테일" 영상과 "제작 과정 상상 재현"
// 영상은 완전히 다른 대본/화면입니다).
const USED_PATH = path.join(ROOT, 'data', 'used-paintings-process.json');
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

  let uploadResult;
  try {
    console.log('[generate-process] AI로 스케치/밑칠/마무리 직전 단계 이미지를 생성하는 중 (Gemini)...');
    const visionBuffer = fs.readFileSync(visionPath);
    for (let i = 0; i < script.segments.length; i++) {
      const seg = script.segments[i];
      if (!seg.usesGeneratedImage) {
        // 실제 사진 세그먼트(identify/reference/finish)는 원본 고화질 이미지를 그대로 씁니다.
        seg.imagePath = imagePath;
        continue;
      }
      const stagePath = path.join(workDir, `seg-${i}-stage-${seg.stage}.png`);
      await generateStageImage({
        referenceImageBuffer: visionBuffer,
        referenceMediaType: 'image/jpeg',
        prompt: seg.imagePrompt,
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_IMAGE_MODEL,
        outPath: stagePath,
      });
      seg.imagePath = stagePath;
      console.log(`[generate-process]   "${seg.stage}" 단계 이미지 생성 완료`);
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

  usedList.push({
    objectID: painting.objectID,
    title: painting.title,
    artistDisplayName: painting.artistDisplayName,
    usedAt: new Date().toISOString(),
    videoId: uploadResult.videoId,
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

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, 'generate-process-video.mjs');
if (isMainModule) {
  generateOneProcessVideo().catch((err) => {
    console.error('[generate-process] 실패:', err);
    process.exit(1);
  });
}
