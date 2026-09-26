export function engineEnvironment({ isPackaged, env, nativeKernelPath }) {
  // A packaged engine needs OS paths and locale, not the launching shell's
  // provider credentials, build overrides or runtime injection settings.
  const environment = isPackaged
    ? Object.fromEntries(Object.entries(env).filter(([name]) => (
      /^(?:PATH|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|SystemRoot|WINDIR|TEMP|TMP|TMPDIR|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME|LANG|LANGUAGE|LC_[A-Z_]+|TZ)$/iu.test(name)
    )))
    : { ...env }
  for (const name of [
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'NODE_PATH',
    'VIGO_API_PORT',
    'VIGO_API_TRANSPORT',
    'VIGO_CONFIG_DIR',
    'VIGO_DIST_DIR',
    'VIGO_HOST',
    'VIGO_NATIVE_ROUTING_KERNEL',
    'VIGO_PORT',
    'VIGO_PROJECTS_DIR',
  ]) {
    delete environment[name]
  }
  environment.VIGO_API_TRANSPORT = 'memory'
  environment.VIGO_NATIVE_ROUTING_KERNEL = nativeKernelPath
  return environment
}
