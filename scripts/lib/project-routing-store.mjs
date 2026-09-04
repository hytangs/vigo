import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function vigoProjectsDirectory() {
  return path.resolve(process.env.VIGO_PROJECTS_DIR || path.join(os.homedir(), 'Documents', 'Vigo Projects'))
}

export function readProjectRoutingIdentity(projectId, options = {}) {
  const projectsDirectory = path.resolve(options.projectsDirectory || vigoProjectsDirectory())
  const projectRoot = path.join(projectsDirectory, projectId)
  const metadataPath = path.join(projectRoot, '.vigo', 'project.json')
  const project = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
  const routingFeed = project.feeds?.find((feed) => feed.routingStore?.status === 'ready')
  const projectRoutingStore = project.routingStore?.status === 'ready' ? project.routingStore : null
  const routingStore = projectRoutingStore || routingFeed?.routingStore
  if (!routingStore) throw new Error(`${projectId} does not declare a ready routing store.`)

  const defaultFileName = projectRoutingStore ? 'project.sqlite' : `${routingFeed.id}.sqlite`
  const storePath = path.join(projectRoot, '.vigo', 'routing', path.basename(routingStore.fileName || defaultFileName))
  const streetStorePath = path.join(projectRoot, '.vigo', 'osm', 'street-index.sqlite')
  if (options.requireExisting !== false && !fs.existsSync(storePath)) {
    throw new Error(`${projectId} routing store is missing: ${storePath}`)
  }

  return {
    project,
    projectId,
    projectsDirectory,
    projectRoot,
    metadataPath,
    feedId: routingFeed?.id || '__project__',
    routingStore,
    storePath,
    streetStorePath,
  }
}
