import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { command, render } from './render.mjs';
import { Plan } from './plan.mjs';

function milliseconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid audio duration from ffprobe');
  return Math.round(n * 1000);
}

export function subtitleTime(ms, vtt = false) {
  if (!Number.isFinite(ms) || ms < 0) throw new Error('Invalid subtitle timestamp');
  const total = Math.floor(ms);
  const hrs = Math.floor(total / 3600000);
  const mins = Math.floor(total % 3600000 / 60000);
  const secs = Math.floor(total % 60000 / 1000);
  const milli = total % 1000;
  return [hrs, mins, secs].map(n => String(n).padStart(2, '0')).join(':') +
    (vtt ? '.' : ',') + String(milli).padStart(3, '0');
}

export function subtitleFiles(items) {
  let srt = '', vtt = 'WEBVTT\n\n';
  for (const [index, item] of items.entries()) {
    const text = item.text.replace(/[\r\n]+/g, ' ').trim();
    const srtRange = subtitleTime(item.startMs) + ' --> ' + subtitleTime(item.endMs);
    const vttRange = subtitleTime(item.startMs, true) + ' --> ' + subtitleTime(item.endMs, true);
    srt += (index + 1) + '\n' + srtRange + '\n' + text + '\n\n';
    vtt += vttRange + '\n' + text + '\n\n';
  }
  return { srt, vtt };
}

export async function espeakSynth(text, language, destination) {
  if (!['vi', 'en'].includes(language)) throw new Error('Unsupported narration language');
  // No shell; language is allowlisted; text is passed as a distinct CLI argument.
  await command('espeak-ng', ['-v', language, '-s', language === 'vi' ? '135' : '150',
    '-w', destination, '--', text]);
  const output = (await command('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', destination])).trim();
  const durationMs = milliseconds(output);
  if (!durationMs) throw new Error('espeak-ng returned an empty audio clip');
  return durationMs;
}

export async function prepareNarration(planInput, root, synth = espeakSynth) {
  const plan = Plan.parse(planInput);
  const voiceDir = path.join(root, 'voice');
  await mkdir(voiceDir, { recursive: true });
  const clips = new Map();
  const steps = [];
  for (const [index, step] of plan.steps.entries()) {
    const text = (step.description || '').trim().replace(/\s+/g, ' ');
    let holdMs = step.holdMs;
    if (text) {
      const file = path.join(voiceDir, 'step-' + (index + 1) + '.wav');
      const durationMs = await synth(text, plan.language, file);
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new Error('TTS provider returned invalid duration for ' + step.id);
      }
      // Reserve time after voice ends; never silently clip the audio.
      holdMs = Math.max(holdMs, Math.ceil(durationMs / 100) * 100 + 850);
      if (holdMs > 30000) {
        throw new Error('Voiceover too long for step "' + step.id + '". Shorten the description (max hold 30s).');
      }
      clips.set(step.id, { file, text, durationMs });
    }
    steps.push({ ...step, holdMs });
  }
  return { plan: { ...plan, steps }, clips };
}

/**
 * Narrates exactly the runtime path through IF/ELSE. Audio onset is measured
 * when the popover is visible in the same capture, not from a guessed
 * schedule that would drift when navigation/target waits are slow.
 */
export async function renderNarrated(planInput, {
  outDir, headed = false, preview = false,
  synth = espeakSynth, renderImpl = render, commandImpl = command,
} = {}) {
  if (!outDir) throw new Error('outDir is required for narration');
  if (preview) throw new Error('Narrated preview is not supported; render the MP4 or preview without TTS');
  const root = path.resolve(outDir);
  const { plan, clips } = await prepareNarration(planInput, root, synth);
  const report = await renderImpl(plan, { outDir: root, headed, preview: false });
  if (!report.video?.path || !report.recordingStartedAt) {
    throw new Error('Renderer did not provide media path or capture start timestamp');
  }
  const videoMs = milliseconds(report.video.duration);
  const start = Date.parse(report.recordingStartedAt);
  if (!Number.isFinite(start)) throw new Error('Renderer capture timestamp is invalid');
  const entries = [];
  for (const step of report.steps) {
    const clip = clips.get(step.id);
    if (!clip) continue;
    const onset = Date.parse(step.narrationStartAt);
    if (!Number.isFinite(onset)) throw new Error('Missing runtime narration timestamp: ' + step.id);
    const startMs = Math.max(0, onset - start);
    const endMs = startMs + clip.durationMs;
    if (endMs > videoMs + 250) {
      throw new Error('Narration would be cut at the video end for step ' + step.id);
    }
    entries.push({ ...clip, startMs, endMs: Math.min(endMs, videoMs) });
  }
  const subtitles = subtitleFiles(entries);
  await writeFile(path.join(root, 'tutorial.srt'), subtitles.srt);
  await writeFile(path.join(root, 'tutorial.vtt'), subtitles.vtt);

  if (entries.length) {
    const args = ['-y', '-i', report.video.path];
    for (const entry of entries) args.push('-i', entry.file);
    const filters = entries.map((entry, index) => {
      // Delay all channels equally; trim output to measured TTS clip duration.
      return '[' + (index + 1) + ':a]aresample=async=1,adelay=' +
        Math.round(entry.startMs) + ':all=1[a' + index + ']';
    });
    const sources = entries.map((_, index) => '[a' + index + ']').join('');
    filters.push(sources + 'amix=inputs=' + entries.length +
      ':duration=longest:normalize=0,atrim=duration=' + (videoMs / 1000) + '[voice]');
    const temp = path.join(root, 'tutorial-with-audio.tmp.mp4');
    args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[voice]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
      '-t', String(videoMs / 1000), temp);
    await commandImpl('ffmpeg', args);
    const probe = JSON.parse(await commandImpl('ffprobe', [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', temp,
    ]));
    const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
    const picture = probe.streams?.find(stream => stream.codec_type === 'video');
    if (audio?.codec_name !== 'aac' || picture?.codec_name !== 'h264') {
      throw new Error('Narrated video failed AAC/H.264 verification');
    }
    await rename(temp, report.video.path);
    report.video.audio = true;
    report.video.audioCodec = 'aac';
  }
  report.video.narration = { provider: 'espeak-ng', language: plan.language,
    clipCount: entries.length, srt: 'tutorial.srt', vtt: 'tutorial.vtt' };
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}
