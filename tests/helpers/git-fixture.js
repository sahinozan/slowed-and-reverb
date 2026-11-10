'use strict';

// The environment for git in a throwaway repository: none of the settings
// that could point git at another repository or change what it does. A test
// run from a git hook inherits GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE,
// which would make a fixture's commands act on the real repository, and
// the machine's own git configuration could change what they list.

const os = require('node:os');

function gitFixtureEnv(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com'
  };
}

module.exports = { gitFixtureEnv };
