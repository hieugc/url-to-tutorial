import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { renderNarrated } from '../src/narration.mjs';
import { command } from '../src/render.mjs';

const html = '<!doctype html><html><meta charset="utf-8">' +
  '<title>TTS fixture</title><body style="font-family:Arial">' +
  '<main><h1 id="intro">Welcome to the sample</h1>' +
  '<p>Simple walkthrough page for speech synchronization.</p></main></body></html>';
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const base = 'http://127.0.0.1:' + server.address().port;
  await mkdir('output/e2e-narration', { recursive: true });
  for (const language of ['vi', 'en']) {
    const plan = {
      schemaVersion: 1, title: 'Narration smoke', url: base, language,
      steps: [
        { id: 'intro', title: 'Hello', target: { css: '#intro' },
          description: language === 'vi' ? 'Chào bạn, đây là hướng dẫn.' : 'Hello, this is a short tutorial.',
          action: 'highlight', holdMs: 500 },
        { id: 'finish', title: 'Done',
          description: language === 'vi' ? 'Đã hoàn thành.' : 'The tutorial is complete.',
          action: 'stop', holdMs: 500 },
      ],
    };
    const root = 'output/e2e-narration/' + language;
    const result = await renderNarrated(plan, { outDir: root });
    assert.equal(result.status, 'completed');
    assert.equal(result.video.codec, 'h264');
    assert.equal(result.video.audioCodec, 'aac');
    assert.equal(result.video.narration.clipCount, 2);
    assert.ok(result.video.duration > 3);
    const probe = JSON.parse(await command('ffprobe', ['-v', 'error', '-show_streams', '-show_format',
      '-of', 'json', root + '/tutorial.mp4']));
    assert.ok(probe.streams.some(s => s.codec_type === 'audio' && s.codec_name === 'aac'));
    const srt = await readFile(root + '/tutorial.srt', 'utf8');
    const vtt = await readFile(root + '/tutorial.vtt', 'utf8');
    assert.match(srt, /00:00:\d\d,\d{3} --> 00:00:\d\d,\d{3}/);
    assert.match(vtt, /^WEBVTT/);
    assert.ok(result.steps.every(step => step.narrationStartAt));
    const captureTime = Date.parse(result.recordingStartedAt);
    for (const step of result.steps) assert.ok(Date.parse(step.narrationStartAt) > captureTime);
    console.log(JSON.stringify({
      language, video: result.video,
      stepTimes: result.steps.map(s => ({ id: s.id, narrationStartAt: s.narrationStartAt })),
    }));
  }
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
