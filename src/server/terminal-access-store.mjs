import path from 'node:path'
import { disposeNativeRoutingKernel } from './native-routing-kernel.mjs'
import { disposeNationalGtfsStore } from './national-gtfs-store.mjs'
import { runCityCompiler } from './runtime/city-compiler.mjs'

// Authorized endpoint access is compiled by the `vigo` executable from the
// original PBF: mapped private paths and gates linked to the public streets
// that the routing store's stations reach.
export async function buildTerminalAccessStore({ pbfPath, streetStorePath, routingStorePath }) {
  const result = await runCityCompiler('_build-terminal-access', [
    `--osm=${path.resolve(pbfPath)}`, `--street-store=${path.resolve(streetStorePath)}`,
    `--routing-store=${path.resolve(routingStorePath)}`,
  ], { label: 'Endpoint access compiler' })
  disposeNativeRoutingKernel(streetStorePath)
  disposeNationalGtfsStore(routingStorePath)
  return result
}
