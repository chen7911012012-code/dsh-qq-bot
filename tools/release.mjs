#!/usr/bin/env node
/**
 * Release this bundle: bump the version, keep CHANGELOG and the market index in
 * step, then publish to GitHub (commit + release) through the REST API.
 *
 * Usage:
 *   node tools/release.mjs --repo owner/name [--bump patch|minor|major]
 *                          [--note "本次变更一句话"] [--no-release] [--dry-run]
 *
 * Without --bump the current version is published as-is (docs-only updates).
 * The token is the one tools/publish-github.mjs resolves.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = path.join(ROOT, 'package.json')
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md')
const INDEX = path.join(ROOT, 'market-index.json')

function fail(message, code = 1) {
  console.error(`error: ${message}`)
  process.exit(code)
}

function parseArgs(argv) {
  const options = { repo: '', bump: '', note: '', release: true, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo') options.repo = argv[++index] ?? ''
    else if (arg === '--bump') options.bump = argv[++index] ?? ''
    else if (arg === '--note') options.note = argv[++index] ?? ''
    else if (arg === '--no-release') options.release = false
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      console.log('node tools/release.mjs --repo owner/name [--bump patch|minor|major] [--note text] [--no-release] [--dry-run]')
      process.exit(0)
    } else fail(`unknown argument: ${arg}`, 2)
  }
  if (!/^[^/\s]+\/[^/\s]+$/u.test(options.repo)) fail('--repo owner/name is required', 2)
  if (options.bump !== '' && !['patch', 'minor', 'major'].includes(options.bump)) {
    fail('--bump must be patch, minor, or major', 2)
  }
  return options
}

function bumpVersion(version, kind) {
  const [major, minor, patch] = version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  return version
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const pkg = JSON.parse(fs.readFileSync(PACKAGE, 'utf8'))
  const previous = pkg.version
  const version = options.bump === '' ? previous : bumpVersion(previous, options.bump)
  const today = new Date().toISOString().slice(0, 10)

  if (options.bump !== '') {
    pkg.version = version
    if (!options.dryRun) fs.writeFileSync(PACKAGE, `${JSON.stringify(pkg, null, 2)}\n`)
    const entry = options.note.trim() === '' ? '（补充本次变更说明）' : options.note.trim()
    const existing = fs.existsSync(CHANGELOG) ? fs.readFileSync(CHANGELOG, 'utf8') : '# 更新记录\n'
    const heading = '# 更新记录'
    const body = existing.startsWith(heading) ? existing.slice(heading.length).replace(/^\s*/u, '') : existing
    const next = `${heading}\n\n## ${version} — ${today}\n\n- ${entry}\n\n${body}`
    if (!options.dryRun) fs.writeFileSync(CHANGELOG, next)
    console.log(`version: ${previous} -> ${version}`)
  } else {
    console.log(`version: ${version} (unchanged)`)
  }

  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'))
  const plugin = index.plugins?.[0]
  if (plugin === undefined) fail('market-index.json has no plugins[0]')
  plugin.versions = plugin.versions ?? []
  if (!plugin.versions.some((entry) => entry.version === version)) {
    plugin.versions.unshift({
      version,
      publishTimestamp: Math.floor(Date.now() / 1000),
      engines: pkg.engines?.dsh === undefined ? {} : { dsh: pkg.engines.dsh },
      source: {
        type: 'git',
        url: `https://github.com/${options.repo}`,
        commit: '0'.repeat(40),
      },
    })
    if (!options.dryRun) fs.writeFileSync(INDEX, `${JSON.stringify(index, null, 2)}\n`)
    console.log(`market-index.json: added ${version}`)
  }

  const publishArgs = [path.join(ROOT, 'tools', 'publish-github.mjs'), '--repo', options.repo, '--message', `release: ${version}`]
  if (options.release) publishArgs.push('--release')
  if (options.dryRun) publishArgs.push('--dry-run')
  const result = spawnSync(process.execPath, publishArgs, { stdio: 'inherit', cwd: ROOT })
  process.exit(result.status ?? 1)
}

main()
