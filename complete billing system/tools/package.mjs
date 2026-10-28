// Builds the delivery package for MartBill.
//
//   npm run deliver            -> MartBill-v<version>.zip          (small, installs on first run)
//   npm run deliver:offline    -> MartBill-v<version>-offline.zip  (bundles node_modules, no internet needed)
//
// Options:  --no-build   skip "npm run build" (use the existing dist/)
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const offline = process.argv.includes('--offline');
const skipBuild = process.argv.includes('--no-build');

const ZIP_NAME = `MartBill-v${pkg.version}${offline ? '-offline' : ''}.zip`;
const TOP_FOLDER = 'MartBill';

// never ship these (safety net — the file list below is the real filter)
const SKIP_DIRS = new Set(['node_modules', 'data', '.git']);
const INCLUDE_DIRS = ['server', 'src', 'shared', 'tests', 'dist', 'screenshots', 'tools'];
const INCLUDE_FILES = ['index.html', 'package.json', 'package-lock.json', 'vite.config.js', 'tailwind.config.js', 'postcss.config.js', 'render.yaml', 'DEPLOY.md', 'README.md', '.gitignore', 'start.bat'];

// npm is a .cmd on Windows, so it needs the shell; powershell/tar must NOT have one
// (with shell:true and an args array Windows would pass the arguments unescaped)
function runLine(line, opts = {}) {
  const r = spawnSync(line, { stdio: 'inherit', shell: true, cwd: root, ...opts });
  if (r.status !== 0) {
    console.error(`\nFAILED: ${line} (exit ${r.status})`);
    process.exit(r.status || 1);
  }
}

function runDirect(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
  if (r.status !== 0) {
    console.error(`\nFAILED: ${cmd} ${args[0]} ... (exit ${r.status})`);
    process.exit(r.status || 1);
  }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else if (entry.name.endsWith('.zip')) continue; // previous packages
    else fs.copyFileSync(src, dest);
  }
}

console.log(`\nPackaging ${pkg.name} v${pkg.version} -> ${ZIP_NAME}${offline ? '  (offline variant)' : ''}\n`);

// 1. make sure the interface is built
if (!skipBuild) runLine('npm run build');

// 2. stage a clean copy
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'shopbill-pack-'));
const stage = path.join(staging, TOP_FOLDER);
fs.mkdirSync(stage, { recursive: true });
for (const d of INCLUDE_DIRS) {
  if (fs.existsSync(path.join(root, d))) copyDir(path.join(root, d), path.join(stage, d));
}
for (const f of INCLUDE_FILES) {
  if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(stage, f));
}
console.log(`staged: ${stage}`);

// 3. offline variant: bundle the production dependencies into the package
if (offline) {
  console.log('installing production dependencies into the package...');
  runLine('npm ci --omit=dev', { cwd: stage });
}

// 4. zip it
const out = path.join(root, ZIP_NAME);
runDirect('powershell', [
  '-NoProfile', '-Command',
  `Compress-Archive -Path '${stage}' -DestinationPath '${out}' -Force`
]);

// 5. report
const size = fs.statSync(out).size / (1024 * 1024);
let count = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name));
    else count++;
  }
})(stage);

fs.rmSync(staging, { recursive: true, force: true });

console.log(`\nCreated ${ZIP_NAME}`);
console.log(`  size   : ${size.toFixed(2)} MB`);
console.log(`  files  : ${count}`);
console.log(`  content: server/ src/ tests/ dist/ ${offline ? 'node_modules/ (production only) ' : ''}+ project files`);
console.log(`\nShip this file. On the shop's computer: unzip and double-click start.bat\n`);
