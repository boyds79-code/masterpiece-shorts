import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { pickUnusedPainting, downloadImage } from './lib/met-api.mjs';
import { generateVideoScript } from './lib/anthropic.mjs';
import { generateNarrationAudio } from './lib/gemini-tts.mjs';
import { assembleVideo } from './lib/video-builder.mjs';
import { uploadVideo } from './lib/youtube-upload.mjs';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
const USED_PATH = path.join(ROOT, 'data', 'used-paintings.json');
const LOG_PATH = path.join(ROOT, 'data', 'log.md');
const WORK_DIR = path.join(ROOT, 'output', `run-${Date.now()}`);

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

async function main() {
  fs.mkdirSync(WORK_DIR, { recursive: true });

  console.log('[generate-video] 메트로폴리탄 미술관에서 아직 쓰지 않은 명화를 고르는 중...');
  const usedList = loadUsed();
  const usedIds = usedList.map((u) => u.objectID);
  const painting = await pickUnusedPainting(usedIds);

  if (!painting) {
    console.log('[generate-video] 하이라이트로 지정된 유럽 회화 작품을 모두 소진했습니다. 새 department를 추가해야 합니다 (scripts/lib/met-api.mjs의 DEPARTMENT_IDS 참고).');
    return;
  }

  console.log(`[generate-video] 선정: "${painting.title}" — ${painting.artistDisplayName} (${painting.objectDate})`);

  const imagePath = path.join(WORK_DIR, 'original.jpg');
  const visionPath = path.join(WORK_DIR, 'vision.jpg');
  const imageBuffer = await downloadImage(painting.primaryImage);
  fs.writeFileSync(imagePath, imageBuffer);
  await makeVisionCopy(imagePath, visionPath);

  console.log('[generate-video] Claude에게 그림을 보여주고 대본을 받는 중...');
  const script = await generateVideoScript({
    painting,
    imageBufferForVision: fs.readFileSync(visionPath),
    imageMediaType: 'image/jpeg',
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.CLAUDE_MODEL,
  });
  console.log(`[generate-video] 대본 완성 — 세그먼트 ${script.segments.length}개, 제목: "${script.youtube.title}"`);

  console.log('[generate-video] 각 세그먼트 나레이션 오디오 생성 중 (Gemini TTS)...');
  for (let i = 0; i < script.segments.length; i++) {
    const seg = script.segments[i];
    const audioPath = path.join(WORK_DIR, `seg-${i}-audio.wav`);
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

  console.log('[generate-video] ffmpeg로 영상 조립 중 (줌/팬 + 자막)...');
  const finalVideoPath = await assembleVideo({
    imagePath,
    segments: script.segments,
    painting,
    workDir: path.join(WORK_DIR, 'assembly'),
  });
  console.log(`[generate-video] 영상 완성: ${finalVideoPath}`);

  const privacyStatus = process.env.YOUTUBE_PRIVACY_STATUS || 'private';
  console.log(`[generate-video] YouTube에 "${privacyStatus}" 상태로 업로드 중...`);
  const uploadResult = await uploadVideo({
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

  usedList.push({
    objectID: painting.objectID,
    title: painting.title,
    artistDisplayName: painting.artistDisplayName,
    usedAt: new Date().toISOString(),
    videoId: uploadResult.videoId,
  });
  saveUsed(usedList);
  appendLog({ painting, youtube: script.youtube, uploadResult });

  // 업로드까지 끝났으니 로컬 임시 산출물(원본 이미지, 오디오, 중간 영상들)은 정리합니다.
  // 저장소에는 data/used-paintings.json과 data/log.md만 남습니다.
  fs.rmSync(WORK_DIR, { recursive: true, force: true });

  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      `VIDEO_TITLE=${script.youtube.title}\nVIDEO_ID=${uploadResult.videoId}\nPAINTING_TITLE=${painting.title}\n`
    );
  }
}

main().catch((err) => {
  console.error('[generate-video] 실패:', err);
  process.exit(1);
});
