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

// { data, mimeType } 형태로 반환합니다 — mimeType은 다음 체이닝 단계에서 "직전 단계
// 이미지"를 다시 참고 이미지로 넣을 때 정확한 형식을 알려주기 위해 필요합니다.
function extractImagePart(data) {
  const direct = data?.interaction?.output_image;
  if (direct?.data) return { data: direct.data, mimeType: direct.mime_type || direct.mimeType || 'image/png' };
  const directAlt = data?.output_image;
  if (directAlt?.data) return { data: directAlt.data, mimeType: directAlt.mime_type || directAlt.mimeType || 'image/png' };

  const found = findImagePart(data);
  if (found) return { data: found.data, mimeType: found.mime_type || found.mimeType || 'image/png' };

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
 * 참고 이미지 1개 이상(referenceImages)을 주고, prompt로 설명한 변화를 적용한 새 이미지를
 * 생성합니다. "터치 바이 터치" 타임랩스 효과를 위해 여러 번 체이닝해서 호출하는 걸 전제로
 * 합니다 — 보통 referenceImages는 [완성작(항상 목표로 유지), 직전 단계에서 생성된 이미지
 * (여기서부터 이어서 그리기)] 두 장을 함께 줍니다. 실제 그림의 제작 단계 기록이 아니라, AI가
 * 완성작을 보고 "이런 식으로 진행됐을 것 같다"고 상상해서 새로 그리는 이미지입니다 —
 * 호출하는 쪽(generate-process-video.mjs)에서 영상에 "AI 상상 재현"이라는 문구를 반드시
 * 함께 노출해야 합니다.
 *
 * @param {{ buffer: Buffer, mediaType: string, label?: string }[]} referenceImages - 참고
 *   이미지들. label을 주면 그 이미지 바로 앞에 설명 텍스트를 넣어서 모델이 "어떤 이미지가
 *   무엇인지" 구분하게 돕습니다 (예: "Reference A — the finished painting").
 * @returns {Promise<{ path: string, mediaType: string }>} 저장된 이미지 파일 경로와 실제
 *   반환된 이미지의 mime type (다음 체이닝 단계에 그대로 넘기면 됩니다).
 */
export async function generateStageImage({ referenceImages, prompt, apiKey, model, outPath }) {
  apiKey = apiKey?.trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY가 설정되어 있지 않습니다. GitHub Actions Secret 또는 로컬 .env를 확인하세요.');
  }
  if (!Array.isArray(referenceImages) || referenceImages.length === 0) {
    throw new Error('generateStageImage()에는 referenceImages가 최소 1개 필요합니다.');
  }

  const input = [];
  for (const ref of referenceImages) {
    if (ref.label) {
      input.push({ type: 'text', text: ref.label });
    }
    input.push({ type: 'image', mime_type: ref.mediaType, data: ref.buffer.toString('base64') });
  }
  input.push({ type: 'text', text: prompt });

  const body = {
    model: model || DEFAULT_IMAGE_MODEL,
    input,
  };

  const data = await callGeminiImage({ body, apiKey });
  const imagePart = extractImagePart(data);
  if (!imagePart) {
    throw new Error(
      'Gemini 이미지 생성 응답에서 이미지 데이터를 찾지 못했습니다 (API 응답 형태가 예상과 다를 수 있음). 응답 일부: ' +
        JSON.stringify(data).slice(0, 800)
    );
  }

  fs.writeFileSync(outPath, Buffer.from(imagePart.data, 'base64'));
  return { path: outPath, mediaType: imagePart.mimeType };
}
