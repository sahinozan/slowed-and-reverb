const fs = require('fs');
const path = require('path');

const SOURCE_FILES = ['background.js', 'content.js', 'popup.js', 'popup.html', 'popup.css'];
const DEV_ONLY_ASSETS = /\.(sh|svg)$/;
const GECKO_ID = 'slowed-reverb@example.com';
const GECKO_MIN_VERSION = '142.0';

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist', 'firefox');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const file of SOURCE_FILES) {
  fs.copyFileSync(path.join(root, file), path.join(outDir, file));
}

fs.cpSync(path.join(root, 'assets'), path.join(outDir, 'assets'), {
  recursive: true,
  filter: (src) => !DEV_ONLY_ASSETS.test(src)
});

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

manifest.background = { scripts: ['background.js'] };
manifest.browser_specific_settings = {
  gecko: {
    id: GECKO_ID,
    strict_min_version: GECKO_MIN_VERSION,
    data_collection_permissions: { required: ['none'] }
  }
};

fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built ${outDir}`);
