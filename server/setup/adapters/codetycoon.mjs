// Code Tycoon's own folder. The hook, its token and the autostart launcher are
// re-registered on restore instead of copied; the database is history.
import path from 'node:path';

export default {
  id: 'codetycoon',
  name: 'Code Tycoon',
  install: 'npm install -g code-tycoon',
  dirs: env => [{
    dir: path.join(env.home, '.codetycoon'),
    rules: [
      ['deepgram', 'secret', { note: 'Deepgram key for voice control' }],
      ['token', 'state', { note: 'hook token, made again by hooks install' }],
      ['hook.mjs', 'state'], ['codetycoon.db*', 'history'], ['visualizer.db*', 'history'],
      ['summarizer/', 'state'], ['app/', 'state'], ['restore-backup-*/', 'junk'], ['settings.backup-*', 'junk'],
      ['setup-last.json', 'state'], ['protect.json', 'config'],
      ['github.json', 'login', { note: 'GitHub sign-in for protect' }], ['snapshots/', 'state'], ['restore-src/', 'state'],
    ],
  }],
  files: () => [],
  logins: ['GitHub for protect (run `code-tycoon protect --login`), if you used it'],
};
