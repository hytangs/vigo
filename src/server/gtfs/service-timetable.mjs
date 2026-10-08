import { readNativeServiceTimetable } from '../native-routing-kernel.mjs'

export function readServiceTimetable(store, services, segmentCount) {
  const result = readNativeServiceTimetable({
    storePath: store.storePath,
    stopIds: [...store.stopRecords.keys()],
    serviceIds: [...services],
    hasConnectionPermissions: store.hasConnectionPermissions,
    ...(store.activeServiceInstances ? { serviceInstances: store.activeServiceInstances } : segmentCount == null ? {} : { segmentCount }),
  })
  return { ...result, stopIndex: new Map(result.stopIds.map((id, index) => [id, index])) }
}
