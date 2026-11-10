'use strict';

// Writes what is made from the map of which checks a change needs
// (checks.json): the page docs/checks.md, whole, and the "When it applies"
// items of RELEASE-CHECKLIST.md, between its two marker lines. Run after
// changing the map (npm run checks:tables); tests/checks-tables.test.js
// fails until the files match. With --check it writes nothing and only says
// whether they do.

const fs = require('node:fs');
const path = require('node:path');
const { readMap } = require('./classify-ci-changes');

const root = path.join(__dirname, '..');

const START = "<!-- Made from checks.json by npm run checks:tables. Don't edit between these two lines. -->";
const END = '<!-- The end of the part made from checks.json. -->';

const code = (text) => `\`${text}\``;
const list = (items) => items.map(code).join(', ');
// Text from the map on one line: a line break would end a table's row or
// a list's item.
const oneLine = (text) => text.replace(/\s*\n\s*/g, ' ');
// Text in a table's cell: a bar would end the cell.
const cell = (text) => oneLine(text).replaceAll('|', '\\|');
const capital = (text) => text[0].toUpperCase() + text.slice(1);

// Who runs a check. `name` formats a file's name: as code for the page,
// plainly for a terminal.
function runBy(map, check, name = code) {
  const { by, workflow, when } = map.checks[check];
  if (by === 'ci') return "CI's required check";
  if (by === 'workflow') return `its own workflow (${name(path.basename(workflow))})`;
  return when ? `by hand, when ${oneLine(when)}` : 'by hand';
}

// The patterns of every rule that needs a check, in the rules' order.
function pathsNeeding(map, name) {
  return map.rules.filter((rule) => rule.needs.includes(name)).flatMap((rule) => rule.paths);
}

// What a check is, with where its steps are when the release checklist
// spells them out.
function about(check, name = code) {
  const steps = check.steps ? ` Its steps are in ${name('RELEASE-CHECKLIST.md')}, "When it applies".` : '';
  return `${oneLine(check.about)}${steps}`;
}

// What a check asks for, for the page's first table: its commands, then
// what it is.
function whatToDo(check) {
  return `${check.run ? `${list(check.run)}. ` : ''}${about(check)}`;
}

const PAGE_MADE = "<!-- Made from checks.json by npm run checks:tables. Don't edit this page. -->";

// docs/checks.md: the checks, then what each rule's paths need besides the
// check every change needs, in the map's order, since the first rule that
// matches a path decides.
function checksPage(map) {
  const always = Object.keys(map.checks).filter((name) => map.rules.every((rule) => rule.needs.includes(name)));
  const more = (needs) => list(needs.filter((name) => !always.includes(name)));
  const unknown = Object.keys(map.checks).filter((name) => map.checks[name].by === 'ci');
  return [
    '# Which checks a change needs',
    '',
    PAGE_MADE,
    '',
    `The rule is written once, in ${code('checks.json')}, and this page is made from it. ${code('npm run checks:for')} prints what the files you changed need, so you don't have to find the rows yourself. CI decides its browser tests from the same map, and the audio and dependency audit workflows start for the paths it gives them.`,
    '',
    '## The checks',
    '',
    '| Check | Run by | What to do |',
    '| --- | --- | --- |',
    ...Object.entries(map.checks).map(([name, check]) => `| ${code(name)} | ${cell(runBy(map, name))} | ${cell(whatToDo(check))} |`),
    '',
    '## What a change needs',
    '',
    `Find the first row that matches each file you changed, a removed or renamed file's old path included. A change needs ${list(always)} and the checks of every file it touches.`,
    '',
    `| A change to | What it is | Needs, besides ${list(always)} |`,
    '| --- | --- | --- |',
    ...map.rules.map((rule) => `| ${list(rule.paths)} | ${cell(rule.about)} | ${more(rule.needs) || 'nothing more'} |`),
    `| any other path | A path the map doesn't know. | ${more(unknown)}, and a rule in ${code('checks.json')} |`
  ].join('\n');
}

// RELEASE-CHECKLIST.md: the checks a person does only when their condition
// holds, as items to tick.
function checklistItems(map) {
  return Object.entries(map.checks)
    .filter(([, check]) => check.by === 'hand' && check.when)
    .map(([name, check]) => {
      // The condition's first words in bold, up to any detail in brackets.
      const [, head, detail] = /^(.*?)( \(.*)?$/.exec(oneLine(check.when));
      return `- [ ] **${capital(head)}**${detail ?? ''}. ${oneLine(check.steps ?? check.about)} It can happen in a change to ${list(pathsNeeding(map, name))}.`;
    })
    .join('\n');
}

// What is made: a whole file, or the part of one between its marker lines.
const TARGETS = [
  { file: 'docs/checks.md', whole: true, render: checksPage },
  { file: 'RELEASE-CHECKLIST.md', render: checklistItems }
];

// The file's text with the part between its marker lines made again. Each
// marker has to be a line by itself.
function withTables(text, made) {
  const lines = text.split('\n');
  const at = (marker) => lines.flatMap((line, index) => (line === marker ? [index] : []));
  const [starts, ends] = [at(START), at(END)];
  if (starts.length !== 1 || ends.length !== 1 || starts[0] > ends[0]) {
    throw new Error('expected the two marker lines, once each and in order');
  }
  return [...lines.slice(0, starts[0] + 1), made, ...lines.slice(ends[0])].join('\n');
}

// Each file as it is and as the map makes it. A whole file that isn't
// there yet is empty.
function renderAll(map = readMap()) {
  return TARGETS.map(({ file, whole, render }) => {
    const target = path.join(root, file);
    const before = whole && !fs.existsSync(target) ? '' : fs.readFileSync(target, 'utf8');
    try {
      return { file, before, after: whole ? `${render(map)}\n` : withTables(before, render(map)) };
    } catch (error) {
      throw new Error(`${file}: ${error.message}`, { cause: error });
    }
  });
}

// Writes the files, or with --check only says which are out of date.
if (require.main === module) {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === '--check';
  if (args.length > 0 && !check) {
    process.stderr.write(`Unexpected arguments: ${args.join(' ')}\n`);
    process.exitCode = 2;
  } else {
    for (const { file, before, after } of renderAll()) {
      if (after === before) {
        console.log(`${file}: already up to date`);
      } else if (check) {
        console.log(`${file}: out of date; run npm run checks:tables`);
        process.exitCode = 1;
      } else {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), after);
        console.log(`${file}: written`);
      }
    }
  }
}

module.exports = { END, PAGE_MADE, START, about, checklistItems, checksPage, renderAll, runBy, withTables };
