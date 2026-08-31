const targets = {
  'darwin:arm64': {
    targetTriple: 'aarch64-apple-darwin',
    libraryName: 'libvigo_routing_kernel.dylib',
    rustFlags: ['-C', 'target-cpu=apple-m1', '-C', 'link-arg=-mmacosx-version-min=13.5'],
    sign: true,
  },
  'linux:x64': {
    targetTriple: 'x86_64-unknown-linux-gnu',
    libraryName: 'libvigo_routing_kernel.so',
    rustFlags: [],
    sign: false,
  },
  'win32:x64': {
    targetTriple: 'x86_64-pc-windows-msvc',
    // Cargo emits a DLL for a Windows cdylib. Node loads the same N-API binary
    // through its platform-neutral `.node` extension.
    libraryName: 'vigo_routing_kernel.dll',
    rustFlags: [],
    sign: false,
  },
}

export function rustRoutingTarget(platform, architecture) {
  return targets[`${platform}:${architecture}`] ?? null
}

export const supportedRustRoutingTargets = Object.freeze(
  Object.entries(targets).map(([host, target]) => ({ host, ...target })),
)
