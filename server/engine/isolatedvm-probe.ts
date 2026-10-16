import { execFileSync } from 'child_process';

// Probes whether the isolated-vm native module can actually create an
// isolate on THIS machine. A broken native build (e.g. compiled under QEMU
// for another CPU variant) does not throw — it SIGSEGVs the whole process
// (exit 139), which no try/catch can intercept. So the probe runs in a
// disposable child process: a crash there only fails the probe, never boot.
let cached: boolean | null = null;

export function isIsolatedVmUsable(): boolean {
  if (cached !== null) return cached;
  try {
    execFileSync(
      process.execPath,
      ['-e', `const ivm=require('isolated-vm');const i=new ivm.Isolate({memoryLimit:32});i.dispose();console.log('probe-ok');`],
      { timeout: 30000, stdio: 'ignore' }
    );
    cached = true;
    console.log('[Engine] isolated-vm probe passed.');
  } catch {
    cached = false;
    console.error('[Engine] isolated-vm probe FAILED (native module crashes on this machine) — all routes will use the process engine instead.');
  }
  return cached;
}
