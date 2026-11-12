import path from 'node:path'

// Windows' own tar.exe accepts drive-letter paths; the GNU tar that Git Bash
// puts first on PATH reads "C:" as a remote host.
export const tarCommand =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
