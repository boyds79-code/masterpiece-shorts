import './lib/load-env.mjs';
import fs from 'node:fs';
import path from 'node:path';

import { startReviewServer } from './lib/review-server.mjs';

// candidates.json/painting.json/이미지가 이미 디스크에 있는 기존 리뷰 폴더를 다시
// 서빙합니다. 코드(.mjs)를 고쳐도 이미 떠 있는 generate:review 프로세스는 핫리로드되지
// 않으므로, 그림을 새로 고르지 않고 같은 폴더를 새 코드로 다시 열고 싶을 때 씁니다.
const reviewDir = process.argv[2];
if (!reviewDir) {
  console.error('사용법: npm run review:resume -- <리뷰 폴더 경로>');
  console.error('예: npm run review:resume -- output/review-1234567890-ab12c');
  process.exit(1);
}

const resolvedDir = path.resolve(reviewDir);
if (!fs.existsSync(path.join(resolvedDir, 'painting.json'))) {
  console.error(`[review:resume] painting.json을 찾을 수 없습니다: ${resolvedDir}`);
  console.error('generate-review.mjs가 만든 리뷰 폴더 경로가 맞는지 확인하세요.');
  process.exit(1);
}

startReviewServer({ reviewDir: resolvedDir });
