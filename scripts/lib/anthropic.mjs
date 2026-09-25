import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getImageDimensions, cropStill } from './video-builder.mjs';

export const API_URL = 'https://api.anthropic.com/v1/messages';

// TODO: 최신 모델 ID를 확인하고 필요하면 교체하세요.
// https://docs.claude.com/en/docs/about-claude/models
export const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

const MIN_SIZE = 0.12;

// Anthropic API 호출 공통 함수. 일시적인 문제(네트워크 끊김 — "fetch failed"/EPIPE/ECONNRESET,
// 429 레이트리밋, 5xx/529 과부하)는 잠깐 기다렸다가 자동으로 다시 시도합니다. 이런 일시적
// 오류 때문에 그림 고르기부터 전체 실행이 통째로 멈추는 일을 막기 위함입니다. 재시도해도
// 안 되거나 재시도할 의미가 없는 오류(400/401/403 등)는 기존과 같은 형식의 에러를 던집니다.
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_API_ATTEMPTS = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callClaude(body, apiKey, { label = 'Claude API' } = {}) {
  for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt++) {
    const wait = 2000 * 2 ** (attempt - 1); // 2초, 4초, 8초
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt < MAX_API_ATTEMPTS) {
        console.warn(`[anthropic]   ${label} 네트워크 오류(${err.cause?.code || err.message}), ${wait / 1000}초 후 재시도 (${attempt}/${MAX_API_ATTEMPTS - 1})...`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
    if (res.ok) return res.json();

    const text = await res.text();
    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_API_ATTEMPTS) {
      console.warn(`[anthropic]   ${label} 일시 오류(${res.status}), ${wait / 1000}초 후 재시도 (${attempt}/${MAX_API_ATTEMPTS - 1})...`);
      await sleep(wait);
      continue;
    }
    throw new Error(`${label} 호출 실패 (${res.status}): ${text}`);
  }
}

// Claude가 지시를 완벽히 안 지켰을 경우를 대비한 안전장치 — bbox를 이미지 범위 안으로
// clamp하고, 너무 작은 crop을 최소 크기로 보정합니다. (ffmpeg 단계에서 이상한 값으로
// 죽는 것보다 여기서 미리 방어하는 게 낫습니다.)
export function clampBbox(b) {
  const w = Math.max(MIN_SIZE, Math.min(1, b.w));
  const h = Math.max(MIN_SIZE, Math.min(1, b.h));
  const x = Math.max(0, Math.min(1 - w, b.x));
  const y = Math.max(0, Math.min(1 - h, b.y));
  return { x, y, w, h };
}

// Claude가 tool 입력의 중첩 필드(youtube 객체, reveals/segments 배열 등)를 가끔 객체가
// 아니라 JSON "문자열"로 감싸서 돌려줍니다. 그런 경우 여기서 다시 파싱합니다. 파싱이
// 안 되면 원래 값을 그대로 돌려줍니다.
export function parseIfJsonString(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// 그림 제목을 바탕으로 "페인트 바이 넘버 키트" 검색 결과 페이지로 가는 Amazon
// 제휴(Associates) 링크를 만듭니다. 특정 상품(ASIN)을 매번 자동으로 정확히 찾아 붙이는
// 건 기술적으로 불가능합니다 — Amazon 상품 페이지는 robots.txt로 자동 스크래핑이
// 막혀 있고, 공식 Product Advertising API는 어소시에이트 계정에 유효 판매 3건이 쌓이기
// 전엔 발급되지 않습니다. 그래서 특정 상품 링크 대신, 그림 제목으로 바로 검색되는
// Amazon 검색결과 페이지에 내 태그를 붙이는 방식을 씁니다 — 스크래핑/API 없이 그림
// 제목만으로 항상 만들 수 있고, 실제 매칭 상품이 있으면 시청자가 검색결과에서 바로
// 찾을 수 있습니다. AMAZON_ASSOCIATE_TAG가 .env에 없으면 조용히 빈 문자열을 반환해서
// (어필리에이트 계정이 없던 과거 영상들처럼) 아무 영향 없이 넘어갑니다.
export function buildAffiliateBlock(painting) {
  const tag = process.env.AMAZON_ASSOCIATE_TAG?.trim();
  if (!tag) return '';
  const paintingTitle = painting?.title || '';
  if (!paintingTitle) return '';

  const query = encodeURIComponent(`${paintingTitle} paint by numbers kit`);
  const link = `https://www.amazon.com/s?k=${query}&tag=${tag}`;

  return `🎨 Want to paint this yourself? Browse paint-by-numbers kits inspired by this piece: ${link}\n(As an Amazon Associate I earn from qualifying purchases.)`;
}

// YouTube 메타데이터(title/description/tags)를 업로드 가능한 형태로 정규화합니다.
// - 문자열로 온 경우 JSON.parse를 시도하고, 설명 안의 이스케이프 안 된 따옴표(예:
//   painting "Broken Eggs") 때문에 파싱이 깨지면 필드별로 직접 추출합니다.
// - 제목이 비면 그림 제목/작가로 대체하고, YouTube 제한(제목 100자, < > 금지)에 맞춥니다.
// - 어필리에이트 태그가 설정돼 있으면, FTC/유튜브 고지 규정(모바일 기준 "더보기" 없이
//   보이는 영역, 대략 첫 3줄 안에 고지문이 있어야 함)에 맞춰 설명 맨 앞에 고지문+링크를
//   붙입니다. 본문 내용이 길든 짧든 항상 맨 위에 오도록 해서 이 규정을 만족시킵니다.
// 대본 단계에서 여기서 바로잡아 두면, TTS/영상 조립까지 다 끝난 뒤 업로드 단계에서
// "Cannot read properties of undefined" 같은 오류로 죽는 일을 막을 수 있습니다.
export function normalizeYoutube(raw, painting, { fallbackTitle } = {}) {
  let y = parseIfJsonString(raw);

  if (typeof y === 'string') {
    const s = y;
    const unescape = (t) => (t == null ? t : t.replace(/\\n/g, '\n').replace(/\\"/g, '"'));
    const title = s.match(/"title"\s*:\s*"([\s\S]*?)"\s*,\s*"description"/)?.[1];
    const description = s.match(/"description"\s*:\s*"([\s\S]*?)"\s*,\s*"tags"/)?.[1];
    let tags = [];
    try {
      tags = JSON.parse(s.match(/"tags"\s*:\s*(\[[\s\S]*?\])/)?.[1] ?? '[]');
    } catch {
      tags = [];
    }
    y = { title: unescape(title), description: unescape(description), tags };
    console.warn('[anthropic]   youtube 메타데이터가 깨진 JSON 문자열로 와서 필드별로 복구했습니다.');
  }

  if (!y || typeof y !== 'object' || Array.isArray(y)) y = {};

  const clean = (t) => String(t ?? '').replace(/[<>]/g, '').trim();
  const paintingTitle = painting?.title || 'This Painting';
  const artist = painting?.artistDisplayName;

  let title = clean(y.title);
  if (!title) {
    title = clean(fallbackTitle || `The Hidden Meaning of ${paintingTitle}${artist ? ` (${artist})` : ''}`);
    console.warn(`[anthropic]   YouTube 제목이 비어 있어 기본 제목으로 대체합니다: "${title}"`);
  }
  if (title.length > 100) title = title.slice(0, 97).trimEnd() + '...';

  let description = clean(y.description);
  if (!description) {
    description = clean(
      `${paintingTitle}${artist ? ` by ${artist}` : ''} — the hidden meanings most viewers miss.\n\nPublic domain image via The Metropolitan Museum of Art (metmuseum.org), CC0.`
    );
  }

  const affiliateBlock = buildAffiliateBlock(painting);
  if (affiliateBlock && !description.includes('As an Amazon Associate')) {
    description = `${affiliateBlock}\n\n${description}`;
  }

  let tags = parseIfJsonString(y.tags);
  if (!Array.isArray(tags)) tags = [];
  tags = tags
    .filter((t) => typeof t === 'string')
    .map((t) => clean(t).replace(/^#/, ''))
    .filter(Boolean);

  return { title, description, tags };
}

// 그림 후보 하나가 애초에 이 포맷(숨은 디테일 여러 개를 파고드는 영상)에 쓸 만한
// 소재인지를 대본 생성 전에 미리 판단합니다. 인스타그램 "@paintingsanalyzed" 벤치마크처럼
// 다인물/서사/상징이 풍부한 그림을 선호하고, 배경이 단순한 1인 초상화 흉상처럼 파고들
// 디테일이 거의 없는 그림은 걸러냅니다 (단, 상징적 소품이 많거나 잘 알려진 숨은 의미가
// 있는 1인 초상화는 인원 수와 무관하게 통과시킵니다). 실제 대본 생성(세그먼트별 bbox까지
// 포함하는 무거운 호출)을 하기 전에 가벼운 호출 하나로 먼저 걸러내서, 단조로운 그림에
// 전체 파이프라인 비용을 쓰지 않게 하기 위함입니다.
const SUITABILITY_SYSTEM_PROMPT = `You are screening candidate paintings for a YouTube Shorts channel that decodes HIDDEN MEANINGS inside famous paintings — several genuinely distinct, discoverable symbols/secrets/narrative details per painting, similar in spirit to the Instagram art-explainer account @paintingsanalyzed. That account rarely covers plain single-sitter portrait busts with nothing but a face and a blank background; it thrives on paintings packed with things to notice: multiple figures interacting, a narrative or mythological/religious/historical scene, group compositions, or a figure surrounded by richly meaningful, documented symbolic objects.

Look at the actual image (not just the title/metadata) and judge whether this specific painting has enough real, visually-verifiable material to sustain 5 or more genuinely distinct "hidden detail" reveals — not padding, not five ways of restating the same single observation.

STRONG candidates (suitable = true): multiple interacting figures; a narrative/mythological/religious/genre scene; a group portrait; a scene or interior dense with symbolic objects; a single figure whose clothing/objects/setting carry multiple well-documented symbolic meanings.

WEAK candidates (suitable = false): a plain single-sitter portrait bust with a bare or simple background and no other notable objects, symbols, or narrative context — essentially just "a picture of a person's face/shoulders" with nothing else to discover.

Count the number of distinct human/animal figures you can actually see in the image (figureCount). A painting can still be marked suitable with figureCount of 1 if it is visually rich in symbolic objects or has well-documented hidden meaning — the real test is total discoverable material, not headcount alone.

You must respond by calling "evaluate_suitability" exactly once.`;

/**
 * 그림 후보 하나를 대본 생성 전에 미리 심사합니다. 네트워크/레이트리밋 등으로 이 호출
 * 자체가 실패하면 호출자가 그 그림을 그냥 통과시킬 수 있도록 에러를 그대로 던집니다.
 *
 * @returns {Promise<{ suitable: boolean, figureCount?: number, reason?: string }>}
 */
export async function evaluatePaintingSuitability({ imageBufferForVision, imageMediaType, apiKey, model }) {
  apiKey = apiKey?.trim();
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY가 설정되어 있지 않습니다. GitHub Actions Secret 또는 로컬 .env를 확인하세요.');
  }

  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: 512,
    system: SUITABILITY_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: imageMediaType,
              data: imageBufferForVision.toString('base64'),
            },
          },
          { type: 'text', text: 'Evaluate this painting for the channel.' },
        ],
      },
    ],
    tools: [
      {
        name: 'evaluate_suitability',
        description: 'Report whether this painting has enough discoverable material (figures/narrative/symbols) for the format.',
        input_schema: {
          type: 'object',
          properties: {
            suitable: { type: 'boolean' },
            figureCount: { type: 'integer' },
            reason: { type: 'string' },
          },
          required: ['suitable', 'figureCount', 'reason'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'evaluate_suitability' },
  };

  const data = await callClaude(body, apiKey, { label: 'Claude 적합성 판단 API' });
  const toolUse = data.content?.find((block) => block.type === 'tool_use' && block.name === 'evaluate_suitability');
  if (!toolUse) {
    throw new Error('적합성 판단 응답에서 evaluate_suitability tool 호출을 찾지 못했습니다. 응답: ' + JSON.stringify(data));
  }

  return toolUse.input;
}

// generateVideoScript()와 generateHiddenDetailCandidates()가 공통으로 쓰는 메타데이터
// 텍스트 블록을 만듭니다 — 두 곳에서 똑같은 형식을 유지하려고 한 곳으로 모았습니다.
function buildMetadataBlock(painting) {
  return [
    `Title: ${painting.title}`,
    `Artist: ${painting.artistDisplayName || 'Unknown'}`,
    painting.artistDisplayBio ? `Artist bio: ${painting.artistDisplayBio}` : null,
    `Date: ${painting.objectDate || 'Unknown'}`,
    `Medium: ${painting.medium || 'Unknown'}`,
    painting.culture ? `Culture: ${painting.culture}` : null,
    painting.department ? `Department: ${painting.department}` : null,
    painting.creditLine ? `Credit line: ${painting.creditLine}` : null,
    painting.dimensions ? `Dimensions: ${painting.dimensions}` : null,
    `Source: The Metropolitan Museum of Art, object #${painting.objectID}, ${painting.objectURL}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// 리뷰 화면에서 "이 그림의 숨은 이야기들"을 사람이 먼저 보고 몇 개를 고를 수 있게 하기
// 위해, 최종 대본(narration까지 확정)을 한 번에 만들지 않고 먼저 "후보" 디테일을
// 넉넉하게(6~10개) 뽑기만 합니다. teaser는 최종 시청자용 나레이션이 아니라, 이 화면을
// 보는 제작자(사람)가 "이거 넣을 만한가?"를 판단할 수 있게 실제 해석(payoff)까지
// 담아서 씁니다 — 애매하게 궁금증만 유발하는 문구면 판단이 안 되니까요.
const CANDIDATE_DETAILS_SYSTEM_PROMPT = `You are brainstorming candidate hidden-meaning "reveal" details for a YouTube Shorts video about a painting — for a human creator to screen BEFORE the final script is written. This is a menu of options, not the final narration, so each one must include the actual payoff (what it means / why it matters), not just a vague tease, so the human can judge genuine interest.

You will be shown an actual photo of the painting, plus its museum metadata. Look closely at the image itself — real details you can actually see (facial expressions, gestures, hidden symbols, background elements, brushwork, light source, composition) — and propose details that are ACTUALLY visible, not generic art-history filler.

Propose 6 to 10 candidate details. Each one must be a single, specific, visually-locatable detail (never "the overall mood" or "the color palette as a whole") with a genuine interpretive payoff: what it symbolizes, what it reveals about the subject/artist/era, a secret or joke or warning it encodes, or why art historians find it significant. Avoid five variations on the same observation — vary what kind of detail you pick. Only propose things you're reasonably confident about from the given metadata or well-established, uncontroversial art history; flag genuine scholarly debate ("some art historians believe...") rather than asserting it as settled fact; never invent anecdotes unsupported by evidence.

For each candidate:
- "focus": a short label (3-6 words) for what the crop shows, e.g. "her folded hands".
- "gridPosition": mentally divide the image into a 3x3 grid (top/middle/bottom x left/center/right) and name the cell(s) containing the detail. Do this BEFORE picking bbox numbers.
- "bbox": fractions 0.0-1.0 of the full image (x,y = top-left corner, w,h = width/height). Constraints: 0<=x, 0<=y, x+w<=1, y+h<=1, w>=0.12, h>=0.12 (never absurdly tiny). Double-check it's actually consistent with the gridPosition you named.
- "teaser": 1-3 sentences written FOR THE CREATOR who is deciding whether to include this in the video — explain what the detail is AND its actual interpretive payoff, so they can judge real interest without having to guess what you meant.
- "focusKo": a natural Korean translation of "focus" (same short label, in Korean) — the creator screening these options reads Korean.
- "teaserKo": a natural, fluent Korean translation of "teaser" conveying the exact same content and payoff — NOT a stiff word-for-word translation. This is shown ONLY on the screening screen; the final video narration stays in English regardless of what the creator picks.
- "recommended": true for the details you would personally pick first if you could only choose five — your best, most surprising, most confidently-sourced ones.

You must respond by calling "submit_candidates" exactly once.`;

/**
 * 그림 하나에 대해 "숨은 의미" 후보 디테일을 6~10개 뽑습니다 (최종 나레이션은 아직 없음).
 * 사람이 이 중 몇 개를 고르면, 그 선택으로 generateVideoScript()를 다시 불러서 최종
 * 대본(나레이션 확정)을 만듭니다 — 두 단계로 나눈 이유는 review-editor.mjs의 안내를
 * 참고하세요.
 *
 * @returns {Promise<{ candidates: Array<{id,focus,focusKo,gridPosition,bbox,teaser,teaserKo,recommended}> }>}
 */
export async function generateHiddenDetailCandidates({ painting, imageBufferForVision, imageMediaType, apiKey, model }) {
  apiKey = apiKey?.trim();
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY가 설정되어 있지 않습니다. GitHub Actions Secret 또는 로컬 .env를 확인하세요.');
  }

  const metadataBlock = buildMetadataBlock(painting);

  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: 8192,
    system: CANDIDATE_DETAILS_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: imageMediaType,
              data: imageBufferForVision.toString('base64'),
            },
          },
          {
            type: 'text',
            text: `Here is the painting's museum metadata:\n\n${metadataBlock}\n\nPropose the candidate hidden-meaning details now.`,
          },
        ],
      },
    ],
    tools: [
      {
        name: 'submit_candidates',
        description: 'Submit candidate hidden-meaning details for a human to screen before the final script is written.',
        input_schema: {
          type: 'object',
          properties: {
            candidates: {
              type: 'array',
              minItems: 6,
              maxItems: 10,
              items: {
                type: 'object',
                properties: {
                  focus: { type: 'string' },
                  focusKo: { type: 'string', description: 'Natural Korean translation of focus, for the screening screen.' },
                  gridPosition: { type: 'string' },
                  bbox: {
                    type: 'object',
                    properties: {
                      x: { type: 'number' },
                      y: { type: 'number' },
                      w: { type: 'number' },
                      h: { type: 'number' },
                    },
                    required: ['x', 'y', 'w', 'h'],
                  },
                  teaser: { type: 'string' },
                  teaserKo: { type: 'string', description: 'Natural, fluent Korean translation of teaser, for the screening screen.' },
                  recommended: { type: 'boolean' },
                },
                required: ['focus', 'focusKo', 'gridPosition', 'bbox', 'teaser', 'teaserKo', 'recommended'],
              },
            },
          },
          required: ['candidates'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_candidates' },
  };

  // 후보 10개 + 한국어 번역까지 쓰다 보면 응답이 길어져 중간에 잘리거나(max_tokens),
  // candidates가 빠진 채로 오는 경우가 있습니다. 그럴 땐 한 번 더 요청하고, 그래도 안 되면
  // CONTENT_REFUSAL로 표시해 이 그림만 건너뛰고 다른 그림으로 넘어가게 합니다 (전체 실행을
  // 멈추지 않도록).
  const MAX_CANDIDATE_ATTEMPTS = 2;
  let rawCandidates;
  let lastProblem = '';
  for (let attempt = 1; attempt <= MAX_CANDIDATE_ATTEMPTS; attempt++) {
    const data = await callClaude(body, apiKey, { label: 'Claude 후보 디테일 API' });
    const toolUse = data.content?.find((block) => block.type === 'tool_use' && block.name === 'submit_candidates');
    // candidates 배열이 문자열로 감싸져 오는 경우도 방어합니다.
    rawCandidates = parseIfJsonString(toolUse?.input?.candidates);
    if (Array.isArray(rawCandidates) && rawCandidates.length > 0) break;

    lastProblem = !toolUse
      ? 'submit_candidates tool 호출 없음'
      : `candidates가 배열이 아님 (stop_reason: ${data.stop_reason}, 받은 키: ${Object.keys(toolUse.input || {}).join(', ') || '없음'})`;
    console.warn(`[anthropic]   후보 디테일 응답이 비정상입니다 (${lastProblem}) — ${attempt < MAX_CANDIDATE_ATTEMPTS ? '다시 요청합니다.' : '이 그림은 건너뜁니다.'}`);
    rawCandidates = undefined;
  }
  if (!Array.isArray(rawCandidates)) {
    throw Object.assign(new Error(`Claude가 후보 디테일을 제대로 반환하지 않았습니다: ${lastProblem}`), { code: 'CONTENT_REFUSAL' });
  }

  const candidates = rawCandidates.map((c, i) => {
    const candidate = {
      id: `d${i + 1}`,
      focus: c.focus,
      focusKo: c.focusKo || c.focus,
      gridPosition: c.gridPosition,
      bbox: clampBbox(parseIfJsonString(c.bbox)),
      teaser: c.teaser,
      teaserKo: c.teaserKo || c.teaser,
      recommended: !!c.recommended,
    };
    reconcileBboxWithGridPosition(candidate); // bbox가 gridPosition 라벨과 어긋나면 여기서 바로 보정
    return candidate;
  });

  return { candidates };
}

/**
 * generateVideoScript()가 selectedDetails를 받았을 때 위임하는 내부 함수입니다. 이미
 * 사람이 고른 디테일들의 focus/gridPosition/bbox는 그대로 두고(이 함수는 손대지 않음),
 * Claude에게는 (1) 보여줄 순서, (2) 각 디테일의 실제 나레이션 문장, (3) IDENTIFY/CONTEXT/
 * CLOSE 나레이션, (4) YouTube 메타데이터만 맡깁니다 — 자유 선택 경로보다 스키마가 훨씬
 * 단순해서 실패 여지가 적고, 사람이 확인한 확대 위치가 뒤에서 바뀌는 일도 없습니다.
 */
async function generateNarrationForSelectedDetails({ painting, imageBufferForVision, imageMediaType, apiKey, model, metadataBlock, selectedDetails }) {
  const detailsBlock = selectedDetails
    .map((d, i) => `${i + 1}. id="${d.id}" — focus: "${d.focus}" (region: ${d.gridPosition})\n   Payoff to convey: ${d.teaser}`)
    .join('\n\n');

  const systemPrompt = `You are a scriptwriter for a YouTube Shorts channel that decodes the HIDDEN MEANINGS inside famous public-domain paintings — symbols, secrets, jokes, political messages, and psychological details that most viewers would walk right past — similar in spirit to popular Instagram art-explainer accounts, but written to be read aloud as narration over a video.

A human editor has ALREADY chosen exactly which hidden details this specific video will reveal (listed below, each with the region of the painting it zooms into and its interpretive payoff). Your job now is ONLY to:
1. Pick the best storytelling order for these details (in the "reveals" you return) — usually accessible-to-surprising, or a thread that connects them, rather than leaving them in the order listed.
2. Write the actual spoken narration for each of them, plus an opening IDENTIFY line, a CONTEXT line, and a closing CLOSE line that ties everything together.
3. Write the YouTube title/description/tags.

Do NOT introduce new details, drop any of the given details, or change which regions are shown — the crop regions are already fixed and out of scope here. Just write the words, in a good order.

THE MOST IMPORTANT RULE — avoid flat description: never just describe what a detail looks like. Every reveal narration must explain WHY it matters, using the payoff you were given for it, in your own natural spoken voice — not a dry restatement.

- IDENTIFY narration: clearly state what the painting is, who painted it, roughly when, and a hook that promises a hidden layer about to be discovered.
- CONTEXT narration: the bigger picture — what scene/moment this is, why it was painted, historical/cultural context. Scene-setting, not a detail zoom.
- Each reveal narration: ONE to THREE short sentences, must stand alone as a natural spoken chunk (no "as we discussed before" type references).
- CLOSE narration: pull back out, tie the hidden meanings together into one closing thought, then (only if it fits naturally) a light non-salesy nudge like "next time you see a painting, look for what it's not saying out loud."
- Only state facts you're reasonably confident about from the given metadata, the payoffs you were given, or well-established uncontroversial art history; flag genuine scholarly debate rather than asserting it as settled fact; never invent anecdotes.
- Tone: curious, a little conspiratorial — like a knowledgeable friend leaning in to tell you a secret hiding in plain sight, not a dry textbook or museum placard. Short punchy sentences. Rhetorical questions sparingly.
- Narration total length across IDENTIFY + CONTEXT + every reveal + CLOSE: roughly 170-230 words total (this becomes ~70-95 seconds of spoken narration) regardless of how many reveal details there are — do not go far outside this range.
- Write a scroll-stopping YouTube Shorts title (under 90 characters) that promises a hidden meaning or secret, names the painting and/or artist, and creates real curiosity, without being clickbait-dishonest.
- Write a YouTube description: 2-4 sentences about the painting and the hidden meanings the video reveals, then a line crediting "Public domain image via The Metropolitan Museum of Art (metmuseum.org), CC0.", then a few relevant hashtags.
- Write 8-15 relevant YouTube tags (lowercase, no # symbol) mixing the artist name, painting name, art movement/period, and general art-content discovery terms.
- The "youtube" field must be a JSON object with title/description/tags fields, not a string.

You must respond by calling the "submit_narration" tool exactly once.`;

  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: imageMediaType,
              data: imageBufferForVision.toString('base64'),
            },
          },
          {
            type: 'text',
            text: `Here is the painting's museum metadata:\n\n${metadataBlock}\n\nHere are the hidden details a human editor already selected for this video (do not change their regions — just write narration for them and put them in a good order):\n\n${detailsBlock}\n\nWrite the narration now.`,
          },
        ],
      },
    ],
    tools: [
      {
        name: 'submit_narration',
        description: 'Submit narration, ordering, and YouTube metadata for the pre-selected hidden details.',
        input_schema: {
          type: 'object',
          properties: {
            youtube: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' }, minItems: 8, maxItems: 15 },
              },
              required: ['title', 'description', 'tags'],
            },
            identifyNarration: { type: 'string' },
            contextNarration: { type: 'string' },
            reveals: {
              type: 'array',
              description: 'Every given detail id, exactly once each, in the chosen storytelling order, with its narration.',
              minItems: selectedDetails.length,
              maxItems: selectedDetails.length,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  narration: { type: 'string' },
                },
                required: ['id', 'narration'],
              },
            },
            closeNarration: { type: 'string' },
          },
          required: ['youtube', 'identifyNarration', 'contextNarration', 'reveals', 'closeNarration'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_narration' },
  };

  const data = await callClaude(body, apiKey, { label: 'Claude 대본(선택된 디테일) API' });
  const toolUse = data.content?.find((block) => block.type === 'tool_use' && block.name === 'submit_narration');
  if (!toolUse) {
    throw new Error('Claude 응답에서 submit_narration tool 호출을 찾지 못했습니다. 응답: ' + JSON.stringify(data));
  }

  const result = toolUse.input;
  // reveals 배열이 문자열로 감싸져 오는 경우 — 파싱해서 정상 경로로 처리합니다.
  result.reveals = parseIfJsonString(result.reveals);

  // Claude가 id를 빠뜨리거나 중복 반환해도 죽지 않도록 방어적으로 재구성합니다 — 주어진
  // selectedDetails 전부가, 정확히 한 번씩, 최종 segments에 반영되는 것을 보장합니다.
  const byId = new Map(selectedDetails.map((d) => [d.id, d]));
  const seen = new Set();
  const reveals = [];
  for (const r of Array.isArray(result.reveals) ? result.reveals : []) {
    if (r && byId.has(r.id) && !seen.has(r.id) && typeof r.narration === 'string' && r.narration.trim()) {
      reveals.push({ detail: byId.get(r.id), narration: r.narration.trim() });
      seen.add(r.id);
    }
  }
  for (const d of selectedDetails) {
    if (!seen.has(d.id)) {
      console.warn(`[anthropic]   Claude가 detail id "${d.id}"의 narration을 빠뜨려 teaser로 대체합니다.`);
      reveals.push({ detail: d, narration: d.teaser });
      seen.add(d.id);
    }
  }

  const fullImageBbox = { x: 0, y: 0, w: 1, h: 1 };
  const segments = [
    { narration: result.identifyNarration, focus: '그림 전체 소개', gridPosition: 'full image', bbox: { ...fullImageBbox } },
    { narration: result.contextNarration, focus: '배경/맥락 설명', gridPosition: 'full image', bbox: { ...fullImageBbox } },
    ...reveals.map(({ detail, narration }) => ({
      narration,
      focus: detail.focus,
      gridPosition: detail.gridPosition,
      bbox: { ...detail.bbox },
    })),
    { narration: result.closeNarration, focus: '마무리', gridPosition: 'full image', bbox: { ...fullImageBbox } },
  ];

  return { youtube: normalizeYoutube(result.youtube, painting), segments };
}

/**
 * Claude(vision)에게 실제 그림 이미지 + 메타데이터를 보여주고, 숏폼 영상 대본을 받아옵니다.
 *
 * 왜 이미지를 직접 보여주나요? 인스타그램에서 봤다는 "명화의 세부를 파고드는" 포맷을
 * 제대로 재현하려면, 실제로 그 그림에 어떤 디테일(표정, 손, 배경의 상징물, 붓터치 등)이
 * 있는지 알아야 어디를 확대할지 의미 있게 정할 수 있습니다. 메타데이터(제목/작가/연도)만
 * 가지고는 "그럴듯하지만 실제 그림과 무관한" 대본이 나올 위험이 있습니다.
 *
 * @param {object} painting - Met API의 object 응답 (title, artistDisplayName, objectDate,
 *   medium, department, culture, creditLine, objectURL 등)
 * @param {Buffer} imageBufferForVision - Claude에게 보여줄 (리사이즈된) 이미지 바이너리
 * @param {string} imageMediaType - 'image/jpeg' 등
 * @param {string} [imagePath] - imageBufferForVision과 같은 이미지가 저장된 파일 경로.
 *   있으면 대본 생성 후 각 구간의 bbox가 실제로 의도한 디테일을 보여주는지 crop해서
 *   재확인하는 2차 검증을 수행합니다 (없으면 검증을 건너뜁니다).
 * @param {Array<{id,focus,gridPosition,bbox,teaser}>} [selectedDetails] - 사람이 미리
 *   generateHiddenDetailCandidates()의 결과 중에서 고른 디테일들. 주어지면 Claude는 이
 *   디테일 자체를 새로 고르지 않고, 순서/나레이션/YouTube 메타데이터만 작성합니다
 *   (generateNarrationForSelectedDetails 참고). 생략하면 기존처럼 Claude가 디테일까지
 *   전부 자유롭게 고릅니다(자동 실행 파이프라인이 쓰는 경로).
 */
export async function generateVideoScript({ painting, imageBufferForVision, imagePath, imageMediaType, apiKey, model, selectedDetails }) {
  apiKey = apiKey?.trim();
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY가 설정되어 있지 않습니다. GitHub Actions Secret 또는 로컬 .env를 확인하세요.');
  }

  const metadataBlock = buildMetadataBlock(painting);

  // 리뷰 화면에서 사람이 이미 후보 디테일 중 몇 개를 골라둔 경우(selectedDetails), 그
  // 디테일들의 focus/gridPosition/bbox는 이미 확정된 것으로 두고, 나레이션 작성과
  // 순서 배치만 별도 함수에 맡깁니다 — 아래 자유 선택 경로(포맷에 맞춰 Claude가 디테일
  // 자체도 직접 고르는 기존 방식)와는 완전히 다른 프롬프트/스키마를 씁니다.
  if (selectedDetails && selectedDetails.length > 0) {
    const script = await generateNarrationForSelectedDetails({
      painting,
      imageBufferForVision,
      imageMediaType,
      apiKey,
      model,
      metadataBlock,
      selectedDetails,
    });

    validateAndClampScript(script);
    for (const seg of script.segments) {
      reconcileBboxWithGridPosition(seg);
    }
    if (imagePath) {
      console.log('[anthropic] 각 구간의 확대 위치(bbox)가 실제로 맞는 디테일을 보여주는지 검증 중...');
      await verifyAndFixBboxes({ script, imagePath, imageMediaType, apiKey, model });
    }
    return script;
  }

  const systemPrompt = `You are a scriptwriter for a YouTube Shorts channel that decodes the HIDDEN MEANINGS inside famous public-domain paintings — symbols, secrets, jokes, political messages, and psychological details that most viewers would walk right past — similar in spirit to popular Instagram art-explainer accounts, but written to be read aloud as narration over a video.

You will be shown an actual photo of the painting, plus its museum metadata. Look closely at the image itself — real details you can actually see (facial expressions, gestures, hidden symbols, background elements, brushwork, light source, composition) — and build the script around what is ACTUALLY visible, not generic art-history filler.

THE MOST IMPORTANT RULE — avoid flat description: Never just describe what a detail looks like ("here we see a skull on the table"). Every single segment must explain WHY it matters: what it symbolizes, what it reveals about the subject/artist/era, what secret or joke or warning it encodes, or why art historians find it significant. If you only have a plain visual observation and no genuine interpretive angle for it, pick a different detail that you can say something revealing about. The viewer should feel like they just learned something they didn't know, not like they got a guided tour of what their own eyes already told them.

Structure the script as 7 to 10 segments, in exactly this order:
1. IDENTIFY (bbox = the whole painting): Open by clearly stating what the painting is, who painted it, and roughly when — e.g. "This is [Title], painted by [Artist] around [year]." Immediately follow with a hook that promises a hidden layer the viewer is about to discover (never just a flat ID with no hook attached).
2. CONTEXT (bbox = the whole painting or very close to it): Explain the bigger picture — what scene or moment is depicted, why the artist painted it, who it was made for, or what historical/cultural moment it belongs to. This is scene-setting, not a detail zoom yet.
3 through N-1. REVEAL (bbox = one specific real detail each): Each segment zooms into ONE real visible detail and decodes its hidden meaning — a symbol, a piece of iconography, an expression that reveals emotion or intent, a technical trick, a detail that was controversial or surprising for its time, something the artist hid as commentary or a personal signature. Vary what kind of detail you pick (don't do five faces in a row) and favor the most genuinely surprising or little-known facts you can responsibly attribute to this specific work.
Last segment. CLOSE (bbox = the whole painting again): Pull back out and tie the hidden meanings together into one closing thought that reframes the whole painting — then, only if it fits naturally, a light non-salesy nudge like "next time you see a painting, look for what it's not saying out loud."
- Only state facts you're reasonably confident about from the given metadata or well-established, uncontroversial art history. If something is debated or uncertain among art historians, say so ("some art historians believe...", "it's long been debated whether...") rather than asserting it as settled fact. Never invent specific anecdotes, quotes, or events not supported by the metadata or common knowledge about the work — an interesting TRUE detail beats an invented dramatic one every time.
- Tone: curious, a little conspiratorial — like a knowledgeable friend leaning in to tell you a secret hiding in plain sight, not a dry textbook or museum placard. Short punchy sentences. Rhetorical questions ("Notice anything strange about his hands?") are a good tool before a reveal, used sparingly.
- Narration total length across all segments: roughly 170-230 words total (this becomes ~70-95 seconds of spoken narration) — do not go far outside this range.
- Each segment's "narration" is ONE to THREE short sentences — must stand alone as a natural spoken chunk (no "as we discussed before" type references).
- For each segment, first write a "gridPosition": mentally divide the full image into a 3x3 grid (top/middle/bottom × left/center/right) and name which cell (or short span of adjacent cells, e.g. "middle-center to middle-right") contains the detail you're describing. Do this BEFORE picking numbers — it forces you to actually locate the detail instead of guessing coordinates.
- Then provide a "bbox": the region of the image to visually zoom into while that narration plays, as fractions of the full image (0.0 to 1.0), with x,y = top-left corner of the crop box and w,h = width/height of the crop box. Constraints: 0 <= x, 0 <= y, x+w <= 1, y+h <= 1, and w >= 0.12 and h >= 0.12 (never crop absurdly tiny — it will look pixelated). The IDENTIFY, CONTEXT, and CLOSE segments should use approximately the full image (x:0, y:0, w:1, h:1, or very close to it). CRITICAL: double-check that your numeric bbox is actually consistent with the gridPosition you just named — e.g. "top-left" means x and y should both be small (roughly 0.0-0.35), not somewhere else in the image. Zooming into the wrong object is the single worst mistake you can make here, worse than an imperfect narration — a viewer immediately notices when the narration says one thing and the screen shows another.
- Also write a short "focus" label (3-6 words, e.g. "her folded hands", "the storm clouds behind him") describing what that segment's crop shows — used internally, not shown to viewers.
- Write a scroll-stopping YouTube Shorts title (under 90 characters) that promises a hidden meaning or secret, names the painting and/or artist, and creates real curiosity, without being clickbait-dishonest.
- Write a YouTube description: 2-4 sentences about the painting and the hidden meanings the video reveals, then a line crediting "Public domain image via The Metropolitan Museum of Art (metmuseum.org), CC0.", then a few relevant hashtags.
- Write 8-15 relevant YouTube tags (lowercase, no # symbol) mixing the artist name, painting name, art movement/period, and general art-content discovery terms (e.g. "art history", "hidden meaning", "famous paintings", "art explained").
- The "youtube" field must be a JSON object with title/description/tags fields, and "segments" must be a JSON array — never a string.

You must respond by calling the "submit_script" tool exactly once.`;

  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: imageMediaType,
              data: imageBufferForVision.toString('base64'),
            },
          },
          {
            type: 'text',
            text: `Here is the painting's museum metadata:\n\n${metadataBlock}\n\nWrite the Shorts script now.`,
          },
        ],
      },
    ],
    tools: [
      {
        name: 'submit_script',
        description: 'Submit the finished short-form video script.',
        input_schema: {
          type: 'object',
          properties: {
            youtube: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' }, minItems: 8, maxItems: 15 },
              },
              required: ['title', 'description', 'tags'],
            },
            segments: {
              type: 'array',
              minItems: 7,
              maxItems: 10,
              items: {
                type: 'object',
                properties: {
                  narration: { type: 'string' },
                  focus: { type: 'string' },
                  gridPosition: { type: 'string' },
                  bbox: {
                    type: 'object',
                    properties: {
                      x: { type: 'number' },
                      y: { type: 'number' },
                      w: { type: 'number' },
                      h: { type: 'number' },
                    },
                    required: ['x', 'y', 'w', 'h'],
                  },
                },
                required: ['narration', 'focus', 'gridPosition', 'bbox'],
              },
            },
          },
          required: ['youtube', 'segments'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_script' },
  };

  const data = await callClaude(body, apiKey, { label: 'Claude API' });
  const toolUse = data.content?.find((block) => block.type === 'tool_use' && block.name === 'submit_script');
  if (!toolUse) {
    throw new Error('Claude 응답에서 submit_script tool 호출을 찾지 못했습니다. 응답: ' + JSON.stringify(data));
  }

  const script = toolUse.input;
  // 중첩 필드가 문자열로 감싸져 오는 경우를 먼저 바로잡습니다.
  script.segments = parseIfJsonString(script.segments);
  if (Array.isArray(script.segments)) {
    for (const seg of script.segments) {
      if (seg && seg.bbox) seg.bbox = parseIfJsonString(seg.bbox);
    }
  }
  script.youtube = normalizeYoutube(script.youtube, painting);

  validateAndClampScript(script);

  for (const seg of script.segments) {
    reconcileBboxWithGridPosition(seg);
  }

  if (imagePath) {
    console.log('[anthropic] 각 구간의 확대 위치(bbox)가 실제로 맞는 디테일을 보여주는지 검증 중...');
    await verifyAndFixBboxes({ script, imagePath, imageMediaType, apiKey, model });
  }

  return script;
}

export function isNearFullImageBbox(b) {
  return b.w >= 0.9 && b.h >= 0.9;
}

// 3x3 그리드 라벨("top-left", "middle-center to middle-right" 등)을 x/y 비율 범위로
// 해석합니다. 라벨에서 행/열 키워드를 하나도 못 찾으면(자유 형식 텍스트 등) null을
// 반환해서 이 검사를 건너뛰게 합니다.
export function parseGridPosition(text) {
  const t = (text || '').toLowerCase();
  const cols = [];
  if (/\bleft\b/.test(t)) cols.push([0, 1 / 3]);
  if (/\bcenter\b/.test(t)) cols.push([1 / 3, 2 / 3]);
  if (/\bright\b/.test(t)) cols.push([2 / 3, 1]);
  const rows = [];
  if (/\btop\b/.test(t)) rows.push([0, 1 / 3]);
  if (/\bmiddle\b/.test(t)) rows.push([1 / 3, 2 / 3]);
  if (/\bbottom\b/.test(t)) rows.push([2 / 3, 1]);
  if (!cols.length || !rows.length) return null;

  return {
    colRange: [Math.min(...cols.map((c) => c[0])), Math.max(...cols.map((c) => c[1]))],
    rowRange: [Math.min(...rows.map((r) => r[0])), Math.max(...rows.map((r) => r[1]))],
  };
}

// Claude가 gridPosition은 (예) "top-left"라고 적어놓고 실제 bbox 숫자는 화면 반대편을
// 가리키는 경우가 있습니다 — 시스템 프롬프트에서 둘을 맞춰보라고 지시하긴 하지만 항상
// 지켜지지는 않습니다. 여기서는 API 호출 없이 코드로 즉시 확인해서, bbox 중심이 라벨이
// 말하는 그리드 칸 밖에 있으면 같은 크기(w,h)를 유지한 채 중심을 그 칸 가운데로
// 옮깁니다. "완전히 엉뚱한 곳"을 확대하는 가장 심한 사례를 API 검증 이전에 이미
// 걸러내기 위한 무료 안전장치입니다.
export function reconcileBboxWithGridPosition(seg) {
  const b = seg.bbox;
  if (isNearFullImageBbox(b)) return; // IDENTIFY/CONTEXT/CLOSE는 검사 대상 아님

  const grid = parseGridPosition(seg.gridPosition);
  if (!grid) return;

  const TOLERANCE = 0.05;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const inCol = cx >= grid.colRange[0] - TOLERANCE && cx <= grid.colRange[1] + TOLERANCE;
  const inRow = cy >= grid.rowRange[0] - TOLERANCE && cy <= grid.rowRange[1] + TOLERANCE;
  if (inCol && inRow) return;

  const before = { ...b };
  const targetCx = (grid.colRange[0] + grid.colRange[1]) / 2;
  const targetCy = (grid.rowRange[0] + grid.rowRange[1]) / 2;
  seg.bbox = clampBbox({ x: targetCx - b.w / 2, y: targetCy - b.h / 2, w: b.w, h: b.h });
  console.log(
    `[anthropic]   gridPosition("${seg.gridPosition}")과 bbox 불일치 감지, 좌표 보정: "${seg.focus}" ${JSON.stringify(before)} -> ${JSON.stringify(seg.bbox)}`
  );
}

// Claude가 지시를 완벽히 안 지켰을 경우를 대비한 안전장치 — bbox를 이미지 범위 안으로
// clamp하고, 너무 작은 crop을 최소 크기로 보정합니다. (ffmpeg 단계에서 이상한 값으로
// 죽는 것보다 여기서 미리 방어하는 게 낫습니다.)
function validateAndClampScript(script) {
  if (!Array.isArray(script.segments) || script.segments.length === 0) {
    // 이건 "이 그림 자체가 문제"인 경우입니다 (예: 누드가 포함된 종교화/신화화 등 민감한
    // 소재라 Claude가 조심스러워져서 빈 응답을 준 경우) — generate-video.mjs가 이 코드를
    // 보고 "이 그림만 건너뛰고 다른 그림으로 재시도"할지, 아니면 과금/네트워크 등 그림과
    // 무관한 문제라 재시도 없이 바로 실패시킬지를 구분합니다.
    throw Object.assign(new Error('Claude가 segments를 비워서 반환했습니다.'), { code: 'CONTENT_REFUSAL' });
  }
  for (const seg of script.segments) {
    seg.bbox = clampBbox(seg.bbox);
  }
}

const VERIFY_SYSTEM_PROMPT = `You are doing quality control on a video script that zooms into specific regions of a painting while narration describes a detail. For each check, you'll see the full painting, then a cropped preview of the region currently selected for one segment, along with what that segment's narration/focus claims is shown there.

Be strict: if the crop shows the wrong object, is centered on the wrong part of the painting, or only barely/partially captures the intended detail, that is a failure — viewers will immediately notice when the narration describes one thing and the screen shows another. In that case set "matches" to false and provide a corrected "bbox" (fractions 0.0-1.0 of the full image; x,y = top-left corner, w,h = width/height; keep w and h at least 0.12) that actually captures the described detail, by looking again at the full image. If the crop genuinely does show the right thing, set "matches" to true and return the same bbox unchanged.

You must respond by calling "confirm_or_fix_bbox" exactly once.`;

// 세그먼트별로 "실제 크롭이 focus/narration이 말하는 디테일을 보여주는가"를 2차로
// 검증합니다. 예: 나레이션은 다람쥐를 가리키는데 bbox는 사람 손 부분을 확대하는 식의
// 오류(모델이 위치를 잘못 짚는 흔한 실수)를 잡기 위한 단계입니다. 전체 화면을 쓰는
// IDENTIFY/CONTEXT/CLOSE 세그먼트는 애초에 틀릴 여지가 없으니 건너뜁니다.
// 한 번 "틀렸다"고 판정된 bbox에 대해 모델이 내놓는 첫 보정값도 틀릴 수 있습니다
// (같은 종류의 좌표 추정 실수를 반복하는 경우가 흔함). 보정 후 재검증 없이 그냥
// 받아들이면 "고쳤다고 생각했는데 여전히 엉뚱한 곳"이 나올 수 있어서, 보정된 bbox를
// 다시 크롭해서 한 번 더 확인하는 것까지 총 MAX_VERIFY_ATTEMPTS번 반복합니다.
const MAX_VERIFY_ATTEMPTS = 3;

async function verifyAndFixBboxes({ script, imagePath, imageMediaType, apiKey, model }) {
  const { width: imgWidth, height: imgHeight } = await getImageDimensions(imagePath);
  const fullImageBase64 = fs.readFileSync(imagePath).toString('base64');

  for (const seg of script.segments) {
    if (isNearFullImageBbox(seg.bbox)) continue;

    for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
      const b = seg.bbox;
      const cropPath = path.join(os.tmpdir(), `bbox-check-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
      try {
        await cropStill({ imagePath, bbox: b, imgWidth, imgHeight, outPath: cropPath });
        const cropBase64 = fs.readFileSync(cropPath).toString('base64');

        const body = {
          model: model || DEFAULT_MODEL,
          max_tokens: 1024,
          system: VERIFY_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Full painting, for reference:' },
                { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: fullImageBase64 } },
                {
                  type: 'text',
                  text: `Cropped preview currently selected for this segment. Focus: "${seg.focus}". Narration: "${seg.narration}". Current bbox: x=${b.x.toFixed(3)}, y=${b.y.toFixed(3)}, w=${b.w.toFixed(3)}, h=${b.h.toFixed(3)}.`,
                },
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: cropBase64 } },
                { type: 'text', text: 'Does the cropped preview correctly show the described detail? Confirm or fix the bbox.' },
              ],
            },
          ],
          tools: [
            {
              name: 'confirm_or_fix_bbox',
              description: 'Confirm the current crop is correct, or provide a corrected bbox.',
              input_schema: {
                type: 'object',
                properties: {
                  matches: { type: 'boolean' },
                  bbox: {
                    type: 'object',
                    properties: {
                      x: { type: 'number' },
                      y: { type: 'number' },
                      w: { type: 'number' },
                      h: { type: 'number' },
                    },
                    required: ['x', 'y', 'w', 'h'],
                  },
                },
                required: ['matches', 'bbox'],
              },
            },
          ],
          tool_choice: { type: 'tool', name: 'confirm_or_fix_bbox' },
        };

        const data = await callClaude(body, apiKey, { label: 'bbox 검증 API' });
        const toolUse = data.content?.find((block) => block.type === 'tool_use' && block.name === 'confirm_or_fix_bbox');
        if (!toolUse) {
          throw new Error('검증 응답에서 confirm_or_fix_bbox tool 호출을 찾지 못했습니다.');
        }

        const result = toolUse.input;
        const fixed = clampBbox(parseIfJsonString(result.bbox));

        if (result.matches !== false) {
          seg.bbox = fixed;
          break; // 통과 — 이 세그먼트는 더 이상 재확인할 필요 없음
        }

        console.log(
          `[anthropic]   bbox 보정 (시도 ${attempt}/${MAX_VERIFY_ATTEMPTS}): "${seg.focus}" ${JSON.stringify(b)} -> ${JSON.stringify(fixed)}`
        );
        seg.bbox = fixed;
        // matches:false면 다음 attempt에서 이 새 bbox를 다시 크롭해서 재확인합니다.
        // 마지막 attempt까지 계속 틀리면 그냥 마지막 보정값을 채택하고 넘어갑니다.
      } catch (err) {
        // 검증 자체가 실패해도(네트워크/레이트리밋 등) 원래 bbox를 그대로 쓰고 넘어갑니다 —
        // 전체 파이프라인을 죽일 이유는 아닙니다.
        console.warn(`[anthropic]   bbox 검증 실패, 원래 값 유지 ("${seg.focus}"): ${err.message}`);
        break;
      } finally {
        fs.rmSync(cropPath, { force: true });
      }
    }
  }
}
