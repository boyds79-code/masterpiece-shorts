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
 * 줌 효과를 주고, 하단에 자막(narration)을 태워 넣은 세그먼트 영상(오디오 없음)을 만듭니다.
 */
export async function buildSegmentClip({ imagePath, imgWidth, imgHeight, bbox, durationSec, captionText, outPath }) {
  const cw = Math.max(2, Math.round(bbox.w * imgWidth));
  const ch = Math.max(2, Math.round(bbox.h * imgHeight));
  const cx = Math.min(imgWidth - cw, Math.max(0, Math.round(bbox.x * imgWidth)));
  const cy = Math.min(imgHeight - ch, Math.max(0, Math.round(bbox.y * imgHeight)));

  const frames = Math.max(1, Math.round(durationSec * FPS));
  const zoomIncrease = 0.1; // 클립 전체에 걸쳐 10% 확대
  const zoomStep = zoomIncrease / frames;

  const captionFile = `${outPath}.caption.txt`;
  fs.writeFileSync(captionFile, wrapText(captionText));

  const vf = [
    `crop=${cw}:${ch}:${cx}:${cy}`,
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase`,
    `crop=${WIDTH}:${HEIGHT}`,
    `zoompan=z='min(zoom+${zoomStep.toFixed(6)},${(1 + zoomIncrease).toFixed(3)})':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
    `drawtext=fontfile=${escapeDrawtextPath(FONT_BOLD)}:textfile=${escapeDrawtextPath(captionFile)}:fontsize=52:fontcolor=white:line_spacing=10:x=(w-text_w)/2:y=h-420:box=1:boxcolor=black@0.55:boxborderw=28`,
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

  fs.rmSync(captionFile, { force: true });
  return outPath;
}

/**
 * 인트로/아웃트로용 타이틀 카드. 그림 전체를 어둡게 깔고 가운데(또는 하단)에 텍스트를 띄웁니다.
 */
export async function buildTitleCard({ imagePath, lines, durationSec, outPath }) {
  const captionFile = `${outPath}.caption.txt`;
  fs.writeFileSync(captionFile, lines.join('\n'));

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
    '-shortest',
    outPath,
  ]);

  fs.rmSync(captionFile, { force: true });
  return outPath;
}

export async function muxSegmentAudio({ videoPath, audioPath, outPath }) {
  await run('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-c:v', 'libx264',
    '-c:a', 'aac',
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
 * 전체 파이프라인: 세그먼트별 클립 생성 -> 오디오 합성 -> 인트로/아웃트로 -> 이어붙이기.
 * segments 각 항목은 { narration, bbox, audioPath, durationSec }를 가지고 있어야 합니다.
 */
export async function assembleVideo({ imagePath, segments, painting, workDir }) {
  fs.mkdirSync(workDir, { recursive: true });
  const { width: imgWidth, height: imgHeight } = await getImageDimensions(imagePath);

  const clipPaths = [];

  const introPath = path.join(workDir, 'intro.mp4');
  await buildTitleCard({
    imagePath,
    lines: [painting.title, `${painting.artistDisplayName}${painting.objectDate ? ' · ' + painting.objectDate : ''}`],
    durationSec: 2.5,
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
      captionText: seg.narration,
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

  return finalPath;
}
