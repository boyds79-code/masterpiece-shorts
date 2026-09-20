import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';

import { buildEditorHtml } from './review-editor.mjs';
import { buildCandidatePickerHtml } from './candidate-picker.mjs';
import { clampBbox, generateVideoScript } from './anthropic.mjs';

// generate-review.mjs가 후보 디테일(candidates.json)을 만든 직후 이 서버를 띄웁니다.
// 정적 파일(file://)로 열면 브라우저가 로컬 디스크에 직접 쓰거나 서버 프로세스를 실행할
// 수 없어서(보안상 당연히 막혀 있음) 버튼들이 실제로 뭔가를 하게 만들려면 이 페이지를
// 서빙하고 같은 프로세스에서 나머지를 실행해줄 아주 작은 로컬 서버가 필요합니다.
// 127.0.0.1에만 붙어서 이 컴퓨터 밖에서는 접근할 수 없습니다.
//
// 이 서버는 같은 리뷰 폴더로 두 화면을 순서대로 서빙합니다 — GET /이 매 요청마다
// script.json이 있는지부터 확인해서 자동으로 어느 단계인지 판단합니다:
//   1) candidates.json만 있고 script.json은 아직 없음 -> "숨은 이야기 고르기" 화면
//      (candidate-picker.mjs). 사람이 후보 디테일 중 몇 개를 고르고 확인하면
//      POST /confirm-candidates가 그 선택으로 최종 대본(나레이션 확정)을 만들어
//      script.json을 씁니다.
//   2) script.json도 있음 -> 기존 확대 위치(bbox)/패닝 검토 화면(review-editor.mjs).
//
// 라우트:
//   GET  /                   위 설명대로 단계에 맞는 화면 (매번 새로 읽어서 렌더링)
//   GET  /original.jpg       원본 그림 이미지
//   GET  /events              진행 로그를 실시간으로 밀어주는 SSE 스트림
//   POST /confirm-candidates  고른 후보 디테일로 최종 대본(나레이션)을 생성 -> script.json 저장
//   POST /save                 수정된 bbox를 script.json에 즉시 저장
//   POST /build                 나레이션 생성 -> 영상 조립 -> YouTube 업로드까지 실행

export function startReviewServer({ reviewDir, imageFile = 'original.jpg' }) {
  const paintingPath = path.join(reviewDir, 'painting.json');
  const candidatesPath = path.join(reviewDir, 'candidates.json');
  const scriptPath = path.join(reviewDir, 'script.json');
  const visionPath = path.join(reviewDir, 'vision.jpg');
  const imagePath = path.join(reviewDir, imageFile);

  const sseClients = new Set();
  let building = false;
  let confirmingCandidates = false;

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
        if (!fs.existsSync(paintingPath)) {
          res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('이 리뷰는 이미 완료되었거나 폴더가 삭제되었습니다. 터미널에서 새로 npm run generate:review를 실행하세요.');
          return;
        }
        const painting = readJson(paintingPath);

        // script.json이 아직 없으면(사람이 후보 디테일을 아직 확정 안 함) "숨은 이야기
        // 고르기" 화면부터 보여줍니다 — 확인을 누르면 POST /confirm-candidates가
        // script.json을 만들고, 그 다음 새로고침부터는 이 분기를 안 타고 바로 아래
        // 확대 위치 검토 화면으로 넘어갑니다.
        if (!fs.existsSync(scriptPath)) {
          if (!fs.existsSync(candidatesPath)) {
            res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('이 리뷰는 이미 완료되었거나 폴더가 삭제되었습니다. 터미널에서 새로 npm run generate:review를 실행하세요.');
            return;
          }
          const candidates = readJson(candidatesPath);
          const html = buildCandidatePickerHtml({ painting, candidates, imageFile });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

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

      if (req.method === 'POST' && req.url === '/confirm-candidates') {
        if (confirmingCandidates) {
          sendJson(res, 409, { error: '이미 생성 중입니다.' });
          return;
        }
        if (fs.existsSync(scriptPath)) {
          sendJson(res, 410, { error: '이미 대본이 만들어졌습니다. 새로고침해주세요.' });
          return;
        }
        if (!fs.existsSync(candidatesPath) || !fs.existsSync(paintingPath) || !fs.existsSync(visionPath)) {
          sendJson(res, 410, { error: '리뷰 파일을 찾을 수 없습니다. 이미 완료되었거나 폴더가 삭제되었을 수 있습니다.' });
          return;
        }

        const body = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          sendJson(res, 400, { error: '잘못된 JSON입니다.' });
          return;
        }
        const selectedIds = Array.isArray(parsed.selectedIds) ? [...new Set(parsed.selectedIds)] : [];
        const candidatesData = readJson(candidatesPath);
        const selectedDetails = candidatesData.candidates.filter((c) => selectedIds.includes(c.id));
        if (selectedDetails.length < 2) {
          sendJson(res, 400, { error: '최소 2개 이상의 디테일을 선택해주세요.' });
          return;
        }

        confirmingCandidates = true;
        sendJson(res, 202, { ok: true });
        runConfirmCandidatesAndBroadcast({ reviewDir, paintingPath, scriptPath, visionPath, selectedDetails, broadcast })
          .finally(() => {
            confirmingCandidates = false;
          });
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
          // bboxTo(패닝/틸트 도착 지점)는 있을 때만 clamp합니다 — 패닝이 꺼진 구간은
          // undefined이므로 그대로 둡니다.
          if (seg.bboxTo) seg.bboxTo = clampBbox(seg.bboxTo);
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

// 사람이 "숨은 이야기 고르기" 화면에서 고른 디테일들로 generateVideoScript()를
// (selectedDetails와 함께) 다시 불러 최종 대본(나레이션 확정)을 만들고 script.json에
// 씁니다. 성공하면 'script-ready' SSE 이벤트를 보내서 브라우저가 새로고침하도록 하고,
// 그 다음부터는 GET /이 script.json을 발견해서 기존 확대 위치 검토 화면을 보여줍니다.
// runBuildAndBroadcast()와 마찬가지로 console.log/warn/error를 가로채 브라우저 로그
// 패널에도 실시간으로 보여줍니다.
async function runConfirmCandidatesAndBroadcast({ reviewDir, paintingPath, scriptPath, visionPath, selectedDetails, broadcast }) {
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
    const painting = JSON.parse(fs.readFileSync(paintingPath, 'utf8'));
    console.log(`[review-server] 선택한 디테일 ${selectedDetails.length}개로 대본을 작성하는 중...`);
    const script = await generateVideoScript({
      painting,
      imageBufferForVision: fs.readFileSync(visionPath),
      imagePath: visionPath,
      imageMediaType: 'image/jpeg',
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.CLAUDE_MODEL,
      selectedDetails,
    });
    fs.writeFileSync(scriptPath, JSON.stringify(script, null, 2) + '\n');
    console.log(`[review-server] 대본 완성 — 세그먼트 ${script.segments.length}개, 제목: "${script.youtube.title}"`);
    broadcast({ type: 'script-ready' });
  } catch (err) {
    original.error('[review-server] 대본 생성 실패:', err);
    broadcast({ type: 'error', message: err.message });
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
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
    // 실패 원인을 브라우저 로그 패널로만 보내고 터미널엔 안 찍었더니, 브라우저 탭을 이미
    // 닫았거나 안 보고 있으면 왜 실패했는지 터미널만 봐서는 전혀 알 수 없었습니다. 반드시
    // 터미널에도 전체 에러(스택 트레이스 포함)를 찍습니다.
    original.error('[review-server] 실행 실패:', err);
    broadcast({ type: 'error', message: err.message });
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}
