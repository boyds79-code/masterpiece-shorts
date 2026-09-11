import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { pickUnusedPainting, downloadImage } from './lib/met-api.mjs';
import { generateVideoScript, evaluatePaintingSuitability } from './lib/anthropic.mjs';
import { generateNarrationAudio } from './lib/gemini-tts.mjs';
import { assembleVideo } from './lib/video-builder.mjs';
import { uploadVideo, uploadCaptions, uploadThumbnail } from './lib/youtube-upload.mjs';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
const USED_PATH = path.join(ROOT, 'data', 'used-paintings.json');
const LOG_PATH = path.join(ROOT, 'data', 'log.md');

function loadUsed() {
  if (!fs.existsSync(USED_PATH)) return [];
  return JSON.parse(fs.readFileSync(USED_PATH, 'utf8'));
}

function saveUsed(list) {
  fs.mkdirSync(path.dirname(USED_PATH), { recursive: true });
  fs.writeFileSync(USED_PATH, JSON.stringify(list, null, 2) + '\n');
}

function appendLog({ painting, youtube, uploadResult }) {
  const today = new Date().toISOString().slice(0, 10);
  const row = `| ${today} | ${painting.title} | ${painting.artistDisplayName} | [${uploadResult.videoId}](${uploadResult.studioUrl}) |\n`;
  fs.appendFileSync(LOG_PATH, row);
}

// Claude에게 보여줄 이미지가 너무 크면(Met 원본은 수천 픽셀) API 제한/비용에 안 좋으니
// 긴 변 기준 1568px로 줄인 사본을 별도로 만듭니다. 영상 제작에는 원본 그대로 씁니다.
async function makeVisionCopy(originalPath, outPath) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', originalPath,
    '-vf', "scale='min(1568,iw)':'min(1568,ih)':force_original_aspect_ratio=decrease",
    '-q:v', '3',
    outPath,
  ]);
}

// 후보 그림 하나가 (a) Claude vision이 민감한 소재(누드가 포함된 종교화/신화화 등)로 보고
// segments를 비운 채 반환하거나, (b) 사전 적합성 심사에서 "다인물/서사/상징이 부족해 파고들
// 디테일이 거의 없다"고 판정되는 경우가 있습니다 — 두 경우 모두 전체 실행을 실패시키는 대신
// 그 그림만 "skipped"로 기록해서 다음에 다시 뽑히지 않게 하고 다른 그림으로 넘어갑니다.
// 적합성 심사로 거절되는 그림이 늘어난 만큼 시도 횟수를 4 -> 6으로 늘립니다.
const MAX_PAINTING_ATTEMPTS = 6;

/**
 * 영상 하나(그림 선정 -> 대본 -> 나레이션 -> 영상 조립 -> YouTube 업로드)를 처음부터 끝까지
 * 만듭니다. generate-batch.mjs가 이 함수를 여러 번 반복 호출해서 한 번에 여러 개를 만들 때도
 * 쓰고, 이 파일을 직접 실행(`npm run generate`)할 때도 씁니다.
 *
 * @returns {Promise<{ painting: object, script: object, uploadResult: object } | null>}
 *   성공하면 결과 정보를 반환하고, 시도 가능한 그림을 다 소진해서 더 만들 게 없으면 null을 반환합니다.
 */
export async function generateOneVideo() {
  // 같은 프로세스 안에서 여러 번 호출될 수 있으므로(배치 실행) 매번 새 작업 폴더를 만듭니다.
  const workDir = path.join(ROOT, 'output', `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(workDir, { recursive: true });

  const usedList = loadUsed();
  let painting = null;
  let script = null;
  let imagePath, visionPath;

  for (let attempt = 1; attempt <= MAX_PAINTING_ATTEMPTS; attempt++) {
    console.log(`[generate-video] 메트로폴리탄 미술관에서 아직 쓰지 않은 명화를 고르는 중... (시도 ${attempt}/${MAX_PAINTING_ATTEMPTS})`);
    const usedIds = usedList.map((u) => u.objectID);
    const candidate = await pickUnusedPainting(usedIds);

    if (!candidate) {
      console.log('[generate-video] 하이라이트로 지정된 유럽 회화 작품을 모두 소진했습니다. 새 department를 추가해야 합니다 (scripts/lib/met-api.mjs의 DEPARTMENT_IDS 참고).');
      fs.rmSync(workDir, { recursive: true, force: true });
      return null;
    }

    console.log(`[generate-video] 선정: "${candidate.title}" — ${candidate.artistDisplayName} (${candidate.objectDate})`);

    imagePath = path.join(workDir, 'original.jpg');
    visionPath = path.join(workDir, 'vision.jpg');
    const imageBuffer = await downloadImage(candidate.primaryImage);
    fs.writeFileSync(imagePath, imageBuffer);
    await makeVisionCopy(imagePath, visionPath);

    console.log('[generate-video] Claude에게 이 그림이 포맷에 맞는 소재인지(다인물/서사/상징 밀도) 먼저 확인하는 중...');
    let suitability;
    try {
      suitability = await evaluatePaintingSuitability({
        imageBufferForVision: fs.readFileSync(visionPath),
        imageMediaType: 'image/jpeg',
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.CLAUDE_MODEL,
      });
    } catch (err) {
      // 적합성 판단 자체가 실패해도(네트워크/레이트리밋 등) 이 그림을 억울하게 버리지 않고
      // 그냥 통과시켜서 계속 진행합니다 — 다음 단계인 대본 생성에서 어차피 한 번 더
      // 품질(소재 민감도) 검증이 이뤄집니다.
      console.warn(`[generate-video] 적합성 판단 실패, 건너뛰지 않고 계속 진행합니다: ${err.message}`);
      suitability = { suitable: true };
    }

    if (!suitability.suitable) {
      console.warn(
        `[generate-video] "${candidate.title}" 은(는) 소재가 단조로워(인물 수: ${suitability.figureCount ?? '?'}) 건너뜁니다: ${suitability.reason || ''}`
      );
      usedList.push({
        objectID: candidate.objectID,
        title: candidate.title,
        artistDisplayName: candidate.artistDisplayName,
        skippedAt: new Date().toISOString(),
        skipped: true,
        reason: `[낮은 서사/상징 밀도, 인물 수 ${suitability.figureCount ?? '?'}] ${suitability.reason || ''}`.slice(0, 300),
      });
      saveUsed(usedList); // 같은 그림을 다음 실행에서 또 뽑지 않도록 바로 저장
      fs.rmSync(imagePath, { force: true });
      fs.rmSync(visionPath, { force: true });
      continue;
    }

    console.log('[generate-video] Claude에게 그림을 보여주고 대본을 받는 중...');
    try {
      script = await generateVideoScript({
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
        // 이 그림 자체의 문제가 아니라 API 과금/네트워크/인증 등 시스템 차원의 문제입니다
        // (예: "credit balance too low"). 이런 경우 이 그림을 영구히 제외 목록에 넣는 건
        // 억울하므로 블랙리스트에 올리지 않고, 다른 그림으로도 재시도하지 않은 채 바로
        // 에러를 던져서 위(배치 스크립트 등) 호출자가 문제를 알아채게 합니다.
        console.error(`[generate-video] "${candidate.title}" 대본 생성 중 그림과 무관한 오류 발생 — 이 그림은 블랙리스트에 넣지 않고 바로 중단합니다: ${err.message}`);
        fs.rmSync(imagePath, { force: true });
        fs.rmSync(visionPath, { force: true });
        fs.rmSync(workDir, { recursive: true, force: true });
        throw err;
      }
      console.warn(`[generate-video] "${candidate.title}" 대본 생성 실패(민감한 소재로 추정), 다른 그림으로 넘어갑니다: ${err.message}`);
      usedList.push({
        objectID: candidate.objectID,
        title: candidate.title,
        artistDisplayName: candidate.artistDisplayName,
        skippedAt: new Date().toISOString(),
        skipped: true,
        reason: String(err.message).slice(0, 300),
      });
      saveUsed(usedList); // 같은 그림을 다음 실행에서 또 뽑지 않도록 바로 저장
      fs.rmSync(imagePath, { force: true });
      fs.rmSync(visionPath, { force: true });
    }
  }

  if (!painting) {
    throw Object.assign(
      new Error(`${MAX_PAINTING_ATTEMPTS}개 그림을 시도했지만 모두 민감한 소재이거나 소재가 단조로워(다인물/서사/상징 부족) 사용하지 못했습니다.`),
      { code: 'CONTENT_REFUSAL' }
    );
  }

  console.log(`[generate-video] 대본 완성 — 세그먼트 ${script.segments.length}개, 제목: "${script.youtube.title}"`);

  const { uploadResult } = await buildAndUploadHiddenMeaningVideo({ painting, script, imagePath, workDir });

  usedList.push({
    objectID: painting.objectID,
    title: painting.title,
    artistDisplayName: painting.artistDisplayName,
    usedAt: new Date().toISOString(),
    videoIdMeaning: uploadResult.videoId,
  });
  saveUsed(usedList);
  appendLog({ painting, youtube: script.youtube, uploadResult });

  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      `VIDEO_TITLE=${script.youtube.title}\nVIDEO_ID=${uploadResult.videoId}\nPAINTING_TITLE=${painting.title}\n`
    );
  }

  return { painting, script, uploadResult };
}

/**
 * "숨은 의미" 대본(script) + 이미 선정된 그림/이미지로부터 나레이션 오디오 생성 -> 영상 조립
 * -> YouTube 업로드(영상/자막/썸네일)까지 처리합니다. generateOneVideo()가 내부적으로 이
 * 함수를 쓰며, 그림 선정/대본 생성 로직과 분리해 둔 덕에 그림 선정을 직접 하는 다른
 * 오케스트레이터도 이미 만든 painting/script/imagePath만 넘겨서 재사용할 수 있습니다.
 *
 * workDir은 호출자가 만들어서 넘겨야 하고, 성공/실패와 무관하게 이 함수가 끝나면서
 * (finally) 삭제합니다 — 호출자는 그 안의 파일을 이 함수 호출 이후에 쓰면 안 됩니다.
 *
 * @returns {Promise<{ uploadResult: object }>}
 */
export async function buildAndUploadHiddenMeaningVideo({ painting, script, imagePath, workDir }) {
  // 여기서부터 업로드 완료까지 중간 어디서든 실패하면(TTS 서버 오류, ffmpeg 실패, 업로드
  // 인증 오류 등) workDir(원본 이미지/오디오/조립 중간 파일)을 지우지 않고 남겨두면 배치로
  // 여러 개 돌릴 때 실패한 시도마다 output/ 폴더에 찌꺼기가 계속 쌓입니다. try/finally로
  // 성공/실패 상관없이 workDir을 정리합니다 (실패 시에도 에러는 그대로 위로 던집니다).
  let uploadResult;
  try {
    console.log('[generate-video] 각 세그먼트 나레이션 오디오 생성 중 (Gemini TTS)...');
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
      console.log(`[generate-video]   세그먼트 ${i + 1}/${script.segments.length} 오디오 완료 (${durationSec.toFixed(1)}초)`);
    }

    console.log('[generate-video] ffmpeg로 영상 조립 중 (줌/팬, 자막은 굽지 않고 SRT로 별도 생성, 썸네일 생성)...');
    const { finalPath: finalVideoPath, srtPath, thumbnailPath } = await assembleVideo({
      imagePath,
      segments: script.segments,
      painting,
      workDir: path.join(workDir, 'assembly'),
    });
    console.log(`[generate-video] 영상 완성: ${finalVideoPath}`);

    const privacyStatus = process.env.YOUTUBE_PRIVACY_STATUS || 'private';
    console.log(`[generate-video] YouTube에 "${privacyStatus}" 상태로 업로드 중...`);
    uploadResult = await uploadVideo({
      filePath: finalVideoPath,
      title: script.youtube.title,
      description: script.youtube.description,
      tags: script.youtube.tags,
      privacyStatus,
      clientId: process.env.YOUTUBE_CLIENT_ID,
      clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
      refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
    });
    console.log(`[generate-video] 업로드 완료! 검토용 링크: ${uploadResult.studioUrl}`);

    console.log('[generate-video] 자막(CC) 트랙 업로드 중...');
    try {
      await uploadCaptions({
        videoId: uploadResult.videoId,
        srtPath,
        clientId: process.env.YOUTUBE_CLIENT_ID,
        clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
        refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
      });
      console.log('[generate-video] 자막 업로드 완료.');
    } catch (err) {
      // 영상 업로드 자체는 이미 성공했으니, 자막 업로드가 실패해도 전체 실행을 실패시키지
      // 않습니다 — 검수 시 YouTube Studio에서 자막을 수동으로 다시 올릴 수 있습니다.
      console.warn(`[generate-video] 자막 업로드 실패 (영상은 정상 업로드됨): ${err.message}`);
    }

    console.log('[generate-video] 썸네일(그림 전체 화면) 업로드 중...');
    try {
      await uploadThumbnail({
        videoId: uploadResult.videoId,
        thumbnailPath,
        clientId: process.env.YOUTUBE_CLIENT_ID,
        clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
        refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
      });
      console.log('[generate-video] 썸네일 업로드 완료.');
    } catch (err) {
      // 커스텀 썸네일은 "휴대폰 인증된 채널"만 허용되는 등 계정 설정에 따라 실패할 수 있어서,
      // 여기서도 전체 실행을 실패시키지 않고 경고만 남깁니다 — 필요하면 YouTube Studio에서
      // 수동으로 썸네일을 올릴 수 있습니다 (output/ 폴더가 이미 정리된 뒤라면 다시 생성해야 함).
      console.warn(`[generate-video] 썸네일 업로드 실패 (영상은 정상 업로드됨): ${err.message}`);
    }
  } finally {
    // 업로드까지 끝났든(성공) 중간에 실패했든, 로컬 임시 산출물(원본 이미지, 오디오,
    // 중간 영상들)은 여기서 정리합니다. 저장소에는 data/used-paintings.json과
    // data/log.md만 남습니다.
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  return { uploadResult };
}

// 이 파일을 직접 실행했을 때만(`npm run generate`) 한 번 돌립니다. generate-batch.mjs처럼
// 다른 파일에서 generateOneVideo()를 import해서 쓸 때는 이 블록이 실행되지 않습니다.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, 'generate-video.mjs');
if (isMainModule) {
  generateOneVideo().catch((err) => {
    console.error('[generate-video] 실패:', err);
    process.exit(1);
  });
}
