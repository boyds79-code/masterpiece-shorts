import fs from 'node:fs';
import { google } from 'googleapis';

/**
 * OAuth2 refresh token으로 인증해서 영상을 YouTube에 업로드합니다.
 * refresh token은 최초 1회, scripts/get-youtube-token.mjs를 로컬에서 실행해서 발급받습니다
 * (README "YouTube 설정" 참고). 그 이후로는 이 refresh token만으로 GitHub Actions에서도
 * 사람 개입 없이 계속 인증할 수 있습니다.
 */
function buildOAuthClient({ clientId, clientSecret, refreshToken }) {
  clientId = clientId?.trim();
  clientSecret = clientSecret?.trim();
  refreshToken = refreshToken?.trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN이 모두 필요합니다. README의 "YouTube 설정"을 참고해 발급받으세요.'
    );
  }
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

/**
 * @returns {{ videoId: string, url: string, studioUrl: string }}
 */
export async function uploadVideo({
  filePath,
  title,
  description,
  tags,
  privacyStatus,
  clientId,
  clientSecret,
  refreshToken,
}) {
  const auth = buildOAuthClient({ clientId, clientSecret, refreshToken });
  const youtube = google.youtube({ version: 'v3', auth });

  // 제목은 YouTube 제한이 100자이지만, 여유를 두고 95자에서 자릅니다.
  const safeTitle = title.length > 95 ? `${title.slice(0, 92)}...` : title;

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: safeTitle,
        description,
        tags,
        categoryId: '27', // Education
      },
      status: {
        privacyStatus: privacyStatus || 'private',
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: fs.createReadStream(filePath),
    },
  });

  const videoId = res.data.id;
  return {
    videoId,
    url: `https://youtu.be/${videoId}`,
    studioUrl: `https://studio.youtube.com/video/${videoId}/edit`,
  };
}

/**
 * 영상에는 자막을 굽지 않는 대신(폰트가 딱딱해 보인다는 피드백), SRT 파일을 별도의
 * YouTube 자막(Closed Caption) 트랙으로 업로드합니다. 시청자가 CC를 켜면 유튜브
 * 플레이어 자체 폰트/스타일로 자막이 나옵니다.
 */
export async function uploadCaptions({
  videoId,
  srtPath,
  language = 'en',
  name = 'English',
  clientId,
  clientSecret,
  refreshToken,
}) {
  const auth = buildOAuthClient({ clientId, clientSecret, refreshToken });
  const youtube = google.youtube({ version: 'v3', auth });

  await youtube.captions.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        videoId,
        language,
        name,
        isDraft: false,
      },
    },
    media: {
      mimeType: 'application/x-subrip',
      body: fs.createReadStream(srtPath),
    },
  });
}
