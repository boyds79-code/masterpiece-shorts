const API_URL = 'https://api.anthropic.com/v1/messages';

// TODO: 최신 모델 ID를 확인하고 필요하면 교체하세요.
// https://docs.claude.com/en/docs/about-claude/models
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

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
 */
export async function generateVideoScript({ painting, imageBufferForVision, imageMediaType, apiKey, model }) {
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

  const systemPrompt = `You are a scriptwriter for a YouTube Shorts channel that decodes the HIDDEN MEANINGS inside famous public-domain paintings — symbols, secrets, jokes, political messages, and psychological details that most viewers would walk right past — similar in spirit to popular Instagram art-explainer accounts, but written to be read aloud as narration over a video.

You will be shown an actual photo of the painting, plus its museum metadata. Look closely at the image itself — real details you can actually see (facial expressions, gestures, hidden symbols, background elements, brushwork, light source, composition) — and build the script around what is ACTUALLY visible, not generic art-history filler.

THE MOST IMPORTANT RULE — avoid flat description: Never just describe what a detail looks like ("here we see a skull on the table"). Every single segment must explain WHY it matters: what it symbolizes, what it reveals about the subject/artist/era, what secret or joke or warning it encodes, or why art historians find it significant. If you only have a plain visual observation and no genuine interpretive angle for it, pick a different detail that you can say something revealing about. The viewer should feel like they just learned something they didn't know, not like they got a guided tour of what their own eyes already told them.

Structure the script as 7 to 10 segments, in exactly this order:
1. IDENTIFY (bbox = the whole painting): Open by clearly stating what the painting is, who painted it, and roughly when — e.g. "This is [Title], painted by [Artist] around [year]." Immediately follow with a hook that promises a hidden layer the viewer is about to discover (never just a flat ID with no hook attached).
2. CONTEXT (bbox = the whole painting or very close to it): Explain the bigger picture — what scene or moment is depicted, why the artist painted it, who it was made for, or what historical/cultural moment it belongs to. This is scene-setting, not a detail zoom yet.
3 through N-1. REVEAL (bbox = one specific real detail each): Each segment zooms into ONE real visible detail and decodes its hidden meaning — a symbol, a piece of iconography, an expression that reveals emotion or intent, a technical trick, a detail that was controversial or surprising for its time, something the artist hid as commentary or a personal signature. Vary what kind of detail you pick (don't do five faces in a row) and favor the most genuinely surprising or little-known facts you can respons­ibly attribute to this specific work.
Last segment. CLOSE (bbox = the whole painting again): Pull back out and tie the hidden meanings together into one closing thought that reframes the whole painting — then, only if it fits naturally, a light non-salesy nudge like "next time you see a painting, look for what it's not saying out loud."
- Only state facts you're reasonably confident about from the given metadata or well-established, uncontroversial art history. If something is debated or uncertain among art historians, say so ("some art historians believe...", "it's long been debated whether...") rather than asserting it as settled fact. Never invent specific anecdotes, quotes, or events not supported by the metadata or common knowledge about the work — an interesting TRUE detail beats an invented dramatic one every time.
- Tone: curious, a little conspiratorial — like a knowledgeable friend leaning in to tell you a secret hiding in plain sight, not a dry textbook or museum placard. Short punchy sentences. Rhetorical questions ("Notice anything strange about his hands?") are a good tool before a reveal, used sparingly.
- Narration total length across all segments: roughly 170-230 words total (this becomes ~70-95 seconds of spoken narration) — do not go far outside this range.
- Each segment's "narration" is ONE to THREE short sentences — must stand alone as a natural spoken chunk (no "as we discussed before" type references).
- For each segment, provide a "bbox": the region of the image to visually zoom into while that narration plays, as fractions of the full image (0.0 to 1.0), with x,y = top-left corner of the crop box and w,h = width/height of the crop box. Constraints: 0 <= x, 0 <= y, x+w <= 1, y+h <= 1, and w >= 0.12 and h >= 0.12 (never crop absurdly tiny — it will look pixelated). The IDENTIFY, CONTEXT, and CLOSE segments should use approximately the full image (x:0, y:0, w:1, h:1, or very close to it).
- Also write a short "focus" label (3-6 words, e.g. "her folded hands", "the storm clouds behind him") describing what that segment's crop shows — used internally, not shown to viewers.
- Write a scroll-stopping YouTube Shorts title (under 90 characters) that promises a hidden meaning or secret, names the painting and/or artist, and creates real curiosity, without being clickbait-dishonest.
- Write a YouTube description: 2-4 sentences about the painting and the hidden meanings the video reveals, then a line crediting "Public domain image via The Metropolitan Museum of Art (metmuseum.org), CC0.", then a few relevant hashtags.
- Write 8-15 relevant YouTube tags (lowercase, no # symbol) mixing the artist name, painting name, art movement/period, and general art-content discovery terms (e.g. "art history", "hidden meaning", "famous paintings", "art explained").

You must respond by calling the "submit_script" tool exactly once.`;

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
                required: ['narration', 'focus', 'bbox'],
              },
            },
          },
          required: ['youtube', 'segments'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_script' },
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
  const toolUse = data.content?.find((block) => block.type === 'tool_use' && block.name === 'submit_script');
  if (!toolUse) {
    throw new Error('Claude 응답에서 submit_script tool 호출을 찾지 못했습니다. 응답: ' + JSON.stringify(data));
  }

  const script = toolUse.input;
  validateAndClampScript(script);
  return script;
}

// Claude가 지시를 완벽히 안 지켰을 경우를 대비한 안전장치 — bbox를 이미지 범위 안으로
// clamp하고, 너무 작은 crop을 최소 크기로 보정합니다. (ffmpeg 단계에서 이상한 값으로
// 죽는 것보다 여기서 미리 방어하는 게 낫습니다.)
function validateAndClampScript(script) {
  if (!Array.isArray(script.segments) || script.segments.length === 0) {
    throw new Error('Claude가 segments를 비워서 반환했습니다.');
  }
  const MIN_SIZE = 0.12;
  for (const seg of script.segments) {
    const b = seg.bbox;
    b.w = Math.max(MIN_SIZE, Math.min(1, b.w));
    b.h = Math.max(MIN_SIZE, Math.min(1, b.h));
    b.x = Math.max(0, Math.min(1 - b.w, b.x));
    b.y = Math.max(0, Math.min(1 - b.h, b.y));
  }
}
