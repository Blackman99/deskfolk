// The app's own folk avatar layers, for the 0.5.0 film's Bots: node folk.mjs <out.json>
// A Bot's avatar in 0.5.0 is one of the task map's characters, drawn from WebP layers rendered in Blender
// (packages/protocol/src/folk-avatar-assets.ts, made by scripts/folk-avatar/build.py). The film stacks the same layers
// as the app does (FolkAvatar.tsx) rather than drawing the characters again. The roster scene also shows the folks as
// they were before (the one mustard Pudding with a sprout, antenna, bow or headphones): those layers are read from the
// commit before ab4f18ca ("a Bot's avatar is one of the task map's characters") with a read-only `git show`.
// Writes { now: { edge, geometry, layers }, then: { edge, geometry, layers } }; render.mjs serves it as /work/folk.json.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const ASSETS = 'packages/protocol/src/folk-avatar-assets.ts';
const BEFORE = 'ab4f18ca~1';
const out = process.argv[2];
if (!out) throw new Error('usage: node folk.mjs <out.json>');

/** FOLK_LAYER_EDGE, FOLK_GEOMETRY and FOLK_LAYERS from the generated module's text (plain JSON literals). */
function read(text) {
  const edge = Number(/FOLK_LAYER_EDGE = (\d+)/.exec(text)[1]);
  const geometry = JSON.parse(/FOLK_GEOMETRY = (\{[^}]*\})/.exec(text)[1]);
  const layers = {};
  for (const [, name, data] of text.matchAll(/^\s*"([a-z-]+)": "([A-Za-z0-9+/=]+)",?$/gm)) layers[name] = data;
  if (!Object.keys(layers).length) throw new Error('no folk layers found');
  return { edge, geometry, layers };
}

const now = read(fs.readFileSync(path.join(ROOT, ASSETS), 'utf8'));
const then = read(execFileSync('git', ['-C', ROOT, 'show', `${BEFORE}:${ASSETS}`], { encoding: 'utf8', maxBuffer: 1 << 26 }));
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ now, then }));
console.log(`folk layers: ${Object.keys(now.layers).length} now, ${Object.keys(then.layers).length} before → ${out}`);
