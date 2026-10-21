import os from 'node:os'
import { buildMemoryEnvironment } from './build-memory.mjs'

// Shipped binaries must not embed this machine's paths. Rust remapping does
// not cover C/C++ dependencies (including bundled SQLite), so both get neutral
// prefixes that cannot include a container's /build source root.
export function remappedBuildEnvironment(repositoryRoot, rustFlags = []) {
  const inheritedRustFlags = String(process.env.RUSTFLAGS ?? '').trim()
  const inheritedFlags = process.env.CARGO_ENCODED_RUSTFLAGS?.split('\u001f') ?? inheritedRustFlags.split(/\s+/u).filter(Boolean)
  const flags = [...inheritedFlags, ...rustFlags,
    '--remap-path-prefix', `${os.homedir()}=/vigo-home`,
    '--remap-path-prefix', `${repositoryRoot}=/vigo-source`,
  ]
  const cPathFlags = process.platform === 'win32' ? [] : [
    `-ffile-prefix-map=${os.homedir()}=/vigo-home`,
    `-ffile-prefix-map=${repositoryRoot}=/vigo-source`,
  ]
  return {
    ...buildMemoryEnvironment(),
    ...Object.fromEntries(['CFLAGS', 'CXXFLAGS'].map(key => [key,
      [process.env[key] || '', ...cPathFlags.map(flag => JSON.stringify(flag))].filter(Boolean).join(' '),
    ])),
    ...(cPathFlags.length ? { CC_SHELL_ESCAPED_FLAGS: '1' } : {}),
    CARGO_ENCODED_RUSTFLAGS: flags.join('\u001f'),
  }
}
