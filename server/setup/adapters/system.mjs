// What every AI tool here leans on but none of them owns: git identity, SSH keys
// (the private repos clone with them), npm config, and launchers in the Windows
// Startup folder. Only named files, never a walk of the whole home folder.
import path from 'node:path';

export default {
  id: 'system',
  name: 'Git, SSH and login items',
  dirs: env => [
    {
      dir: path.join(env.home, '.ssh'),
      rules: [
        ['*.pub', 'config'], ['config', 'config'], ['known_hosts', 'config'],
        ['authorized_keys', 'state'], ['known_hosts.*', 'junk'], ['agent*', 'state'],
        ['*', 'secret'], // private keys under any name
      ],
    },
    ...(env.platform === 'win32' && env.vars.APPDATA ? [{
      dir: path.join(env.vars.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
      rules: [
        ['CodeTycoon.vbs', 'state', { note: 're-registered by Code Tycoon' }],
        ['*.lnk', 'state', { note: 'shortcut to an installed app' }],
        ['*', 'autostart'],
      ],
    }] : []),
  ],
  files: env => [
    { abs: path.join(env.home, '.gitconfig'), class: 'config' },
    { abs: path.join(env.home, '.npmrc'), class: 'config' },
    { abs: path.join(env.home, '.git-credentials'), class: 'secret' },
  ],
  logins: [],
};
