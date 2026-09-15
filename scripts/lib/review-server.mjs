import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';

import { buildEditorHtml } from './review-editor.mjs';
import { clampBbox } from './anthropic.mjs';

// generate-review.mjs가 대본을 만든 직후 이 서버를 띄웁니다. 정적 파일(file://)로 열면
// 브라우저가 로컬 디스크에 직접 쓰거나 서버 프로세스를 실행할 수 없어서(보안상 당연히 막혀
// 있음) "저장"과 "실행하기" 버튼이 실제로 뭔가를 하게 만들려면 이 페이지를 서빙하고 같은
// 프로세스에서 빌드까지 실행해줄 아주 작은 로컬 서버가 필요합니다. 127.0.0.1에만 붙어서
// 이 컴퓨터 밖에서는 접근할 수 없습니다.
//
// 라우트:
//   GET  /              편집기 페이지 (script.json/painting.json을 매번 새로 읽어서 렌더링)
//   GET  /original.jpg  원본 그림 이미지
//   GET  /events         진행 로그를 실시간으로 밀어주는 SSE 스트림
//   POST /save            수정된 bbox를 script.json에 즉시 저장
//   POST /build            나레이션 생성 -> 영상 조립 -> YouTube 업로드까지 실행

export function startReviewServer({ reviewDir, imageFile = 'original.jpg' }) {
  const paintingPath = path.join(reviewDir, 'painting.json');
  const scriptPath = path.join(reviewDir, 'script.json');
  const imagePath = path.join(reviewDir, imageFile);

  const sseClients = new Set();
  let building = false;

  function broadcast(event) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) res.write(line);
  }

  function readJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 5_000_000) req.destroy(new Error('요청 본문이 너무 큽니다'));
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/') {
        if (!fs.existsSync(paintingPath) || !fs.existsSync(scriptPath)) {
          res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('이 리뷰는 이미 완료되었거나 폴더가 삭제되었습니다. 터미널에서 새로 npm run generate:review를 실행하세요.');
          return;
        }
        const painting = readJson(paintingPath);
        const script = readJson(scriptPath);
        const html = buildEditorHtml({ script, painting, imageFile });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && req.url === `/${imageFile}`) {
        if (!fs.existsSync(imagePath)) {
          res.writeHead(404);
          res.end('이미지를 찾을 수 없습니다.');
          return;
        }
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        fs.createReadStream(imagePath).pipe(res);
        return;
      }

      if (req.method === 'GET' && req.url === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write('\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (req.method === 'POST' && req.url === '/save') {
        const body = await readBody(req);
        let updated;
        try {
          updated = JSON.parse(body);
        } catch {
          sendJson(res, 400, { error: '잘못된 JSON입니다.' });
          return;
        }
        if (!Array.isArray(updated.segments) || updated.segments.length === 0) {
          sendJson(res, 400, { error: 'segments가 비어 있습니다.' });
          return;
        }
        for (const seg of updated.segments) {
          seg.bbox = clampBbox(seg.bbox);
        }
        fs.writeFileSync(scriptPath, JSON.stringify(updated, null, 2) + '\n');
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && req.url === '/build') {
        if (building) {
          sendJson(res, 409, { error: '이미 실행 중입니다.' });
          return;
        }
        if (!fs.existsSync(paintingPath) || !fs.existsSync(scriptPath) || !fs.existsSync(imagePath)) {
          sendJson(res, 410, { error: '리뷰 파일을 찾을 수 없습니다. 이미 완료되었을 수 있습니다.' });
          return;
        }
        building = true;
        sendJson(res, 202, { ok: true });
        runBuildAndBroadcast(reviewDir, broadcast).finally(() => {
          building = false;
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      console.error('[review-server] 요청 처리 중 오류:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal error');
      }
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/`;
    console.log(`\n[generate-review] 브라우저에서 검토 화면을 여는 중: ${url}`);
    console.log('[generate-review] (자동으로 안 열리면 위 주소를 브라우저에 직접 붙여넣으세요)');
    console.log('[generate-review] 이 터미널 창은 검토가 끝날 때까지 열어두세요. Ctrl+C로 언제든 중단할 수 있습니다.\n');
    execFile('open', [url], (err) => {
      if (err) console.warn('[generate-review] 브라우저 자동 실행 실패 — 위 주소를 직접 열어주세요.');
    });
  });

  return server;
}

// build-from-review.mjs의 runBuildFromReviewDir()를 실행하면서, 그 안에서 나오는
// console.log/warn/error를 가로채 터미널에도 그대로 찍고(원래 동작 유지) 동시에 브라우저의
// 로그 패널로도 실시간 전송합니다. 끝나면(성공/실패 모두) SSE로 최종 결과를 한 번 더
// 보내고, 성공한 경우엔 잠깐 뒤 프로세스를 종료해서 터미널을 돌려줍니다.
async function runBuildAndBroadcast(reviewDir, broadcast) {
  const { runBuildFromReviewDir } = await import('../build-from-review.mjs');

  const original = { log: console.log, warn: console.warn, error: console.error };
  function wrap(level) {
    return (...args) => {
      original[level](...args);
      broadcast({ type: 'log', level, text: args.map(String).join(' ') });
    };
  }
  console.log = wrap('log');
  console.warn = wrap('warn');
  console.error = wrap('error');

  try {
    const { uploadResult } = await runBuildFromReviewDir(reviewDir);
    broadcast({ type: 'done', uploadResult });
    setTimeout(() => process.exit(0), 1500);
  } catch (err) {
    broadcast({ type: 'error', message: err.message });
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}
