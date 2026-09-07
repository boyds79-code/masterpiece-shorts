// 최초 1회, 당신의 맥에서 직접 실행하는 스크립트입니다 (GitHub Actions에서 실행하지 않음).
// Google 계정으로 로그인해서 "이 앱이 내 YouTube 채널에 영상을 업로드하도록 허용"에
// 동의하면, 그 결과로 나오는 refresh token을 한 번만 발급받아 GitHub Secret에 저장해두는
// 용도입니다. 이후 자동화(daily-video.yml)는 이 refresh token만으로 계속 인증합니다.
//
// 사용법:
//   1. .env에 YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET을 먼저 채워두세요.
//      (Google Cloud Console에서 만든 OAuth 2.0 클라이언트 ID — 유형은 "데스크톱 앱")
//   2. set -a && source .env && set +a
//   3. npm run get-youtube-token
//   4. 터미널에 뜨는 URL을 브라우저에서 열고, 채널 소유 구글 계정으로 로그인 후 허용
//   5. 터미널에 refresh token이 출력되면 그대로 복사해서 GitHub Secret
//      YOUTUBE_REFRESH_TOKEN에 등록하세요.

import http from 'node:http';
import { google } from 'googleapis';

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID?.trim();
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET?.trim();
const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET이 환경변수에 없습니다.');
  console.error('   .env에 값을 채운 뒤 `set -a && source .env && set +a`로 불러오고 다시 실행하세요.');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline', // refresh token을 받으려면 필수
  prompt: 'consent', // 이미 한 번 동의한 적이 있어도 refresh token을 다시 받기 위해 강제
  // youtube.upload만으로는 영상 업로드는 되지만 자막(captions.insert) 업로드 권한이 없습니다.
  // youtube.force-ssl을 추가해야 SRT 자막을 별도 트랙으로 올릴 수 있습니다.
  scope: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.force-ssl',
  ],
});

console.log('\n아래 URL을 브라우저에서 열어 채널 소유 구글 계정으로 로그인/허용하세요:\n');
console.log(authUrl);
console.log('\n(자동으로 브라우저가 열리지 않으면 위 URL을 직접 복사해서 붙여넣으세요)\n');

// macOS에서는 `open` 명령으로 브라우저를 바로 띄워봅니다 (실패해도 무시).
try {
  const { execFile } = await import('node:child_process');
  execFile('open', [authUrl]);
} catch {
  // 무시 — 사용자가 위 URL을 직접 열면 됩니다.
}

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<h2>인증 실패: ${error}</h2>터미널을 확인하세요.`);
    console.error(`❌ 인증 실패: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400);
    res.end('code 파라미터가 없습니다.');
    return;
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<h2>완료! 이 탭은 닫고 터미널로 돌아가세요.</h2>');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('\n✅ 인증 성공!\n');
    if (tokens.refresh_token) {
      console.log('아래 refresh token을 복사해서 GitHub Secret YOUTUBE_REFRESH_TOKEN에 등록하세요:\n');
      console.log(tokens.refresh_token);
      console.log('');
    } else {
      console.warn(
        '⚠️  refresh_token이 응답에 없습니다. 이미 이 앱에 한 번 허용한 적이 있어서 그럴 수 있습니다.\n' +
          '   Google 계정 설정 > 보안 > 타사 앱 액세스에서 이 앱의 연결을 해제한 뒤 이 스크립트를 다시 실행해보세요.'
      );
    }
  } catch (err) {
    console.error('❌ 토큰 교환 실패:', err.message);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT, () => {
  console.log(`(로컬에서 인증 결과를 받기 위해 http://127.0.0.1:${PORT} 에서 잠시 대기 중...)`);
});
