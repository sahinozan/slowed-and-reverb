'use strict';

// Checks that what is made from checks.json, the page docs/checks.md and
// the release checklist's "When it applies" items, is up to date, and what
// it is made of.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, test } = require('node:test');
const { readMap } = require('../scripts/classify-ci-changes');
const { END, PAGE_MADE, START, checklistItems, checksPage, renderAll, withTables } = require('../scripts/render-checks-tables');

const { root } = require('./helpers/load-script');

const source = fs.readFileSync(path.join(root, 'checks.json'), 'utf8');
const map = readMap(source);

// The lines of a Markdown text that are rows of the page's tables: a row
// whose first cell is one of the tables' headings, a check's name, or a
// rule's paths. Markdown reads a table with or without its first bar, and
// moved in by up to three spaces.
function tableCopies(text, checkMap) {
  const firsts = new Set([
    'Check',
    'A change to',
    'any other path',
    ...Object.keys(checkMap.checks).map((name) => `\`${name}\``),
    ...checkMap.rules.map((rule) => rule.paths.map((pattern) => `\`${pattern}\``).join(', '))
  ]);
  return text.split('\n').filter((line) => {
    if (!/^ {0,3}\S/.test(line) || !line.includes('|')) return false;
    const cells = line.trim().replace(/^\|/, '').split('|');
    return cells.length > 1 && firsts.has(cells[0].trim());
  });
}

// The map with one change.
function changed(change) {
  const copy = JSON.parse(source);
  change(copy);
  return readMap(JSON.stringify(copy));
}

describe('what is made from the map of checks', () => {
  test('is up to date in docs/checks.md and RELEASE-CHECKLIST.md', () => {
    const files = renderAll(map);
    assert.deepEqual(files.map(({ file }) => file), ['docs/checks.md', 'RELEASE-CHECKLIST.md']);
    for (const { file, before, after } of files) {
      // Compared as a yes or no: a failed comparison of the texts would
      // print both files whole.
      assert.ok(after === before, `${file} is out of date; run npm run checks:tables`);
    }
  });

  test('a change to the map leaves them out of date', () => {
    const later = renderAll(changed((copy) => copy.rules.find((rule) => rule.paths.includes('extension/popup.css')).needs.push('listen')));
    for (const { file, before, after } of later) assert.ok(after !== before, `${file} didn't follow the map`);
    const renamed = renderAll(changed((copy) => (copy.checks.ui.about = 'The popup.')));
    assert.ok(renamed[0].after !== renamed[0].before);
    // The checklist has only the checks a person does when their condition
    // holds.
    assert.ok(renamed[1].after === renamed[1].before);
  });

  test('the page lists every check, and what each rule is and needs, in the map\'s order', () => {
    const lines = checksPage(map).split('\n');
    assert.deepEqual(lines.slice(0, 4), ['# Which checks a change needs', '', PAGE_MADE, '']);
    const names = Object.keys(map.checks);
    const first = lines.indexOf('| Check | Run by | What to do |');
    assert.notEqual(first, -1);
    assert.deepEqual(
      lines.slice(first + 2, first + 2 + names.length).map((line) => /^\| `([\w-]+)` \| /.exec(line)?.[1]),
      names
    );
    assert.equal(lines[first + 2 + names.length], '');
    const second = lines.indexOf('| A change to | What it is | Needs, besides `repo` |');
    assert.ok(second > first);
    const rows = lines.slice(second + 2);
    assert.equal(rows.length, map.rules.length + 1);
    map.rules.forEach((rule, index) => {
      const [, paths, about, needs] = /^\| (.*?) \| (.*) \| (.*?) \|$/.exec(rows[index]);
      assert.equal(paths, rule.paths.map((pattern) => `\`${pattern}\``).join(', '));
      assert.equal(about, rule.about);
      const more = rule.needs.filter((name) => name !== 'repo');
      assert.equal(needs, more.length ? more.map((name) => `\`${name}\``).join(', ') : 'nothing more');
    });
    assert.equal(rows.at(-1), "| any other path | A path the map doesn't know. | `extension`, `ui`, `site`, and a rule in `checks.json` |");
    assert.match(lines[first + 2], /^\| `repo` \| CI's required check \| `npm run check`\. /);
    assert.ok(lines.some((line) => line.startsWith('| `audio-hosted` | its own workflow (`audio-capture-trial.yml`) | ')));
    assert.ok(lines.some((line) => line.startsWith("| `firefox-frame-look` | by hand, when the popup's frame changed in CSS | ")));
  });

  test('AGENTS.md points at the page and the command, and holds no copy of the tables', () => {
    const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.match(agents, /`npm run checks:for`/);
    assert.match(agents, /`docs\/checks\.md`/);
    assert.ok(!agents.includes(START) && !agents.includes(END) && !agents.includes(PAGE_MADE));
    assert.deepEqual(tableCopies(agents, map), []);

    // The page's tables put back into it are found: as they are, without
    // their first bar, and moved in by the spaces Markdown still reads as a
    // table.
    const page = checksPage(map).split('\n');
    const rows = page.filter((line) => line.startsWith('|') && !line.startsWith('| ---'));
    assert.equal(tableCopies(`${agents}\n${page.join('\n')}\n`, map).length, rows.length);
    assert.equal(tableCopies(`${agents}\n${page.map((line) => ` ${line}`).join('\n')}\n`, map).length, rows.length);
    assert.equal(tableCopies(`${agents}\n${page.map((line) => `   ${line.replace(/^\| /, '')}`).join('\n')}\n`, map).length, rows.length);
    // One row is enough, and four spaces make it code, not a table.
    assert.deepEqual(tableCopies('| `listen` | by hand | Listen. |\n', map), ['| `listen` | by hand | Listen. |']);
    assert.deepEqual(tableCopies('`extension/popup.css` | `extension`\n', map), ['`extension/popup.css` | `extension`']);
    assert.deepEqual(tableCopies('    | `listen` | by hand | Listen. |\n', map), []);
    // Its other tables and its prose aren't taken for copies.
    assert.deepEqual(tableCopies('| Files | Source | Command |\n| `dist/` | `extension/` | `npm run package` |\nThe `listen` check.\n', map), []);
  });

  test('the release checklist has an item for each check done by hand when its condition holds', () => {
    const items = checklistItems(map).split('\n');
    const conditional = Object.entries(map.checks).filter(([, check]) => check.by === 'hand' && check.when);
    assert.deepEqual(conditional.map(([name]) => name), ['listen', 'firefox-frame-look', 'permission-steps', 'store-art-look']);
    assert.equal(items.length, conditional.length);
    assert.match(items[0], /^- \[ \] \*\*A change can affect how the effect sounds\*\* \(the audio graph's wiring, /);
    assert.match(items[0], /\(the limiter stage\)\. It can happen in a change to `extension\/spotify-main\.js`, /);
    assert.equal(
      items[1],
      "- [ ] **The popup's frame changed in CSS**. Look at the real popup in Firefox, with its rounded panel corners. It can happen in a change to `extension/popup.css`."
    );
    assert.match(items[2], /^- \[ \] \*\*The permission code changed\*\* \(the manifest's permissions, .*`extension\/manifest\.json`/);
    assert.match(items[3], /^- \[ \] \*\*There is new store art\*\*\. .* It can happen in a change to `store-assets\/\*\*`\.$/);
  });

  test('writes only between the two marker lines, which have to be there once each', () => {
    const text = `Before.\n\n${START}\nold\nold\n${END}\n\nAfter.\n`;
    assert.equal(withTables(text, 'new'), `Before.\n\n${START}\nnew\n${END}\n\nAfter.\n`);
    assert.equal(withTables(withTables(text, 'new'), 'new'), withTables(text, 'new'));
    // A file that doesn't end with a line break keeps that.
    assert.equal(withTables(`${START}\nold\n${END}`, 'new'), `${START}\nnew\n${END}`);
    for (const broken of [
      'No markers.\n',
      `${START}\nold\n`,
      `old\n${END}\n`,
      `${END}\nold\n${START}\n`,
      `${START}\nold\n${END}\n${START}\nold\n${END}\n`,
      // A marker that isn't a line by itself, or with another kind of line end.
      `See ${START}\nold\n${END}\n`,
      `${START}\nold\n${END} and more\n`,
      `${START}\r\nold\r\n${END}\r\n`
    ]) {
      assert.throws(() => withTables(broken, 'new'), /expected the two marker lines, once each and in order/, broken);
    }
  });

  test('keeps any text the map may hold on one line of a table or a list', () => {
    const odd = changed((copy) => {
      copy.checks.listen.when = 'the sound(effect) changed\n  or a | bar';
      copy.checks.listen.steps = 'Listen.\nThen listen again.';
      copy.checks.ui.about = 'The popup,\nand a | bar.';
    });
    const tables = checksPage(odd).split('\n');
    assert.equal(tables.length, checksPage(map).split('\n').length);
    assert.ok(tables.includes('| `ui` | CI\'s required check | `npm run test:ui`. The popup, and a \\| bar. |'));
    assert.ok(tables.some((line) => line.startsWith('| `listen` | by hand, when the sound(effect) changed or a \\| bar | ')));
    const items = checklistItems(odd).split('\n');
    assert.equal(items.length, checklistItems(map).split('\n').length);
    assert.match(items[0], /^- \[ \] \*\*The sound\(effect\) changed or a \| bar\*\*\. Listen\. Then listen again\. It can happen in a change to /);
  });

  // Run with --check, which writes nothing: a test shouldn't put the files
  // right while another is failing because they are out of date.
  test('the command can say whether the files are up to date without writing them', () => {
    const script = path.join(root, 'scripts', 'render-checks-tables.js');
    const before = renderAll(map).map(({ before }) => before);
    const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, 'docs/checks.md: already up to date\nRELEASE-CHECKLIST.md: already up to date\n');
    assert.ok(renderAll(map).every(({ before: now }, index) => now === before[index]));
    const unexpected = spawnSync(process.execPath, [script, '--force'], { encoding: 'utf8' });
    assert.equal(unexpected.status, 2);
    assert.equal(unexpected.stdout, '');
    const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(scripts['checks:tables'], 'node scripts/render-checks-tables.js');
  });
});
