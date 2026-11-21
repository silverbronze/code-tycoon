// code-tycoon audit [--json]
// code-tycoon protect [--to github[:org] | <folder>] [--only a,b] [--yes] [--login] [--logout]
// code-tycoon snapshot <folder | git url> [--new-vault]
// code-tycoon restore <folder | git url> [--yes] [--projects <dir>] [--recovery-key] [--no-install] [--no-clone]
// The passphrase comes from CODETYCOON_PASSPHRASE or a hidden prompt.
const [cmd, ...rest] = process.argv.slice(2);
const flag = f => rest.includes(f);
const opt = f => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : null; };
const positional = rest.filter((a, i) => !a.startsWith('--') && !['--projects', '--to', '--only'].includes(rest[i - 1]));

try {
  if (cmd === 'audit') {
    const { audit, formatAudit } = await import('./audit.mjs');
    const a = await audit();
    console.log(flag('--json') ? JSON.stringify(a, null, 2) : formatAudit(a));
  } else if (cmd === 'snapshot') {
    if (!positional[0]) throw new Error('usage: code-tycoon snapshot <folder | git url>');
    const { snapshot } = await import('./snapshot.mjs');
    await snapshot(positional[0], { newVault: flag('--new-vault') });
  } else if (cmd === 'restore') {
    if (!positional[0]) throw new Error('usage: code-tycoon restore <folder | git url> [--yes]');
    const { restore } = await import('./restore.mjs');
    await restore(positional[0], { yes: flag('--yes'), projectsDir: opt('--projects'), recovery: flag('--recovery-key'), install: !flag('--no-install'), clone: !flag('--no-clone') });
  } else if (cmd === 'protect') {
    const gh = await import('./github.mjs');
    if (flag('--logout')) { gh.logout(); console.log('Signed out of GitHub.'); process.exit(0); }
    if (flag('--login')) {
      const s = await gh.startDeviceLogin();
      console.log(`Open ${s.url} and enter the code ${s.code}`);
      console.log(`Signed in to GitHub as ${await gh.finishDeviceLogin(s)}.`);
      if (!positional.length && !opt('--to')) process.exit(0);
    }
    const { protect } = await import('./protect.mjs');
    await protect({ to: opt('--to'), yes: flag('--yes'), only: (opt('--only') || '').split(',').filter(Boolean) });
  } else {
    throw new Error('usage: code-tycoon audit | protect [--to github|<folder>] | snapshot <target> | restore <source>');
  }
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
