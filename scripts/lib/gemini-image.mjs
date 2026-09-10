import fs from 'node:fs';

// Gemini의 이미지 생성/편집 API("Nano Banana" 계열 모델) 래퍼입니다. TTS(gemini-tts.mjs)와
// 같은 GEMINI_API_KEY를 그대로 재사용합니다 — 새 발급/새 시크릿이 필요 없습니다.
// 참고: https://ai.google.dev/gemini-api/docs/image-generation
//
// 이 엔드포인트("v1beta/interactions")는 비교적 최근에 나온 API라, 응답 JSON의 정확한
// 형태가 문서/실제 응답에서 조금씩 다를 수 있습니다. 아래 extractImageBase64()는 알려진
// 형태(interaction.output_image.data)를 먼저 시도하고, 안 맞으면 응답 전체를 재귀적으로
// 뒤져서 "mime_type이 image/*이고 data가 있는" 첫 객체를 찾는 방식으로 방어적으로
// 파싱합니다 — 만약 이 파싱이 실제 응답과 안 맞으면 에러 메시지에 원본 응답 일부를
// 그대로 남기므로, 그걸 보고 필드 경로만 고치면 됩니다.

const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryDelaySeconds(errText) {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(errText || '');
  return match ? Math.ceil(parseFloat(match[1])) : null;
}

const MAX_RETRIES = 4;
const DEFAULT_RETRY_DELAY_SEC = 30;
const TRANSIENT_STATUS_CODES = new Set([500, 502, 503, 504]);

// 응답 JSON 어딘가에서 { mime_type: "image/...", data: "<base64>" } 형태의 객체를 재귀적으로 찾습니다.
function findImagePart(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (typeof node.data === 'string' && typeof node.mime_type === 'string' && node.mime_type.startsWith('image/')) {
    return node;
  }
  // inlineData(camelCase) 형태(구 generateContent 스타일)도 혹시 몰라 함께 확인합니다.
  if (typeof node.data === 'string' && typeof node.mimeType === 'string' && node.mimeType.startsWith('image/')) {
    return node;
  }
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findImagePart(item, depth + 1);
        if (found) return found;
      }
    } else if (child && typeof child === 'object') {
      const found = findImagePart(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractImageBase64(data) {
  const direct = data?.interaction?.output_image?.data || data?.output_image?.data;
  if (direct) return direct;

  const found = findImagePart(data);
  if (found) return found.data;

  return null;
}

async function callGeminiImage({ body, apiKey }) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(INTERACTIONS_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      if (attempt < MAX_RETRIES) {
        console.log(
          `[gemini-image]   ⏳ 네트워크 오류(${networkErr.message}). ${DEFAULT_RETRY_DELAY_SEC}초 대기 후 재시도합니다 (${attempt}/${MAX_RETRIES})...`
        );
        await sleep(DEFAULT_RETRY_DELAY_SEC * 1000);
        continue;
      }
      throw networkErr;
    }

    if (res.ok) return res.json();

    const errText = await res.text();

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const delaySec = parseRetryDelaySeconds(errText) ?? DEFAULT_RETRY_DELAY_SEC;
      console.log(
        `[gemini-image]   ⏳ 레이트리밋(429). ${delaySec}초 대기 후 재시도합니다 (${attempt}/${MAX_RETRIES})...`
      );
      await sleep((delaySec + 2) * 1000);
      continue;
    }

    if (TRANSIENT_STATUS_CODES.has(res.status) && attempt < MAX_RETRIES) {
      console.log(
        `[gemini-image]   ⏳ Gemini 서버 일시 오류(${res.status}). ${DEFAULT_RETRY_DELAY_SEC}초 대기 후 재시도합니다 (${attempt}/${MAX_RETRIES})...`
      );
      await sleep(DEFAULT_RETRY_DELAY_SEC * 1000);
      continue;
    }

    throw new Error(`Gemini 이미지 생성 API 호출 실패 (${res.status}): ${errText}`);
  }
  throw new Error('Gemini 이미지 생성 API 호출이 재시도 한도를 넘어 계속 실패했습니다.');
}

/**
 * 완성작 이미지(referenceImageBuffer)를 참고 자료로 주고, prompt로 설명한 스타일(예: "이
 * 구도를 유지한 채, 아직 색을 칠하지 않은 연필 스케치처럼 보이게")로 새 이미지를 생성합니다.
 * 실제 그림의 제작 단계 기록이 아니라, AI가 완성작을 보고 "이런 식으로 시작했을 것 같다"고
 * 상상해서 새로 그리는 이미지입니다 — 호출하는 쪽(generate-process-video.mjs)에서 영상에
 * "AI 상상 재현"이라는 문구를 반드시 함께 노출해야 합니다.
 *
 * @returns {Promise<string>} 저장된 이미지 파일 경로 (outPath)
 */
export async function generateStageImage({ referenceImageBuffer, referenceMediaType, prompt, apiKey, model, outPath }) {
  apiKey = apiKey?.trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY가 설정되어 있지 않습니다. GitHub Actions Secret 또는 로컬 .env를 확인하세요.');
  }

  const body = {
    model: model || DEFAULT_IMAGE_MODEL,
    input: [
      { type: 'text', text: prompt },
      {
        type: 'image',
        mime_type: referenceMediaType,
        data: referenceImageBuffer.toString('base64'),
      },
    ],
  };

  const data = await callGeminiImage({ body, apiKey });
  const base64Image = extractImageBase64(data);
  if (!base64Image) {
    throw new Error(
      'Gemini 이미지 생성 응답에서 이미지 데이터를 찾지 못했습니다 (API 응답 형태가 예상과 다를 수 있음). 응답 일부: ' +
        JSON.stringify(data).slice(0, 800)
    );
  }

  fs.writeFileSync(outPath, Buffer.from(base64Image, 'base64'));
  return outPath;
}
