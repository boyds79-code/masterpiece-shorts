import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;

// Ubuntu(GitHub Actions 포함)에는 fonts-dejavu-core 패키지로 이 경로가 설치됩니다.
// daily-video.yml에서 apt-get install fonts-dejavu-core를 실행합니다.
const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

async function run(cmd, args) {
  try {
    return await execFileAsync(cmd, args, { maxBuffer: 1024 * 1024 * 64 });
  } catch (err) {
    throw new Error(`${cmd} 실행 실패: ${err.stderr || err.message}`);
  }
}

export async function getImageDimensions(imagePath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=s=x:p=0',
    imagePath,
  ]);
  const [width, height] = stdout.trim().split('x').map(Number);
  return { width, height };
}

/**
 * bbox(0~1 비율)에 해당하는 영역만 정지 이미지로 잘라냅니다. anthropic.mjs가 "Claude가
 * 고른 확대 영역이 실제로 의도한 디테일을 보여주는지" 검증할 때, 그 crop 미리보기를
 * 만드는 데 씁니다 (다람쥐를 보라면서 실제로는 손이 확대되는 것 같은 오류를 잡기 위함).
 */
export async function cropStill({ imagePath, bbox, imgWidth, imgHeight, outPath }) {
  const cw = Math.max(2, Math.round(bbox.w * imgWidth));
  const ch = Math.max(2, Math.round(bbox.h * imgHeight));
  const cx = Math.min(imgWidth - cw, Math.max(0, Math.round(bbox.x * imgWidth)));
  const cy = Math.min(imgHeight - ch, Math.max(0, Math.round(bbox.y * imgHeight)));

  await run('ffmpeg', [
    '-y',
    '-i', imagePath,
    '-vf', `crop=${cw}:${ch}:${cx}:${cy}`,
    '-q:v', '3',
    outPath,
  ]);

  return outPath;
}

// 자막이 화면 폭을 벗어나지 않도록 대략적인 글자 수 기준으로 줄바꿈합니다.
// (drawtext는 자동 줄바꿈을 지원하지 않아 직접 처리해야 합니다.)
function wrapText(text, maxCharsPerLine = 26) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

function escapeDrawtextPath(p) {
  // drawtext 필터 옵션 안에서 콜론/백슬래시/작은따옴표는 특수 문자라 이스케이프가 필요합니다.
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * 원본 그림 이미지에서 bbox 영역으로 크롭한 뒤 9:16으로 채우고, 은은한 Ken Burns
 * 줌 효과를 준 세그먼트 영상(오디오 없음)을 만듭니다.
 *
 * 예전에는 여기서 drawtext로 나레이션 자막을 영상에 직접 태웠지만, 폰트가 딱딱해
 * 보인다는 피드백에 따라 영상에는 자막을 굽지 않습니다. 대신 buildSrt()로 만든
 * SRT 파일을 YouTube 자막(CC) 트랙으로 별도 업로드합니다 — youtube-upload.mjs의
 * uploadCaptions() 참고. 시청자가 CC를 켜면 유튜브 플레이어 자체 폰트로 보입니다.
 */
export async function buildSegmentClip({ imagePath, imgWidth, imgHeight, bbox, durationSec, outPath }) {
  const cw = Math.max(2, Math.round(bbox.w * imgWidth));
  const ch = Math.max(2, Math.round(bbox.h * imgHeight));
  const cx = Math.min(imgWidth - cw, Math.max(0, Math.round(bbox.x * imgWidth)));
  const cy = Math.min(imgHeight - ch, Math.max(0, Math.round(bbox.y * imgHeight)));

  const frames = Math.max(1, Math.round(durationSec * FPS));
  const zoomIncrease = 0.1; // 클립 전체에 걸쳐 10% 확대
  const zoomStep = zoomIncrease / frames;

  const vf = [
    `crop=${cw}:${ch}:${cx}:${cy}`,
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase`,
    `crop=${WIDTH}:${HEIGHT}`,
    `zoompan=z='min(zoom+${zoomStep.toFixed(6)},${(1 + zoomIncrease).toFixed(3)})':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
    'format=yuv420p',
  ].join(',');

  await run('ffmpeg', [
    '-y',
    '-loop', '1',
    '-i', imagePath,
    '-t', String(durationSec),
    '-r', String(FPS),
    '-vf', vf,
    '-an',
    outPath,
  ]);

  return outPath;
}

// 타이틀 카드는 fontsize=58, WIDTH=1080px 기준으로 그립니다. drawtext는 자동
// 줄바꿈을 지원하지 않아서, 긴 작품명/작가명(특히 "작가 · 연도"처럼 이어붙인 줄)이
// 그대로 한 줄로 그려지면 text_w가 프레임 폭을 넘어서고, x=(w-text_w)/2가 음수가
// 되면서 양쪽 끝이 잘려 보입니다 — 각 줄을 이 글자수 기준으로 먼저 감싸줍니다.
const TITLE_CARD_MAX_CHARS_PER_LINE = 24;

/**
 * 인트로/아웃트로용 타이틀 카드. 그림 전체를 어둡게 깔고 가운데(또는 하단)에 텍스트를 띄웁니다.
 */
export async function buildTitleCard({ imagePath, lines, durationSec, outPath }) {
  const captionFile = `${outPath}.caption.txt`;
  const wrapped = lines.map((line) => wrapText(line, TITLE_CARD_MAX_CHARS_PER_LINE));
  fs.writeFileSync(captionFile, wrapped.join('\n'));

  const vf = [
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase`,
    `crop=${WIDTH}:${HEIGHT}`,
    'boxblur=6:1',
    'eq=brightness=-0.25',
    `drawtext=fontfile=${escapeDrawtextPath(FONT_BOLD)}:textfile=${escapeDrawtextPath(captionFile)}:fontsize=58:fontcolor=white:line_spacing=14:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.45:boxborderw=32`,
    'format=yuv420p',
  ].join(',');

  await run('ffmpeg', [
    '-y',
    '-loop', '1',
    '-i', imagePath,
    '-f', 'lavfi',
    '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', String(durationSec),
    '-r', String(FPS),
    '-vf', vf,
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-ar', String(AUDIO_SAMPLE_RATE),
    '-ac', String(AUDIO_CHANNELS),
    '-shortest',
    outPath,
  ]);

  fs.rmSync(captionFile, { force: true });
  return outPath;
}

/**
 * YouTube 썸네일용 정지 이미지를 만듭니다. 인트로 카드와 달리 그림을 잘라내지(crop) 않고
 * 전체가 다 보이도록 비율에 맞춰 안쪽에 맞추고(letterbox/pillarbox), 남는 여백은 같은
 * 그림을 흐릿하게 확대한 배경으로 채웁니다 — 검은 여백 없이 그림 전체를 꽉 찬 느낌으로
 * 보여주기 위해서입니다.
 */
export async function buildThumbnail({ imagePath, outPath }) {
  const filterComplex = [
    `[0:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},boxblur=25:5,eq=brightness=-0.08[bg]`,
    `[0:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p[out]`,
  ].join(';');

  await run('ffmpeg', [
    '-y',
    '-i', imagePath,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-frames:v', '1',
    '-q:v', '2',
    outPath,
  ]);

  return outPath;
}

// Gemini TTS는 세그먼트마다 샘플레이트/채널이 살짝 다를 수 있는데(예: 24kHz 모노), 인트로/아웃트로는
// 44.1kHz 스테레오 무음 트랙입니다. concat demuxer는 모든 입력 파일의 오디오 스트림 규격이 완전히
// 동일하다고 가정하고 그냥 패킷을 이어붙이는 방식이라, 규격이 섞이면 디코더가 깨져서
// "channel element ... is not allocated" 같은 알아보기 힘든 에러를 뱉습니다. 그래서 모든 클립의
// 오디오를 여기서 명시적으로 같은 샘플레이트/채널로 강제 통일합니다.
const AUDIO_SAMPLE_RATE = 44100;
const AUDIO_CHANNELS = 2;

// 인트로 카드 길이 (초). assembleVideo()의 intro 클립과 buildSrt()의 자막 시작 시각
// 계산 둘 다에서 이 값을 써서 서로 어긋나지 않게 합니다.
const INTRO_DURATION_SEC = 2.5;

function formatSrtTimestamp(totalSeconds) {
  const ms = Math.max(0, Math.round(totalSeconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msec = ms % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msec, 3)}`;
}

/**
 * 각 세그먼트의 나레이션 텍스트 + 재생 시간(durationSec)을 바탕으로 SRT 자막 파일
 * 내용을 만듭니다. 인트로 카드 동안에는 나레이션이 없으므로 첫 세그먼트 자막은
 * introDurationSec 이후부터 시작합니다.
 */
export function buildSrt(segments, introDurationSec = INTRO_DURATION_SEC) {
  let t = introDurationSec;
  const blocks = segments.map((seg, i) => {
    const start = t;
    const end = t + seg.durationSec;
    t = end;
    return `${i + 1}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${wrapText(seg.narration, 42)}\n`;
  });
  return blocks.join('\n');
}

export async function muxSegmentAudio({ videoPath, audioPath, outPath }) {
  await run('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-ar', String(AUDIO_SAMPLE_RATE),
    '-ac', String(AUDIO_CHANNELS),
    '-b:a', '128k',
    '-shortest',
    outPath,
  ]);
  return outPath;
}

export async function concatClips(clipPaths, outPath) {
  const listPath = `${outPath}.list.txt`;
  const listContent = clipPaths.map((p) => `file '${path.resolve(p)}'`).join('\n');
  fs.writeFileSync(listPath, listContent);

  await run('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-pix_fmt', 'yuv420p',
    outPath,
  ]);

  fs.rmSync(listPath, { force: true });
  return outPath;
}

/**
 * 전체 파이프라인: 세그먼트별 클립 생성 -> 오디오 합성 -> 인트로/아웃트로 -> 이어붙이기
 * -> SRT 자막 파일 생성 -> 썸네일 이미지 생성. segments 각 항목은
 * { narration, bbox, audioPath, durationSec }를 가지고 있어야 합니다.
 *
 * @returns {{ finalPath: string, srtPath: string, thumbnailPath: string }} finalPath는 자막이
 *   굽지 않은(burned-in caption 없는) 영상이고, srtPath는 YouTube 자막(CC) 트랙으로 별도
 *   업로드할 SRT 파일, thumbnailPath는 그림 전체가 잘리지 않고 다 보이는 썸네일 이미지입니다.
 */
export async function assembleVideo({ imagePath, segments, painting, workDir }) {
  fs.mkdirSync(workDir, { recursive: true });
  const { width: imgWidth, height: imgHeight } = await getImageDimensions(imagePath);

  const clipPaths = [];

  const introPath = path.join(workDir, 'intro.mp4');
  await buildTitleCard({
    imagePath,
    lines: [painting.title, `${painting.artistDisplayName}${painting.objectDate ? ' · ' + painting.objectDate : ''}`],
    durationSec: INTRO_DURATION_SEC,
    outPath: introPath,
  });
  clipPaths.push(introPath);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const rawVideo = path.join(workDir, `seg-${i}-video.mp4`);
    const finalSeg = path.join(workDir, `seg-${i}-final.mp4`);

    await buildSegmentClip({
      imagePath,
      imgWidth,
      imgHeight,
      bbox: seg.bbox,
      durationSec: seg.durationSec,
      outPath: rawVideo,
    });
    await muxSegmentAudio({ videoPath: rawVideo, audioPath: seg.audioPath, outPath: finalSeg });
    fs.rmSync(rawVideo, { force: true });
    clipPaths.push(finalSeg);
  }

  const outroPath = path.join(workDir, 'outro.mp4');
  await buildTitleCard({
    imagePath,
    lines: ['Look closer next time.', 'Follow for more hidden details\nin famous paintings.'],
    durationSec: 3,
    outPath: outroPath,
  });
  clipPaths.push(outroPath);

  const finalPath = path.join(workDir, 'final.mp4');
  await concatClips(clipPaths, finalPath);

  const srtPath = path.join(workDir, 'captions.srt');
  fs.writeFileSync(srtPath, buildSrt(segments, INTRO_DURATION_SEC));

  const thumbnailPath = path.join(workDir, 'thumbnail.jpg');
  await buildThumbnail({ imagePath, outPath: thumbnailPath });

  return { finalPath, srtPath, thumbnailPath };
}


/**
 * "제작 과정 상상 재현" 영상 전용 조립 함수. 기존 assembleVideo()와 달리 세그먼트마다
 * 서로 다른 이미지(실제 사진 또는 AI가 생성한 스케치/밑칠/마무리 직전 단계 이미지)를 쓸 수
 * 있습니다. segments 각 항목은 { narration, audioPath, durationSec, imagePath, bbox }를
 * 가지고 있어야 합니다 — bbox가 없으면 전체 화면(x:0,y:0,w:1,h:1)으로 간주합니다.
 *
 * 인트로 카드에는 "AI-Imagined Creation Process"라는 문구를 항상 고정으로 넣어서, 이 영상이
 * 실제 제작 기록이 아니라 AI가 상상으로 재구성한 것임을 시청자가 나레이션을 듣기도 전에
 * 화면에서부터 알 수 있게 합니다 (대본 나레이션에만 의존하지 않는 코드 레벨 안전장치).
 *
 * @returns {{ finalPath: string, srtPath: string, thumbnailPath: string }}
 */
export async function assembleProcessVideo({ finishedImagePath, segments, painting, workDir }) {
  fs.mkdirSync(workDir, { recursive: true });

  const clipPaths = [];

  const introPath = path.join(workDir, 'intro.mp4');
  await buildTitleCard({
    imagePath: finishedImagePath,
    lines: [
      painting.title,
      `${painting.artistDisplayName}${painting.objectDate ? ' · ' + painting.objectDate : ''}`,
      'AI-Imagined Creation Process',
    ],
    durationSec: INTRO_DURATION_SEC,
    outPath: introPath,
  });
  clipPaths.push(introPath);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const bbox = seg.bbox || { x: 0, y: 0, w: 1, h: 1 };
    const { width: imgWidth, height: imgHeight } = await getImageDimensions(seg.imagePath);

    const rawVideo = path.join(workDir, `seg-${i}-video.mp4`);
    const finalSeg = path.join(workDir, `seg-${i}-final.mp4`);

    await buildSegmentClip({
      imagePath: seg.imagePath,
      imgWidth,
      imgHeight,
      bbox,
      durationSec: seg.durationSec,
      outPath: rawVideo,
    });
    await muxSegmentAudio({ videoPath: rawVideo, audioPath: seg.audioPath, outPath: finalSeg });
    fs.rmSync(rawVideo, { force: true });
    clipPaths.push(finalSeg);
  }

  const outroPath = path.join(workDir, 'outro.mp4');
  await buildTitleCard({
    imagePath: finishedImagePath,
    lines: ['A speculative recreation,', 'imagined from the finished piece.'],
    durationSec: 3,
    outPath: outroPath,
  });
  clipPaths.push(outroPath);

  const finalPath = path.join(workDir, 'final.mp4');
  await concatClips(clipPaths, finalPath);

  const srtPath = path.join(workDir, 'captions.srt');
  fs.writeFileSync(srtPath, buildSrt(segments, INTRO_DURATION_SEC));

  const thumbnailPath = path.join(workDir, 'thumbnail.jpg');
  await buildThumbnail({ imagePath: finishedImagePath, outPath: thumbnailPath });

  return { finalPath, srtPath, thumbnailPath };
}
