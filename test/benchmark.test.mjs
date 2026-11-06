import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFrameTimes, inspectVideo, compareCaptures } from '../src/benchmark.mjs';

test('Video frame statistics disclose actual encoded intervals rather than fake 60fps', () => {
  const data = summarizeFrameTimes([0, 0.04, 0.08, 0.12, 0.16]);
  assert.equal(data.frameCount, 5);
  assert.equal(data.measuredFps, 25);
  assert.ok(data.intervalJitterStdDevMs < 0.1);
  const mixed = summarizeFrameTimes([0, .04, .10, .14]);
  assert.ok(mixed.intervalP95Ms > mixed.intervalP50Ms);
  assert.throws(() => summarizeFrameTimes([0]), /At least two/);
});

test('FFprobe benchmark reads actual frame times and reports baseline-only honestly', async () => {
  let calls = 0;
  const mock = async () => {
    calls++;
    if (calls === 1) return JSON.stringify({
      format: { duration: '0.12' },
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }],
    });
    return JSON.stringify({ frames: [0,.04,.08,.12].map(time => ({
      best_effort_timestamp_time: String(time),
    })) });
  };
  const result = await inspectVideo('/fixture.mp4', mock);
  assert.equal(result.measuredFps, 25);
  assert.equal(result.audio, false);
  const comparison = compareCaptures(result, null);
  assert.equal(comparison.status, 'baseline-only');
  assert.match(comparison.note, /not proof/);
});
