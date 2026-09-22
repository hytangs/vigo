import { formatNumber, type FeedSummary } from '../../domain'
import { scheduledVehicleDiagnostics } from '../../scheduledVehicles'

export type MapScope = 'network' | 'route'

export function quietMapLabel(value: string) {
  return value
    .replace(/\bGTFS[-\s]*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || value
}

type FeedIdentity = {
  title: string
  detail: string
  chip: string
  shortLabel: string
}

function compactFeedFileName(fileName = '') {
  const clean = fileName.split(/[\\/]/).pop()?.trim() || ''
  return clean || fileName.trim()
}

function compactFeedVersion(versionLabel = '') {
  const clean = versionLabel.split(',')[0]?.trim() || versionLabel.trim()
  if (!clean || /^local import$/i.test(clean)) return ''
  return clean.length > 18 ? `${clean.slice(0, 17)}...` : clean
}

export function feedIdentity(feeds: FeedSummary[], feed: FeedSummary): FeedIdentity {
  const feedIndex = Math.max(0, feeds.findIndex((item) => item.id === feed.id))
  const duplicateName = feeds.filter((item) => item.name === feed.name).length > 1
  const fileName = compactFeedFileName(feed.fileName)
  const fileStem = fileName.replace(/\.(gtfs\.)?zip$/i, '')
  const version = compactFeedVersion(feed.versionLabel)
  const ordinal = `Feed ${feedIndex + 1}`
  const chip = (duplicateName ? fileStem : feed.provider || fileStem || ordinal).slice(0, 10) || ordinal
  const detailParts = duplicateName
    ? [fileName || ordinal, version]
    : [feed.provider !== feed.name ? feed.provider : fileName, version]
  const detail = detailParts.filter(Boolean).join(' · ') || ordinal

  return {
    title: feed.name,
    detail,
    chip,
    shortLabel: duplicateName ? (fileStem || ordinal) : feed.name,
  }
}

export function liveVehicleDiagnostics(vehicleCount: number, connected = false): ReturnType<typeof scheduledVehicleDiagnostics> {
  return {
    tone: vehicleCount > 0 ? 'good' : connected ? 'watch' : 'empty',
    title: vehicleCount > 0 ? `${formatNumber(vehicleCount)} live vehicles` : connected ? 'Live · 0 positions' : 'Live layer idle',
    detail: vehicleCount > 0
      ? `Rendering all ${formatNumber(vehicleCount)} positioned GTFS-RT vehicles in the live service frame.`
      : connected
        ? 'The Vehicle Positions feed returned no valid coordinates. The live frame stays empty and explicit.'
        : 'No live vehicle positions are being rendered.',
  }
}
