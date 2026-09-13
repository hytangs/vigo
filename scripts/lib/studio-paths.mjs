import path from 'node:path'
import { rustRoutingTarget } from './rust-routing-targets.mjs'

export function studioPaths(releaseRoot, version, platform = process.platform, architecture = process.arch) {
  if (!rustRoutingTarget(platform, architecture)) throw new Error(`Unsupported Studio target: ${platform}:${architecture}`)
  const directory = path.join(releaseRoot, `VIGO Agency-${platform}-${architecture}`)
  const application = platform === 'darwin' ? path.join(directory, 'VIGO Agency.app') : directory
  const resources = platform === 'darwin'
    ? path.join(application, 'Contents', 'Resources') : path.join(directory, 'resources')
  const executable = platform === 'darwin' ? path.join(application, 'Contents', 'MacOS', 'VIGO Agency')
    : path.join(directory, platform === 'win32' ? 'VIGO Agency.exe' : 'VIGO Agency')
  const label = { darwin: 'mac', linux: 'linux', win32: 'windows' }[platform]
  const extension = platform === 'linux' ? 'tar.gz' : 'zip'
  return {
    directory, application, executable,
    program: path.join(resources, 'app', 'public', 'vigo.mjs'),
    nativeKernel: path.join(resources, 'app', 'server', 'vigo-routing-kernel.node'),
    archive: path.join(releaseRoot, `VIGO-Agency-${version}-${label}-${architecture}.${extension}`),
  }
}
