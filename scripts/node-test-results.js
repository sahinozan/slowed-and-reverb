'use strict';

// A node --test reporter that the release (scripts/release.js) adds next to
// the printed one:
//
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=scripts/node-test-results.js --test-reporter-destination=<file>
//
// It writes, as JSON, every test's and suite's result and the summaries of
// each test file and of the whole run, as the test runner reports them rather
// than as the tests' printed output, which goes only to the printed report.
// It writes once, after the run, so a run that stops early leaves an empty or
// partial file.

const FORMAT = 'slowed-reverb node test results 1';

async function* nodeTestResults(source) {
  const results = [];
  const summaries = [];
  for await (const { type, data } of source) {
    if (type === 'test:pass' || type === 'test:fail') {
      results.push({
        file: data.file ?? null,
        name: data.name,
        nesting: data.nesting,
        type: data.details?.type ?? null,
        passed: type === 'test:pass',
        failureType: data.details?.error?.failureType ?? null,
        skip: data.skip ?? false,
        todo: data.todo ?? false
      });
    } else if (type === 'test:summary') {
      summaries.push({ file: data.file ?? null, counts: data.counts, success: data.success });
    }
  }
  yield `${JSON.stringify({ format: FORMAT, results, summaries })}\n`;
}

module.exports = nodeTestResults;
module.exports.FORMAT = FORMAT;
