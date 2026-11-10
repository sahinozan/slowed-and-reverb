'use strict';

// Checks the hooks for coding agents (scripts/agent-hooks/): that their
// list of generated files is the table in AGENTS.md, that an edit to a
// generated file is refused with the source and the command named and no
// other edit is, that the generators run after an edit to a source in the
// checkout the file is in, and that the settings of Claude Code and Codex
// run these scripts and nothing else.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { after, describe, test } = require('node:test');
const { GENERATED, matches, matchesAny } = require('../scripts/agent-hooks/generated-files');
const { refusal } = require('../scripts/agent-hooks/refuse-generated-edit');
const { regenerate } = require('../scripts/agent-hooks/regenerate');
const { stampFor } = require('../scripts/stamp-site-assets');

const { root } = require('./helpers/load-script');

const HOOKS = 'scripts/agent-hooks';
const REFUSE = `${HOOKS}/refuse-generated-edit.js`;
const REGENERATE = `${HOOKS}/regenerate.js`;

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const read = (file, from = root) => fs.readFileSync(path.join(from, file), 'utf8');
const plain = (cell) => cell.replaceAll('`', '');

// Temporary folders, removed at the end.
const scratch = [];
function folder() {
  // Resolved, because macOS's temporary folder is reached through a link.
  const made = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hooks-')));
  scratch.push(made);
  return made;
}
after(() => {
  for (const made of scratch) fs.rmSync(made, { recursive: true, force: true });
});

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A hook run as the agents run it: the edit on standard input.
function run(script, input, from = root) {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [path.join(from, script)], { input: text, encoding: 'utf8' });
}

const edit = (file, old = 'a', now = 'b', from = root) => ({
  tool_name: 'Edit',
  tool_input: { file_path: path.join(from, file), old_string: old, new_string: now }
});
const writeWhole = (file, content, from = root) => ({ tool_name: 'Write', tool_input: { file_path: path.join(from, file), content } });
// A Codex patch that names these files, each with what is done to it.
const patch = (files, from = root) => ({
  tool_name: 'apply_patch',
  cwd: from,
  tool_input: { command: ['*** Begin Patch', ...files.map((file) => `*** ${file}\n@@\n-a\n+b`), '*** End Patch'].join('\n') }
});

// The rows of the "Generated files" table in AGENTS.md, each as its cells.
function tableRows() {
  const lines = read('AGENTS.md').split('\n');
  const head = lines.indexOf('| Files | Source | Command |');
  assert.ok(head > lines.indexOf('## Generated files') && lines.indexOf('## Generated files') !== -1, 'AGENTS.md has no "Generated files" table');
  const rows = [];
  for (let at = head + 2; lines[at]?.startsWith('|'); at += 1) rows.push(lines[at].replace(/^\| | \|$/g, '').split(' | '));
  return rows;
}

// The paths a cell names, as patterns: a folder stands for all in it.
const pathsIn = (cell) => [...cell.matchAll(/`([^`]+)`/g)]
  .map((match) => match[1])
  .filter((text) => /^[\w.*/-]+$/.test(text) && /[/.]/.test(text))
  .map((text) => (text.endsWith('/') ? `${text}**` : text));

const refusedWhole = (file) => GENERATED.some((entry) => matchesAny(entry.whole, file) && !matchesAny(entry.except, file));
const known = (file) => refusedWhole(file) || GENERATED.some((entry) =>
  (entry.between ?? []).some((part) => part.file === file) || matchesAny(entry.regenerate?.writes, file));

describe("the hooks' list of generated files", () => {
  test('is the table in AGENTS.md, row for row', () => {
    const rows = tableRows();
    assert.equal(rows.length, 6);
    assert.deepEqual(GENERATED.map(({ files, source, command }) => [files, source, command]), rows);
  });

  test('knows every file the table names, and refuses no other', () => {
    const named = GENERATED.flatMap((entry) => pathsIn(entry.files));
    assert.ok(named.includes('dist/**') && named.includes('site/*.html') && named.includes('RELEASE-CHECKLIST.md'), named.join(' '));
    for (const pattern of named.filter((pattern) => pattern !== 'dist/**')) {
      const files = tracked.filter((file) => matches(pattern, file));
      assert.ok(files.length > 0, `the table's ${pattern} names no tracked file`);
      for (const file of files) assert.ok(known(file), `the table names ${file}, but the hooks don't know it`);
    }
    for (const file of tracked.filter(refusedWhole)) {
      assert.ok(matchesAny(named, file), `the hooks refuse an edit to ${file}, which the table doesn't name`);
    }
    // dist/ isn't tracked.
    assert.ok(refusedWhole('dist/chromium/popup.js') && refusedWhole('dist/packages/slowed-reverb-firefox.zip'));
    assert.ok(!refusedWhole('dist/packages/1.3.0/RELEASE-1.3.0.txt'), "a release's draft notes are filled in by hand");
  });

  test('has no pattern, marker or script that is gone', () => {
    const { scripts } = JSON.parse(read('package.json'));
    for (const entry of GENERATED) {
      const patterns = [...(entry.whole ?? []), ...(entry.regenerate?.after ?? []), ...(entry.regenerate?.writes ?? [])];
      for (const pattern of patterns.filter((pattern) => pattern !== 'dist/**')) {
        assert.ok(tracked.some((file) => matches(pattern, file)), `${pattern} matches no tracked file`);
      }
      for (const part of entry.between ?? []) {
        const pieces = read(part.file).split(part.start);
        assert.ok(pieces.length === 2 && pieces[1].split(part.end).length === 2, `${part.file} doesn't have the two markers once each, in order`);
      }
      // The command is one of the package's scripts, and the script the
      // hook runs in its place is what that command runs.
      const commands = [...entry.command.matchAll(/`npm run ([\w:-]+)`/g)].map((match) => match[1]);
      assert.ok(commands.length > 0, entry.command);
      for (const name of commands) assert.ok(scripts[name], `npm run ${name} is not one of package.json's scripts`);
      if (entry.regenerate) {
        assert.ok(tracked.includes(entry.regenerate.script), entry.regenerate.script);
        assert.deepEqual(commands.map((name) => scripts[name]), [`node ${entry.regenerate.script}`]);
        // It runs after an edit to each source the table names.
        for (const source of pathsIn(entry.source)) assert.ok(entry.regenerate.after.includes(source), `${entry.command} doesn't run after an edit to ${source}`);
      }
    }
    assert.deepEqual(GENERATED.filter((entry) => entry.regenerate).map((entry) => entry.command), ['`npm run site:popup`', '`npm run site:stamp`', '`npm run checks:tables`']);
  });
});

describe('an edit to a generated file', () => {
  const generated = [
    ['dist/chromium/popup.js', 0],
    ['dist/packages/slowed-reverb-chromium.zip', 0],
    ['site/popup/popup.html', 1],
    ['site/popup/popup.css', 1],
    ['site/popup/popup.js', 1],
    ['site/popup/settings.js', 1],
    ['docs/checks.md', 3],
    ['extension/assets/icon.svg', 4],
    ['extension/assets/icon48-off.png', 4],
    ['store-assets/chrome/store-icon-128.png', 4],
    ['store-assets/screenshots/01-youtube.png', 5],
    ['store-assets/firefox/screenshots/05-privacy.png', 5],
    ['store-assets/chrome/promotional-tile-440x280.png', 5],
    ['store-assets/chrome/marquee-1400x560.png', 5],
    ['site/assets/og-card.png', 5]
  ];

  test('is refused, with the source to change and the command to run', () => {
    for (const [file, row] of generated) {
      for (const input of [edit(file), writeWhole(file, 'new'), patch([`Update File: ${file}`])]) {
        const why = refusal(input);
        assert.ok(why?.startsWith(`${file} is generated`), `${input.tool_name} of ${file}: ${why}`);
        assert.ok(why.includes(`Change the source (${plain(GENERATED[row].source)}), then run ${plain(GENERATED[row].command)}.`), why);
        assert.ok(why.includes('"Generated files" in AGENTS.md'), why);
      }
    }
  });

  test('is refused as the agents read it: the reason on standard error, and status 2', () => {
    for (const input of [edit('docs/checks.md'), writeWhole('site/popup/popup.js', 'new'), patch(['Update File: dist/chromium/popup.js'])]) {
      const { status, stderr, stdout } = run(REFUSE, input);
      assert.equal(status, 2, stderr);
      assert.equal(stdout, '');
      assert.equal(stderr, `${refusal(input)}\n`);
    }
    for (const input of [edit('extension/popup.js'), writeWhole('site/index.html', 'new'), patch(['Update File: checks.json'])]) {
      const { status, stderr, stdout } = run(REFUSE, input);
      assert.equal(status, 0, stderr);
      assert.equal(stdout + stderr, '');
    }
  });

  test('is refused however a Codex patch names the file', () => {
    const refused = [
      patch(['Add File: dist/firefox/new.js']),
      patch(['Delete File: docs/checks.md']),
      patch(['Update File: extension/popup.js', 'Update File: site/popup/popup.js']),
      patch(['Update File: extension/popup.js\n*** Move to: site/popup/popup.js']),
      patch([`Update File: ${path.join(root, 'docs/checks.md')}`], os.tmpdir()),
      // The patch as a command's words.
      { tool_name: 'apply_patch', cwd: root, tool_input: { command: ['apply_patch', '*** Begin Patch\n*** Update File: docs/checks.md\n@@\n-a\n+b\n*** End Patch'] } },
      // From a folder inside the checkout.
      { ...patch(['Update File: popup/popup.css']), cwd: path.join(root, 'site') }
    ];
    for (const input of refused) assert.ok(refusal(input)?.includes(' is generated'), JSON.stringify(input.tool_input));
  });

  test('is not refused for any other file', () => {
    const others = [
      'AGENTS.md',
      'README.md',
      'checks.json',
      'extension/assets/logo.svg',
      'extension/popup.css',
      'extension/popup.js',
      'extension/settings.js',
      'scripts/render-icons.js',
      'site/index.html',
      'site/popup/popup-host.js',
      'site/styles.css',
      'store-assets/LISTING.md',
      'store-assets/README.md',
      'store-assets/chrome/notes.txt',
      'store-assets/originals/2026-01-01/capture.png',
      // A release's draft notes, filled in by hand.
      'dist/packages/1.3.0/RELEASE-1.3.0.txt'
    ];
    for (const file of others) {
      for (const input of [edit(file), writeWhole(file, 'new'), patch([`Update File: ${file}`, 'Add File: extension/new.js'])]) {
        assert.equal(refusal(input), null, `${input.tool_name} of ${file}`);
      }
    }
  });

  test('is not refused outside this repository', () => {
    // A folder that is no checkout, and another repository with the same
    // files.
    const loose = folder();
    const other = folder();
    fs.mkdirSync(path.join(other, '.git'));
    for (const from of [loose, other]) {
      for (const file of ['docs/checks.md', 'site/popup/popup.js', 'dist/chromium/popup.js']) {
        assert.equal(refusal(edit(file, 'a', 'b', from)), null, path.join(from, file));
        assert.equal(refusal(patch([`Update File: ${file}`], from)), null, path.join(from, file));
      }
    }
  });

  test('lets the edit go on when the hook itself can\'t tell', () => {
    for (const input of ['', 'not JSON', '{']) assert.equal(run(REFUSE, input).status, 1, input);
    for (const input of [{}, { tool_name: 'Edit' }, { tool_name: 'Edit', tool_input: {} }, { tool_name: 'apply_patch', tool_input: { command: 'no files' } }]) {
      assert.equal(refusal(input), null, JSON.stringify(input));
    }
    assert.equal(run(REFUSE, {}).status, 0);
  });
});

describe('an edit to a part that is generated', () => {
  const checklist = read('RELEASE-CHECKLIST.md');
  const popup = read('extension/popup.html');
  const [list] = GENERATED[3].between;
  const [logo] = GENERATED[4].between;
  // A line inside each part, and one outside it.
  const lineWith = (text, piece) => text.split('\n').find((line) => line.includes(piece));
  const item = lineWith(checklist, '- [ ] **There is new store art**.');
  const mark = lineWith(popup, '<svg width="128" height="128" viewBox="0 0 128 128"');
  const title = lineWith(popup, '<title>');
  const part = checklist.slice(checklist.indexOf(list.start), checklist.indexOf(list.end) + list.end.length);
  const refusedList = 'The items under "When it applies" in RELEASE-CHECKLIST.md are generated, so an edit by hand would be lost or fail the tests. Leave them and the two marker lines as they are.';
  const refusedLogo = "The popup's header mark in extension/popup.html is generated, so an edit by hand would be lost or fail the tests. Leave it and the two marker lines as they are.";

  test('the test\'s texts are where it takes them to be', () => {
    const inside = (text, between, piece) => text.indexOf(between.start) < text.indexOf(piece) && text.indexOf(piece) < text.indexOf(between.end);
    assert.ok(inside(checklist, list, item) && checklist.split(item).length === 2);
    assert.ok(inside(popup, logo, mark) && popup.split(mark).length === 2);
    assert.ok(checklist.split('\n').includes('# Release checklist') && part.startsWith(list.start) && part.endsWith(list.end));
    assert.ok(title && !inside(popup, logo, title));
  });

  test('is refused when it changes what is between the markers', () => {
    const cases = [
      [edit('RELEASE-CHECKLIST.md', item, '- [ ] **New art**.'), refusedList, 3],
      [writeWhole('RELEASE-CHECKLIST.md', checklist.replace(item, '- [ ] **New art**.')), refusedList, 3],
      [{ tool_name: 'Edit', tool_input: { ...edit('RELEASE-CHECKLIST.md', '**', '__').tool_input, replace_all: true } }, refusedList, 3],
      [edit('extension/popup.html', mark, mark.replaceAll('128', '64')), refusedLogo, 4],
      [writeWhole('extension/popup.html', popup.replace(mark, '<svg>')), refusedLogo, 4]
    ];
    for (const [input, start, row] of cases) {
      const why = refusal(input);
      assert.ok(why?.startsWith(start), `${JSON.stringify(input.tool_input).slice(0, 160)}: ${why}`);
      assert.ok(why.includes(`Change the source (${plain(GENERATED[row].source)}), then run ${plain(GENERATED[row].command)}.`), why);
    }
    assert.equal(run(REFUSE, cases[0][0]).status, 2);
  });

  test('is refused when it takes the part or a marker away', () => {
    const cases = [
      writeWhole('RELEASE-CHECKLIST.md', checklist.replace(part, '')),
      writeWhole('RELEASE-CHECKLIST.md', '# Release checklist\n'),
      // The mark changed and its start marker gone.
      writeWhole('extension/popup.html', popup.replace(`${logo.start}\n`, '').replace(mark, '<svg>')),
      edit('extension/popup.html', logo.end, ''),
      // A second start marker, so the generator couldn't tell which.
      edit('RELEASE-CHECKLIST.md', '# Release checklist', `# Release checklist\n\n${list.start}`)
    ];
    for (const input of cases) assert.ok(refusal(input)?.includes(' generated, so an edit by hand'), JSON.stringify(input.tool_input).slice(0, 160));
  });

  test('is not refused when it leaves that as it is', () => {
    const allowed = [
      edit('RELEASE-CHECKLIST.md', '# Release checklist', '# The release checklist'),
      writeWhole('RELEASE-CHECKLIST.md', checklist.replace('# Release checklist', '# The release checklist')),
      edit('extension/popup.html', '<title>', '<title lang="en">'),
      writeWhole('extension/popup.html', popup.replace('<title>', '<title lang="en">')),
      // An edit that finds nothing changes nothing.
      edit('RELEASE-CHECKLIST.md', 'a text the checklist does not have', 'another'),
      // A marker quoted in a sentence isn't the marker: that is a line of
      // its own.
      edit('RELEASE-CHECKLIST.md', '# Release checklist', `# Release checklist\n\nThe line "${list.start}" starts the part made from the map.`),
      writeWhole('extension/popup.html', popup.replace(title, `${title}\n  <!-- The mark is between ${logo.start} and ${logo.end}. -->`)),
      // The part moved within the file in one edit.
      writeWhole('RELEASE-CHECKLIST.md', `${part}\n${checklist.replace(part, '')}`)
    ];
    for (const input of allowed) assert.equal(refusal(input), null, JSON.stringify(input.tool_input).slice(0, 160));
  });

  test('is not judged for a Codex patch, which doesn\'t say what the file will hold', () => {
    // Judging one takes a copy of how Codex applies patches, and each copy
    // tried refused patches that did no harm: these among them. After a
    // patch the checklist's items are made again (see below), and
    // tests/package.test.js checks the popup's mark.
    const hunk = (file, ...lines) => ({ tool_name: 'apply_patch', cwd: root, tool_input: { command: ['*** Begin Patch', `*** Update File: ${file}`, ...lines, '*** End Patch', ''].join('\n') } });
    const patches = [
      hunk('RELEASE-CHECKLIST.md', '@@', '-# Release checklist', '+# The release checklist'),
      // Next to the part, with a marker as a line kept, spelled without
      // the spaces it starts with.
      hunk('extension/popup.html', '@@', ` ${logo.end}`, '+          <!-- after the mark -->'),
      hunk('RELEASE-CHECKLIST.md', '@@', ` ${list.end}`, ' ', '-## After publishing', '+## After the stores publish', '*** End of File'),
      // The file moved away and back, and updated twice.
      { tool_name: 'apply_patch', cwd: root, tool_input: { command: '*** Begin Patch\n*** Update File: RELEASE-CHECKLIST.md\n*** Move to: temporary.md\n@@\n-# Release checklist\n+# The release checklist\n*** Update File: temporary.md\n*** Move to: RELEASE-CHECKLIST.md\n@@\n-## After publishing\n+## After the stores publish\n*** End Patch' } },
      { tool_name: 'apply_patch', cwd: root, tool_input: { command: `*** Begin Patch\n*** Update File: RELEASE-CHECKLIST.md\n@@\n-${item}\n+changed\n*** Update File: RELEASE-CHECKLIST.md\n@@\n-changed\n+${item}\n*** End Patch` } },
      // Every line taken out and put back, the part as it was.
      hunk('RELEASE-CHECKLIST.md', '@@', ...checklist.split('\n').map((line) => `-${line}`), ...checklist.replace('# Release checklist', '# The release checklist').split('\n').map((line) => `+${line}`)),
      // And patches that do change the part.
      hunk('RELEASE-CHECKLIST.md', '@@', `-${item}`, '+- [ ] **New art**.'),
      hunk('extension/popup.html', '@@', `-${mark}`, `+${mark.replaceAll('128', '64')}`),
      { tool_name: 'apply_patch', cwd: root, tool_input: { command: '*** Begin Patch\n*** Delete File: RELEASE-CHECKLIST.md\n*** End Patch' } }
    ];
    for (const input of patches) assert.equal(refusal(input), null, input.tool_input.command.slice(0, 160));
    assert.equal(run(REFUSE, patches[6]).status, 0);
  });
});

// A made-up repository with a main checkout, a worktree next to it and one
// inside it (as .claude/worktrees/ holds them), laid out as git does.
function repository() {
  const base = folder();
  const main = path.join(base, 'main');
  fs.mkdirSync(path.join(main, '.git'), { recursive: true });
  const worktree = (checkout, name) => {
    write(path.join(main, '.git', 'worktrees', name, 'commondir'), '../..\n');
    write(path.join(checkout, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', name)}\n`);
    return checkout;
  };
  return {
    main,
    beside: worktree(path.join(base, 'beside'), 'beside'),
    inside: worktree(path.join(main, '.claude', 'worktrees', 'inside'), 'inside')
  };
}

describe('a generated file reached by another name', () => {
  test('is refused through a link to its folder', () => {
    const links = folder();
    fs.symlinkSync(path.join(root, 'docs'), path.join(links, 'pages'));
    fs.symlinkSync(root, path.join(links, 'checkout'));
    for (const file of [path.join(links, 'pages', 'checks.md'), path.join(links, 'checkout', 'site', 'popup', 'popup.js'), path.join(links, 'checkout', 'dist', 'chromium', 'popup.js')]) {
      for (const input of [edit(file, 'a', 'b', ''), writeWhole(file, 'new', ''), patch([`Update File: ${file}`], links)]) {
        assert.ok(refusal(input)?.includes(' is generated'), `${input.tool_name} of ${file}`);
      }
    }
    assert.ok(refusal(patch(['Update File: pages/checks.md'], links))?.startsWith('docs/checks.md is generated'));
    // Deleting a link takes the link away, not the file it leads to.
    fs.symlinkSync(path.join(root, 'docs', 'checks.md'), path.join(links, 'page.md'));
    assert.equal(refusal(patch(['Delete File: page.md'], links)), null);
    assert.equal(refusal(patch(['Delete File: checkout'], links)), null);
    assert.ok(refusal(patch(['Update File: page.md'], links))?.startsWith('docs/checks.md is generated'));
    assert.ok(refusal(patch(['Delete File: pages/checks.md'], links))?.startsWith('docs/checks.md is generated'));
    assert.equal(refusal(edit(path.join(links, 'checkout', 'extension', 'popup.js'), 'a', 'b', '')), null);
    assert.equal(refusal(edit(path.join(links, 'pages', 'notes.md'), 'a', 'b', '')), null);
  });

  test('is refused in other letter case, where the file system takes the two for one file', () => {
    const one = fs.existsSync(path.join(root, 'DOCS', 'CHECKS.MD'));
    for (const file of ['DOCS/CHECKS.MD', 'Site/Popup/Popup.JS', 'release-checklist.MD']) {
      const input = file.startsWith('release') ? writeWhole(file, '# Release checklist\n') : edit(file);
      assert.equal(refusal(input) !== null, one, file);
    }
  });
});

describe('the checkout a file is in', () => {
  test('is found from the file, whichever checkout the hook runs from', () => {
    const { main, beside, inside } = repository();
    for (const home of [main, beside, inside]) {
      for (const checkout of [main, beside, inside]) {
        const why = refusal(edit('site/popup/popup.js', 'a', 'b', checkout), home);
        assert.ok(why?.startsWith('site/popup/popup.js is generated'), `${checkout} from ${home}: ${why}`);
        assert.equal(refusal(edit('extension/popup.js', 'a', 'b', checkout), home), null);
        assert.ok(refusal(patch(['Update File: docs/checks.md'], checkout), home)?.startsWith('docs/checks.md is generated'));
      }
    }
    // A worktree's folder isn't a path in the checkout around it.
    assert.equal(refusal(edit('.claude/worktrees/inside/extension/popup.js', 'a', 'b', main), main), null);
  });

  test('is not this repository\'s when it belongs to another', () => {
    const { main } = repository();
    const other = repository();
    const loose = folder();
    for (const checkout of [other.main, other.beside, other.inside, loose]) {
      assert.equal(refusal(edit('site/popup/popup.js', 'a', 'b', checkout), main), null, checkout);
    }
    // A checkout whose git folder is somewhere else (git init
    // --separate-git-dir) is a repository of its own.
    const apart = path.join(loose, 'apart');
    fs.mkdirSync(path.join(loose, 'apart.git'));
    write(path.join(apart, '.git'), `gitdir: ${path.join(loose, 'apart.git')}\n`);
    assert.ok(refusal(edit('site/popup/popup.js', 'a', 'b', apart), apart)?.startsWith('site/popup/popup.js is generated'));
    assert.equal(refusal(edit('site/popup/popup.js', 'a', 'b', apart), main), null);
    assert.equal(refusal(edit('site/popup/popup.js', 'a', 'b', main), apart), null);
    // A .git file that names no repository, as a broken worktree has.
    write(path.join(loose, 'broken', '.git'), 'gitdir: /nowhere/at/all\n');
    assert.equal(refusal(edit('site/popup/popup.js', 'a', 'b', path.join(loose, 'broken')), main), null);
    assert.equal(refusal(edit('site/popup/popup.js', 'a', 'b', main), path.join(loose, 'broken')), null);
  });
});

// A checkout with what the three quick generators read and write, and the
// hooks themselves, so that its hooks take it for their own repository.
const SOURCES = [
  'checks.json',
  'docs/checks.md',
  'RELEASE-CHECKLIST.md',
  'scripts/classify-ci-changes.js',
  ...GENERATED.flatMap((entry) => (entry.regenerate ? [entry.regenerate.script] : [])),
  ...tracked.filter((file) => /^(scripts\/agent-hooks\/|extension\/(popup\.|settings\.js$)|site\/popup\/|site\/[^/]+\.(html|js|css)$)/.test(file))
];
function copyInto(checkout) {
  for (const file of SOURCES) {
    fs.mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(checkout, file));
  }
  return checkout;
}

// What the hook tells the agent after this edit, with a checkout as the
// hooks' own: null when it says nothing.
const tells = (input, home) => {
  const lines = regenerate(input, home);
  return lines.length > 0 ? lines.join('\n') : null;
};

// The same from the hook run as the agents run it.
function told(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  if (result.stdout === '') return null;
  const { hookSpecificOutput, ...rest } = JSON.parse(result.stdout);
  assert.deepEqual(rest, {});
  assert.deepEqual(Object.keys(hookSpecificOutput), ['hookEventName', 'additionalContext']);
  assert.equal(hookSpecificOutput.hookEventName, 'PostToolUse');
  return hookSpecificOutput.additionalContext;
}

describe('after an edit to a source of generated files', () => {
  const { main, beside } = repository();
  copyInto(main);
  copyInto(beside);
  const append = (checkout, file, text) => fs.appendFileSync(path.join(checkout, file), text);
  const same = (checkout, first, second) => read(first, checkout) === read(second, checkout);

  test('the copy holds the files the generators need', () => {
    assert.ok(SOURCES.includes('scripts/sync-site-popup.js') && SOURCES.includes('site/index.html') && SOURCES.includes('extension/popup.html'));
    assert.equal(told(run(REGENERATE, edit('README.md', 'a', 'b', main), main)), null);
  });

  test('the hook tells the agent as Claude Code and Codex read it', () => {
    append(main, 'extension/popup.css', '/* first */\n');
    const input = edit('extension/popup.css', 'a', 'b', main);
    assert.equal(told(run(REGENERATE, input, main)), 'npm run site:popup ran after the edit to extension/popup.css and changed site/popup/popup.css. What it makes is generated (AGENTS.md, "Generated files") and belongs in the same commit as its source.');
    assert.equal(told(run(REGENERATE, input, main)), null);
  });

  test("the popup is copied into the website, in the file's own checkout", () => {
    for (const [checkout, home] of [[main, main], [beside, main], [main, beside]]) {
      const other = checkout === main ? beside : main;
      const untouched = read('site/popup/popup.css', other);
      append(checkout, 'extension/popup.css', `/* ${home} */\n`);
      assert.ok(!same(checkout, 'extension/popup.css', 'site/popup/popup.css'));
      const said = tells(edit('extension/popup.css', 'a', 'b', checkout), home);
      assert.ok(same(checkout, 'extension/popup.css', 'site/popup/popup.css'), 'the copy was not made');
      assert.equal(said, 'npm run site:popup ran after the edit to extension/popup.css and changed site/popup/popup.css. What it makes is generated (AGENTS.md, "Generated files") and belongs in the same commit as its source.');
      assert.ok(read('site/popup/popup.css', other) === untouched, 'the other checkout was written to');
      // With nothing to change, it says nothing.
      assert.equal(tells(edit('extension/popup.css', 'a', 'b', checkout), home), null);
    }
    for (const file of ['extension/popup.html', 'extension/popup.js', 'extension/settings.js']) {
      append(main, file, '\n');
      assert.ok(tells(writeWhole(file, '', main), main).includes(`changed site/popup/${path.basename(file)}.`), file);
    }
  });

  test('the pages are stamped again', () => {
    const stamped = (page, file) => read(page, main).includes(`${file}?v=${stampForIn(main, file)}"`);
    append(main, 'site/styles.css', '/* later */\n');
    assert.ok(!stamped('site/index.html', 'styles.css'));
    const said = tells(edit('site/styles.css', 'a', 'b', main), main);
    assert.ok(said.startsWith('npm run site:stamp ran after the edit to site/styles.css and changed site/404.html, '), said);
    assert.ok(stamped('site/index.html', 'styles.css') && stamped('site/404.html', 'styles.css'));
    append(main, 'site/site.js', '// later\n');
    assert.ok(tells(edit('site/site.js', 'a', 'b', main), main).includes('npm run site:stamp ran after the edit to site/site.js'));
    assert.ok(stamped('site/index.html', 'site.js'));
    // A stamp changed by hand in a page is put back.
    const page = read('site/index.html', main);
    write(path.join(main, 'site/index.html'), page.replace(/styles\.css\?v=[0-9a-f]+/, 'styles.css?v=0000000000'));
    assert.equal(tells(edit('site/index.html', 'a', 'b', main), main), 'npm run site:stamp ran after the edit to site/index.html and changed site/index.html. What it makes is generated (AGENTS.md, "Generated files") and belongs in the same commit as its source.');
    assert.ok(read('site/index.html', main) === page);
    // The popup's copy in the website has no stamps.
    assert.equal(tells(edit('site/popup/popup-host.js', 'a', 'b', main), main), null);
  });

  test('the tables of checks are made again, and a failure is only reported', () => {
    const map = read('checks.json', main);
    const page = read('docs/checks.md', main);
    write(path.join(main, 'checks.json'), map.replace('"The popup\'s styles."', '"How the popup looks."'));
    const said = tells(edit('checks.json', 'a', 'b', main), main);
    assert.ok(said.startsWith('npm run checks:tables ran after the edit to checks.json and changed docs/checks.md.'), said);
    assert.ok(read('docs/checks.md', main).includes('How the popup looks.') && page.includes("The popup's styles."));
    // An item of the checklist changed by a Codex patch is made again.
    const checklist = read('RELEASE-CHECKLIST.md', main);
    write(path.join(main, 'RELEASE-CHECKLIST.md'), checklist.replace('**There is new store art**', '**New art**'));
    assert.ok(tells(patch(['Update File: RELEASE-CHECKLIST.md'], main), main).includes('changed RELEASE-CHECKLIST.md.'));
    assert.ok(read('RELEASE-CHECKLIST.md', main) === checklist);
    // A map broken halfway through an edit.
    const made = read('docs/checks.md', main);
    write(path.join(main, 'checks.json'), '{');
    const failed = tells(edit('checks.json', 'a', 'b', main), main);
    assert.ok(failed.startsWith('npm run checks:tables failed after the edit to checks.json, so what it makes may be out of date.'), failed);
    assert.ok(failed.split('\n').length <= 6, failed);
    assert.ok(read('docs/checks.md', main) === made);
    write(path.join(main, 'checks.json'), map);
    assert.ok(tells(edit('checks.json', 'a', 'b', main), main).includes('changed docs/checks.md.'));
    assert.ok(read('docs/checks.md', main) === page);
  });

  test('a patch to several sources runs each command once', () => {
    for (const file of ['extension/popup.js', 'extension/popup.css', 'site/app.js', 'site/guide.js']) append(main, file, '\n');
    const said = tells(patch(['Update File: extension/popup.js', 'Update File: extension/popup.css', 'Update File: site/app.js', 'Update File: site/guide.js'], main), main);
    assert.deepEqual(said.split('\n').map((line) => line.split(' ran after ')[0]), ['npm run site:popup', 'npm run site:stamp']);
    assert.ok(said.includes('changed site/popup/popup.css, site/popup/popup.js.'), said);
  });

  test('nothing runs for any other file, or in another repository', () => {
    const other = copyInto(repository().main);
    append(other, 'extension/popup.css', '/* later */\n');
    assert.equal(tells(edit('extension/popup.css', 'a', 'b', other), main), null);
    assert.ok(!same(other, 'extension/popup.css', 'site/popup/popup.css'));
    for (const file of ['AGENTS.md', 'extension/content.js', 'site/popup/popup.js', 'site/README.md', 'scripts/sync-site-popup.js', 'docs/checks.md']) {
      assert.equal(tells(edit(file, 'a', 'b', main), main), null, file);
    }
    for (const input of [{}, { tool_name: 'Edit', tool_input: {} }]) assert.equal(told(run(REGENERATE, input, main)), null);
    assert.equal(run(REGENERATE, 'not JSON', main).status, 1);
  });
});

// The stamp a checkout's own file gets.
function stampForIn(checkout, file) {
  const here = stampFor(file);
  const there = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(checkout, 'scripts/stamp-site-assets.js'))}).stampFor(${JSON.stringify(file)}))`], { encoding: 'utf8' }).stdout;
  assert.match(there, /^[0-9a-f]{10}$/);
  assert.match(here, /^[0-9a-f]{10}$/);
  return there;
}

describe('the settings that run the hooks', () => {
  const claude = JSON.parse(read('.claude/settings.json'));
  const codex = JSON.parse(read('.codex/hooks.json'));
  const events = { PreToolUse: REFUSE, PostToolUse: REGENERATE };

  test('Claude Code runs the two scripts around Edit and Write, from the project\'s folder', () => {
    assert.deepEqual(Object.keys(claude), ['permissions', 'hooks']);
    assert.deepEqual(Object.keys(claude.hooks), Object.keys(events));
    for (const [event, script] of Object.entries(events)) {
      assert.deepEqual(claude.hooks[event], [
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node', args: [`\${CLAUDE_PROJECT_DIR}/${script}`] }] }
      ]);
      assert.ok(tracked.includes(script), script);
    }
  });

  test('Codex runs the same two around apply_patch, from the checkout\'s root', () => {
    assert.deepEqual(Object.keys(codex), ['hooks']);
    assert.deepEqual(Object.keys(codex.hooks), Object.keys(events));
    for (const [event, script] of Object.entries(events)) {
      assert.deepEqual(codex.hooks[event], [
        { matcher: 'apply_patch', hooks: [{ type: 'command', command: `node "$(git rev-parse --show-toplevel)/${script}"` }] }
      ]);
    }
  });

  test('the hooks load only Node\'s own modules and each other, and nothing that reaches the network', () => {
    const scripts = tracked.filter((file) => file.startsWith(`${HOOKS}/`));
    assert.deepEqual(scripts, [`${HOOKS}/generated-files.js`, REFUSE, REGENERATE]);
    for (const script of scripts) {
      const text = read(script);
      const loaded = [...text.matchAll(/\brequire\(([^)]*)\)/g)].map((match) => match[1]);
      assert.ok(loaded.length > 0, script);
      for (const name of loaded) {
        assert.ok(["'node:fs'", "'node:path'", "'node:child_process'", "'./generated-files'"].includes(name), `${script} loads ${name}`);
      }
      assert.doesNotMatch(text, /\bimport\b|\bfetch\(|https?:|node:(http|https|http2|net|tls|dgram|dns)\b/, script);
    }
    // The one program they start is Node itself, on a generator's script.
    const starts = scripts.flatMap((script) => [...read(script).matchAll(/(?<![.\w])(spawn\w*|exec\w*|fork)\(([^,)]*)/g)].map((match) => `${match[1]}(${match[2]}`));
    assert.deepEqual(starts, ['spawnSync(process.execPath']);
  });

  test('allow only quiet commands of the package, ask before the audit\'s exceptions change, and deny what the rules forbid', () => {
    const { scripts } = JSON.parse(read('package.json'));
    assert.deepEqual(Object.keys(claude.permissions), ['allow', 'ask', 'deny']);
    for (const rule of claude.permissions.allow) {
      // The command alone. With a * after it, npm's own options would be
      // allowed too (--prefix runs another folder's script), and so would
      // any file given to the tests, one outside the repository or one of
      // the audio suites included.
      const name = /^Bash\(npm (test)\)$/.exec(rule)?.[1] ?? /^Bash\(npm run ([\w:-]+)\)$/.exec(rule)?.[1];
      assert.ok(name && scripts[name], `${rule} is not one of package.json's scripts`);
      // Nothing that plays sound, reaches the network, starts a server or
      // writes the release or the store's images.
      assert.doesNotMatch(name, /^(test:audio|test:firefox|test:watch|audit|release|icons|store|site:serve)/, rule);
    }
    assert.ok(claude.permissions.allow.includes('Bash(npm run check)') && claude.permissions.allow.includes('Bash(npm test)'));
    assert.deepEqual(claude.permissions.ask, ['Edit(audit-exceptions.json)']);
    assert.ok(tracked.includes('audit-exceptions.json'));
    assert.deepEqual(claude.permissions.deny, [
      'Bash(npm audit fix)',
      'Bash(npm audit fix *)',
      'Bash(git push origin main)',
      'Bash(git push origin main *)',
      'Bash(git push origin HEAD:main)',
      'Bash(git push origin HEAD:main *)'
    ]);
    // A * anywhere but the end also matches a longer command that only
    // mentions main later, such as a push of a branch followed by
    // gh pr create --base main.
    for (const rule of claude.permissions.deny) assert.match(rule, /^Bash\([^*]+( \*)?\)$/, rule);
  });

  test('no CLAUDE.md is tracked: Claude Code would read it in place of AGENTS.md', () => {
    assert.deepEqual(tracked.filter((file) => /(^|\/)CLAUDE(\.local)?\.md$/i.test(file)), []);
  });
});
