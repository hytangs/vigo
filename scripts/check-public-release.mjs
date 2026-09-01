#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const ignoredDirectories = new Set([
  '.git',
  'dist',
  'dist-cli',
  'node_modules',
  'release',
  'target',
  'temp',
])

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) return []
    if (entry.isFile() && entry.name.endsWith('.node')) return []
    const absolute = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(absolute) : [path.relative(root, absolute)]
  })
}

function publicFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer' })
  if (result.status === 0 && result.stdout.length) {
    return result.stdout.toString('utf8').split('\0').filter(Boolean)
  }
  return walk(root)
}

const files = publicFiles().map((file) => file.split(path.sep).join('/')).sort()
const bannedRoots = [
  'paper/',
  'python/',
  'release/',
  'tmp/',
  'output/',
  'docs/release_nodes/',
  'docs/tutorials/python/',
]
const bannedFiles = new Set([
  'scripts/benchmark-accessibility-workload.mjs',
  'scripts/differential-routing-harness.mjs',
  'scripts/run-routing-adversarial-oracle.mjs',
  'scripts/run-routing-permission-oracle.mjs',
  'scripts/check-routing-adversarial.mjs',
  'scripts/check-routing-properties.mjs',
  'scripts/check-walking-policy-config.mjs',
  'scripts/repair-national-gtfs-untimed-gaps.mjs',
])
const bannedExtensions = new Set([
  '.dmg',
  '.ipynb',
  '.jsonl',
  '.node',
  '.pbf',
  '.pdf',
  '.sqlite',
  '.zip',
])

for (const file of files) {
  assert(!bannedRoots.some((prefix) => file.startsWith(prefix)), `Excluded public path is present: ${file}`)
  assert(!bannedFiles.has(file), `Internal experiment or repair script is present: ${file}`)
  assert(!bannedExtensions.has(path.extname(file).toLowerCase()), `Generated or private data file is present: ${file}`)
  assert(!/(?:^|\/)\.env(?:\.|$)/u.test(file), `Environment file is present: ${file}`)
  assert(!/(?:^|\/)(?:debug|scratch)(?:[._-]|$)/iu.test(file), `Debug or scratch file is present: ${file}`)
}

const textExtensions = new Set([
  '', '.c', '.css', '.html', '.js', '.json', '.md', '.mjs', '.rs', '.toml',
  '.ts', '.tsx', '.txt', '.xml', '.yml', '.yaml',
])
const forbiddenContent = [
  { pattern: /\/(?:Users|Volumes)\/[A-Za-z0-9._-]+/gu, label: 'developer-specific absolute path' },
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/gu, label: 'private key' },
  { pattern: /\bgh(?:p|o|s|r|u)_[A-Za-z0-9]{20,}\b/gu, label: 'GitHub token' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, label: 'GitHub token' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/gu, label: 'AWS access key' },
  { pattern: /https:\/\/github\.com\/hytangs\/vigo-dev(?:\.git)?/gu, label: 'private development remote' },
  { pattern: /v[e]xta/giu, label: 'unrelated product reference' },
  { pattern: /r[a]pidonkey/giu, label: 'private source-tree reference' },
]

let scannedTextFiles = 0
for (const file of files) {
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue
  const absolute = path.join(root, file)
  const source = fs.readFileSync(absolute, 'utf8')
  scannedTextFiles += 1
  for (const rule of forbiddenContent) {
    rule.pattern.lastIndex = 0
    assert(!rule.pattern.test(source), `${file} contains a ${rule.label}.`)
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
assert.equal(packageJson.version, '0.3.0', 'Public package version must be 0.3.0.')
assert.equal(packageJson.license, 'Apache-2.0', 'Public package must use Apache-2.0.')

const workflowFiles = files.filter((file) => file.startsWith('.github/workflows/'))
for (const file of workflowFiles) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  for (const match of source.matchAll(/\buses:\s*[^\s@]+@([^\s#]+)/gu)) {
    assert.match(
      match[1],
      /^[a-f0-9]{40}$/u,
      `${file} must pin ${match[0]} to an immutable commit SHA.`,
    )
  }
}

const releaseWorkflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'release-check.yml'),
  'utf8',
)
const [releaseBuildSection, releaseAttestationSection = ''] = releaseWorkflow.split(/\n  attest-macos-arm64:\n/u)
assert(!releaseBuildSection.includes('id-token: write'), 'The release build job must not receive an OIDC token.')
assert(!releaseBuildSection.includes('attestations: write'), 'The release build job must not receive attestation write access.')
assert(releaseAttestationSection.includes('needs: build-macos-arm64'), 'Attestation must consume the completed read-only build artifact.')
assert(releaseAttestationSection.includes('id-token: write'), 'The isolated attestation job requires OIDC access.')
assert(releaseAttestationSection.includes('attestations: write'), 'The isolated attestation job requires attestation write access.')

console.log(JSON.stringify({
  status: 'passed',
  version: packageJson.version,
  files: files.length,
  scannedTextFiles,
  excludedPublicationMaterial: true,
  excludedPrivateData: true,
  excludedExperimentScripts: true,
  excludedLanguageBindings: true,
  immutableWorkflowActions: true,
  isolatedReleaseAttestation: true,
}, null, 2))
