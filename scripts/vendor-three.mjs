// Copies the exact Three.js files this game needs out of node_modules into
// vendor/three so the shipped game has no node_modules dependency at runtime.
import { cpSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const nm = join(root, 'node_modules', 'three');
const out = join(root, 'vendor', 'three');
const addonsOut = join(out, 'addons');

const build = ['three.module.js', 'three.core.js'];
const addons = [
  'postprocessing/EffectComposer.js',
  'postprocessing/RenderPass.js',
  'postprocessing/ShaderPass.js',
  'postprocessing/MaskPass.js',
  'postprocessing/Pass.js',
  'postprocessing/UnrealBloomPass.js',
  'postprocessing/OutputPass.js',
  'shaders/CopyShader.js',
  'shaders/LuminosityHighPassShader.js',
  'shaders/OutputShader.js',
];

mkdirSync(out, { recursive: true });
mkdirSync(addonsOut, { recursive: true });
const missing = [];
for (const f of build) {
  const src = join(nm, 'build', f);
  if (!existsSync(src)) { missing.push(f); continue; }
  cpSync(src, join(out, f));
}
for (const f of addons) {
  const src = join(nm, 'examples', 'jsm', f);
  if (!existsSync(src)) { missing.push(f); continue; }
  const dest = join(addonsOut, f);
  mkdirSync(join(dest, '..'), { recursive: true });
  cpSync(src, dest);
}
if (missing.length) {
  console.error('missing three files:', missing);
  process.exit(1);
}
writeFileSync(join(out, 'README.txt'),
  'Vendored from three@' + JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(join(nm, 'package.json'), 'utf8'))).version +
  '\nRegenerate with: npm run vendor\n');
console.log('vendored three ->', out);
