import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function vigoProjectsDirectory() {
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

const sha256Pattern = /^[a-f0-9]{64}$/
const directionMetadataKeys = Object.freeze([
  'directionRestrictedWayCount',
  'directionExcludedWayCount',
  'uncertainConveyingWayCount',
])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSha256(value) {
  return sha256Pattern.test(String(value ?? ''))
}

function requireStoreIdentity(value, label) {
  const normalized = String(value ?? '').trim()
  if (!normalized) throw new Error(`${label} is missing from authoritative store metadata.`)
  return normalized
}

function requireStoreFingerprint(value, label) {
  const normalized = requireStoreIdentity(value, label)
  if (!isSha256(normalized)) {
    throw new Error(`${label} must be a lowercase SHA-256 fingerprint.`)
  }
  return normalized
}

/**
 * Construct the canonical raw-input identity shared by project rebuilds and
 * result provenance. Input order is significant because it is the declared
 * merge order retained by merged GTFS store metadata.
 */
export function routingDatasetIdentityFromInputs(inputRecords) {
  if (!Array.isArray(inputRecords) || inputRecords.length < 2) {
    throw new Error('Routing dataset identity requires GTFS input(s) and one OSM PBF input.')
  }
  const normalizedInputs = inputRecords.map((input, index) => {
    const kind = requireStoreIdentity(input?.kind, `Input ${index} kind`)
    if (kind !== 'gtfs' && kind !== 'osm-pbf') {
      throw new Error(`Input ${index} kind must be gtfs or osm-pbf; received ${kind}.`)
    }
    const scope = input?.scope === undefined || input?.scope === null
      ? ''
      : String(input.scope).trim()
    const sourceFile = path.basename(requireStoreIdentity(
      input?.path ?? input?.sourceFile,
      `Input ${index} source file`,
    ))
    const sha256 = requireStoreFingerprint(
      input?.sha256 ?? input?.sourceFingerprint,
      `Input ${index} source fingerprint`,
    )
    return { kind, scope, sourceFile, sha256 }
  })
  const gtfsInputs = normalizedInputs.filter((input) => input.kind === 'gtfs')
  const osmInputs = normalizedInputs.filter((input) => input.kind === 'osm-pbf')
  if (!gtfsInputs.length || osmInputs.length !== 1) {
    throw new Error(
      `Routing dataset identity requires at least one GTFS input and exactly one OSM PBF input; `
      + `received ${gtfsInputs.length} GTFS and ${osmInputs.length} OSM PBF input(s).`,
    )
  }
  const fingerprintInput = normalizedInputs
    .map((input) => `${input.kind}:${input.scope}:${input.sourceFile}:${input.sha256}`)
    .join('|')
  return {
    fingerprintInput,
    datasetFingerprint:
      `sha256:${crypto.createHash('sha256').update(fingerprintInput).digest('hex')}`,
    inputs: normalizedInputs,
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function mergedGtfsFingerprint(sources) {
  const canonical = sources
    .map((source) => ({ scope: String(source.scope), sourceFingerprint: String(source.sourceFingerprint) }))
    .sort((left, right) => left.scope.localeCompare(right.scope))
  return crypto.createHash('sha256').update(stableJson(canonical)).digest('hex')
}

function addViolation(violations, code, detail) {
  violations.push({ code, detail })
}

function requireFingerprint(violations, code, label, value) {
  if (!isSha256(value)) {
    addViolation(violations, code, `${label} must contain a lowercase SHA-256 fingerprint.`)
    return null
  }
  return String(value)
}

function requireDirectionMetadata(violations, prefix, label, value) {
  const counts = {}
  for (const key of directionMetadataKeys) {
    const count = value?.[key]
    if (!Object.hasOwn(value ?? {}, key) || !Number.isInteger(count) || count < 0) {
      addViolation(
        violations,
        `${prefix}_${key}`,
        `${label}.${key} must be an explicit non-negative integer.`,
      )
      continue
    }
    counts[key] = count
  }
  return counts
}

function compareFingerprint(violations, code, label, actual, expected) {
  const declared = requireFingerprint(violations, `${code}_invalid`, label, actual)
  if (declared && expected && declared !== expected) {
    addViolation(violations, `${code}_mismatch`, `${label} ${declared} does not match in-store ${expected}.`)
  }
}

function compareDirectionMetadata(violations, prefix, label, actual, expected) {
  const counts = requireDirectionMetadata(violations, prefix, label, actual)
  for (const key of directionMetadataKeys) {
    if (counts[key] !== undefined && expected[key] !== undefined && counts[key] !== expected[key]) {
      addViolation(
        violations,
        `${prefix}_${key}_mismatch`,
        `${label}.${key} ${counts[key]} does not match in-store ${expected[key]}.`,
      )
    }
  }
}

/**
 * Validate the immutable identities required by production release evidence.
 * SQLite metadata is authoritative. Project and atomic-rebuild manifests are
 * cross-checks only; they cannot supply identity that is absent from a store.
 */
export function auditReleaseStoreProvenance({
  project = null,
  rebuildManifest = null,
  gtfsMetadata,
  streetMetadata,
} = {}) {
  const violations = []
  const gtfsFingerprint = requireFingerprint(
    violations,
    'gtfs_store_source_fingerprint',
    'GTFS store metadata.sourceFingerprint',
    gtfsMetadata?.sourceFingerprint,
  )
  const featureInventoryPresent = isRecord(gtfsMetadata?.featureInventory)
    && Object.keys(gtfsMetadata.featureInventory).length > 0
  let featureInventoryValid = featureInventoryPresent
  if (!featureInventoryPresent) {
    addViolation(
      violations,
      'gtfs_store_feature_inventory',
      'GTFS store metadata.featureInventory must be a non-empty imported-feature inventory.',
    )
  } else {
    for (const [key, value] of Object.entries(gtfsMetadata.featureInventory)) {
      if (!Number.isFinite(value) || value < 0) {
        featureInventoryValid = false
        addViolation(
          violations,
          'gtfs_store_feature_inventory_value',
          `GTFS store metadata.featureInventory.${key} must be a finite non-negative number.`,
        )
      }
    }
  }

  const sourceStores = Array.isArray(gtfsMetadata?.sourceStores) ? gtfsMetadata.sourceStores : []
  const sourceStoreByScope = new Map()
  if (gtfsMetadata?.serviceModel === 'exact-date-multi-feed' || sourceStores.length > 0) {
    if (sourceStores.length < 2) {
      addViolation(
        violations,
        'gtfs_store_source_stores',
        'A merged GTFS store must retain at least two component sourceStores.',
      )
    }
    for (const [index, source] of sourceStores.entries()) {
      const scope = String(source?.scope ?? '').trim()
      if (!scope || sourceStoreByScope.has(scope)) {
        addViolation(
          violations,
          'gtfs_store_source_scope',
          `GTFS store sourceStores[${index}] must have a unique non-empty scope.`,
        )
        continue
      }
      const sourceFingerprint = requireFingerprint(
        violations,
        'gtfs_store_component_fingerprint',
        `GTFS store sourceStores[${index}].sourceFingerprint`,
        source?.sourceFingerprint,
      )
      if (sourceFingerprint) sourceStoreByScope.set(scope, sourceFingerprint)
    }
    if (gtfsFingerprint && sourceStoreByScope.size === sourceStores.length && sourceStores.length >= 2) {
      const recomputed = mergedGtfsFingerprint([...sourceStoreByScope].map(([scope, sourceFingerprint]) => ({
        scope,
        sourceFingerprint,
      })))
      if (recomputed !== gtfsFingerprint) {
        addViolation(
          violations,
          'gtfs_store_merged_fingerprint_mismatch',
          `GTFS store merged source fingerprint recomputes to ${recomputed}, not ${gtfsFingerprint}.`,
        )
      }
    }
  }

  if (streetMetadata?.sourceModel !== 'pbf') {
    addViolation(
      violations,
      'street_store_source_model',
      `Street store metadata.sourceModel must be pbf, received ${streetMetadata?.sourceModel ?? 'missing'}.`,
    )
  }
  const streetFingerprint = requireFingerprint(
    violations,
    'street_store_source_fingerprint',
    'Street store metadata.sourceFingerprint',
    streetMetadata?.sourceFingerprint,
  )
  const streetDirections = requireDirectionMetadata(
    violations,
    'street_store',
    'Street store metadata',
    streetMetadata,
  )

  if (project) {
    compareFingerprint(
      violations,
      'project_gtfs_source_fingerprint',
      'Project routingStore.sourceFingerprint',
      project.routingStore?.sourceFingerprint,
      gtfsFingerprint,
    )
    compareFingerprint(
      violations,
      'project_street_source_fingerprint',
      'Project osmStreetIndex.sourceFingerprint',
      project.osmStreetIndex?.sourceFingerprint,
      streetFingerprint,
    )
    if (project.osmStreetIndex?.sourceSha256 !== undefined) {
      compareFingerprint(
        violations,
        'project_street_source_sha256',
        'Project osmStreetIndex.sourceSha256',
        project.osmStreetIndex.sourceSha256,
        streetFingerprint,
      )
    }
    compareDirectionMetadata(
      violations,
      'project_street',
      'Project osmStreetIndex',
      project.osmStreetIndex,
      streetDirections,
    )
  }

  if (rebuildManifest) {
    compareFingerprint(
      violations,
      'rebuild_gtfs_source_fingerprint',
      'Rebuild manifest routingStore.sourceFingerprint',
      rebuildManifest.routingStore?.sourceFingerprint,
      gtfsFingerprint,
    )
    compareFingerprint(
      violations,
      'rebuild_street_source_fingerprint',
      'Rebuild manifest osmStreetIndex.sourceFingerprint',
      rebuildManifest.osmStreetIndex?.sourceFingerprint,
      streetFingerprint,
    )
    if (rebuildManifest.osmStreetIndex?.sourceSha256 !== undefined) {
      compareFingerprint(
        violations,
        'rebuild_street_source_sha256',
        'Rebuild manifest osmStreetIndex.sourceSha256',
        rebuildManifest.osmStreetIndex.sourceSha256,
        streetFingerprint,
      )
    }
    compareDirectionMetadata(
      violations,
      'rebuild_street',
      'Rebuild manifest osmStreetIndex',
      rebuildManifest.osmStreetIndex,
      streetDirections,
    )

    const pbfInputs = (rebuildManifest.inputs ?? []).filter((input) => input.kind === 'osm-pbf')
    if (pbfInputs.length !== 1) {
      addViolation(
        violations,
        'rebuild_osm_input_count',
        `Rebuild manifest must identify exactly one OSM PBF input, received ${pbfInputs.length}.`,
      )
    } else {
      compareFingerprint(
        violations,
        'rebuild_osm_input_fingerprint',
        'Rebuild manifest OSM PBF input sha256',
        pbfInputs[0].sha256,
        streetFingerprint,
      )
    }

    const gtfsInputs = (rebuildManifest.inputs ?? []).filter((input) => input.kind === 'gtfs')
    if (gtfsInputs.length === 1) {
      compareFingerprint(
        violations,
        'rebuild_gtfs_input_fingerprint',
        'Rebuild manifest GTFS input sha256',
        gtfsInputs[0].sha256,
        gtfsFingerprint,
      )
    } else if (gtfsInputs.length > 1) {
      const inputByScope = new Map()
      for (const [index, input] of gtfsInputs.entries()) {
        const scope = String(input?.scope ?? '').trim()
        if (!scope || inputByScope.has(scope)) {
          addViolation(
            violations,
            'rebuild_gtfs_input_scope',
            `Rebuild manifest GTFS input ${index} must have a unique non-empty scope.`,
          )
          continue
        }
        const sourceFingerprint = requireFingerprint(
          violations,
          'rebuild_gtfs_input_fingerprint_invalid',
          `Rebuild manifest GTFS input ${scope} sha256`,
          input.sha256,
        )
        if (sourceFingerprint) inputByScope.set(scope, sourceFingerprint)
      }
      if (sourceStoreByScope.size !== inputByScope.size) {
        addViolation(
          violations,
          'rebuild_gtfs_component_count_mismatch',
          `Rebuild manifest has ${inputByScope.size} GTFS scope(s), but store metadata has ${sourceStoreByScope.size}.`,
        )
      }
      for (const [scope, inputFingerprint] of inputByScope) {
        if (!sourceStoreByScope.has(scope)) {
          addViolation(
            violations,
            'rebuild_gtfs_component_scope_mismatch',
            `Rebuild manifest GTFS scope ${scope} is absent from store metadata.sourceStores.`,
          )
        } else if (sourceStoreByScope.get(scope) !== inputFingerprint) {
          addViolation(
            violations,
            'rebuild_gtfs_component_fingerprint_mismatch',
            `Rebuild manifest GTFS scope ${scope} fingerprint does not match store metadata.sourceStores.`,
          )
        }
      }
      if (inputByScope.size === gtfsInputs.length) {
        const recomputed = mergedGtfsFingerprint([...inputByScope].map(([scope, sourceFingerprint]) => ({
          scope,
          sourceFingerprint,
        })))
        if (gtfsFingerprint && recomputed !== gtfsFingerprint) {
          addViolation(
            violations,
            'rebuild_gtfs_merged_fingerprint_mismatch',
            `Rebuild manifest GTFS inputs recompute to ${recomputed}, not in-store ${gtfsFingerprint}.`,
          )
        }
      }
    }
  }

  return {
    schemaVersion: 'vigo.release-store-provenance.v1',
    passed: violations.length === 0,
    gtfs: {
      sourceFingerprint: gtfsFingerprint,
      featureInventoryPresent,
      featureInventoryValid,
      componentCount: sourceStoreByScope.size,
    },
    street: {
      sourceModel: streetMetadata?.sourceModel ?? null,
      sourceFingerprint: streetFingerprint,
      ...Object.fromEntries(directionMetadataKeys.map((key) => [key, streetDirections[key] ?? null])),
    },
    manifests: {
      projectChecked: Boolean(project),
      rebuildChecked: Boolean(rebuildManifest),
    },
    violations,
  }
}

export function assertReleaseStoreProvenance(input) {
  const audit = auditReleaseStoreProvenance(input)
  if (!audit.passed) {
    const detail = audit.violations.map((violation) => `${violation.code}: ${violation.detail}`).join('; ')
    const error = new Error(`Release store provenance failed: ${detail}`)
    error.code = 'VIGO_RELEASE_STORE_PROVENANCE'
    error.audit = audit
    throw error
  }
  return audit
}
