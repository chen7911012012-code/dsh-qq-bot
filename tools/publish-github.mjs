#!/usr/bin/env node
/**
 * Publish this bundle to a GitHub repository through the REST API.
 *
 * No git installation is required: every file is uploaded with the Contents
 * API, and only files whose content changed produce a commit. Run it after
 * editing the bundle to keep the repository in sync.
 *
 * Usage:
 *   node tools/publish-github.mjs --repo owner/name [--message "release: 1.1.0"]
 *                                 [--dry-run] [--delete]
 *
 * Token lookup, first match wins:
 *   1. --token <value>
 *   2. GITHUB_TOKEN / GH_TOKEN environment variables
 *   3. %USERPROFILE%\.dsh-qq-bot-token (a file containing only the token)
 *
 * Exit codes: 0 published or nothing to do, 1 failure, 2 usage error.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'https://api.github.com'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = new Set(['.git', 'node_modules', 'publish', '.github-token', '.dsh-qq-bot-token'])

/** Files that belong in the repository. */
const INCLUDE = [
  'index.js', 'impl.js', 'onebot.js', 'cordis.patch.yml', 'icon.svg', 'README.md',
  'package.json', 'LICENSE', 'CHANGELOG.md', 'market-index.json', '安装NapCat.cmd', 'AGENTS.md',
  'docs', 'locale', 'tools',
]

function fail(message, code = 1) {
  console.error(`error: ${message}`)
  process.exit(code)
}

function parseArgs(argv) {
  const options = { repo: '', message: '', token: '', dryRun: false, del: false, release: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo') options.repo = argv[++index] ?? ''
    else if (arg === '--message') options.message = argv[++index] ?? ''
    else if (arg === '--token') options.token = argv[++index] ?? ''
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--delete') options.del = true
    else if (arg === '--release') options.release = true
    else if (arg === '--help' || arg === '-h') {
      console.log('node tools/publish-github.mjs --repo owner/name [--message text] [--release] [--dry-run] [--delete]')
      process.exit(0)
    } else fail(`unknown argument: ${arg}`, 2)
  }
  if (!/^[^/\s]+\/[^/\s]+$/u.test(options.repo)) fail('--repo owner/name is required', 2)
  return options
}

function resolveToken(explicit) {
  if (explicit) return explicit
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = process.env[name]
    if (value && value.trim() !== '') return value.trim()
  }
  const file = path.join(os.homedir(), '.dsh-qq-bot-token')
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
  fail('no GitHub token: pass --token, set GITHUB_TOKEN, or write %USERPROFILE%\\.dsh-qq-bot-token')
  return ''
}

async function request(token, method, url, body) {
  const response = await fetch(`${API}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-qq-bot-publisher',
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  const payload = text === '' ? undefined : JSON.parse(text)
  if (!response.ok) {
    throw new Error(`${method} ${url} -> ${String(response.status)} ${payload?.message ?? text.slice(0, 200)}`)
  }
  return payload
}

/**
 * Take the Markdown body of one version section out of a changelog.
 * @param markdown - full changelog.
 * @param version - version whose section is returned.
 * @returns the section text without its heading, or an empty string.
 */
function changelogSection(markdown, version) {
  const lines = markdown.split(/\r?\n/u)
  const start = lines.findIndex((line) => line.startsWith(`## ${version}`))
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
}

/** Collect files to publish, as repo-relative POSIX paths. */function collect() {
  const files = []
  const walk = (relative) => {
    const absolute = path.join(ROOT, relative)
    if (!fs.existsSync(absolute)) return
    const stat = fs.statSync(absolute)
    if (stat.isDirectory()) {
      if (SKIP.has(path.basename(relative))) return
      for (const entry of fs.readdirSync(absolute)) walk(path.posix.join(relative, entry))
      return
    }
    files.push({ path: relative.replaceAll('\\', '/'), absolute })
  }
  for (const entry of INCLUDE) walk(entry)
  return files
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const token = resolveToken(options.token)
  const [owner, name] = options.repo.split('/')
  const files = collect()
  if (files.length === 0) fail('nothing to publish; run from the bundle directory')

  let user
  try {
    user = await request(token, 'GET', '/user')
  } catch (error) {
    fail(`token rejected: ${error.message}`)
  }

  let exists = true
  try {
    await request(token, 'GET', `/repos/${owner}/${name}`)
  } catch {
    exists = false
  }
  if (!exists) {
    console.log(`creating repository ${owner}/${name}`)
    if (!options.dryRun) {
      await request(token, 'POST', owner === user.login ? '/user/repos' : `/orgs/${owner}/repos`, {
        name,
        description: 'QQ bot bridge for DeepSeek Harness (OneBot v11 / NapCat), one persistent session per QQ chat.',
        homepage: 'https://github.com/deepseek-ai/deepseek-harness',
        private: false,
        has_issues: true,
        auto_init: true,
      })
    }
  }

  const message = options.message || `publish ${new Date().toISOString().slice(0, 10)}`
  let created = 0
  let updated = 0
  let unchanged = 0
  for (const file of files) {
    const content = fs.readFileSync(file.absolute).toString('base64')
    let sha
    try {
      const current = await request(token, 'GET', `/repos/${owner}/${name}/contents/${encodeURI(file.path)}`)
      sha = current.sha
      if (current.content?.replaceAll('\n', '') === content) {
        unchanged += 1
        continue
      }
    } catch {
      sha = undefined
    }
    if (options.dryRun) {
      console.log(`${sha === undefined ? 'create' : 'update'} ${file.path}`)
      if (sha === undefined) created += 1
      else updated += 1
      continue
    }
    await request(token, 'PUT', `/repos/${owner}/${name}/contents/${encodeURI(file.path)}`, {
      message: `${message}: ${file.path}`,
      content,
      branch: 'main',
      ...(sha === undefined ? {} : { sha }),
    })
    if (sha === undefined) created += 1
    else updated += 1
    console.log(`${sha === undefined ? 'created' : 'updated'} ${file.path}`)
  }

  // Pin Git entries in market-index.json to the commit that contains the files
  // just uploaded, so the index installs exactly this tree.
  const indexFile = path.join(ROOT, 'market-index.json')
  if (!options.dryRun && fs.existsSync(indexFile)) {
    try {
      const head = await request(token, 'GET', `/repos/${owner}/${name}/commits/main`)
      const sha = head?.sha
      if (typeof sha === 'string' && /^[0-9a-f]{40}$/u.test(sha)) {
        const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
        let changed = false
        for (const plugin of index.plugins ?? []) {
          for (const version of plugin.versions ?? []) {
            if (version?.source?.type === 'git' && version.source.commit !== sha) {
              version.source.commit = sha
              changed = true
            }
          }
        }
        if (changed) {
          fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`)
          const content = Buffer.from(`${JSON.stringify(index, null, 2)}\n`).toString('base64')
          let sha2
          try {
            sha2 = (await request(token, 'GET', `/repos/${owner}/${name}/contents/market-index.json`)).sha
          } catch {
            sha2 = undefined
          }
          await request(token, 'PUT', `/repos/${owner}/${name}/contents/market-index.json`, {
            message: `${message}: pin market-index.json to ${sha}`,
            content,
            branch: 'main',
            ...(sha2 === undefined ? {} : { sha: sha2 }),
          })
          console.log(`pinned market-index.json to ${sha}`)
        }
      }
    } catch (error) {
      console.warn(`warning: could not pin market-index.json: ${error.message}`)
    }
  }

  if (options.del) {    const tree = await request(token, 'GET', `/repos/${owner}/${name}/git/trees/main?recursive=1`)
    const keep = new Set(files.map((file) => file.path))
    for (const entry of tree.tree ?? []) {
      if (entry.type !== 'blob' || keep.has(entry.path) || SKIP.has(entry.path.split('/')[0])) continue
      if (entry.path.startsWith('.github/')) continue
      if (options.dryRun) {
        console.log(`delete ${entry.path}`)
        continue
      }
      await request(token, 'DELETE', `/repos/${owner}/${name}/contents/${encodeURI(entry.path)}`, {
        message: `${message}: remove ${entry.path}`,
        sha: entry.sha,
        branch: 'main',
      })
      console.log(`deleted ${entry.path}`)
    }
  }

  if (options.release && !options.dryRun) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const tag = `v${pkg.version}`
    const changelogPath = path.join(ROOT, 'CHANGELOG.md')
    const changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : ''
    const body = changelogSection(changelog, pkg.version) || `dsh-qq-bot ${pkg.version}`
    try {
      const head = await request(token, 'GET', `/repos/${owner}/${name}/commits/main`)
      await request(token, 'POST', `/repos/${owner}/${name}/releases`, {
        tag_name: tag,
        target_commitish: head.sha,
        name: `${pkg.name} ${tag}`,
        body,
        draft: false,
        prerelease: false,
      })
      console.log(`release created: ${tag}`)
    } catch (error) {
      console.warn(`warning: could not create release ${tag}: ${error.message}`)
    }
  }

  console.log(`\n${options.dryRun ? '[dry-run] ' : ''}${created} created, ${updated} updated, ${unchanged} unchanged`)
  console.log(`repository: https://github.com/${owner}/${name}`)
}

await main()
