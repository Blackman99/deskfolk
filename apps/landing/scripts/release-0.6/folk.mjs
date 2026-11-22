// The app's own folk avatar layers and its icon, for the 0.6.0 film: node folk.mjs <out.json>
// A Bot's avatar is one of the task map's characters, drawn from WebP layers rendered in Blender
// (packages/protocol/src/folk-avatar-assets.ts, made by scripts/folk-avatar/build.py). The film stacks the same layers
// as the app does (FolkAvatar.tsx) rather than drawing the characters again. 0.6.0 shows only the folks as they are
// now, so nothing is read from history (0.5.0's film also read the folks of before with `git show`).
// Writes { now: { edge, geometry, layers }, icon } beside it: `icon` is apps/desktop-nsh/assets/icons/app-icon.svg, the
// art the Windows icon (icon.ico, the tray's and the toast's) is made from. render.mjs serves it as /work/folk.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const ASSETS = 'packages/protocol/src/folk-avatar-assets.ts';
const ICON = 'apps/desktop-nsh/assets/icons/app-icon.svg';
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
const icon = fs.readFileSync(path.join(ROOT, ICON), 'utf8');
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ now, icon }));
console.log(`folk layers: ${Object.keys(now.layers).length}, app icon ${icon.length} bytes → ${out}`);
