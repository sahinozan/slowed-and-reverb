'use strict';

// CI's "Classify changes" job runs git diff --check on a change's lines. This
// runs the same check on every line of every file git tracks, as it is in the
// working tree, so npm run lint finds what CI would. Files git doesn't track
// are left out, as in CI. A file that must stay exactly as published, such as
// a font license, opts out in .gitattributes with -whitespace.

const { spawnSync } = require('node:child_process');

// Git's empty tree. Compared with it, every line of every tracked file is new.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const result = spawnSync('git', ['diff', '--check', EMPTY_TREE, '--'], { stdio: 'inherit' });
if (result.error) {
  console.error(`Couldn't run git: ${result.error.message}`);
  process.exit(2);
}
if (result.status !== 0) {
  console.error('Fix the whitespace above: trailing spaces, blank lines at the end of a file, or a space before a tab.');
}
process.exit(result.status ?? 1);
