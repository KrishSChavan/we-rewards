// Runs one of this repo's PowerShell scripts on whichever laptop you are on.
//
//   node scripts/run-ps.mjs scripts/ship.ps1 -Message "what changed"
//
// WHY THIS EXISTS. The .ps1 files are already portable — checked, not assumed:
// no PowerShell 7-only syntax (no &&, ??, ?., ternary, -AsHashtable), no
// Windows-only cmdlets, no registry, and every path they build comes from
// `git rev-parse --show-toplevel`, which answers in forward slashes everywhere.
// The ONLY thing that differs between the two machines is the NAME of the
// interpreter:
//
//   macOS      pwsh          PowerShell 7. There is no `powershell` at all.
//   Windows    powershell    5.1, present on every install; `pwsh` only if
//                            PowerShell 7 was installed deliberately.
//
// So the alternative — a .ps1 for Windows and a parallel .sh for the Mac —
// would have meant maintaining ~590 lines of deploy logic twice, in two
// languages, with production pushes riding on the two halves staying in step.
// This file is the entire difference instead.
//
// ⚠ THE EXIT CODE IS LOAD-BEARING. ship.ps1 decides whether to promote to
// production by checking $LASTEXITCODE from the staging deploy. If this
// launcher swallowed a non-zero status, a failed staging deploy would walk
// straight into a production push. Same reasoning as the comment in ship.ps1.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const isWindows = process.platform === 'win32';
const [script, ...forwarded] = process.argv.slice(2);

if (!script) {
  console.error('usage: node scripts/run-ps.mjs <script.ps1> [args...]');
  process.exit(2);
}
if (!existsSync(path.resolve(process.cwd(), script))) {
  console.error(`run-ps: no such script: ${script}`);
  process.exit(2);
}

// pwsh first on BOTH platforms, so that when PowerShell 7 is installed the two
// laptops run byte-for-byte the same interpreter and a script that works on one
// cannot mysteriously fail on the other. powershell.exe is the fallback that
// keeps a stock Windows box working with nothing installed.
const hosts = isWindows ? ['pwsh', 'powershell'] : ['pwsh'];

// -NoProfile: a deploy must not depend on whatever either laptop's profile does.
// -ExecutionPolicy Bypass is Windows-only; PowerShell 7 on macOS rejects it.
const argsFor = (host) => [
  '-NoProfile',
  ...(isWindows ? ['-ExecutionPolicy', 'Bypass'] : []),
  '-File', script,
  ...forwarded,
];

for (const host of hosts) {
  const run = spawnSync(host, argsFor(host), { stdio: 'inherit' });

  // ENOENT means this interpreter isn't installed — try the next one. Any other
  // failure came from the script itself and must be reported, not retried.
  if (run.error?.code === 'ENOENT') continue;
  if (run.error) {
    console.error(`run-ps: could not start ${host}: ${run.error.message}`);
    process.exit(1);
  }
  // A script killed by a signal (Ctrl-C at the "promote to production?" prompt)
  // has no exit status. Report it as a failure so nothing downstream proceeds.
  process.exit(run.status ?? 1);
}

console.error(
  isWindows
    ? 'run-ps: no PowerShell found. Windows ships powershell.exe by default, so this\n'
      + '        usually means PATH is broken. PowerShell 7: winget install Microsoft.PowerShell'
    : 'run-ps: pwsh not found. PowerShell 7 runs these deploy scripts on macOS:\n'
      + '        brew install --cask powershell'
);
process.exit(127);
