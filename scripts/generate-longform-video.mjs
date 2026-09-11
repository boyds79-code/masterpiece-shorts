import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { pickUnusedPainting, downloadImage } from './lib/met-api.mjs';
import { evaluatePaintingSuitability } from './lib/anthropic.mjs';
import { generateLongformScript } from './lib/longform-script.mjs';
import { generateStageImage } from './lib/gemini-image.mjs';
import { generateNarrationAudio } from './lib/gemini-tts.mjs';
import { assembleLongformBundle } from './lib/video-builder.mjs';
import { uploadVideo, uploadCaptions, uploadThumbnail } from './lib/youtube-upload.mjs';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
// 다른 파이프라인들과 그림 선정 목록을 공유합니다 — 이 파이프라인이 쓴 그림은 숨은 의미/
// 제작 과정/듀오 파이프라인에서도 다시 뽑히지 않아야 하고, 반대도 마찬가지입니다.
const USED_PATH = path.join(ROOT, 'data', 'used-paintings.json');
const LOG_PATH = path.join(ROOT, 'data', 'log-longform.md');

function loadUsed() {
  if (!fs.existsSync(USED_PATH)) return [];
  return JSON.parse(fs.readFileSync(USED_PATH, 'utf8'));
}

function saveUsed(list) {
  fs.mkdirSync(path.dirname(USED_PATH), { recursive: true });
  fs.writeFileSync(USED_PATH, JSON.stringify(list, null, 2) + '\n');
}

function appendLog({ painting, uploads }) {
  if (!fs.existsSync(LOG_PATH)) {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.writeFileSync(
      LOG_PATH,
      '| 날짜 | 그림 | 작가 | 긴 영상 | 그리는 방법 티저 | 숨은 의미 티저 |\n| --- | --- | --- | --- | --- | --- |\n'
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  const row =
    `| ${today} | ${painting.title} | ${painting.artistDisplayName} ` +
    `| [${uploads.full.videoId}](${uploads.full.studioUrl}) ` +
    `| [${uploads.processTeaser.videoId}](${uploads.processTeaser.studioUrl}) ` +
    `| [${uploads.meaningTeaser.videoId}](${uploads.meaningTeaser.studioUrl}) |\n`;
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

// 숨은 의미 리빌 4개를 포함하는 만큼(사전 적합성 심사 대상) + 대본 생성 자체가 거부될
// 가능성(민감한 소재)까지 감안해서 넉넉한 시도 횟수를 씁니다.
const MAX_PAINTING_ATTEMPTS = 8;

// 긴 영상/그리는 방법 티저는 스케치·밑칠·마무리 직전 단계에 AI가 생성한 이미지를 담고
// 있으므로, 기존 process-video 파이프라인과 동일하게 제목/설명에 코드 레벨로 고지 문구를
// 강제로 붙입니다 (모델의 서술에만 의존하지 않기 위해). 숨은 의미 티저는 실사진만 쓰므로
// 이 고지가 필요 없습니다.
const AI_PROCESS_TITLE_SUFFIX = ' (Incl. AI-Imagined Process)';
const AI_PROCESS_TEASER_TITLE_SUFFIX = ' (AI-Imagined Process)';
const AI_PROCESS_DISCLOSURE_PARAGRAPH =
  '⚠️ The "how it was painted" portion of this video imagines the process — a speculative, AI-assisted ' +
  'recreation based on the finished artwork and general knowledge of period painting techniques, not a ' +
  'documented historical record of the artist\'s actual process. The sketch/underpainting-stage images ' +
  'shown are AI-generated illustrations, not archival documents.';

function buildFinalFullTitle(claudeTitle) {
  const maxBase = 95 - AI_PROCESS_TITLE_SUFFIX.length;
  const base = claudeTitle.length > maxBase ? `${claudeTitle.slice(0, maxBase - 1)}…` : claudeTitle;
  return `${base}${AI_PROCESS_TITLE_SUFFIX}`;
}

function buildFinalFullDescription(claudeDescription, techniqueBasis) {
  const techniqueLine = techniqueBasis ? `\n\nTechnique basis for the imagined process portion: ${techniqueBasis}` : '';
  return (
    `${claudeDescription}\n\n${AI_PROCESS_DISCLOSURE_PARAGRAPH}${techniqueLine}\n\n` +
    'Painting image: public domain, via The Metropolitan Museum of Art (metmuseum.org), CC0.'
  );
}

function buildFinalProcessTeaserTitle(claudeTitle) {
  const maxBase = 90 - AI_PROCESS_TEASER_TITLE_SUFFIX.length;
  const base = claudeTitle.length > maxBase ? `${claudeTitle.slice(0, maxBase - 1)}…` : claudeTitle;
  return `${base}${AI_PROCESS_TEASER_TITLE_SUFFIX}`;
}

// 유튜브 쇼츠는 설명란/댓글에 클릭 가능한 링크를 넣을 수 없으므로(2023년 8월부터), 여기서는
// 링크 대신 긴 영상의 정확한 제목을 텍스트로 못박아서 "채널에서 검색해 보라"고 안내합니다.
// 화면(아웃트로 카드)에도 동일한 문구가 이미 노출되지만, 설명란에도 같은 문구를 남겨 둡니다.
function teaserCtaParagraph(fullTitle) {
  return `📺 This is a short excerpt. The full story — "${fullTitle}" — is on this channel; search the channel to watch it in full.`;
}

function buildFinalProcessTeaserDescription(claudeDescription, fullTitle) {
  return (
    `${claudeDescription}\n\n${AI_PROCESS_DISCLOSURE_PARAGRAPH}\n\n${teaserCtaParagraph(fullTitle)}\n\n` +
    'Painting image: public domain, via The Metropolitan Museum of Art (metmuseum.org), CC0.'
  );
}

function buildFinalMeaningTeaserDescription(claudeDescription, fullTitle) {
  return (
    `${claudeDescription}\n\n${teaserCtaParagraph(fullTitle)}\n\n` +
    'Painting image: public domain, via The Metropolitan Museum of Art (metmuseum.org), CC0.'
  );
}

/**
 * 영상 3개(그림 선정 -> 통합 대본 -> 스케치/밑칠/마무리 이미지 생성 -> 나레이션 -> 긴 영상 +
 * 티저 쇼츠 2개 조립 -> YouTube 업로드 3회)를 처음부터 끝까지 만듭니다. "긴 영상 1개(3분
 * 이상) + 그 영상에서 발췌한 짧은 티저 쇼츠 2개"를 만듭니다 — 쇼츠로 우연히 채널을 접한
 * 사람이 관심이 있으면 같은 그림의 긴 영상을 찾아볼 수 있도록 유도하는 것이 목적입니다.
 *
 * @returns {Promise<{ painting: object, script: object, uploads: object } | null>}
 */
export async function generateOneLongformVideo() {
  const workDir = path.join(ROOT, 'output', `longform-run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(workDir, { recursive: true });

  const usedList = loadUsed();
  let painting = null;
  let script = null;
  let imagePath, visionPath;

  for (let attempt = 1; attempt <= MAX_PAINTING_ATTEMPTS; attempt++) {
    console.log(`[generate-longform] 메트로폴리탄 미술관에서 아직 쓰지 않은 명화를 고르는 중... (시도 ${attempt}/${MAX_PAINTING_ATTEMPTS})`);
    const usedIds = usedList.map((u) => u.objectID);
    const candidate = await pickUnusedPainting(usedIds);

    if (!candidate) {
      console.log('[generate-longform] 하이라이트로 지정된 유럽 회화 작품을 모두 소진했습니다.');
      fs.rmSync(workDir, { recursive: true, force: true });
      return null;
    }

    console.log(`[generate-longform] 선정: "${candidate.title}" — ${candidate.artistDisplayName} (${candidate.objectDate})`);

    imagePath = path.join(workDir, 'original.jpg');
    visionPath = path.join(workDir, 'vision.jpg');
    const imageBuffer = await downloadImage(candidate.primaryImage);
    fs.writeFileSync(imagePath, imageBuffer);
    await makeVisionCopy(imagePath, visionPath);

    // 이 파이프라인은 숨은 의미 리빌 4개를 포함하므로, 기존 숨은 의미 파이프라인과 같은
    // 사전 적합성 심사(다인물/서사/상징 밀도)를 재사용합니다.
    console.log('[generate-longform] Claude에게 이 그림이 포맷에 맞는 소재인지(다인물/서사/상징 밀도) 먼저 확인하는 중...');
    let suitability;
    try {
      suitability = await evaluatePaintingSuitability({
        imageBufferForVision: fs.readFileSync(visionPath),
        imageMediaType: 'image/jpeg',
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.CLAUDE_MODEL,
      });
    } catch (err) {
      console.warn(`[generate-longform] 적합성 판단 실패, 건너뛰지 않고 계속 진행합니다: ${err.message}`);
      suitability = { suitable: true };
    }

    if (!suitability.suitable) {
      console.warn(
        `[generate-longform] "${candidate.title}" 은(는) 소재가 단조로워(인물 수: ${suitability.figureCount ?? '?'}) 건너뜁니다: ${suitability.reason || ''}`
      );
      usedList.push({
        objectID: candidate.objectID,
        title: candidate.title,
        artistDisplayName: candidate.artistDisplayName,
        skippedAt: new Date().toISOString(),
        skipped: true,
        reason: `[낮은 서사/상징 밀도, 인물 수 ${suitability.figureCount ?? '?'}] ${suitability.reason || ''}`.slice(0, 300),
      });
      saveUsed(usedList);
      fs.rmSync(imagePath, { force: true });
      fs.rmSync(visionPath, { force: true });
      continue;
    }

    console.log('[generate-longform] Claude에게 그림을 보여주고 긴 대본(+티저 2개용 메타데이터)을 받는 중...');
    try {
      script = await generateLongformScript({
        painting: candidate,
        imageBufferForVision: fs.readFileSync(visionPath),
        imagePath: visionPath,
        imageMediaType: 'image/jpeg',
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.CLAUDE_MODEL,
      });
      painting = candidate;
      break;
    } catch (err) {
      if (err.code !== 'CONTENT_REFUSAL') {
        console.error(`[generate-longform] "${candidate.title}" 대본 생성 중 그림과 무관한 오류 발생 — 바로 중단합니다: ${err.message}`);
        fs.rmSync(imagePath, { force: true });
        fs.rmSync(visionPath, { force: true });
        fs.rmSync(workDir, { recursive: true, force: true });
        throw err;
      }
      console.warn(`[generate-longform] "${candidate.title}" 대본 생성 실패(민감한 소재로 추정), 다른 그림으로 넘어갑니다: ${err.message}`);
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
      new Error(`${MAX_PAINTING_ATTEMPTS}개 그림을 시도했지만 모두 민감한 소재이거나 소재가 단조로워 사용하지 못했습니다.`),
      { code: 'CONTENT_REFUSAL' }
    );
  }

  console.log(`[generate-longform] 대본 완성 — 제목: "${script.youtube.full.title}"`);
  console.log(`[generate-longform] 근거(techniqueBasis): ${script.techniqueBasis}`);

  const { uploads } = await buildAndUploadLongformBundle({ painting, script, imagePath, visionPath, workDir });

  usedList.push({
    objectID: painting.objectID,
    title: painting.title,
    artistDisplayName: painting.artistDisplayName,
    usedAt: new Date().toISOString(),
    videoIdFull: uploads.full.videoId,
    videoIdProcessShort: uploads.processTeaser.videoId,
    videoIdMeaningShort: uploads.meaningTeaser.videoId,
  });
  saveUsed(usedList);
  appendLog({ painting, uploads });

  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      `FULL_VIDEO_TITLE=${script.youtube.full.title}\n` +
        `FULL_VIDEO_ID=${uploads.full.videoId}\n` +
        `PROCESS_TEASER_ID=${uploads.processTeaser.videoId}\n` +
        `MEANING_TEASER_ID=${uploads.meaningTeaser.videoId}\n` +
        `PAINTING_TITLE=${painting.title}\n`
    );
  }

  return { painting, script, uploads };
}

/**
 * 긴 대본(script) + 이미 선정된 그림/이미지(원본, vision용 축소본)로부터 스케치/밑칠/마무리
 * 진행 컷 이미지 생성 -> 전체 10개 세그먼트 나레이션 오디오 생성 -> 긴 영상 + 티저 쇼츠 2개
 * 조립 -> YouTube에 3개 모두 업로드(영상/자막/썸네일)까지 처리합니다.
 * generateOneLongformVideo()가 내부적으로 이 함수를 씁니다 — 다른 파이프라인의
 * buildAndUpload*() 함수들과 마찬가지로, 그림 선정/대본 생성 로직은 이 함수에 없습니다.
 *
 * workDir은 호출자가 만들어서 넘겨야 하고, 성공/실패와 무관하게 이 함수가 끝나면서
 * (finally) 삭제합니다.
 *
 * @returns {Promise<{ uploads: { full: object, processTeaser: object, meaningTeaser: object } }>}
 */
export async function buildAndUploadLongformBundle({ painting, script, imagePath, visionPath, workDir }) {
  let uploads;
  try {
    console.log('[generate-longform] AI로 스케치/밑칠/마무리 직전 단계의 진행 컷들을 순서대로 생성하는 중 (Gemini)...');
    const visionBuffer = fs.readFileSync(visionPath);
    const FINAL_TARGET_LABEL =
      'Reference A — the finished painting (the final target this reconstruction should lead toward). Preserve this exact composition and subject positions throughout.';
    const PREVIOUS_STEP_LABEL =
      'Reference B — the current progress state from the immediately previous step. Continue building on THIS image incrementally — do not restart from scratch or revert progress already made.';

    // sketch -> underpainting -> refine 전체에 걸쳐 하나로 이어지는 체이닝입니다(스테이지가
    // 바뀐다고 새로 시작하지 않음). 완성작(visionBuffer)은 항상 함께 참고 이미지로 줘서
    // 스타일/구도가 드리프트하지 않게 붙잡아둡니다. identify/reference/reveal x4/finish는
    // 실사진 세그먼트라 imagePaths에 원본 이미지 1장만 넣고 건너뜁니다.
    let previousStepBuffer = null;
    let previousStepMediaType = null;

    for (let i = 0; i < script.segments.length; i++) {
      const seg = script.segments[i];
      if (!seg.usesGeneratedImage) {
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
      console.log(`[generate-longform]   "${seg.stage}" 단계 진행 컷 ${stepPaths.length}개 생성 완료`);
    }

    console.log('[generate-longform] 세그먼트 10개 전체 나레이션 오디오 생성 중 (Gemini TTS)...');
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
      console.log(`[generate-longform]   세그먼트 ${i + 1}/${script.segments.length} 오디오 완료 (${durationSec.toFixed(1)}초)`);
    }

    // 긴 영상의 최종(고지 문구 포함) 제목을 먼저 확정합니다 — 두 티저의 아웃트로 화면 CTA와
    // 설명란 모두 이 문자열을 그대로 노출해야, 시청자가 채널에서 검색했을 때 실제로 이
    // 제목의 영상을 찾을 수 있습니다.
    const finalFullTitle = buildFinalFullTitle(script.youtube.full.title);
    const finalProcessTeaserTitle = buildFinalProcessTeaserTitle(script.youtube.processTeaser.title);
    // 숨은 의미 티저는 실사진만 쓰므로 "AI가 상상한 제작 과정" 고지가 필요 없습니다.
    const finalMeaningTeaserTitle = script.youtube.meaningTeaser.title;

    console.log('[generate-longform] ffmpeg로 긴 영상 + 티저 쇼츠 2개 조립 중 (세그먼트 클립은 한 번만 생성해서 재사용)...');
    const bundle = await assembleLongformBundle({
      finishedImagePath: imagePath,
      segments: script.segments,
      painting,
      titles: { full: finalFullTitle, processTeaser: finalProcessTeaserTitle, meaningTeaser: finalMeaningTeaserTitle },
      workDir: path.join(workDir, 'assembly'),
    });
    console.log(`[generate-longform] 조립 완료 — 긴 영상: ${bundle.full.finalPath}`);

    const privacyStatus = process.env.YOUTUBE_PRIVACY_STATUS || 'private';

    async function uploadOne({ label, finalPath, srtPath, thumbnailPath, title, description, tags, containsSyntheticMedia }) {
      console.log(`[generate-longform] YouTube에 "${privacyStatus}" 상태로 업로드 중 (${label})...`);
      const uploadResult = await uploadVideo({
        filePath: finalPath,
        title,
        description,
        tags,
        privacyStatus,
        containsSyntheticMedia,
        clientId: process.env.YOUTUBE_CLIENT_ID,
        clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
        refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
      });
      console.log(`[generate-longform] 업로드 완료(${label})! 검토용 링크: ${uploadResult.studioUrl}`);

      try {
        await uploadCaptions({
          videoId: uploadResult.videoId,
          srtPath,
          clientId: process.env.YOUTUBE_CLIENT_ID,
          clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
          refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
        });
      } catch (err) {
        console.warn(`[generate-longform] 자막 업로드 실패(${label}, 영상은 정상 업로드됨): ${err.message}`);
      }
      try {
        await uploadThumbnail({
          videoId: uploadResult.videoId,
          thumbnailPath,
          clientId: process.env.YOUTUBE_CLIENT_ID,
          clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
          refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
        });
      } catch (err) {
        console.warn(`[generate-longform] 썸네일 업로드 실패(${label}, 영상은 정상 업로드됨): ${err.message}`);
      }
      return uploadResult;
    }

    // 긴 영상과 그리는 방법 티저는 AI가 생성한 이미지를 담고 있으므로 containsSyntheticMedia:
    // true로 표시합니다. 숨은 의미 티저는 실사진만 쓰므로 표시하지 않습니다(기존 숨은 의미
    // 파이프라인과 동일).
    const fullUpload = await uploadOne({
      label: 'full',
      finalPath: bundle.full.finalPath,
      srtPath: bundle.full.srtPath,
      thumbnailPath: bundle.full.thumbnailPath,
      title: finalFullTitle,
      description: buildFinalFullDescription(script.youtube.full.description, script.techniqueBasis),
      tags: script.youtube.full.tags,
      containsSyntheticMedia: true,
    });

    const processTeaserUpload = await uploadOne({
      label: 'processTeaser',
      finalPath: bundle.processTeaser.finalPath,
      srtPath: bundle.processTeaser.srtPath,
      thumbnailPath: bundle.processTeaser.thumbnailPath,
      title: finalProcessTeaserTitle,
      description: buildFinalProcessTeaserDescription(script.youtube.processTeaser.description, finalFullTitle),
      tags: script.youtube.processTeaser.tags,
      containsSyntheticMedia: true,
    });

    const meaningTeaserUpload = await uploadOne({
      label: 'meaningTeaser',
      finalPath: bundle.meaningTeaser.finalPath,
      srtPath: bundle.meaningTeaser.srtPath,
      thumbnailPath: bundle.meaningTeaser.thumbnailPath,
      title: finalMeaningTeaserTitle,
      description: buildFinalMeaningTeaserDescription(script.youtube.meaningTeaser.description, finalFullTitle),
      tags: script.youtube.meaningTeaser.tags,
      containsSyntheticMedia: false,
    });

    uploads = { full: fullUpload, processTeaser: processTeaserUpload, meaningTeaser: meaningTeaserUpload };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  return { uploads };
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, 'generate-longform-video.mjs');
if (isMainModule) {
  generateOneLongformVideo().catch((err) => {
    console.error('[generate-longform] 실패:', err);
    process.exit(1);
  });
}
