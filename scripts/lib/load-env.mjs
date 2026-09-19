// 로컬 터미널에서 npm run 스크립트를 직접 실행할 때, 저장소 루트의 .env 파일을 읽어서
// process.env에 채워줍니다. 예전에는 매번 `set -a && source .env && set +a`로 먼저
// 불러와야 했는데(그걸 깜빡하면 "ANTHROPIC_API_KEY가 설정되어 있지 않습니다" 같은 오류가
// 남), 이제 각 진입 스크립트 맨 위에서 이 파일을 import하면 자동으로 처리됩니다.
//
// GitHub Actions에서는 시크릿이 이미 진짜 환경 변수로 들어있고 .env 파일 자체가
// 없으므로, 그 경우엔 조용히 아무 것도 하지 않습니다(에러 아님). 이미 쉘에서 직접
// export한 값이 있으면 process.loadEnvFile()이 그 값을 절대 덮어쓰지 않습니다 —
// .env보다 실제 환경 변수가 항상 우선합니다.
import fs from 'node:fs';
import path from 'node:path';

const envPath = path.resolve(import.meta.dirname, '..', '..', '.env');

if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
