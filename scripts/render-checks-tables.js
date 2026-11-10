'use strict';

// Writes the tables of which checks a change needs into AGENTS.md and
// RELEASE-CHECKLIST.md, from the map (checks.json), between the two marker
// lines in each file. Run after changing the map (npm run checks:tables);
// tests/checks-tables.test.js fails until the files match.

const fs = require('node:fs');
const path = require('node:path');
const { readMap } = require('./classify-ci-changes');

const root = path.join(__dirname, '..');

const START = "<!-- Made from checks.json by npm run checks:tables. Don't edit between these two lines. -->";
const END = '<!-- The end of the part made from checks.json. -->';

const code = (text) => `\`${text}\``;
const list = (items) => items.map(code).join(', ');
// Text in a table's cell: a bar would end the cell.
const cell = (text) => text.replaceAll('|', '\\|');
const capital = (text) => text[0].toUpperCase() + text.slice(1);

// Who runs a check, for the first table.
function runBy(map, name) {
  const check = map.checks[name];
  if (check.by === 'ci') return "CI's required check";
  if (check.by === 'workflow') return `its own workflow (${code(path.basename(check.workflow))})`;
  return check.when ? `by hand, when ${check.when}` : 'by hand';
}

// The patterns of every rule that needs a check, in the rules' order.
function pathsNeeding(map, name) {
  return map.rules.filter((rule) => rule.needs.includes(name)).flatMap((rule) => rule.paths);
}

// What a check asks for, for the first table: its commands, what it is,
// and where its steps are when the release checklist spells them out.
function whatToDo(check) {
  const commands = check.run ? `${list(check.run)}. ` : '';
  const steps = check.steps ? ` Its steps are in ${code('RELEASE-CHECKLIST.md')}, "When it applies".` : '';
  return `${commands}${check.about}${steps}`;
}

// AGENTS.md: the checks, then what each rule's paths need besides the check
// every change needs, in the map's order, since the first rule that matches
// a path decides.
function agentsTables(map) {
  const always = Object.keys(map.checks).filter((name) => map.rules.every((rule) => rule.needs.includes(name)));
  const more = (needs) => list(needs.filter((name) => !always.includes(name)));
  const unknown = Object.keys(map.checks).filter((name) => map.checks[name].by === 'ci');
  return [
    '| Check | Run by | What to do |',
    '| --- | --- | --- |',
    ...Object.entries(map.checks).map(([name, check]) => `| ${code(name)} | ${cell(runBy(map, name))} | ${cell(whatToDo(check))} |`),
    '',
    `| A change to | Needs, besides ${list(always)} |`,
    '| --- | --- |',
    ...map.rules.map((rule) => `| ${list(rule.paths)} | ${more(rule.needs) || 'nothing more'} |`),
    `| any other path | ${more(unknown)}, and a rule in ${code('checks.json')} |`
  ].join('\n');
}

// RELEASE-CHECKLIST.md: the checks a person does only when their condition
// holds, as items to tick.
function checklistItems(map) {
  return Object.entries(map.checks)
    .filter(([, check]) => check.by === 'hand' && check.when)
    .map(([name, check]) => {
      // The condition's first words in bold, up to any detail in brackets.
      const [, head, detail] = /^([^(]*?)( \(.*)?$/.exec(check.when);
      return `- [ ] **${capital(head)}**${detail ?? ''}. ${check.steps ?? check.about} It can happen in a change to ${list(pathsNeeding(map, name))}.`;
    })
    .join('\n');
}

const TARGETS = [
  { file: 'AGENTS.md', render: agentsTables },
  { file: 'RELEASE-CHECKLIST.md', render: checklistItems }
];

// The file's text with the part between its marker lines made again.
function withTables(text, made) {
  const start = text.split(`${START}\n`);
  const end = text.split(`\n${END}\n`);
  if (start.length !== 2 || end.length !== 2 || text.indexOf(START) > text.indexOf(END)) {
    throw new Error('expected the two marker lines, once each and in order');
  }
  return `${start[0]}${START}\n${made}\n${END}\n${end[1]}`;
}

// Each file as it is and as the map makes it.
function renderAll(map = readMap()) {
  return TARGETS.map(({ file, render }) => {
    const before = fs.readFileSync(path.join(root, file), 'utf8');
    try {
      return { file, before, after: withTables(before, render(map)) };
    } catch (error) {
      throw new Error(`${file}: ${error.message}`, { cause: error });
    }
  });
}

if (require.main === module) {
  for (const { file, before, after } of renderAll()) {
    if (after !== before) fs.writeFileSync(path.join(root, file), after);
    console.log(`${file}: ${after === before ? 'already up to date' : 'written'}`);
  }
}

module.exports = { END, START, agentsTables, checklistItems, renderAll, withTables };
