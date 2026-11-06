import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareNarration, renderNarrated, subtitleTime, subtitleFiles } from '../src/narration.mjs';

const base = {
  schemaVersion: 1, title: 'Narration demo', url: 'https://example.com', language: 'vi',
  steps: [
    { id: 'one', title: 'Mở đầu', description: 'Giới thiệu tổng quan', target: { css: 'h1' }, holdMs: 500 },
    { id: 'stop', title: 'Dừng', description: 'Kết thúc ở đây', action: 'stop', holdMs: 500 },
  ],
};

test('SRT/VTT timestamps use measured milliseconds', () => {
  assert.equal(subtitleTime(61234), '00:01:01,234');
  assert.equal(subtitleTime(61234, true), '00:01:01.234');
  assert.throws(() => subtitleTime(-1));
  const subs = subtitleFiles([
    { startMs: 1120, endMs: 2670, text: 'Xin chào\ncác bạn' },
  ]);
  assert.match(subs.srt, /1\n00:00:01,120 --> 00:00:02,670\nXin chào các bạn/);
  assert.match(subs.vtt, /^WEBVTT\n\n00:00:01\.120 --> 00:00:02\.670/);
});

test('TTS duration pads holds without truncating, supports VI and EN and silence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'utv005-'));
  let calls = 0;
  const synth = async (text, lang, file) => {
    calls++; assert.equal(lang, 'vi'); assert.ok(text);
    await writeFile(file, 'synthetic wav');
    return 2500;
  };
  const result = await prepareNarration(base, root, synth);
  assert.equal(calls, 2);
  assert.equal(result.plan.steps[0].holdMs, 3350);
  assert.equal(result.clips.size, 2);

  const english = await prepareNarration({
    ...base, language: 'en', steps: [{ ...base.steps[0], description: '' }],
  }, path.join(root, 'en'), async () => { throw new Error('should stay silent'); });
  assert.equal(english.clips.size, 0);
  assert.equal(english.plan.steps[0].holdMs, 500);
  await assert.rejects(prepareNarration(base, path.join(root, 'long'), async () => 31000), /Voiceover too long/);
});

test('Narrated output aligns to runtime popovers and includes AAC/SRT/VTT', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'utv005-mux-'));
  const video = path.join(root, 'tutorial.mp4');
  const synth = async (_, __, file) => {
    await writeFile(file, 'fake wav');
    return 1000;
  };
  let captured;
  const commandImpl = async (name, args) => {
    if (name === 'ffmpeg') {
      captured = args;
      await writeFile(args.at(-1), 'fake muxed video');
      return '';
    }
    if (name === 'ffprobe') {
      return JSON.stringify({ streams: [
        { codec_type: 'video', codec_name: 'h264' },
        { codec_type: 'audio', codec_name: 'aac' },
      ] });
    }
    throw new Error('Unexpected command ' + name);
  };
  const result = await renderNarrated(base, {
    outDir: root, synth, commandImpl,
    renderImpl: async () => {
      await writeFile(video, 'video');
      return {
        status: 'completed', recordingStartedAt: '2026-01-01T00:00:00.000Z',
        steps: [
          { id: 'one', status: 'completed', narrationStartAt: '2026-01-01T00:00:02.000Z' },
          { id: 'stop', status: 'completed', narrationStartAt: '2026-01-01T00:00:05.000Z' },
        ],
        video: { path: video, duration: 9, codec: 'h264', audio: false },
      };
    },
  });
  assert.equal(result.video.audio, true);
  assert.equal(result.video.audioCodec, 'aac');
  assert.equal(result.video.narration.clipCount, 2);
  assert.match(captured.join(' '), /adelay=2000:all=1/);
  assert.match(captured.join(' '), /adelay=5000:all=1/);
  assert.match(await readFile(path.join(root, 'tutorial.srt'), 'utf8'), /00:00:02,000 --> 00:00:03,000/);
  assert.match(await readFile(path.join(root, 'tutorial.vtt'), 'utf8'), /00:00:05\.000 --> 00:00:06\.000/);
  assert.equal(await readFile(video, 'utf8'), 'fake muxed video');
  const saved = JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8'));
  assert.equal(saved.video.audio, true);
});

test('Narration refuses incorrect timing that would cut last voice clip', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'utv005-timing-'));
  await assert.rejects(renderNarrated(base, {
    outDir: root,
    synth: async (_text, _lang, file) => {
      await writeFile(file, 'wav'); return 4000;
    },
    renderImpl: async () => ({
      recordingStartedAt: '2026-01-01T00:00:00.000Z',
      steps: [{ id: 'one', narrationStartAt: '2026-01-01T00:00:01.000Z' }],
      video: { path: path.join(root, 'tutorial.mp4'), duration: 1.5 },
    }),
  }), /cut at the video end/);
});
