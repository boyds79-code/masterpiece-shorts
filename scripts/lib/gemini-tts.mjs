import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts';
const DEFAULT_VOICE = 'Kore'; // https://ai.google.dev/gemini-api/docs/speech-generation 의 사전 정의 음성 중 하나

// Gemini TTS는 raw PCM 오디오를 돌려줍니다 (mimeType 예: "audio/L16;codec=pcm;rate=24000").
// 헤더가 없는 순수 PCM이라, ffmpeg으로 변환할 때 샘플레이트/채널을 직접 알려줘야 합니다.
function parsePcmMimeType(mimeType) {
  const rateMatch = /rate=(\d+)/.exec(mimeType || '');
  return {
    sampleRate: rateMatch ? Number(rateMatch[1]) : 24000,
    channels: 1,
    bitsPerSample: 16,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 429 응답 본문에서 "retryDelay": "56s" 같은 값을 뽑아냅니다. 없으면 null.
function parseRetryDelaySeconds(errText) {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(errText || '');
  return match ? Math.ceil(parseFloat(match[1])) : null;
}

// Gemini TTS 무료 등급은 분당 요청 수가 매우 적게 제한되어 있어서(예: 3회/분),
// 영상 하나에 세그먼트가 6~9개면 중간에 429(RESOURCE_EXHAUSTED)를 만나는 게 정상입니다.
// 실패로 끝내지 않고, 서버가 알려주는 retryDelay(또는 기본 65초)만큼 기다렸다가 자동 재시도합니다.
const MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_SEC = 65;

async function callGeminiTts({ url, body }) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) return res.json();

    const errText = await res.text();

    // "PerDay" 한도는 며칠 자릿수라 몇십 초 기다리는 재시도로는 절대 안 풀립니다 —
    // 괜히 재시도로 시간 낭비하지 말고 바로 명확한 에러로 알려줍니다.
    if (res.status === 429 && /PerDay/i.test(errText)) {
      throw new Error(
        `Gemini TTS 무료 등급의 "하루 요청 횟수" 한도를 넘었습니다 (재시도로 해결 안 됨). ` +
          `Google Cloud 프로젝트에 결제(billing)를 연결하면 한도가 크게 늘어납니다 — ` +
          `https://aistudio.google.com/apikey 또는 Google Cloud Console → Billing에서 설정하세요. ` +
          `원본 에러: ${errText}`
      );
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const delaySec = parseRetryDelaySeconds(errText) ?? DEFAULT_RETRY_DELAY_SEC;
      console.log(
        `[gemini-tts]   ⏳ 무료 등급 분당 요청 한도(429)에 걸렸습니다. ${delaySec}초 대기 후 재시도합니다 (${attempt}/${MAX_RETRIES})...`
      );
      await sleep((delaySec + 2) * 1000); // 여유 2초 추가
      continue;
    }

    throw new Error(`Gemini TTS 호출 실패 (${res.status}): ${errText}`);
  }
  throw new Error('Gemini TTS 호출이 재시도 한도를 넘어 계속 실패했습니다 (429).');
}

/**
 * 대본 한 문단(segment.narration)을 나레이션 오디오(.wav)로 만들어 outPath에 저장하고,
 * 실제 길이(초)를 돌려줍니다. 영상 각 구간의 길이를 이 오디오 길이에 정확히 맞춰야 하므로,
 * 길이 측정은 ffprobe로 직접 합니다 (텍스트 길이로 추정하지 않음 — 부정확함).
 */
export async function generateNarrationAudio({ text, apiKey, model, voice, outPath }) {
  apiKey = apiKey?.trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY가 설정되어 있지 않습니다. GitHub Actions Secret 또는 로컬 .env를 확인하세요.');
  }

  const chosenModel = model || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${chosenModel}:generateContent?key=${apiKey}`;

  // "Say warmly and curiously:" 같은 스타일 지시를 프롬프트 앞에 붙이면 Gemini TTS가
  // 어조를 더 잘 반영합니다 (공식 문서 권장 패턴).
  const styledText = `Say in a warm, curious, engaging narrator voice, at a natural conversational pace: ${text}`;

  const body = {
    contents: [{ parts: [{ text: styledText }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice || DEFAULT_VOICE },
        },
      },
    },
  };

  const data = await callGeminiTts({ url, body });
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) {
    throw new Error('Gemini TTS 응답에서 오디오 데이터를 찾지 못했습니다: ' + JSON.stringify(data).slice(0, 500));
  }

  const pcmBuffer = Buffer.from(part.inlineData.data, 'base64');
  const { sampleRate, channels } = parsePcmMimeType(part.inlineData.mimeType);

  const rawPath = `${outPath}.raw`;
  fs.writeFileSync(rawPath, pcmBuffer);

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 's16le',
      '-ar', String(sampleRate),
      '-ac', String(channels),
      '-i', rawPath,
      outPath,
    ]);
  } finally {
    fs.rmSync(rawPath, { force: true });
  }

  const duration = await getAudioDuration(outPath);
  return { path: outPath, durationSec: duration };
}

export async function getAudioDuration(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  return parseFloat(stdout.trim());
}
