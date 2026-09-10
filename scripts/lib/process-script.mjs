import { API_URL, DEFAULT_MODEL, clampBbox, isNearFullImageBbox, reconcileBboxWithGridPosition } from './anthropic.mjs';

// "스케치"/"밑칠"/"마무리 직전" 각 단계마다 하나의 정적 이미지만 오래 보여주면 "스케치에서
// 바로 완성 직전으로 점프하는" 느낌이 듭니다 — 더 타임랩스처럼 보이도록, 각 단계마다
// 여러 장(진행 컷)을 순서대로 체이닝해서 생성하고 영상에서는 빠른 디졸브로 이어붙입니다.
// 늘릴수록(예: 4~5) 더 매끄러운 타임랩스가 되지만 Gemini 이미지 생성 호출 수와 생성
// 시간이 그만큼 늘어납니다 — 체감이 아쉬우면 이 숫자만 올리면 됩니다.
export const PROCESS_STEPS_PER_STAGE = 3;

/**
 * Claude(vision)에게 완성된 명화 이미지 + 메타데이터를 보여주고, "이 그림이 어떻게 그려졌을지"를
 * 상상으로 재구성하는 영상 대본을 받아옵니다. 실제 제작 과정 기록이 아니라, 완성작에서
 * 보이는 화풍/기법/구도를 근거로 "이런 순서로 이렇게 그려졌을 것 같다"고 추정하는 것이므로,
 * 시스템 프롬프트에서 단정적 서술("~였다")이 아니라 추정 어조("~였을 것이다", "~했을 가능성이
 * 높다")를 강제합니다. 영상 자체에 "AI 상상 재현"이라는 문구를 코드 레벨(제목/설명/인트로
 * 카드)에서 강제로 붙이는 건 이 함수를 호출하는 쪽(generate-process-video.mjs)의 책임입니다 —
 * Claude의 서술에만 의존하면 매번 빠짐없이 지켜진다는 보장이 없기 때문입니다.
 *
 * 아무 근거 없이 매번 똑같은 "스케치 -> 색칠 -> 완성" 패턴으로 흘러가지 않도록, 대본을 쓰기
 * 전에 먼저 "techniqueBasis"라는 필드로 이 그림에 실제로 알려진 근거(메타데이터의 매체 —
 * 예: 유화/템페라, 그리고 작가/시대가 속한 화파의 잘 알려진 제작 관행 — 예: 인상파의 알라
 * 프리마 직접 채색, 르네상스 패널화의 밑그림 전사 후 글레이징 등)를 먼저 명시하게 하고,
 * sketch/underpainting/refine 단계와 그 imagePrompt가 이 근거를 따르도록 강제합니다.
 *
 * 세그먼트는 정해진 순서를 따르고(총 6개), 인트로/아웃트로 카드(약 5.5초)를 더하면 전체
 * 영상이 유튜브 쇼츠에 맞는 1~2분 사이가 되도록 나레이션 분량을 조정합니다:
 * 1. identify (실제 사진, 전체 화면): 완성작이 무엇인지 소개.
 * 2. reference (실제 사진, 전체 또는 특정 부분 확대): 작가가 이 장면/구도를 그리기 위해 무엇을
 *    관찰/참고했을지 상상.
 * 3~4. sketch, underpainting (각각 AI가 새로 생성한 이미지): techniqueBasis에 따른 초기
 *    스케치(또는 화파에 따라 밑그림 없이 바로 채색을 시작하는 방식) 단계, 밑칠/명암 구축
 *    단계를 상상해서 묘사. 이 두 세그먼트는 "steps"(PROCESS_STEPS_PER_STAGE개의 순차적인
 *    진행 컷 프롬프트)를 받아, 각 컷이 직전 컷 이미지를 이어받아 체이닝 생성되고 영상에서는
 *    빠른 디졸브로 이어붙여 타임랩스처럼 보입니다.
 * 5. refine (AI가 새로 생성한, 완성 직전 단계 이미지): 세부 묘사/글레이징 단계 — 역시 steps로 진행 컷 생성.
 * 6. finish (실제 사진, 전체 화면): 완성작으로 돌아와 변화를 되짚으며 마무리.
 */
export async function generateProcessScript({ painting, imageBufferForVision, imageMediaType, apiKey, model }) {
  apiKey = apiKey?.trim();
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY가 설정되어 있지 않습니다. GitHub Actions Secret 또는 로컬 .env를 확인하세요.');
  }

  const metadataBlock = [
    `Title: ${painting.title}`,
    `Artist: ${painting.artistDisplayName || 'Unknown'}`,
    painting.artistDisplayBio ? `Artist bio: ${painting.artistDisplayBio}` : null,
    `Date: ${painting.objectDate || 'Unknown'}`,
    `Medium: ${painting.medium || 'Unknown'}`,
    painting.culture ? `Culture: ${painting.culture}` : null,
    painting.department ? `Department: ${painting.department}` : null,
    painting.creditLine ? `Credit line: ${painting.creditLine}` : null,
    `Source: The Metropolitan Museum of Art, object #${painting.objectID}, ${painting.objectURL}`,
  ]
    .filter(Boolean)
    .join('\n');

  const systemPrompt = `You are a scriptwriter for a YouTube Shorts channel that imagines HOW a famous painting might have been made — a speculative, step-by-step recreation of the artist's process, going from a blank canvas to the finished masterpiece. This is NOT a documented historical record (almost none exist for these works) — it is an educated, artistically-informed reconstruction based on (a) what is actually visible in the finished painting, (b) well-known general techniques of the artist's era/medium (e.g., oil underpainting in grisaille or earth tones, egg tempera cartoons transferred to panel, alla prima direct painting, glazing layers), and (c) the artist's documented working habits when something specific is actually known.

CRITICAL — honesty about speculation: Never assert invented specific facts as if documented (no fake quotes, no invented anecdotes, no claiming a specific X-ray/infrared study exists unless it's genuinely well-known and you're confident it does). Use hedging language throughout — "likely", "probably", "it's easy to imagine", "may well have" — never flat assertions about what definitely happened. If a specific technical detail about this artist/era IS well-established (e.g., "Vermeer is believed to have used a camera obscura", "Renaissance panel painters typically built up thin glazes over an underdrawing"), you may state that established general fact plainly, then apply it speculatively to this specific painting.

You will be shown the actual finished painting plus its museum metadata. Look closely at real, visible qualities — visible brushwork texture, layering, edges (hard vs. soft), evidence of underdrawing showing through thin paint, palette choices, compositional structure — and build the imagined process around what these visible clues suggest, not generic filler that could apply to any painting.

STEP 1 — ground the reconstruction in real, documented technique before writing anything else. Write "techniqueBasis": 2-3 sentences naming (a) the actual medium given in the metadata below (e.g., "oil on canvas", "tempera on wood, gold ground"), (b) the specific art-historical movement or period this artist/work belongs to (identify it from the artist name, date, and the painting's visible style — this is well-established art history, state it plainly), and (c) that movement's real, well-known technique convention for HOW paintings were typically built up (concrete examples: Impressionists like Monet or Renoir typically painted alla prima — direct, wet-into-wet color application with little or no detailed underdrawing; Northern Renaissance and Early Netherlandish oil painters typically built up thin, transparent glazes over a detailed underdrawing often transferred from a cartoon; Baroque painters such as Rembrandt or Caravaggio typically worked from a dark toned ground upward, building impasto highlights over shadow; Neo-Impressionists/Pointillists applied small distinct dots or dashes of pure, unmixed color; egg tempera panel painters built up fine hatched strokes over an underdrawing). If you cannot confidently identify a specific movement, default to the most standard, well-documented technique for that general medium and era, and say so honestly (e.g., "oil paintings of this general period typically..."). Every later stage — especially "sketch", "underpainting", and their imagePrompts — MUST follow logically from what you state here, not a generic one-size-fits-all process. In particular: if the documented convention for this artist/movement is to skip a careful drawn underdrawing (as with many Impressionists working alla prima), say so and adjust the "sketch" stage to describe a loose, rough color gesture-sketch directly on the canvas instead of a graphite/charcoal drawing — don't force a pencil-sketch stage onto an artist not known to have worked that way.

STEP 2 — structure the script as exactly 6 segments, in exactly this order and stage type, consistent with the techniqueBasis you just stated:
1. stage "identify" (usesGeneratedImage: false, bbox = the whole painting): Introduce the finished painting — title, artist, rough year. End with a hook promising to reconstruct how it might have come together, stroke by stroke.
2. stage "reference" (usesGeneratedImage: false, bbox = whole painting or a specific real detail): Imagine what the artist likely observed, studied, or referenced to build this composition (a live model, a study of natural light, a religious/mythological source text, preliminary drawings, a specific setting) — grounded in what the finished image actually shows and in the techniqueBasis.
3. stage "sketch" (usesGeneratedImage: true): Describe the imagined initial stage consistent with techniqueBasis — either a loosely blocked-in drawn underdrawing (for artists/movements known to work that way) or a rough gestural color block-in with no drawn stage (for artists/movements known to paint alla prima, skipping a formal underdrawing). Instead of one single image, write "steps": an array of exactly 3 short image-generation prompts, each describing ONE INCREMENTAL bit of progress within this stage, from barest beginning to this stage's natural end point (e.g., step 1 = the very first loose marks establishing the main shapes only; step 2 = more of the composition roughed in, still loose and incomplete; step 3 = this early stage essentially complete, ready to move to the next stage). Each step's image will be generated by continuing from the ACTUAL image produced by the previous step (not from scratch) — so word each step as an incremental instruction ("add...", "rough in...", "extend the ... further") rather than restating the whole scene, and name the actual technique (e.g., "loose charcoal underdrawing" vs. "rough alla-prima color block-in with visible loose brushstrokes, no pencil lines").
4. stage "underpainting" (usesGeneratedImage: true): Describe the imagined tonal/color block-in stage consistent with techniqueBasis — e.g., a monochrome grisaille underpainting for a glazing-based technique, or a direct rough color mass block-in for alla prima work. Write "steps": 3 incremental prompts (same rules as above) taking the composition from where "sketch" left off toward a more built-up tonal/color block-in, naming the specific technique.
5. stage "refine" (usesGeneratedImage: true): Describe the imagined final push consistent with techniqueBasis — layering transparent glazes and sharpening edges for a glazing technique, or adding thicker impasto highlights and final direct strokes for an alla-prima/impasto technique. Write "steps": 3 incremental prompts taking the composition from the underpainting stage to nearly-finished (the very last step should look close to, but not quite, the real finished painting), naming the specific technique.
6. stage "finish" (usesGeneratedImage: false, bbox = the whole painting): Pull back to the real finished painting. Reflect on the transformation from the early stage to finished work, then close with a light line reinforcing that this was an imagined reconstruction grounded in known technique, not a documented record (e.g., "That's our best guess, built on how [movement] painters actually worked — nobody alive watched them paint it.").

For every segment:
- "narration": TWO to FOUR short sentences, natural spoken chunks, no references to "earlier" segments. At least one segment among sketch/underpainting/refine should naturally mention the real technique term from techniqueBasis (e.g., "alla prima", "glazing", "grisaille underpainting") so the reconstruction reads as informed, not generic.
- "focus": short 3-6 word label describing what's shown.
- For "identify"/"reference"/"finish" segments (usesGeneratedImage: false): also provide "gridPosition" (3x3 grid label, e.g. "top-left") and "bbox" (x,y,w,h as fractions 0-1, x+w<=1, y+h<=1, w>=0.12, h>=0.12). "identify" and "finish" must use approximately the full image (x:0,y:0,w:1,h:1 or very close). "reference" may use a specific real detail's region if that better supports the narration, or the full image if the observation is about the whole scene.
- For "sketch"/"underpainting"/"refine" segments (usesGeneratedImage: true): provide "steps" as described above (exactly 3 incremental prompts), and omit bbox/gridPosition entirely.

Narration total length across all 6 segments: roughly 170-260 words total (this becomes roughly 70-110 seconds of spoken narration). Combined with the fixed ~5.5-second intro/outro title cards, the finished video should land in the 1-2 minute range that works well for YouTube Shorts — do not go noticeably short of this range.
Tone: curious and speculative but confident in craft knowledge — like a painter-friend walking you through how they'd guess this was built, not a dry textbook.

- Write a scroll-stopping YouTube Shorts title (under 80 characters — a fixed disclosure suffix will be appended by our system, so leave room) that promises to reveal how the painting might have been made, naming the painting and/or artist.
- Write a YouTube description: 2-4 sentences about the painting and what the imagined process reconstruction shows, written in a way that is honest this is a speculative recreation.
- Write 8-15 relevant YouTube tags (lowercase, no # symbol) mixing the artist name, painting name, art technique terms (e.g. "underpainting", "art process", "painting technique", the actual movement name), and general discovery terms (e.g. "art history", "how paintings are made", "famous paintings").

You must respond by calling the "submit_process_script" tool exactly once.`;

  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: 4096,
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
            text: `Here is the painting's museum metadata:\n\n${metadataBlock}\n\nWrite the speculative "how it was made" Shorts script now.`,
          },
        ],
      },
    ],
    tools: [
      {
        name: 'submit_process_script',
        description: 'Submit the finished speculative process-recreation video script.',
        input_schema: {
          type: 'object',
          properties: {
            techniqueBasis: {
              type: 'string',
              description: 'Real documented medium + art-historical movement/period + that movement\'s known technique convention this reconstruction is grounded in.',
            },
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
              minItems: 6,
              maxItems: 6,
              items: {
                type: 'object',
                properties: {
                  stage: { type: 'string', enum: ['identify', 'reference', 'sketch', 'underpainting', 'refine', 'finish'] },
                  narration: { type: 'string' },
                  focus: { type: 'string' },
                  usesGeneratedImage: { type: 'boolean' },
                  steps: {
                    type: 'array',
                    minItems: PROCESS_STEPS_PER_STAGE,
                    maxItems: PROCESS_STEPS_PER_STAGE,
                    items: { type: 'string' },
                  },
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
                required: ['stage', 'narration', 'focus', 'usesGeneratedImage'],
              },
            },
          },
          required: ['techniqueBasis', 'youtube', 'segments'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_process_script' },
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API 호출 실패 (${res.status}): ${text}`);
  }

  const data = await res.json();
  const toolUse = data.content?.find((block) => block.type === 'tool_use' && block.name === 'submit_process_script');
  if (!toolUse) {
    throw new Error('Claude 응답에서 submit_process_script tool 호출을 찾지 못했습니다. 응답: ' + JSON.stringify(data));
  }

  const script = toolUse.input;
  validateAndClampProcessScript(script);
  return script;
}

const EXPECTED_STAGE_ORDER = ['identify', 'reference', 'sketch', 'underpainting', 'refine', 'finish'];

// Claude가 지시를 완벽히 안 지켰을 경우를 대비한 안전장치: segments가 비었거나, 6개가
// 아니거나, stage 순서가 기대와 다르거나, 생성 이미지 세그먼트에 imagePrompt가 없거나,
// 실사진 세그먼트에 bbox가 없으면 잡아냅니다. segments가 아예 비어 있는 경우는(예: 민감한
// 소재로 Claude가 응답을 거부한 경우) 기존 hidden-detail 파이프라인과 동일하게
// CONTENT_REFUSAL로 표시해서, 이 그림만 건너뛰고 다른 그림으로 재시도할 수 있게 합니다.
// 그 외의(스키마 위반성) 문제는 이 그림 자체의 문제가 아니라 모델이 형식을 잘못 지킨
// 시스템적인 문제이므로 일반 에러로 던져서 바로 실행을 중단시킵니다.
function validateAndClampProcessScript(script) {
  if (!Array.isArray(script.segments) || script.segments.length === 0) {
    throw Object.assign(new Error('Claude가 segments를 비워서 반환했습니다.'), { code: 'CONTENT_REFUSAL' });
  }
  if (!script.techniqueBasis || !script.techniqueBasis.trim()) {
    throw new Error('techniqueBasis가 비어 있습니다 — 제작 과정의 근거(매체/화파/기법)가 없으면 진행하지 않습니다.');
  }
  if (script.segments.length !== 6) {
    throw new Error(`segments가 정확히 6개여야 하는데 ${script.segments.length}개가 반환되었습니다.`);
  }
  script.segments.forEach((seg, i) => {
    const expectedStage = EXPECTED_STAGE_ORDER[i];
    if (seg.stage !== expectedStage) {
      throw new Error(`segments[${i}].stage가 "${expectedStage}"이어야 하는데 "${seg.stage}"입니다.`);
    }
    if (seg.usesGeneratedImage) {
      if (!Array.isArray(seg.steps) || seg.steps.length !== PROCESS_STEPS_PER_STAGE) {
        throw new Error(
          `segments[${i}] (stage: ${seg.stage})는 usesGeneratedImage=true인데 steps가 정확히 ${PROCESS_STEPS_PER_STAGE}개가 아닙니다 (받은 개수: ${Array.isArray(seg.steps) ? seg.steps.length : 'N/A'}).`
        );
      }
      if (seg.steps.some((s) => !s || !s.trim())) {
        throw new Error(`segments[${i}] (stage: ${seg.stage})의 steps 중 비어 있는 항목이 있습니다.`);
      }
    } else {
      if (!seg.bbox) {
        throw new Error(`segments[${i}] (stage: ${seg.stage})는 usesGeneratedImage=false인데 bbox가 없습니다.`);
      }
      seg.bbox = clampBbox(seg.bbox);
      reconcileBboxWithGridPosition(seg);
      if ((seg.stage === 'identify' || seg.stage === 'finish') && !isNearFullImageBbox(seg.bbox)) {
        // identify/finish는 전체 화면이어야 하므로, 실수로 좁게 나왔으면 강제로 전체로 되돌립니다.
        seg.bbox = { x: 0, y: 0, w: 1, h: 1 };
      }
    }
  });
}
