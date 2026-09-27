/**
 * The last step of every film: compose (or load) the music for the timeline, lay the interface
 * sounds on the cues, normalize to -14 LUFS and encode the picture with the sound.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { composeMusic, composeSfx, loadMusic, mixdown, writeWav, type Cue, type Timeline } from './audio.ts';

export function scoreAndMux(opts: {
  silentPath: string;
  timeline: Timeline;
  cues: Cue[];
  outDir: string;
  tag: string;
  music?: string;
}): string {
  const { silentPath, timeline, cues, outDir, tag } = opts;
  const music = opts.music ? loadMusic(path.resolve(opts.music), timeline.durationMs) : composeMusic(timeline);
  const sfx = composeSfx(cues, timeline.durationMs);
  const mix = mixdown(music, sfx, -27);
  const mixPath = path.join(outDir, `${tag}.mix.wav`);
  writeWav(mixPath, mix);
  const target = 'I=-14:TP=-1.5:LRA=11';
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-i', mixPath, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-']);
  const err = probe.stderr.toString();
  const m = JSON.parse(err.slice(err.lastIndexOf('{'), err.lastIndexOf('}') + 1));
  const norm =
    `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  const finalPath = path.join(outDir, `${tag}.mp4`);
  execFileSync(
    'ffmpeg',
    [
      '-y', '-v', 'error', '-i', silentPath, '-i', mixPath,
      // Limiting at 4× the rate catches the peaks between samples too (AAC brings them back up at
      // 48 kHz), keeping true peak under -1 dBTP, which loudnorm alone does not in linear mode.
      '-map', '0:v', '-map', '1:a', '-af', `${norm},aresample=192000,alimiter=limit=0.7:level=false,aresample=48000`,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-tune', 'animation', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', finalPath
    ],
    { stdio: 'inherit' }
  );
  return finalPath;
}
