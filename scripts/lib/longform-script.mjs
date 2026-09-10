import { API_URL, DEFAULT_MODEL, clampBbox, isNearFullImageBbox, reconcileBboxWithGridPosition } from './anthropic.mjs';
import { PROCESS_STEPS_PER_STAGE } from './process-script.mjs';

/**
 * 하나의 그림에 대해 "긴 영상(3분 이상, WHEN+WHY+HOW+숨은 의미를 모두 담은 완결된 이야기) +
 * 그 영상에서 발췌한 쇼츠 두 개(그리는 방법 티저 / 숨은 의미 티저)"를 만들기 위한 대본 하나를
 * 생성합니다.
 *
 * 왜 대본을 하나만 만드나요? 세 개의 결과물(긴 영상 + 티저 쇼츠 2개)이 서로 다른 이야기를
 * 하면 안 되고, 같은 그림에 대한 "하나의 완결된 설명"에서 서로 다른 구간을 잘라 쓰는 것이어야
 * 합니다 — 그래야 쇼츠를 우연히 본 사람이 "이 채널에 이 그림에 대한 더 긴 영상이 있겠구나"라고
 * 자연스럽게 느끼고, 실제로 그 긴 영상을 찾아봤을 때 방금 본 쇼츠와 같은 목소리·같은 설명
 * 흐름이 이어지는 느낌을 받습니다. 그래서 이 함수는 세그먼트 10개짜리 대본 "하나"만 만들고,
 * 그중 어떤 세그먼트를 어떻게 잘라 쓰는지는 오직 조립 단계(video-builder.mjs의
 * assembleLongformBundle)와 조립을 호출하는 generate-longform-video.mjs가 결정합니다:
 *   - 긴 영상 = 세그먼트 10개 전부 (인트로/아웃트로 카드 포함)
 *   - "그리는 방법" 티저 쇼츠 = sketch/underpainting/refine 3개 세그먼트만 + 티저 전용
 *     인트로/아웃트로 카드(아웃트로에 긴 영상 제목을 화면 텍스트로 고정 노출)
 *   - "숨은 의미" 티저 쇼츠 = reveal 4개 세그먼트만 + 티저 전용 인트로/아웃트로 카드(동일)
 *
 * 유튜브 쇼츠는 2023년 8월부터 설명란/댓글의 클릭 가능한 링크를 막았고, Data API로는
 * 댓글 고정이나 최종 화면(end screen)/카드 추가도 지원하지 않습니다 — 그래서 "티저를 보고
 * 긴 영상으로 유도"하는 유일하게 신뢰할 수 있는 방법은 화면에 긴 영상의 정확한 제목을
 * 텍스트로 못박아 두는 것입니다(사람이 검색해서 채널에서 찾아보도록). 이 파일은 그 제목이
 * 나중에 화면 카드에 그대로 들어갈 것을 알고, 각 세그먼트의 나레이션이 "이전 세그먼트를
 * 언급하지 않고 그 자체로 완결되게" 쓰이도록 강제합니다 — 티저가 원본 영상에서 몇 개
 * 세그먼트만 잘라내도 어색하지 않아야 하기 때문입니다.
 *
 * 세그먼트는 정해진 순서를 따르고(총 10개), 나레이션 길이를 세그먼트별로 충분히 확보해서
 * (아래 각 stage 설명에 명시된 단어 수 목표), 완성된 긴 영상이 안정적으로 유튜브 쇼츠 기준
 * (3분)을 넘기고, 반대로 두 티저는 각자 3분을 넘지 않도록 설계돼 있습니다:
 * 1. identify (실제 사진, 전체 화면) — 언제: 무엇이 그려졌는지, 언제 그려졌는지.
 * 2. reference (실제 사진, 전체 또는 특정 부분) — 왜: 왜 이렇게 그려졌는지 + 무엇을
 *    관찰/참고했을지.
 * 3~5. sketch, underpainting, refine (각각 AI가 새로 생성한 이미지, steps 배열) — 어떻게:
 *    techniqueBasis에 따른 스케치 -> 밑칠 -> 마무리 직전 단계.
 * 6~9. reveal (실제 사진, 특정 디테일로 확대, 4개) — 숨은 의미: 서로 다른 디테일 4개를 각각
 *    디코딩.
 * 10. finish (실제 사진, 전체 화면) — 완성작으로 돌아와 언제·왜·어떻게·숨은 의미를 모두
 *     엮어 마무리.
 */
export async function generateLongformScript({ painting, imageBufferForVision, imagePath, imageMediaType, apiKey, model }) {
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
    painting.dimensions ? `Dimensions: ${painting.dimensions}` : null,
    `Source: The Metropolitan Museum of Art, object #${painting.objectID}, ${painting.objectURL}`,
  ]
    .filter(Boolean)
    .join('\n');

  const systemPrompt = `You are a scriptwriter for a YouTube channel about famous public-domain paintings. You are writing ONE long-form video script (3+ minutes) that tells the complete story of a painting — WHEN it was made, WHY it was made, HOW it was likely physically painted (a speculative, artistically-informed reconstruction), and WHAT hidden symbols/secrets/details are encoded in it. This same script will later be cut into two short teaser clips as well (one covering only the HOW portion, one covering only the hidden-meaning portion), so every segment's narration must work as a self-contained thought — never reference "as I mentioned earlier", "as we discussed", "the previous section", etc.

You will be shown an actual photo of the painting, plus its museum metadata. Look closely at the image itself — real details you can actually see (facial expressions, gestures, hidden symbols, background elements, brushwork, light source, composition) — and build the script around what is ACTUALLY visible, not generic filler that could apply to any painting.

STEP 1 — ground the HOW portion in real, documented technique before writing anything else. Write "techniqueBasis": 2-3 sentences naming (a) the actual medium given in the metadata (e.g., "oil on canvas"), (b) the specific art-historical movement/period this artist/work belongs to (identify it from the artist name, date, and the painting's visible style), and (c) that movement's real, well-known technique convention for HOW paintings were typically built up (e.g., Impressionists often painted alla prima with little underdrawing; Northern Renaissance oil painters typically built thin glazes over a detailed underdrawing; Baroque painters like Rembrandt or Caravaggio often worked from a dark ground upward; egg tempera panel painters built fine hatched strokes over an underdrawing). If you cannot confidently identify a specific movement, default to the most standard documented technique for that general medium/era and say so honestly. This reconstruction is NOT a documented historical record — use hedging language ("likely", "probably", "it's easy to imagine") throughout the HOW segments, never flat assertions about what definitely happened.

STEP 2 — write the hidden-meaning portion with real interpretive substance, not flat description. Never just describe what a detail looks like ("here we see a skull on the table") — always explain WHY it matters: what it symbolizes, what it reveals, what secret/joke/warning it encodes, or why art historians find it significant. Only state facts you're reasonably confident about from the metadata or well-established art history; if something is debated, say so ("some art historians believe...") rather than asserting it as settled fact. Never invent specific anecdotes, quotes, or events not supported by the metadata or common knowledge — a true, less dramatic detail always beats an invented one.

STEP 3 — structure the script as exactly 10 segments, in exactly this order and stage type:
1. stage "identify" (usesGeneratedImage: false, bbox = the whole painting): Introduce the finished painting — title, artist, rough year (WHEN). End with a hook promising to cover how it was made AND what's secretly hidden inside it. Narration target: roughly 30-40 words.
2. stage "reference" (usesGeneratedImage: false, bbox = whole painting or a specific real detail): WHY this painting exists and looks the way it does — the artist's likely motivation/purpose/context (commission, personal/historical circumstance, belief/emotion/event) AND what they likely observed or referenced to build the composition, grounded in what the finished image actually shows. Narration target: roughly 50-65 words.
3. stage "sketch" (usesGeneratedImage: true): The imagined initial stage consistent with techniqueBasis (a loose drawn underdrawing, or a rough gestural color block-in for alla-prima-type artists). Write "steps": an array of exactly ${PROCESS_STEPS_PER_STAGE} short image-generation prompts, each describing ONE INCREMENTAL bit of progress within this stage (barest beginning -> this stage's natural end point). Each step continues from the actual image produced by the previous step, so word it as an incremental instruction ("add...", "rough in...") not a full scene restatement. Narration target: roughly 35-50 words, and it must stand alone (this segment may later be shown on its own in a "how it was painted" teaser, with no identify/reference segment before it) — so briefly ground what stage of the process this is without assuming the viewer heard the identify/reference segments.
4. stage "underpainting" (usesGeneratedImage: true): The imagined tonal/color block-in stage consistent with techniqueBasis, continuing from where "sketch" left off. Write "steps": ${PROCESS_STEPS_PER_STAGE} incremental prompts (same rules). Narration target: roughly 35-50 words, self-contained (no references to the sketch segment by name like "as we just saw").
5. stage "refine" (usesGeneratedImage: true): The imagined final push (glazing/sharpening edges, or impasto highlights/final direct strokes) consistent with techniqueBasis, continuing from the underpainting stage to nearly-finished (the last step should look close to, but not quite, the real finished painting). Write "steps": ${PROCESS_STEPS_PER_STAGE} incremental prompts. Narration target: roughly 35-50 words, self-contained, and should include the real technique term from techniqueBasis (e.g. "alla prima", "glazing", "grisaille underpainting") so it reads as informed.
6 through 9. FOUR stage "reveal" segments (usesGeneratedImage: false, bbox = one specific real visible detail each): Each zooms into ONE real visible detail and decodes its hidden meaning — vary what kind of detail you pick (don't do four faces in a row) and favor genuinely surprising or little-known facts you can responsibly attribute to this specific work. Narration target: roughly 35-45 words EACH, and each must stand completely alone (these four segments may later be shown on their own, back to back, as a "hidden meaning" teaser with no identify/reference segment before them) — so each reveal needs enough of its own setup that a viewer dropped in cold still understands what they're looking at and why it matters, without referring to "another detail" or "as we saw before".
10. stage "finish" (usesGeneratedImage: false, bbox = the whole painting): Pull back to the real finished painting and tie WHEN/WHY/HOW/hidden-meaning together into one closing thought, then close with a light line noting the HOW portion was an imagined reconstruction grounded in known technique, not a documented record. Narration target: roughly 45-60 words.

For every segment:
- "narration": natural spoken chunks (2-5 short sentences depending on the word target above), no references to other segments.
- "focus": short 3-6 word label describing what's shown.
- For "identify"/"reference"/"reveal"/"finish" segments (usesGeneratedImage: false): also provide "gridPosition" (3x3 grid label, e.g. "top-left") and "bbox" (x,y,w,h as fractions 0-1, x+w<=1, y+h<=1, w>=0.12, h>=0.12). "identify" and "finish" must use approximately the full image (x:0,y:0,w:1,h:1 or very close). "reference" may use a full or partial region. Each "reveal" must use a real, specific detail region (never the full image) — double-check the numeric bbox is actually consistent with the gridPosition you named.
- For "sketch"/"underpainting"/"refine" segments (usesGeneratedImage: true): provide "steps" as described above, and omit bbox/gridPosition entirely.

Tone: curious and engaged throughout — a knowledgeable friend walking you through the full story of a painting, not a dry textbook. Total narration across all 10 segments should land roughly in the 370-495 word range (this becomes the long-form video's spoken narration, several minutes long) — do not go noticeably under this range, since the finished video needs to reliably run past 3 minutes.

You must also write YOUTUBE METADATA for three separate outputs, since the same material will be published three different ways:
- "full": the long-form video. Title (under 95 characters) should promise the complete story (how it was made AND what's hidden inside), naming the painting and/or artist. Description: 3-5 sentences summarizing what the video covers.
- "processTeaser": a short, hook-driven YouTube Shorts title (under 80 characters) that promises to reveal HOW this painting was made — this is a short excerpt covering only the painting technique, not the hidden meaning.
- "meaningTeaser": a short, hook-driven YouTube Shorts title (under 80 characters) that promises a hidden secret/symbol inside this painting — this is a short excerpt covering only the hidden-meaning reveals, not the painting technique.
For processTeaser and meaningTeaser, also write a short 1-2 sentence description of just that clip's own content (our system will automatically append a fixed note pointing viewers to the full video — do not write that note yourself).
All three need "tags": 8-15 relevant lowercase YouTube tags (no # symbol) mixing the artist name, painting name, art technique/movement terms, and general discovery terms (e.g. "art history", "famous paintings").

You must respond by calling the "submit_longform_script" tool exactly once.`;

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
            text: `Here is the painting's museum metadata:\n\n${metadataBlock}\n\nWrite the long-form script (and its two teaser metadata blocks) now.`,
          },
        ],
      },
    ],
    tools: [
      {
        name: 'submit_longform_script',
        description: 'Submit the finished long-form video script plus metadata for the full video and its two teaser Shorts.',
        input_schema: {
          type: 'object',
          properties: {
            techniqueBasis: {
              type: 'string',
              description: 'Real documented medium + art-historical movement/period + that movement\'s known technique convention the HOW segments are grounded in.',
            },
            youtube: {
              type: 'object',
              properties: {
                full: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' }, minItems: 8, maxItems: 15 },
                  },
                  required: ['title', 'description', 'tags'],
                },
                processTeaser: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' }, minItems: 8, maxItems: 15 },
                  },
                  required: ['title', 'description', 'tags'],
                },
                meaningTeaser: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' }, minItems: 8, maxItems: 15 },
                  },
                  required: ['title', 'description', 'tags'],
                },
              },
              required: ['full', 'processTeaser', 'meaningTeaser'],
            },
            segments: {
              type: 'array',
              minItems: 10,
              maxItems: 10,
              items: {
                type: 'object',
                properties: {
                  stage: { type: 'string', enum: ['identify', 'reference', 'sketch', 'underpainting', 'refine', 'reveal', 'finish'] },
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
    tool_choice: { type: 'tool', name: 'submit_longform_script' },
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
  const toolUse = data.content?.find((block) => block.type === 'tool_use' && block.name === 'submit_longform_script');
  if (!toolUse) {
    throw new Error('Claude 응답에서 submit_longform_script tool 호출을 찾지 못했습니다. 응답: ' + JSON.stringify(data));
  }

  const script = toolUse.input;
  validateAndClampLongformScript(script);
  return script;
}

const EXPECTED_STAGE_ORDER = [
  'identify',
  'reference',
  'sketch',
  'underpainting',
  'refine',
  'reveal',
  'reveal',
  'reveal',
  'reveal',
  'finish',
];

// Claude가 지시를 완벽히 안 지켰을 경우를 대비한 안전장치. segments가 아예 비어 있으면
// (예: 민감한 소재로 응답을 거부한 경우) 기존 파이프라인들과 동일하게 CONTENT_REFUSAL로
// 표시해서 이 그림만 건너뛰고 다른 그림으로 재시도할 수 있게 합니다. 그 외의(스키마
// 위반성) 문제는 일반 에러로 던져서 바로 실행을 중단시킵니다.
function validateAndClampLongformScript(script) {
  if (!Array.isArray(script.segments) || script.segments.length === 0) {
    throw Object.assign(new Error('Claude가 segments를 비워서 반환했습니다.'), { code: 'CONTENT_REFUSAL' });
  }
  if (!script.techniqueBasis || !script.techniqueBasis.trim()) {
    throw new Error('techniqueBasis가 비어 있습니다 — 제작 과정(HOW)의 근거(매체/화파/기법)가 없으면 진행하지 않습니다.');
  }
  if (!script.youtube?.full || !script.youtube?.processTeaser || !script.youtube?.meaningTeaser) {
    throw new Error('youtube.full / youtube.processTeaser / youtube.meaningTeaser 중 빠진 항목이 있습니다.');
  }
  if (script.segments.length !== 10) {
    throw new Error(`segments가 정확히 10개여야 하는데 ${script.segments.length}개가 반환되었습니다.`);
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
      if (seg.stage === 'reveal' && isNearFullImageBbox(seg.bbox)) {
        // reveal은 반드시 특정 디테일을 확대해야 하므로, 실수로 전체 화면이 나왔으면
        // 화면 중앙 절반 크기로 강제 보정합니다 (완전히 틀린 것보다 낫습니다).
        seg.bbox = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
      }
    }
  });
}
