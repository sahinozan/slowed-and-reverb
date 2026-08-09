'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { describe, test } = require('node:test');
const { JSDOM } = require('jsdom');

const { root } = require('./helpers/load-script');

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
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

  test('builds a Firefox package with the required manifest conversion', () => {
    const build = spawnSync(process.execPath, ['scripts/build-firefox.js'], {
      cwd: root,
      encoding: 'utf8'
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const chromium = readJson('manifest.json');
    const firefox = readJson('dist/firefox/manifest.json');
    assert.deepEqual(firefox.background, { scripts: ['background.js'] });
    assert.equal('service_worker' in firefox.background, false);
    assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions, {
      required: ['none']
    });
    assert.match(firefox.browser_specific_settings.gecko.id, /^[^@]+@[^@]+$/);
    assert.equal(firefox.version, chromium.version);
    assert.deepEqual(firefox.permissions, chromium.permissions);

    for (const file of ['background.js', 'content.js', 'popup.js', 'popup.html', 'popup.css']) {
      assert.equal(
        fs.readFileSync(path.join(root, file), 'utf8'),
        fs.readFileSync(path.join(root, 'dist', 'firefox', file), 'utf8'),
        `Firefox build changed ${file}`
      );
    }

    const builtAssets = listFiles(path.join(root, 'dist', 'firefox', 'assets'));
    assert.equal(builtAssets.some((file) => file.endsWith('.svg')), false);
    assert.equal(builtAssets.filter((file) => file.endsWith('.png')).length, 6);
  });

  test('contains no prose em dashes in maintained or generated files', () => {
    const ignoredDirectories = new Set(['.git', 'node_modules']);
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
