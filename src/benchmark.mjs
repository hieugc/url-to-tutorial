import { writeFile } from 'node:fs/promises';
import { command } from './render.mjs';

function percentile(sorted, percentile) {
  if (!sorted.length) return 0;
  const rank = (sorted.length - 1) * percentile;
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export function summarizeFrameTimes(times) {
  const frames = times.filter(Number.isFinite);
  if (frames.length < 2) throw new Error('At least two decoded video frame timestamps are required');
  const intervals = frames.slice(1).map((time, i) => (time - frames[i]) * 1000)
    .filter(n => n > 0 && Number.isFinite(n)).sort((a, b) => a - b);
  if (!intervals.length) throw new Error('Frame timestamps are non-increasing or invalid');
  const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const variance = intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length;
  return {
    frameCount: frames.length,
    measuredFps: Number((1000 / mean).toFixed(2)),
    intervalP50Ms: Number(percentile(intervals, 0.5).toFixed(2)),
    intervalP95Ms: Number(percentile(intervals, 0.95).toFixed(2)),
    intervalMaxMs: Number(Math.max(...intervals).toFixed(2)),
    intervalJitterStdDevMs: Number(Math.sqrt(variance).toFixed(2)),
  };
}

export async function inspectVideo(file, commandImpl = command) {
  const meta = JSON.parse(await commandImpl('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ]));
  const video = meta.streams?.find(stream => stream.codec_type === 'video');
  if (!video) throw new Error('No video stream in ' + file);
  const raw = JSON.parse(await commandImpl('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file,
  ]));
  const times = (raw.frames || []).map(frame => Number(frame.best_effort_timestamp_time))
    .filter(Number.isFinite);
  return {
    file, codec: video.codec_name, width: video.width, height: video.height,
    durationSec: Number(meta.format.duration),
    audio: Boolean(meta.streams.some(stream => stream.codec_type === 'audio')),
    ...summarizeFrameTimes(times),
  };
}

export function compareCaptures(baseline, candidate) {
  if (!candidate) return {
    status: 'baseline-only',
    note: 'No Webreel file supplied. Encoded FPS is not proof of native cursor/animation smoothness.',
  };
  return {
    status: 'A/B-files',
    baselineFps: baseline.measuredFps, candidateFps: candidate.measuredFps,
    baselineJitterMs: baseline.intervalJitterStdDevMs,
    candidateJitterMs: candidate.intervalJitterStdDevMs,
    note: 'File-level frame timing only. Compare identical scripts and measure capture-process CPU/RAM on Mac separately.',
  };
}

if (process.argv[1] && process.argv[1].endsWith('/benchmark.mjs')) {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node src/benchmark.mjs <baseline.mp4> [webreel.mp4] [output.json]');
    process.exitCode = 1;
  } else {
    try {
      const baseline = await inspectVideo(input);
      const candidate = process.argv[3] ? await inspectVideo(process.argv[3]) : null;
      const result = { baseline, candidate, comparison: compareCaptures(baseline, candidate) };
      if (process.argv[4]) await writeFile(process.argv[4], JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
