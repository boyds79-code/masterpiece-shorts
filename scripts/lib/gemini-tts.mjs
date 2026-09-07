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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini TTS 호출 실패 (${res.status}): ${errText}`);
  }

  const data = await res.json();
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
