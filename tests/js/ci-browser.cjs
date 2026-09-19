/* CI wrapper for the browser suites. Job logs on GitHub need repo sign-in to
 * read, so on failure this re-emits the suite's captured output tail as a
 * workflow annotation, which the run page shows anonymously. Locally it just
 * streams each suite through.
 */
'use strict';
const { spawnSync } = require('node:child_process');
const suites = ['tests/js/browser.cjs', 'tests/js/native-ui.cjs', 'tests/js/panel-browser.cjs'];
const annotate = process.env.GITHUB_ACTIONS === 'true';
const escape = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
let failed = 0;
for (const suite of suites) {
  const run = spawnSync(process.execPath, [suite], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  if (run.status === 0) continue;
  failed = run.status || 1;
  if (annotate) {
    const lines = ((run.stdout || '') + '\n' + (run.stderr || ''))
      .split('\n')
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim())
      .filter(Boolean);
    const tail = lines.slice(-15).join('\n').slice(0, 1500);
    console.log(`::error title=${suite} failed::${escape(tail)}`);
  }
  break;
}
process.exit(failed);
