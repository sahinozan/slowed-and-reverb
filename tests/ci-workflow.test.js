'use strict';

// Runs the classification and gate scripts from .github/workflows/ci.yml with
// bash, the way GitHub Actions does, in throwaway Git repositories.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { describe, test } = require('node:test');
const { POLICY_VERSION } = require('../scripts/classify-ci-changes');

const { root } = require('./helpers/load-script');

const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const CLASSIFIER = 'scripts/classify-ci-changes.js';

// The text of a job, from its key to the next job.
function jobText(name) {
  const match = new RegExp(`^ {2}${name}:\\n[\\s\\S]*?(?=^ {2}\\S|(?![\\s\\S]))`, 'm').exec(workflow);
  assert.ok(match, `no ${name} job`);
  return match[0];
}

// The run: | block of the step with this id, without its indentation.
function stepScript(id) {
  const lines = workflow.split('\n');
  const idLine = lines.findIndex((line) => line.trim() === `id: ${id}`);
  assert.notEqual(idLine, -1, `no step with id ${id}`);
  const runLine = lines.findIndex((line, index) => index > idLine && /^\s+run: \|$/.test(line));
  assert.ok(!lines.slice(idLine, runLine).some((line) => /^\s+- name:/.test(line)), `step ${id} has no run block`);
  const indent = lines[runLine].search(/\S/);
  const body = [];
  for (const line of lines.slice(runLine + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    body.push(line);
  }
  const bodyIndent = Math.min(...body.filter((line) => line.trim()).map((line) => line.search(/\S/)));
  return body.map((line) => line.slice(bodyIndent)).join('\n').trimEnd() + '\n';
}

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowed-reverb-ci-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Like GitHub's bash steps: bash --noprofile --norc -eo pipefail <file>.
function runStep(t, id, { cwd, env }) {
  const dir = temporary(t);
  const script = path.join(dir, 'step.sh');
  const output = path.join(dir, 'output');
  fs.writeFileSync(script, stepScript(id));
  fs.writeFileSync(output, '');
  fs.mkdirSync(path.join(dir, 'runner-temp'));
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    cwd: cwd ?? dir,
    encoding: 'utf8',
    env: {
      PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
      HOME: dir,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: path.join(dir, 'runner-temp'),
      ...env
    }
  });
  const outputs = Object.fromEntries(
    fs
      .readFileSync(output, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/=(.*)/s).slice(0, 2))
  );
  return { status: result.status, outputs, log: result.stdout + result.stderr };
}

const legacyClassifier = `'use strict';
process.stdout.write('full=false\\nbrowser=false\\n');
`;
const lenientClassifier = `'use strict';
if (process.argv[2] === '--policy-version') process.stdout.write('${POLICY_VERSION}\\n');
else process.stdout.write('browser=false\\n');
`;

// A throwaway repository whose first commit has the real classifier.
function repository(t, { classifier = fs.readFileSync(path.join(root, CLASSIFIER), 'utf8') } = {}) {
  const dir = temporary(t);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com'
  };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
  const repo = {
    dir,
    git,
    write(file, text) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    },
    commit(message) {
      git('add', '--all');
      git('commit', '--quiet', '--allow-empty', '-m', message);
      return git('rev-parse', 'HEAD');
    },
    classify(env) {
      return runStep(t, 'changes', { cwd: dir, env });
    },
    pullRequest(base, head) {
      return repo.classify({ EVENT_NAME: 'pull_request', BASE_SHA: base, HEAD_SHA: head });
    }
  };
  git('init', '--quiet', '--initial-branch=main');
  // Rename detection on, as Git's default for git diff, so the test shows the
  // workflow turns it off.
  git('config', 'diff.renames', 'true');
  repo.write('extension/runtime.js', 'console.log("the audio engine");\n'.repeat(20));
  repo.write('README.md', '# Readme\n');
  repo.write('site/index.html', '<p>Site</p>\n');
  if (classifier !== null) repo.write(CLASSIFIER, classifier);
  repo.base = repo.commit('Base');
  return repo;
}

describe('CI workflow structure', () => {
  test('runs the repository checks for every change, whatever the classification says', () => {
    const job = jobText('repository-checks');
    assert.doesNotMatch(job, /^\s+if:/m);
    assert.doesNotMatch(job, /^\s+needs:/m);
    assert.match(job, /run: npm run check/);
  });

  test('routes the browser tests and the gate by the same classification outputs', () => {
    assert.match(jobText('classify'), /browser: \$\{\{ steps\.changes\.outputs\.browser \}\}/);
    assert.match(jobText('classify'), /policy: \$\{\{ steps\.changes\.outputs\.policy \}\}/);
    assert.match(jobText('browser-smoke'), /^ {4}if: needs\.classify\.outputs\.browser == 'true'$/m);
    const gate = jobText('required-gate');
    assert.match(gate, /name: Lint, test, and package/);
    assert.match(gate, /if: \$\{\{ always\(\) \}\}/);
    assert.match(gate, /BROWSER_REQUIRED: \$\{\{ needs\.classify\.outputs\.browser \}\}/);
    assert.match(gate, /POLICY: \$\{\{ needs\.classify\.outputs\.policy \}\}/);
    assert.match(gate, /REPOSITORY_RESULT: \$\{\{ needs\.repository-checks\.result \}\}/);
  });

  test('the browser job runs the extension, Firefox, popup layout and website tests', () => {
    const job = jobText('browser-smoke');
    for (const command of ['npm run test:e2e', 'npm run test:firefox', 'npm run test:ui']) {
      assert.match(job, new RegExp(`^ {8}run: ${command}$`, 'm'), command);
    }
  });

  // Firefox plays the website's demo only through a sound device: the Ubuntu
  // job must start one before the website tests and run the playing tests in
  // both engines; only Windows, which has none, may leave them out of Gecko.
  test("the browser job plays the website's demo in Firefox on Ubuntu, through a null sink", () => {
    const job = jobText('browser-smoke');
    assert.match(job, / {8}include:\n {10}- os: ubuntu-latest\n {12}firefox-playback: run\n {10}- os: windows-latest\n {12}firefox-playback: omit\n/);
    assert.equal(job.match(/firefox-playback: /g).length, 2);

    const steps = job.split(/\n(?= {6}- name: )/);
    const index = (pattern) => {
      const found = steps.findIndex((step) => pattern.test(step));
      assert.notEqual(found, -1, String(pattern));
      return found;
    };
    const sink = steps[index(/- name: Start a PulseAudio null sink/)];
    assert.match(sink, /^ {8}if: runner\.os == 'Linux'$/m);
    assert.match(sink, /^ {8}timeout-minutes: \d+$/m);
    assert.match(sink, /pactl load-module module-null-sink sink_name=site_demo/);
    assert.match(sink, /pactl set-default-sink site_demo/);
    const ui = steps[index(/run: npm run test:ui$/m)];
    assert.match(ui, /^ {10}SLOWED_REVERB_UI_FIREFOX_PLAYBACK: \$\{\{ matrix\.firefox-playback \}\}$/m);
    assert.doesNotMatch(ui, /^ {8}if:/m);
    assert.ok(index(/run: npm run test:firefox$/m) < index(/Start a PulseAudio null sink/));
    assert.ok(index(/Start a PulseAudio null sink/) < index(/run: npm run test:ui$/m));
    assert.equal(workflow.match(/SLOWED_REVERB_UI_FIREFOX_PLAYBACK/g).length, 1);
  });

  test('keeps read-only permissions and the scripts free of GitHub expressions', () => {
    assert.match(workflow, /^permissions:\n {2}contents: read\n\n/m);
    assert.doesNotMatch(workflow, /secrets\./);
    assert.doesNotMatch(workflow, /pull_request_target/);
    for (const id of ['changes', 'gate']) assert.doesNotMatch(stepScript(id), /\$\{\{/, id);
  });

  test('asks for the policy version the classifier answers', () => {
    assert.match(stepScript('changes'), new RegExp(`\\[\\[ "\\$version" != ${POLICY_VERSION} \\]\\]`));
  });
});

describe('CI classification step', () => {
  test('uses the base policy for a PRIVACY.md-only pull request', (t) => {
    const repo = repository(t);
    repo.write('PRIVACY.md', '# Privacy\n');
    const result = repo.pullRequest(repo.base, repo.commit('Privacy'));

    assert.equal(result.status, 0, result.log);
    assert.deepEqual(result.outputs, { policy: 'base', browser: 'false' });
  });

  test('a rename lists the removed runtime file, so it still runs the browser tests', (t) => {
    const repo = repository(t);
    repo.git('mv', 'extension/runtime.js', 'docs.md');
    const head = repo.commit('Rename');

    // Git's rename detection would list only the new name.
    assert.equal(repo.git('diff', '--name-only', '-z', `${repo.base}...${head}`), 'docs.md\0');

    const result = repo.pullRequest(repo.base, head);
    assert.equal(result.status, 0, result.log);
    assert.deepEqual(result.outputs, { policy: 'base', browser: 'true' });
  });

  test('a deleted runtime file runs the browser tests', (t) => {
    const repo = repository(t);
    repo.git('rm', '--quiet', 'extension/runtime.js');
    repo.write('README.md', '# Readme\n\nUpdated.\n');
    const result = repo.pullRequest(repo.base, repo.commit('Delete'));

    assert.deepEqual(result.outputs, { policy: 'base', browser: 'true' });
  });

  test('mixed changes take the highest tier', (t) => {
    const repo = repository(t);
    repo.write('README.md', '# Readme\n\nUpdated.\n');
    repo.write('store-assets/LISTING.md', '# Listing\n');
    repo.write('tests/notes.test.js', '// A test.\n');
    const docsAndTests = repo.commit('Docs and tests');
    assert.deepEqual(repo.pullRequest(repo.base, docsAndTests).outputs, { policy: 'base', browser: 'false' });

    repo.write('extension/runtime.js', 'console.log("changed");\n');
    assert.deepEqual(repo.pullRequest(repo.base, repo.commit('Runtime')).outputs, { policy: 'base', browser: 'true' });
  });

  test(
    'reads paths with spaces and newlines whole',
    { skip: process.platform === 'win32' && 'Windows file names cannot hold newlines' },
    (t) => {
      const repo = repository(t);
      // Split at the newline, this would look like a change to extension/.
      repo.write('tests/odd name\nextension/b.js', 'test file\n');
      const result = repo.pullRequest(repo.base, repo.commit('Odd name'));

      assert.equal(result.status, 0, result.log);
      assert.deepEqual(result.outputs, { policy: 'base', browser: 'false' });
    }
  );

  test('a website change runs the browser tests', (t) => {
    const repo = repository(t);
    repo.write('site/index.html', '<p>New site</p>\n');

    assert.deepEqual(repo.pullRequest(repo.base, repo.commit('Site')).outputs, { policy: 'base', browser: 'true' });
  });

  test('runs everything when the comparison is empty', (t) => {
    const repo = repository(t);
    const result = repo.pullRequest(repo.base, repo.commit('Empty'));

    assert.deepEqual(result.outputs, { policy: 'base', browser: 'true' });
  });

  test("the pull request's own classifier doesn't decide its checks", (t) => {
    const repo = repository(t);
    repo.write(CLASSIFIER, lenientClassifier);
    repo.write('extension/runtime.js', 'console.log("changed");\n');
    const head = repo.commit('Tampered classifier');

    // Run as the head would, the classifier skips the browser tests.
    const headDecision = spawnSync(process.execPath, [path.join(repo.dir, CLASSIFIER)], {
      input: 'extension/runtime.js\0',
      encoding: 'utf8'
    });
    assert.equal(headDecision.stdout, 'browser=false\n');

    const result = repo.pullRequest(repo.base, head);
    assert.equal(result.status, 0, result.log);
    assert.deepEqual(result.outputs, { policy: 'base', browser: 'true' });
  });

  test("the base commit's classifier decides, even when it is the lenient one", (t) => {
    const repo = repository(t, { classifier: lenientClassifier });
    repo.write(CLASSIFIER, fs.readFileSync(path.join(root, CLASSIFIER), 'utf8'));
    repo.write('extension/runtime.js', 'console.log("changed");\n');

    assert.deepEqual(repo.pullRequest(repo.base, repo.commit('Stricter classifier')).outputs, {
      policy: 'base',
      browser: 'false'
    });
  });

  test('runs everything when the base has no classifier or one without a policy version', (t) => {
    for (const classifier of [null, legacyClassifier]) {
      const repo = repository(t, { classifier });
      repo.write('PRIVACY.md', '# Privacy\n');
      const result = repo.pullRequest(repo.base, repo.commit('Privacy'));

      assert.equal(result.status, 0, result.log);
      assert.deepEqual(result.outputs, { policy: 'none', browser: 'true' }, String(classifier));
      assert.match(result.log, /every check runs/);
    }
  });

  test('fails when the base classifier fails or prints something unexpected', (t) => {
    const versioned = (body) => `'use strict';
if (process.argv[2] === '--policy-version') process.stdout.write('${POLICY_VERSION}\\n');
else ${body}
`;
    for (const classifier of [
      versioned("process.stdout.write('browser=maybe\\n');"),
      versioned("process.stdout.write('browser=false\\nbrowser=true\\n');"),
      versioned("process.stdout.write('');"),
      versioned('process.exit(1);'),
      "'use strict';\nprocess.exit(3);\n"
    ]) {
      const repo = repository(t, { classifier });
      repo.write('PRIVACY.md', '# Privacy\n');
      const result = repo.pullRequest(repo.base, repo.commit('Privacy'));

      assert.notEqual(result.status, 0, classifier);
      assert.deepEqual(result.outputs, {}, classifier);
    }
  });

  test('fails on whitespace errors', (t) => {
    const repo = repository(t);
    repo.write('README.md', '# Readme   \n');
    const result = repo.pullRequest(repo.base, repo.commit('Trailing spaces'));

    assert.notEqual(result.status, 0);
    assert.deepEqual(result.outputs, {});
  });

  test('pushes use the policy from before the push, or run everything without one', (t) => {
    const repo = repository(t);
    repo.write('PRIVACY.md', '# Privacy\n');
    const head = repo.commit('Privacy');

    assert.deepEqual(repo.classify({ EVENT_NAME: 'push', BEFORE_SHA: repo.base, HEAD_SHA: head }).outputs, {
      policy: 'base',
      browser: 'false'
    });
    assert.deepEqual(repo.classify({ EVENT_NAME: 'push', BEFORE_SHA: '0'.repeat(40), HEAD_SHA: head }).outputs, {
      policy: 'none',
      browser: 'true'
    });
  });

  test('manual runs run everything and other events fail', (t) => {
    const repo = repository(t);
    assert.deepEqual(repo.classify({ EVENT_NAME: 'workflow_dispatch', HEAD_SHA: repo.base }).outputs, {
      policy: 'manual',
      browser: 'true'
    });

    const other = repo.classify({ EVENT_NAME: 'schedule', HEAD_SHA: repo.base });
    assert.notEqual(other.status, 0);
    assert.deepEqual(other.outputs, {});
  });
});

describe('CI required gate', () => {
  const passing = {
    CLASSIFY_RESULT: 'success',
    REPOSITORY_RESULT: 'success',
    POLICY: 'base',
    BROWSER_REQUIRED: 'false',
    BROWSER_RESULT: 'skipped'
  };
  const gate = (t, changes) => runStep(t, 'gate', { env: { ...passing, ...changes } });

  test('passes when the base policy skipped the browser tests and everything else passed', (t) => {
    const result = gate(t, {});
    assert.equal(result.status, 0, result.log);
  });

  test('passes when the required browser tests passed', (t) => {
    for (const POLICY of ['base', 'none', 'manual']) {
      const result = gate(t, { POLICY, BROWSER_REQUIRED: 'true', BROWSER_RESULT: 'success' });
      assert.equal(result.status, 0, `${POLICY}: ${result.log}`);
    }
  });

  test('fails unless the classification and the repository checks succeeded', (t) => {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      assert.notEqual(gate(t, { CLASSIFY_RESULT: result }).status, 0, `classify ${result}`);
      assert.notEqual(gate(t, { REPOSITORY_RESULT: result }).status, 0, `repository checks ${result}`);
    }
  });

  test('fails when required browser tests did not pass', (t) => {
    for (const BROWSER_RESULT of ['failure', 'cancelled', 'skipped', '']) {
      assert.notEqual(gate(t, { BROWSER_REQUIRED: 'true', BROWSER_RESULT }).status, 0, BROWSER_RESULT);
    }
  });

  test('fails on missing, malformed or conflicting classification outputs', (t) => {
    for (const changes of [
      { BROWSER_REQUIRED: '' },
      { BROWSER_REQUIRED: 'TRUE' },
      { BROWSER_REQUIRED: 'no' },
      { BROWSER_REQUIRED: 'false ' },
      { POLICY: '' },
      { POLICY: 'head' },
      { POLICY: 'none' },
      { POLICY: 'manual' },
      { BROWSER_RESULT: 'success' }
    ]) {
      assert.notEqual(gate(t, changes).status, 0, JSON.stringify(changes));
    }
  });

  test('a documentation-only change still needs its repository checks to pass', (t) => {
    const repo = repository(t);
    repo.write('PRIVACY.md', '# Privacy\n');
    const { outputs } = repo.pullRequest(repo.base, repo.commit('Privacy'));
    const decided = { POLICY: outputs.policy, BROWSER_REQUIRED: outputs.browser, BROWSER_RESULT: 'skipped' };

    assert.equal(gate(t, decided).status, 0);
    assert.notEqual(gate(t, { ...decided, REPOSITORY_RESULT: 'skipped' }).status, 0);
    assert.notEqual(gate(t, { ...decided, REPOSITORY_RESULT: 'failure' }).status, 0);
  });
});
