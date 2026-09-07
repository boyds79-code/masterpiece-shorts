import fs from 'node:fs';
import path from 'node:path';

import { generateOneVideo } from './generate-video.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// 몇 개를 만들지: `node scripts/generate-batch.mjs 10` 처럼 첫 번째 인자로 주거나,
// 안 주면 기본 10개.
const COUNT = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 10;

/**
 * generateOneVideo()를 순서대로(동시에 여러 개 X — API 요청 제한/자원 경쟁을 피하려고)
 * COUNT번 반복 호출합니다. 하나가 실패해도 나머지는 계속 진행하고, 마지막에 성공/실패
 * 목록을 정리해서 보여줍니다. 각 영상은 기존과 동일하게 YouTube에 "비공개"로 올라가므로,
 * 이 스크립트가 끝난 뒤 아래 목록의 링크를 하나씩 열어 검토하고 마음에 드는 것만 공개로
 * 바꾸면 됩니다.
 */
async function main() {
  console.log(`[generate-batch] 총 ${COUNT}개 영상 생성을 시작합니다. 하나당 몇 분씩 걸릴 수 있어요 — 끝까지 켜두세요.\n`);

  const succeeded = [];
  const failed = [];

  for (let i = 1; i <= COUNT; i++) {
    console.log(`\n========== [${i}/${COUNT}] 영상 생성 시작 ==========`);
    try {
      const result = await generateOneVideo();
      if (!result) {
        console.log('[generate-batch] 더 이상 만들 수 있는(아직 안 쓴) 명화가 없어서 여기서 멈춥니다.');
        break;
      }
      succeeded.push({
        index: i,
        title: result.painting.title,
        artist: result.painting.artistDisplayName,
        videoId: result.uploadResult.videoId,
        studioUrl: result.uploadResult.studioUrl,
        watchUrl: result.uploadResult.url,
      });
      console.log(`[generate-batch] [${i}/${COUNT}] 완료 — ${result.uploadResult.studioUrl}`);
    } catch (err) {
      console.error(`[generate-batch] [${i}/${COUNT}] 실패: ${err.message}`);
      failed.push({ index: i, reason: err.message });

      if (err.code !== 'CONTENT_REFUSAL') {
        // 특정 그림의 민감한 소재 때문이 아니라 API 과금/네트워크/인증 등 시스템 차원의
        // 문제입니다. 이런 문제는 다음 그림으로 넘어가도 똑같이 반복될 뿐이니, 나머지
        // 배치를 계속 돌려서 시간과 API 호출만 낭비하지 말고 여기서 바로 멈춥니다.
        console.error(
          `\n[generate-batch] 그림과 무관한 시스템 오류로 보여 나머지 ${COUNT - i}개는 시도하지 않고 배치를 중단합니다.\n` +
            '문제를 해결한 뒤(예: Anthropic 콘솔에서 크레딧 충전) 다시 실행해주세요.\n'
        );
        break;
      }
    }
  }

  console.log('\n\n================ 배치 생성 결과 요약 ================\n');
  console.log(`성공: ${succeeded.length}개 / 실패: ${failed.length}개 (총 시도 ${succeeded.length + failed.length}개)\n`);

  if (succeeded.length > 0) {
    console.log('검토용 링크 (전부 "비공개" 상태로 올라가 있습니다 — 확인 후 마음에 드는 것만 공개로 전환하세요):\n');
    for (const s of succeeded) {
      console.log(`${s.index}. "${s.title}" — ${s.artist}`);
      console.log(`   ${s.studioUrl}`);
    }
  }

  if (failed.length > 0) {
    console.log('\n실패한 항목:\n');
    for (const f of failed) {
      console.log(`${f.index}. ${f.reason}`);
    }
  }

  // 터미널 스크롤이 길어져도 나중에 다시 찾아볼 수 있도록 결과를 파일로도 남겨둡니다.
  const summaryPath = path.join(ROOT, 'output', `batch-summary-${Date.now()}.md`);
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  const lines = [
    `# 배치 생성 결과 (${new Date().toISOString()})`,
    '',
    `성공 ${succeeded.length}개 / 실패 ${failed.length}개`,
    '',
    ...succeeded.map((s) => `${s.index}. [${s.title} — ${s.artist}](${s.studioUrl})`),
    '',
    ...failed.map((f) => `${f.index}. 실패: ${f.reason}`),
    '',
  ];
  fs.writeFileSync(summaryPath, lines.join('\n'));
  console.log(`\n(이 목록은 ${summaryPath} 파일에도 저장해뒀습니다.)`);
}

main().catch((err) => {
  console.error('[generate-batch] 배치 실행 자체가 실패했습니다:', err);
  process.exit(1);
});
