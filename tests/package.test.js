'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { describe, test } = require('node:test');
const AdmZip = require('adm-zip');
const { JSDOM } = require('jsdom');

const { root } = require('./helpers/load-script');
const SOURCE_FILES = ['background.js', 'content.js', 'popup.js', 'popup.html', 'popup.css'];
const PNG_DIMENSIONS = new Map([
  ['assets/icon16.png', 16],
  ['assets/icon16-off.png', 16],
  ['assets/icon48.png', 48],
  ['assets/icon48-off.png', 48],
  ['assets/icon128.png', 128],
  ['assets/icon128-off.png', 128]
]);
const PACKAGE_FILES = [...SOURCE_FILES, 'manifest.json', ...PNG_DIMENSIONS.keys()].sort();

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolute) : [absolute];
  });
}

function manifestPaths(manifest) {
  return [
    manifest.action.default_popup,
    manifest.background.service_worker,
    ...Object.values(manifest.action.default_icon),
    ...Object.values(manifest.icons)
  ];
}

describe('store package contracts', () => {
  test('keeps the Chromium manifest minimal and internally consistent', () => {
    const manifest = readJson('manifest.json');
    const packageJson = readJson('package.json');

    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.version, packageJson.version);
    assert.ok(manifest.description.length <= 132);
    assert.equal(packageJson.engines.node, '>=24.19.0');
    assert.equal(packageJson.packageManager, 'npm@11.19.0');
    assert.equal(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim(), '24.19.0');
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.match(readme, /ESLint 10/);
    assert.match(readme, /Node >= 24\.19/);
    assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
    assert.equal('host_permissions' in manifest, false);
    assert.equal('content_scripts' in manifest, false);
    assert.deepEqual(Object.keys(manifest.commands).sort(), [
      'toggle-effect',
      'toggle-nightcore',
      'toggle-slowed-reverb'
    ]);

    for (const file of manifestPaths(manifest)) {
      assert.equal(fs.existsSync(path.join(root, file)), true, `Missing manifest file: ${file}`);
    }
  });

  test('keeps popup JavaScript element references synchronized with the HTML', () => {
    const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
    const source = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
    const document = new JSDOM(html).window.document;
    const ids = [...source.matchAll(/\bel\('([^']+)'\)/g)].map((match) => match[1]);

    assert.ok(ids.length > 20, 'Expected the popup contract scan to find its controls');
    for (const id of new Set(ids)) {
      assert.ok(document.getElementById(id), `popup.js references missing #${id}`);
    }
  });

  test('uses a real repository URL and valid PNG icon dimensions', () => {
    const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
    const document = new JSDOM(html).window.document;
    assert.equal(
      document.querySelector('.github-link').href,
      'https://github.com/sahinozan/slowed-and-reverb'
    );

    for (const [file, expectedSize] of PNG_DIMENSIONS) {
      const png = fs.readFileSync(path.join(root, file));
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(png.readUInt32BE(16), expectedSize, `${file} width`);
      assert.equal(png.readUInt32BE(20), expectedSize, `${file} height`);
    }
  });

  test('builds allowlisted target directories with the required manifest conversion', () => {
    run(process.execPath, ['scripts/build-extension.js', 'chromium']);
    run(process.execPath, ['scripts/build-extension.js', 'firefox']);

    const chromium = readJson('manifest.json');
    const builtChromium = readJson('dist/chromium/manifest.json');
    const firefox = readJson('dist/firefox/manifest.json');
    assert.deepEqual(builtChromium, chromium);
    assert.deepEqual(firefox.background, { scripts: ['background.js'] });
    assert.equal('service_worker' in firefox.background, false);
    assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions, {
      required: ['none']
    });
    assert.equal(firefox.browser_specific_settings.gecko.id, 'slowed-reverb@sahinozan');
    assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, '140.0');
    assert.equal(firefox.browser_specific_settings.gecko_android.strict_min_version, '142.0');
    assert.equal(firefox.version, chromium.version);
    assert.deepEqual(firefox.permissions, chromium.permissions);

    for (const target of ['chromium', 'firefox']) {
      for (const file of SOURCE_FILES) {
        assert.equal(
          fs.readFileSync(path.join(root, file), 'utf8'),
          fs.readFileSync(path.join(root, 'dist', target, file), 'utf8'),
          `${target} build changed ${file}`
        );
      }

      const builtFiles = listFiles(path.join(root, 'dist', target))
        .map((file) => path.relative(path.join(root, 'dist', target), file))
        .sort();
      assert.deepEqual(builtFiles, PACKAGE_FILES);
    }
  });

  test('creates store ZIPs containing only the allowlisted runtime files', () => {
    run('npm', ['run', 'package']);

    for (const target of ['chromium', 'firefox']) {
      const archive = new AdmZip(path.join(root, 'dist', 'packages', `slowed-reverb-${target}.zip`));
      const entries = archive
        .getEntries()
        .filter((entry) => !entry.isDirectory)
        .map((entry) => entry.entryName)
        .sort();

      assert.deepEqual(entries, PACKAGE_FILES);
      assert.ok(archive.getEntry('manifest.json'));
    }
  });

  test('keeps CI dependencies immutable and automatic updates enabled', () => {
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    assert.doesNotMatch(workflow, /uses:\s+actions\/(?:checkout|setup-node)@v\d/);
    assert.doesNotMatch(workflow, /uses:\s+actions\/upload-artifact@v\d/);
    assert.match(workflow, /persist-credentials:\s+false/);
    assert.match(workflow, /node-version:\s+24\.19\.0/);
    assert.match(workflow, /npm@11\.19\.0/);
    assert.match(workflow, /os:\s+\[ubuntu-latest, windows-latest\]/);
    assert.match(workflow, /npm run test:e2e/);
    assert.equal(fs.existsSync(path.join(root, '.github/dependabot.yml')), true);
  });

  test('contains no prose em dashes in maintained or generated files', () => {
    const ignoredDirectories = new Set([
      '.git',
      'node_modules',
      'playwright-report',
      'test-results'
    ]);
    const emDash = String.fromCodePoint(0x2014);

    function maintainedFiles(directory) {
      return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) return [];
        const absolute = path.join(directory, entry.name);
        return entry.isDirectory() ? maintainedFiles(absolute) : [absolute];
      });
    }

    const offenders = maintainedFiles(root).filter((file) => {
      try {
        return fs.readFileSync(file, 'utf8').includes(emDash);
      } catch {
        return false;
      }
    });

    assert.deepEqual(offenders.map((file) => path.relative(root, file)), []);
  });
});
