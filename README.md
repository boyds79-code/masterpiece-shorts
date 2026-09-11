# Masterpiece Shorts — 명화 숏폼 자동화

퍼블릭 도메인(저작권 만료) 명화를 하나 골라서, Claude가 그림을 직접 보고 "숨은 의미를
파고드는" 나레이션 대본을 쓰고, Gemini가 그 대본을 음성으로 읽고, ffmpeg이 줌/팬 효과를 입힌
9:16 숏폼 영상으로 조립한 뒤, YouTube에 **비공개(private)** 로 업로드하는 파이프라인입니다.
**GitHub Actions 자동 스케줄 없이, 만들고 싶을 때 수동으로 실행합니다.**

**중요: 영상은 자동으로 "공개"되지 않습니다.** 비공개 상태로 채널에 올라가고, 당신이
YouTube Studio에서 직접 확인한 뒤 공개로 전환해야 실제로 사람들이 볼 수 있습니다 —
블로그 4개 프로젝트의 "자동 초안 + 사람 검수" 철학과 동일합니다.

## 어떻게 작동하나요

1. 로컬(`npm run generate`)이나 GitHub Actions **Actions 탭 → Run workflow**로 원할
   때마다 수동으로 실행합니다 (자동 스케줄 없음).
2. 메트로폴리탄 미술관(Met) Open Access API에서, 아직 쓰지 않은 "하이라이트(대표작)"
   회화 중 하나를 무작위로 고릅니다. `isPublicDomain: true`인 작품만 사용하고(CC0, API 키
   불필요), classification/objectName을 한 번 더 확인해서 조각·구조물 등 회화가 아닌
   오브제는 제외합니다 — "명화(그림)" 기준을 회화로만 한정합니다.
3. 그 그림 이미지를 Claude에게 실제로 보여주고, 진짜 그 그림에 있는 디테일(표정, 손,
   배경, 상징물, 붓터치 등)을 근거로 전체 소개 → 배경 설명 → 숨은 의미 reveal → 마무리
   순서의 7~10개 구간짜리 나레이션 대본과 각 구간이 확대할 영역(bbox)을 받습니다.
4. 각 구간의 나레이션을 Gemini TTS로 음성 변환합니다.
5. ffmpeg으로 각 구간마다 해당 영역을 확대/팬(Ken Burns 효과)한 뒤, 인트로(제목 카드) +
   본편 + 아웃트로(팔로우 유도 카드)를 이어 붙여 9:16 영상을 만듭니다. 영상에는 자막을
   굽지 않습니다 — 대신 나레이션과 시간이 맞는 SRT 자막 파일을 만듭니다.
6. 완성된 영상을 YouTube에 **비공개**로 업로드하고, 이어서 SRT 파일을 YouTube 자막(CC)
   트랙으로 별도 업로드합니다 (시청자가 CC를 켜면 유튜브 플레이어 자체 폰트로 보입니다).
7. 어떤 그림을 이미 썼는지(`data/used-paintings.json`)와 결과 기록(`data/log.md`)을
   저장소에 커밋해서, 같은 그림이 반복되지 않게 합니다.
8. 당신이 YouTube Studio에서 영상을 확인 → 제목/설명/자막 다듬고 싶으면 수정 →
   **공개로 전환**합니다.

## 시작하기 (처음 한 번만)

### 1. 로컬에서 확인
```bash
npm install
cp .env.example .env
# .env에 아래 "2~4" 단계에서 발급받을 키들을 채우세요
set -a && source .env && set +a
npm run generate   # 실제로 그림 선정 -> 대본 -> 음성 -> 영상 -> 업로드까지 한 번 실행
```

### 2. Anthropic API 키
https://console.anthropic.com 에서 발급 (다른 블로그 프로젝트에서 쓰던 키를 재사용해도 됩니다).

### 3. Gemini API 키
https://aistudio.google.com/apikey 에서 무료로 발급 (역시 재사용 가능). Gemini TTS는
2025년 기준 preview 모델이라 무료 등급에 요청 수 제한이 있을 수 있습니다 — 실패하면
콘솔에서 결제(종량제) 활성화가 필요할 수 있습니다.

### 4. YouTube 설정 (가장 손이 많이 가는 단계입니다)

**4-1. Google Cloud 프로젝트 + YouTube Data API 활성화**
1. https://console.cloud.google.com 에서 새 프로젝트를 만듭니다 (또는 기존 프로젝트 사용).
2. **APIs & Services → Library**에서 "YouTube Data API v3"를 검색해서 **Enable**.

**4-2. OAuth 동의 화면**
1. **APIs & Services → OAuth consent screen**에서 User Type을 **External**로 선택.
2. 앱 이름/이메일 등 최소 정보만 입력하고 저장 (게시 상태는 "Testing"이어도 됩니다 —
   본인 계정만 쓸 거라면 굳이 심사받을 필요 없습니다).
3. **Test users**에 본인의 유튜브 채널 소유 구글 계정 이메일을 추가하세요. (Testing 상태인
   앱은 여기 등록된 계정으로만 로그인이 허용됩니다.)

**4-3. OAuth 클라이언트 ID 발급**
1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type: **Desktop app** 선택, 이름은 아무거나.
3. 생성되면 **Client ID**와 **Client Secret**이 나옵니다 — 이 둘을 `.env`의
   `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`에 넣으세요.

**4-4. Refresh token 발급 (최초 1회, 당신의 맥에서 직접 실행)**
```bash
set -a && source .env && set +a
npm run get-youtube-token
```
브라우저가 자동으로 열립니다 (안 열리면 터미널에 뜬 URL을 직접 여세요). 채널 소유 계정으로
로그인하고 "허용"을 누르면, 터미널에 **refresh token**이 출력됩니다. 이 값을 복사해두세요.

> Google이 "확인되지 않은 앱" 경고를 보여줄 수 있습니다 — 본인이 방금 만든 앱이 맞으므로
> "고급(Advanced) → OO(으)로 이동(안전하지 않음)"을 눌러 진행하면 됩니다.

### 5. GitHub 저장소 만들고 Secrets 등록
```bash
git init
git add -A
git commit -m "Initial commit"
git branch -M main
git remote add origin <당신의-저장소-URL>
git push -u origin main
```

저장소 **Settings → Secrets and variables → Actions**에서:

**Secrets** (New repository secret):
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REFRESH_TOKEN`
- `PAT_TOKEN` — 다른 블로그 프로젝트에서 이미 만든 Personal Access Token을 그대로
  재사용할 수 있습니다 (repo 쓰기 권한이 있는 토큰이면 됩니다). 이 프로젝트는 PR을 만들지
  않고, 결과 기록 파일(`data/`)을 바로 `main`에 커밋하기 위해 필요합니다.

**Variables** (선택, 기본값을 바꾸고 싶을 때만):
- `CLAUDE_MODEL` (기본: `claude-sonnet-4-5-20250929`)
- `GEMINI_TTS_MODEL` (기본: `gemini-2.5-flash-preview-tts`)
- `GEMINI_TTS_VOICE` (기본: `Kore` — 다른 사전정의 음성 목록은 Gemini 공식 문서 참고)
- `YOUTUBE_PRIVACY_STATUS` (기본: `private`. `unlisted`로 바꾸면 링크를 아는 사람은
  검수 전에도 볼 수 있습니다 — 완전히 비공개로 두고 싶으면 건드리지 마세요)

### 6. GitHub Actions에 저장소 쓰기 권한 확인
저장소 **Settings → Actions → General → Workflow permissions**에서
"Read and write permissions"가 켜져 있는지 확인하세요.

### 7. 첫 실행 테스트
저장소 **Actions 탭 → Generate masterpiece short → Run workflow**를 눌러 수동으로 한 번
실행해보세요 (자동 스케줄은 없고, 만들고 싶을 때마다 이 버튼을 누르면 됩니다). 실행이
끝나면 로그 마지막 줄에 뜨는 YouTube Studio 링크로 들어가서 결과를 확인하세요.

## 검수 후 공개하기

1. https://studio.youtube.com → **콘텐츠** 탭에서 방금 올라온 (비공개) 영상을 확인합니다.
2. 자막/제목/설명이 마음에 들면 그대로, 아니면 직접 수정합니다.
3. 공개 범위를 **비공개 → 공개(또는 일부공개)** 로 바꾸면 그때부터 실제로 노출됩니다.

## 저작권/법적 참고사항 (법률 자문 아님)

- 이 파이프라인은 메트로폴리탄 미술관 Open Access API에서 `isPublicDomain: true`로
  명시된 작품만 사용합니다 — 미술관이 CC0(저작권 없음)로 공개한 이미지입니다.
- 원작자가 사망한 지 오래된(즉 원작 자체가 퍼블릭 도메인인) 작품만 대상이 되도록
  Met의 "European Paintings" 하이라이트 컬렉션으로 소재를 제한하고 있습니다 — 사후
  저작권이 아직 살아있는 현대 작가의 작품은 다루지 않습니다.
- 나레이션 대본은 매번 새로 생성되는 원작 해설이며, 특정 인스타그램 계정이나 다른
  창작자의 문구를 그대로 베끼지 않습니다 — "명화 세부를 확대해서 설명한다"는 포맷/아이디어
  자체는 저작권 보호 대상이 아니지만, 실제 서비스 전 한 번쯤 관련 유튜브 정책(재사용
  콘텐츠, "다시 게시된 콘텐츠" 정책 등)을 직접 확인해보는 것을 권장합니다.
- YouTube 각 영상 설명란에 자동으로 "Public domain image via The Metropolitan
  Museum of Art (CC0)" 출처 표기가 들어갑니다.

## 프로젝트 구조

```
scripts/generate-video.mjs      "숨은 의미" 파이프라인 (그림 선정 -> 대본 -> 음성 -> 영상 -> 업로드)
scripts/generate-process-video.mjs  "제작 과정 상상 재현"("그리는 방법") 파이프라인 (아래 별도 섹션 참고)
scripts/generate-longform-video.mjs 그림 하나로 긴 영상 1개 + 그 영상에서 발췌한 티저 쇼츠 2개를 만드는 오케스트레이터
scripts/get-youtube-token.mjs   최초 1회 로컬 실행용 OAuth refresh token 발급 스크립트
scripts/lib/met-api.mjs         메트로폴리탄 미술관 Open Access API
scripts/lib/anthropic.mjs       Claude(vision)로 "숨은 의미" 대본 생성 + 그림 적합성 사전 심사
scripts/lib/process-script.mjs  Claude(vision)로 "제작 과정 상상"("그리는 방법") 대본 생성
scripts/lib/longform-script.mjs Claude(vision)로 긴 영상용 통합 대본(WHEN+WHY+HOW+숨은 의미 10세그먼트) 생성
scripts/lib/gemini-tts.mjs      Gemini TTS로 나레이션 음성 생성
scripts/lib/gemini-image.mjs    Gemini 이미지 생성으로 스케치/밑칠 단계 이미지 생성
scripts/lib/video-builder.mjs   ffmpeg 기반 영상 조립 (줌/팬, SRT 자막 생성, 인트로/아웃트로)
scripts/lib/youtube-upload.mjs  YouTube Data API v3 업로드 (영상 + 자막(CC) 트랙)
data/used-paintings.json        모든 파이프라인이 함께 쓰는 그림 선정 목록(중복 방지) —
                                 그림 하나가 어느 한쪽에서든 이미 쓰였으면 다른 모든 파이프라인에서 제외됩니다.
data/log.md                     "숨은 의미" 영상 생성 기록 (자동 갱신)
data/log-process.md             "제작 과정 상상 재현" 영상 생성 기록 (자동 갱신)
data/log-longform.md            "긴 영상 + 티저 쇼츠 2개" 생성 기록 (자동 갱신)
.github/workflows/daily-video.yml   수동(workflow_dispatch)으로만 실행되는 "숨은 의미" 단독 워크플로
.github/workflows/process-video.yml 수동(workflow_dispatch)으로만 실행되는 "제작 과정 상상 재현" 단독 워크플로
.github/workflows/longform-video.yml 수동(workflow_dispatch)으로만 실행 — 긴 영상 1개 + 티저 쇼츠 2개를 함께 생성
```

## "제작 과정 상상 재현"("그리는 방법") 영상 (별도 파이프라인)

완성된 명화를 보고 "이 그림은 언제·왜·어떻게 만들어졌는지"를 보여주는 영상입니다. 그림의
숨은 의미(상징/디테일 해석)는 다루지 않습니다 — 그건 완전히 별도인 "숨은 의미" 파이프라인
(`scripts/generate-video.mjs`)의 몫이고, 이 파이프라인은 오직 제작 과정(WHEN/WHY/HOW)에만
집중합니다. 실행 파일은 별도 파이프라인이지만, 그림 선정 목록
(`data/used-paintings.json`)은 "숨은 의미" 파이프라인과 공유하며, 위의 API 키
(Anthropic/Gemini/YouTube)도 그대로 재사용합니다.

**작동 방식**
1. Met에서 아직 어느 형식으로도 안 쓴 그림을 하나 고릅니다 (`data/used-paintings.json`을
   "숨은 의미" 파이프라인과 공유 — 그림 하나가 한쪽에서 이미 쓰였으면 다른 쪽에서도 다시
   뽑히지 않습니다).
2. Claude가 대본을 쓰기 전에 먼저 이 그림에 실제로 알려진 근거("techniqueBasis")를 명시합니다 —
   메타데이터의 실제 매체(예: 유화/템페라)와, 작가/시대가 속한 화파의 잘 알려진 제작 관행
   (예: 인상파는 밑그림 없이 알라 프리마로 바로 채색, 르네상스 패널화는 밑그림을 옮긴 뒤
   여러 겹 글레이징). 이후 스케치/밑칠/마무리 단계와 그 이미지 생성 프롬프트가 전부 이
   근거를 따르도록 강제합니다 — 모든 그림에 똑같은 "스케치→색칠→완성" 패턴을 적용하지 않고,
   화파마다 실제로 알려진 제작 방식이 반영됩니다.
3. 6단계 대본을 씁니다: (1) identify — 언제: 완성작 소개 → (2) reference — 왜: 누구를
   위해/어떤 동기·맥락으로 그려졌을지 + 작가가 뭘 관찰·참고했을지 → (3~5) sketch/
   underpainting/refine — 어떻게: 초기 단계(밑그림 또는 화파에 따라 바로 색 블로킹) →
   밑칠/명암 단계 → 마무리 직전 단계 → (6) finish — 완성작으로 복귀해 언제·왜·어떻게를
   하나로 엮어 마무리. 숨은 의미/상징은 다루지 않습니다. 유튜브 쇼츠에 맞게 인트로/아웃트로
   카드를 포함해 전체 영상이 1~2분 사이가 되도록 나레이션 분량을 맞춥니다.
4. "초기 단계"/"밑칠"/"마무리 직전" 3단계는 실제로 존재하는 이미지가 아니므로, Gemini 이미지
   생성 모델이 techniqueBasis에 맞는 이미지를 새로 그립니다 — 각 단계마다 딱 1장이 아니라
   3장(진행 컷)을 순서대로 체이닝해서 생성합니다: 매번 완성작(항상 목표로 유지)과 직전
   컷에서 실제로 생성된 이미지(여기서부터 이어서 진행)를 함께 참고 이미지로 줘서, "스케치→
   바로 완성 직전"으로 점프하지 않고 조금씩 진행되는 게 보이게 합니다. 이 체이닝은 sketch →
   underpainting → refine 전체에 걸쳐 하나로 이어집니다(스테이지가 바뀐다고 새로 시작 안 함).
   영상에서는 이 진행 컷들을 빠른 디졸브(크로스페이드)로 이어붙여 타임랩스처럼 보이게
   합니다 — 정적 이미지 하나를 오래 보여주는 대신, 여러 컷이 빠르게 넘어가는 느낌입니다.
   `scripts/lib/process-script.mjs`의 `PROCESS_STEPS_PER_STAGE`(기본 3) 상수를 올리면 더
   매끄러운 타임랩스가 되지만, 그만큼 Gemini 이미지 생성 호출 수와 생성 시간이 늘어납니다.
5. 각 단계 나레이션은 Gemini TTS로 음성 변환하고, ffmpeg으로 이어붙여 영상을 만듭니다.
6. YouTube에 비공개로 업로드합니다. 설명란에는 이 재구성이 어떤 근거(techniqueBasis)에
   기반했는지도 함께 적힙니다.

**"상상 재현"임을 어떻게 알리나요 — 대본 내용에만 의존하지 않습니다**
- 인트로 화면 카드에 항상 "AI-Imagined Creation Process" 문구가 고정으로 들어갑니다.
- YouTube 제목 끝에 항상 "(AI-Imagined Process)"가 자동으로 붙습니다.
- YouTube 설명 맨 앞에 항상 고정 고지 문단이 자동으로 들어갑니다.
- 업로드 시 YouTube의 "변형되었거나 합성된 콘텐츠(altered or synthetic content)" 공개
  항목(`containsSyntheticMedia`)을 자동으로 켭니다.
- (추가로) Claude에게 나레이션 자체도 단정적 서술이 아니라 "~였을 것이다" 같은 추정
  어조로 쓰도록 지시하지만, 위 4가지는 대본 내용과 무관하게 항상 강제로 적용됩니다.

**실행 방법**
```bash
npm run generate:process
```
또는 저장소 **Actions 탭 → Generate masterpiece process-recreation short → Run workflow**.

**참고**
- `GEMINI_IMAGE_MODEL`은 비교적 최근에 나온 Gemini 이미지 생성 API를 씁니다 — 처음
  한 번은 직접 실행해서 스케치/밑칠 단계 이미지가 잘 나오는지, 응답 형식이 예상과
  맞는지 확인해보는 걸 권장합니다. 만약 이미지 생성 쪽에서 에러가 나면 에러 메시지에
  Gemini 응답 원본 일부가 함께 찍히니, 그걸 보고 `scripts/lib/gemini-image.mjs`의
  `extractImageBase64()`만 살짝 고치면 됩니다.
- 이 형식은 "숨은 의미" 영상에 있는 그림 적합성(다인물/서사 밀도) 사전 심사가 없습니다 —
  제작 과정 상상은 인물 수와 크게 상관없이 대부분의 그림에 적용할 수 있기 때문입니다.

## 긴 영상 + 티저 쇼츠 2개 만들기 (long-form + shorts teasers)

그림 하나를 고른 뒤 **긴 영상 하나(3분 이상, WHEN+WHY+HOW+숨은 의미를 모두 담은 완결된
이야기) + 그 긴 영상에서 그대로 발췌한 짧은 티저 쇼츠 두 개**를 만들어 각각 YouTube에
비공개로 업로드하는 오케스트레이터입니다 (`scripts/generate-longform-video.mjs`). 검색으로
채널에 들어오는 사람은 적고, 대부분 쇼츠를 우연히 보고 채널을 발견하기 때문에 — 그 쇼츠를
보고 관심이 생긴 사람이 같은 그림을 다룬 긴 영상을 찾아볼 수 있게 유도하는 것이 목적입니다.

**왜 대본을 하나만 만드나요?** 세 결과물(긴 영상 + 티저 2개)이 서로 다른 이야기를 하면
안 되고, 같은 "하나의 완결된 설명"에서 구간만 다르게 잘라 써야 합니다. 그래서
`scripts/lib/longform-script.mjs`는 세그먼트 10개짜리 대본을 딱 하나만 만들고
(identify → reference → sketch/underpainting/refine → reveal×4 → finish), 실제로 어떤
세그먼트를 어떻게 잘라 쓰는지는 `video-builder.mjs`의 `assembleLongformBundle()`이
결정합니다:
- **긴 영상** = 10개 세그먼트 전부 (인트로/아웃트로 카드 포함, 3분 이상)
- **"그리는 방법" 티저** = sketch/underpainting/refine 3개 세그먼트만 (전용 인트로/아웃트로)
- **"숨은 의미" 티저** = reveal 4개 세그먼트만 (전용 인트로/아웃트로)

세그먼트별 영상 클립(줌/타임랩스 + 나레이션 오디오 합성)은 딱 한 번씩만 만들어서 세
결과물이 나눠 재사용합니다 — 같은 그림을 세 번씩 중복 렌더링하지 않습니다.

**⚠️ 알아둘 점: 쇼츠에서 긴 영상으로 가는 클릭 가능한 링크는 만들 수 없습니다.** 유튜브는
2023년 8월부터 쇼츠의 설명란과 댓글에서 클릭 가능한 링크를 막았고, YouTube Data API로는
댓글 고정이나 최종 화면(end screen)/카드 추가도 지원하지 않습니다 — 둘 다 YouTube Studio
안에서 직접 조작해야만 되는 기능이라 자동화할 수 없습니다. 그래서 이 파이프라인은 링크
대신, **긴 영상의 정확한 제목을 두 티저의 아웃트로 화면에 텍스트로 못박아 둡니다** (예:
`Full story on this channel: "..."`) — 쇼츠를 본 사람이 그 제목을 기억하거나 캡처해서
채널에서 검색해 찾아보도록 유도하는 방식입니다. 같은 문구를 설명란에도 넣어두지만, 쇼츠는
설명란을 잘 안 읽는 경우가 많으므로 화면 텍스트가 핵심 장치입니다. 이 화면 CTA 문구가
실제로 검색 가능한 정확한 문자열이 되도록, 긴 영상의 최종(고지 문구 포함) 업로드 제목을
먼저 확정한 뒤 그 문자열을 그대로 두 티저 조립에 넘깁니다.

**작동 방식**
1. Met에서 아직 어느 형식으로도 안 쓴 그림을 하나 고르고, "숨은 의미" 쪽 적합성 심사
   (다인물/서사/상징 밀도)를 통과하는지 먼저 확인합니다 (숨은 의미 리빌 4개를 포함하기
   때문에 이 심사를 재사용합니다).
2. Claude에게 그림을 보여주고 10개 세그먼트짜리 통합 대본 + 긴 영상/두 티저 각각의
   YouTube 제목·설명·태그를 한 번에 받습니다. 각 세그먼트의 나레이션은 "이전 세그먼트를
   언급하지 않고 그 자체로 완결되도록" 강제됩니다 — 티저가 몇 개 세그먼트만 잘라내도
   어색하지 않아야 하기 때문입니다.
3. sketch/underpainting/refine 3단계의 진행 컷 이미지를 Gemini로 체이닝 생성하고
   (`process-script.mjs`와 동일한 방식), 10개 세그먼트 전체의 나레이션을 Gemini TTS로
   음성 변환합니다.
4. `assembleLongformBundle()`이 세그먼트 클립을 한 번씩만 만들어서 긴 영상 + 티저 2개를
   조립합니다.
5. 세 영상을 모두 YouTube에 비공개로 업로드합니다. 긴 영상과 "그리는 방법" 티저는 AI가
   생성한 이미지를 담고 있으므로 `containsSyntheticMedia`를 켜고, 제목/설명에
   "제작 과정 상상 재현" 파이프라인과 동일한 고지 문구를 자동으로 붙입니다. "숨은 의미"
   티저는 실사진만 쓰므로 이 고지가 필요 없습니다.
6. 그림 하나에 대해 영상 ID 3개(`videoIdFull`, `videoIdProcessShort`, `videoIdMeaningShort`)를
   모두 기록한 항목 하나를 `data/used-paintings.json`에 남기고, `data/log-longform.md`에
   한 줄을 추가합니다.

**실행 방법**
```bash
npm run generate:longform
```
또는 저장소 **Actions 탭 → Generate masterpiece longform video + teaser shorts →
Run workflow**.

## 로컬에서 다시 테스트하기

```bash
set -a && source .env && set +a
npm run generate
```

매번 실행할 때마다 실제로 YouTube에 (비공개) 업로드까지 됩니다 — 테스트를 너무 자주
돌리면 채널에 비공개 영상이 계속 쌓이니, 다 확인했으면 YouTube Studio에서 필요 없는
테스트 영상은 삭제하세요.
