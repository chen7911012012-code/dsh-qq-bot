/**
 * DeepSeek Harness <-> QQ bot bridge.
 *
 * Transport: OneBot v11 forward WebSocket (NapCat, go-cqhttp, Lagrange).
 * Model side: one persistent DSH session per QQ chat, driven through the Host
 * `agents` / `sessions` services, so every conversation is a normal DSH session
 * that also appears in the Web UI.
 *
 * @module @local/dsh-qq-bot
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { OneBotClient } = await import(new URL(`./onebot.js?t=${Date.now()}`, import.meta.url).href)

/** Services that must exist before the bridge can start. */
export const inject = ['agents', 'sessions']

const DEFAULTS = {
  wsUrl: 'ws://127.0.0.1:3001',
  accessToken: '',
  workdir: '',
  allowedUsers: [],
  allowedGroups: [],
  groupMentionRequired: true,
  approvalMode: 'ask-qq',
  idleTimeoutMinutes: 30,
  progressNoticeSeconds: 12,
  replyChunkSize: 1500,
  allowedTools: [],
  groupAnyone: true,
  quoteContext: true,
  owner: '',
  repo: 'chen7911012012-code/dsh-qq-bot',
  creatorMode: false,
  napcatInstallDir: '',
  napcatPort: 3001,
  groupSessionTools: ['read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch'],
  provider: '',
  model: '',
  preset: '',
  approvalTimeoutSeconds: 180,
  maxMediaBytes: 20 * 1024 * 1024,
}

const APPROVAL_MODES = new Set(['ask-qq', 'allow-all', 'deny-all'])
const COMMAND_PREFIXES = ['/', '／']

/** Normalize the plugin row config. */
function normalizeConfig(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) }
  const list = (value) => (Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [])
  return {
    ...config,
    wsUrl: String(config.wsUrl || DEFAULTS.wsUrl),
    accessToken: typeof config.accessToken === 'string' ? config.accessToken : '',
    workdir: typeof config.workdir === 'string' ? config.workdir : '',
    allowedUsers: list(config.allowedUsers),
    allowedGroups: list(config.allowedGroups),
    allowedTools: list(config.allowedTools),
    groupSessionTools: list(config.groupSessionTools),
    groupAnyone: config.groupAnyone !== false,
    quoteContext: config.quoteContext !== false,
    owner: typeof config.owner === 'string' ? config.owner.trim() : '',
    repo: typeof config.repo === 'string' && /^[^/\s]+\/[^/\s]+$/u.test(config.repo.trim())
      ? config.repo.trim()
      : DEFAULTS.repo,
    creatorMode: config.creatorMode === true,
    napcatInstallDir: typeof config.napcatInstallDir === 'string' ? config.napcatInstallDir.trim() : '',
    napcatPort: clamp(Number(config.napcatPort), 1, 65535, 3001),
    groupMentionRequired: config.groupMentionRequired !== false,
    approvalMode: APPROVAL_MODES.has(config.approvalMode) ? config.approvalMode : 'ask-qq',
    idleTimeoutMinutes: clamp(Number(config.idleTimeoutMinutes), 1, 24 * 60, 30),
    progressNoticeSeconds: clamp(Number(config.progressNoticeSeconds), 0, 600, 12),
    replyChunkSize: clamp(Number(config.replyChunkSize), 200, 4000, 1500),
    approvalTimeoutSeconds: clamp(Number(config.approvalTimeoutSeconds), 10, 3600, 180),
    maxMediaBytes: clamp(Number(config.maxMediaBytes), 1024, 200 * 1024 * 1024, DEFAULTS.maxMediaBytes),
    provider: typeof config.provider === 'string' ? config.provider : '',
    model: typeof config.model === 'string' ? config.model : '',
    preset: typeof config.preset === 'string' ? config.preset.trim() : '',
  }
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), min), max)
}

/** Split text into chat-sized chunks without cutting inside a line when possible. */
function chunkText(text, limit) {
  const chunks = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.4) cut = limit
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** Quote one value for an error line. */
function shortError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 400 ? `${message.slice(0, 400)}…` : message
}

/** Read this package's manifest, for the local version. */
function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'))
  } catch {
    return { name: '@local/dsh-qq-bot', version: '0.0.0' }
  }
}

/** Compare dotted versions; positive when the left one is newer. */
function compareVersions(left, right) {
  const parts = (value) => String(value).replace(/^v/iu, '').split(/[.+-]/u).map((piece) => Number.parseInt(piece, 10) || 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Fetch one GitHub API document. */
async function githubJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'dsh-qq-bot', accept: 'application/vnd.github+json' },
  })
  if (!response.ok) throw new Error(`GitHub HTTP ${String(response.status)}`)
  return await response.json()
}

export function apply(ctx, rawConfig) {
  const profileDir = process.env.DSH_PROFILE_DIR ?? process.cwd()
  const dataDir = path.join(profileDir, '.qq-bot')
  const overridePath = path.join(dataDir, 'override.json')
  // A profile patch change needs a Harness restart; override.json is read at
  // activation so a live plugin reload (disable then enable) applies it.
  const config = normalizeConfig({ ...(rawConfig ?? {}), ...readOverride(overridePath) })
  const workdir = path.resolve(config.workdir === '' ? path.join(profileDir, 'qq-workspace') : config.workdir)
  const statePath = path.join(dataDir, 'state.json')
  const logPath = path.join(dataDir, 'bridge.log')

  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(workdir, { recursive: true })
  fs.mkdirSync(path.join(workdir, 'qq-media'), { recursive: true })

  const log = (line) => {
    const entry = `[${new Date().toISOString()}] ${line}`
    try {
      fs.appendFileSync(logPath, `${entry}\n`)
    } catch {
      /* ignore log write failures */
    }
    try {
      ctx.logger?.info?.(entry)
    } catch {
      /* ignore logger failures */
    }
  }

  /** chatKey -> sessionId, persisted so /new survives restarts. */
  const state = readState(statePath)
  const saveState = () => writeState(statePath, state)

  /** sessionId -> live chat record. */
  const chats = new Map()
  /** chatKey -> pending agent creation, so concurrent messages share one agent. */
  const creating = new Map()
  let client
  let selfId = ''

  const bridge = {
    log,
    config,
    workdir,

    /** Merge fields into override.json so they survive a Harness restart. */
    persistConfig(patch) {
      return writeOverride(overridePath, patch)
    },

    /** Read the newest GitHub release of this plugin. */
    async checkUpdate() {
      const manifest = readManifest()
      const release = await githubJson(`https://api.github.com/repos/${config.repo}/releases/latest`)
      const version = String(release.tag_name ?? '').replace(/^v/iu, '')
      return {
        current: String(manifest.version),
        latest: version,
        hasUpdate: compareVersions(version, manifest.version) > 0,
        notes: String(release.body ?? '').slice(0, 2000),
        url: String(release.html_url ?? ''),
        publishedAt: String(release.published_at ?? ''),
      }
    },

    /** Install the newest release through the DSH plugin manager. */
    async applyUpdate() {
      const manifest = readManifest()
      const info = await this.checkUpdate()
      if (!info.hasUpdate) return { ok: true, message: `已是最新版本 ${info.current}`, spec: '' }
      const commit = await githubJson(`https://api.github.com/repos/${config.repo}/commits/${encodeURIComponent(`v${info.latest}`)}`)
      const sha = String(commit.sha ?? '')
      if (!/^[0-9a-f]{40}$/u.test(sha)) return { ok: false, message: '无法解析该版本的提交', spec: '' }
      const spec = `git+https://github.com/${config.repo}.git#${sha}`
      const manager = ctx.get?.('pluginManager')
      if (manager === undefined) return { ok: false, message: '当前环境没有 pluginManager，请手动安装', spec }
      const result = await manager.installBundle(spec, { expected: { name: manifest.name, version: info.latest } })
      const application = String(result?.application ?? 'unknown')
      return {
        ok: application === 'applied' || application === 'restart-required',
        message: `新版本 ${info.latest} 安装结果：${application}`,
        spec,
      }
    },

    chatKeyFor(event) {
      return event.message_type === 'group'
        ? `group-${event.group_id}`
        : `private-${event.user_id}`
    },

    sessionIdFor(event) {
      const key = this.chatKeyFor(event)
      const stored = state.chats[key]
      if (typeof stored === 'string' && stored.length > 0) return stored
      const sessionId = `qq-${key}-${Date.now().toString(36)}`
      state.chats[key] = sessionId
      saveState()
      return sessionId
    },

    /** True when the sender is the configured owner (or when no owner is set). */
    isOwner(event) {
      const userId = String(event.user_id ?? '')
      if (config.owner !== '') return userId === config.owner
      return config.allowedUsers.length === 0 || config.allowedUsers.includes(userId)
    },

    allowed(event) {
      const userId = String(event.user_id ?? '')
      if (userId === '' || userId === selfId) return false
      if (event.message_type === 'group') {
        const groupId = String(event.group_id ?? '')
        if (config.allowedGroups.length > 0 && !config.allowedGroups.includes(groupId)) return false
        // groupAnyone opens the group to every member; otherwise only the owner asks.
        return config.groupAnyone || this.isOwner(event)
      }
      // Private chat belongs to the owner as soon as one is configured.
      return this.isOwner(event)
    },

    /** Build the model-facing text plus downloaded media notes from one OneBot message. */
    async readMessage(event) {
      const segments = Array.isArray(event.message) ? event.message : []
      const parts = []
      let mentioned = false
      let replyId
      for (const segment of segments) {
        const type = segment?.type
        const data = segment?.data ?? {}
        if (type === 'text') {
          parts.push(String(data.text ?? ''))
        } else if (type === 'at') {
          const qq = String(data.qq ?? '')
          if (qq === selfId) mentioned = true
          if (qq !== 'all' && qq !== selfId) parts.push(`@${data.name ?? qq}`)
        } else if (type === 'image') {
          const note = await this.downloadMedia(data, 'image')
          parts.push(note)
        } else if (type === 'file') {
          const note = await this.downloadMedia(data, 'file')
          parts.push(note)
        } else if (type === 'reply') {
          replyId = data.id
        } else if (type === 'face') {
          continue
        } else if (type === 'record') {
          parts.push('[语音消息：暂不支持转写]')
        } else if (type === 'video') {
          parts.push('[视频消息：暂不支持]')
        } else if (type === 'mface' || type === 'json' || type === 'xml') {
          parts.push(`[${type} 卡片消息]`)
        }
      }
      if (config.quoteContext && replyId !== undefined && replyId !== '') {
        const quoted = await this.readQuoted(replyId)
        if (quoted !== '') parts.unshift(quoted)
      }
      return { mentioned, text: parts.join('').trim() }
    },

    /**
     * Resolve a quoted (replied-to) message and turn its text and media into
     * context, so "@bot 看看这张图" with a reply works in groups.
     * @param replyId - the OneBot message id carried by the reply segment.
     * @returns a bracketed context line, or an empty string when unusable.
     */
    async readQuoted(replyId) {
      let quoted
      try {
        const numeric = Number(replyId)
        quoted = await client.call('get_msg', { message_id: Number.isSafeInteger(numeric) ? numeric : replyId }, 15_000)
      } catch (error) {
        log(`quoted message ${String(replyId)} unavailable: ${shortError(error)}`)
        return '[引用的消息读取失败]'
      }
      const segments = Array.isArray(quoted?.message) ? quoted.message : []
      if (segments.length === 0) return '[引用的消息内容为空]'
      const sender = String(quoted?.sender?.card || quoted?.sender?.nickname || quoted?.sender?.user_id || quoted?.user_id || '某人')
      const pieces = []
      for (const segment of segments) {
        const type = segment?.type
        const data = segment?.data ?? {}
        if (type === 'text') pieces.push(String(data.text ?? ''))
        else if (type === 'image') pieces.push(await this.downloadMedia(data, 'image'))
        else if (type === 'file') pieces.push(await this.downloadMedia(data, 'file'))
        else if (type === 'face' || type === 'reply') continue
        else if (type === 'video') pieces.push('[视频]')
        else if (type === 'record') pieces.push('[语音]')
      }
      const body = pieces.join('').replace(/\s+/gu, ' ').trim()
      const clipped = body.length > 800 ? `${body.slice(0, 800)}…` : body
      log(`quoted message from ${sender} resolved (${segments.length} segments)`)
      return clipped === ''
        ? `[引用了 ${sender} 的一条消息，没有可读内容]`
        : `[引用了 ${sender} 的消息：${clipped}]`
    },

    async downloadMedia(data, kind) {
      const url = typeof data.url === 'string' ? data.url : ''
      if (url === '') return `[${kind}：NapCat 未提供下载地址，无法读取]`
      try {
        const response = await fetch(url)
        if (!response.ok) return `[${kind}：下载失败 HTTP ${response.status}]`
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.byteLength > config.maxMediaBytes) return `[${kind}：文件过大（${buffer.byteLength} 字节），已跳过]`
        const name = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}${extensionFor(data, kind)}`
        const target = path.join(workdir, 'qq-media', name)
        fs.writeFileSync(target, buffer)
        log(`saved ${kind} to ${target} (${buffer.byteLength} bytes)`)
        return `[用户发送了${kind === 'image' ? '图片' : '文件'}，已保存到 ${target}]`
      } catch (error) {
        return `[${kind}：下载出错 ${shortError(error)}]`
      }
    },

    /** Send one chat message, chunked, with an optional @ of the sender in groups. */
    async send(event, text) {
      const chunks = chunkText(text, config.replyChunkSize)
      const group = event.message_type === 'group'
      for (const [index, chunk] of chunks.entries()) {
        const message = []
        if (group && index === 0 && String(event.user_id ?? '') !== '') {
          message.push({ type: 'at', data: { qq: String(event.user_id) } })
          message.push({ type: 'text', data: { text: '\n' } })
        }
        message.push({ type: 'text', data: { text: chunk } })
        try {
          if (group) {
            await client.call('send_group_msg', { group_id: event.group_id, message })
          } else {
            await client.call('send_private_msg', { user_id: event.user_id, message })
          }
        } catch (error) {
          log(`send failed: ${shortError(error)}`)
          return
        }
      }
    },

    async sendPlain(chatKey, text) {
      const chat = chats.get(chatKey)
      if (chat === undefined) return
      await this.send(chat.event, text)
    },

    /** Resolve (resume or create) the agent that owns one chat's session. */
    async ensureChat(event) {
      const key = this.chatKeyFor(event)
      const existing = chats.get(key)
      if (existing !== undefined) {
        existing.event = event
        existing.lastActive = Date.now()
        return existing
      }
      const pending = creating.get(key)
      if (pending !== undefined) return await pending

      const sessionId = this.sessionIdFor(event)
      const promise = this.openChat(key, sessionId, event)
      creating.set(key, promise)
      try {
        return await promise
      } finally {
        creating.delete(key)
      }
    },

    async openChat(key, sessionId, event) {
      const chat = {
        key,
        sessionId,
        event,
        handle: undefined,
        lastActive: Date.now(),
        pendingTurns: 0,
        replies: [],
        noticeTimer: undefined,
        approval: undefined,
        lastError: '',
      }
      const agentOptions = this.agentOptions()
      const presets = ctx.get('agentPresets')
      let presetId
      if (presets !== undefined) {
        try {
          presetId = (await presets.resolve(config.preset === '' ? undefined : config.preset)).id
        } catch (error) {
          log(`preset resolve failed, continuing without a preset: ${shortError(error)}`)
        }
      }
      const setup = async (agentCtx) => {
        if (presets !== undefined && presetId !== undefined) {
          await presets.mount(agentCtx, presetId)
        }
        agentCtx.on('approval/request', (request, next) => this.answerApproval(chat, request, next), { prepend: true })
        const toolAllowlist = event.message_type === 'group' && config.groupSessionTools.length > 0
          ? config.groupSessionTools
          : config.allowedTools
        if (toolAllowlist.length > 0) {
          const tools = agentCtx.get?.('tools')
          if (tools !== undefined) {
            try {
              tools.restrict({ allow: toolAllowlist })
            } catch (error) {
              log(`tool restriction failed: ${shortError(error)}`)
            }
          }
        }
      }
      chat.preset = presetId

      const live = ctx.agents.get(sessionId)
      if (live !== undefined) {
        // Someone else (for example the Web UI) already owns this session.
        chat.agent = live
        chats.set(key, chat)
        log(`attach live agent ${sessionId}`)
        return chat
      }
      if (ctx.sessions.get(sessionId) !== undefined) {
        const agent = ctx.agents.get(sessionId)
        if (agent !== undefined) {
          chat.agent = agent
          chats.set(key, chat)
          return chat
        }
      }

      const persistence = ctx.get('sessionPersistence')
      const stored = persistence === undefined ? undefined : await persistence.stat(sessionId).catch(() => undefined)
      try {
        if (stored !== undefined) {
          const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
          chat.handle = handle
          chat.agent = handle.agent
          log(`resumed ${sessionId}`)
        } else {
          const handle = await ctx.agents.create({ sessionId, meta: { cwd: workdir }, agentOptions, setup })
          chat.handle = handle
          chat.agent = handle.agent
          log(`created ${sessionId}`)
        }
      } catch (error) {
        log(`open ${sessionId} failed: ${shortError(error)}`)
        throw error
      }
      chats.set(key, chat)
      return chat
    },

    agentOptions() {
      const selection = config.provider !== '' && config.model !== ''
        ? { provider: config.provider, model: config.model }
        : ctx.get('agentDefaultModel')?.currentSelection?.()
      if (selection === undefined || selection === null) return undefined
      const options = {}
      if (typeof selection.provider === 'string') options.provider = selection.provider
      if (typeof selection.model === 'string') options.model = selection.model
      if (typeof selection.reasoningEffort === 'string') options.reasoningEffort = selection.reasoningEffort
      return Object.keys(options).length > 0 ? options : undefined
    },

    async prompt(chat, text) {
      chat.replies = []
      chat.pendingTurns += 1
      chat.lastError = ''
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }
      try {
        chat.agent.followup(message)
      } catch (error) {
        chat.pendingTurns = Math.max(0, chat.pendingTurns - 1)
        throw error
      }
      this.armNotice(chat)
    },

    armNotice(chat) {
      clearTimeout(chat.noticeTimer)
      if (config.progressNoticeSeconds <= 0) return
      chat.noticeTimer = setTimeout(() => {
        if (chat.pendingTurns === 0) return
        void this.send(chat.event, '正在处理，请稍候…')
      }, config.progressNoticeSeconds * 1000)
      chat.noticeTimer.unref?.()
    },

    /** Feed one session event into the reply collector. */
    onSessionEvent(session, event) {
      const chat = findChat(session.id)
      if (chat === undefined) return
      if (event.type === 'assistant/message') {
        const message = event.data?.message
        const text = (message?.content ?? [])
          .filter((block) => block?.type === 'text')
          .map((block) => block.text)
          .join('')
          .trim()
        if (text !== '') chat.replies.push(text)
        return
      }
      if (event.type === 'turn/end') {
        const reason = event.data?.reason ?? { kind: 'completed' }
        if (chat.pendingTurns > 0) chat.pendingTurns -= 1
        if (chat.pendingTurns > 0) return
        clearTimeout(chat.noticeTimer)
        const reply = chat.replies.length > 0 ? chat.replies.at(-1) : ''
        chat.replies = []
        this.finishTurn(chat, reason, reply)
      }
    },

    finishTurn(chat, reason, reply) {
      const prefix = reason?.kind === 'error'
        ? `本轮出错：${reason.error?.message ?? '未知错误'}\n\n`
        : reason?.kind === 'aborted'
          ? '已停止。\n\n'
          : reason?.kind === 'max-tokens'
            ? '（输出达到长度上限）\n\n'
            : ''
      const body = reply !== '' ? reply : reason?.kind === 'completed' ? '（本轮没有文字输出）' : ''
      const text = `${prefix}${body}`.trim()
      if (text === '') return
      void this.send(chat.event, text)
    },

    /** Ask the QQ user to approve one tool call. */
    async answerApproval(chat, request, next) {
      log(`approval asked via qq: tool=${request.toolName} mode=${config.approvalMode}`)
      if (config.approvalMode === 'allow-all') return 'allowed-once'
      if (config.approvalMode === 'deny-all') return 'rejected'
      if (chat.approval !== undefined) return 'rejected'
      const reason = request.reason ?? request.displayReason?.zh ?? request.displayReason?.en ?? ''
      const lines = [
        '需要你的授权才能继续：',
        `工具：${request.toolName}`,
      ]
      if (reason !== '') lines.push(`原因：${reason}`)
      lines.push('', `回复 /y 允许一次，/n 拒绝（${config.approvalTimeoutSeconds} 秒内有效）。`)
      await this.send(chat.event, lines.join('\n'))
      return await new Promise((resolve) => {
        const finish = (outcome) => {
          clearTimeout(timer)
          if (chat.approval?.resolve === finish) chat.approval = undefined
          resolve(outcome)
        }
        const timer = setTimeout(() => {
          void this.send(chat.event, '授权请求已超时，本次操作按拒绝处理。')
          finish('rejected')
        }, config.approvalTimeoutSeconds * 1000)
        timer.unref?.()
        chat.approval = { resolve: finish, toolName: request.toolName, requestedAt: Date.now() }
        request.signal?.addEventListener?.('abort', () => finish('cancelled'), { once: true })
      })
    },

    async handleMessage(event) {
      if (!this.allowed(event)) return
      const { mentioned, text } = await this.readMessage(event)
      if (event.message_type === 'group' && config.groupMentionRequired && !mentioned) return
      const content = text.replace(/^\s+|\s+$/g, '')
      if (content === '') return
      log(`message ${event.message_type} from ${event.user_id}${event.message_type === 'group' ? ` in group ${event.group_id}` : ''}: ${content.slice(0, 60)}`)

      const key = this.chatKeyFor(event)
      const existing = chats.get(key)
      if (existing !== undefined) existing.event = event

      if (await this.handleCommand(event, key, content)) return

      let chat
      try {
        chat = await this.ensureChat(event)
      } catch (error) {
        await this.send(event, `无法建立会话：${shortError(error)}`)
        return
      }
      if (chat.pendingTurns > 0) {
        await this.send(event, '已加入队列，等当前回复结束后处理。')
      }
      try {
        await this.prompt(chat, content)
      } catch (error) {
        await this.send(event, `发送失败：${shortError(error)}`)
      }
    },

    async handleCommand(event, key, content) {
      if (!COMMAND_PREFIXES.some((prefix) => content.startsWith(prefix))) return false
      const [rawCommand, ...rest] = content.slice(1).split(/\s+/)
      const command = rawCommand.toLowerCase()
      const chat = chats.get(key)
      const ownerOnly = new Set(['new', 'reset', 'stop', 'status', 'reload', 'update', 'publish'])
      if (ownerOnly.has(command) && !this.isOwner(event)) {
        await this.send(event, '这条命令只有主人可以用。主人在私聊里发 /owner 设置。')
        return true
      }

      if (command === 'owner' || command === 'setowner') {
        const requested = (rest[0] ?? '').replace(/[^0-9]/g, '')
        if (requested === '') {
          const current = config.owner === '' ? '（未设置）' : config.owner
          await this.send(event, `当前主人：${current}\n用法：私聊发 /owner 你的QQ号 来设置。`)
          return true
        }
        if (event.message_type !== 'private') {
          await this.send(event, '为了安全，设置主人请在私聊里进行。')
          return true
        }
        const userId = String(event.user_id ?? '')
        if (config.owner !== '' && userId !== config.owner) {
          await this.send(event, `只有当前主人（${config.owner}）能更换主人。`)
          return true
        }
        if (config.owner === '' && !this.isOwner(event)) {
          await this.send(event, '你不在允许名单里，无法认领主人身份。')
          return true
        }
        config.owner = requested
        const saved = this.persistConfig({ owner: requested })
        await this.send(event, `主人已设置为 ${requested}。${saved ? '' : '（配置写入失败，重启后会失效）'}`)
        log(`owner set to ${requested}`)
        return true
      }

      if (command === 'update') {
        const action = (rest[0] ?? '').toLowerCase()
        try {
          if (action === 'apply' || action === 'install') {
            await this.send(event, '正在安装更新，请稍候…')
            const result = await this.applyUpdate()
            await this.send(event, result.ok
              ? `更新完成：${result.message}`
              : `更新失败：${result.message}${result.spec === '' ? '' : `\n安装参数：${result.spec}`}`)
            return true
          }
          const info = await this.checkUpdate()
          await this.send(event, info.hasUpdate
            ? `发现新版本 ${info.latest}（当前 ${info.current}）\n\n${info.notes === '' ? '（无更新说明）' : info.notes}\n\n回复 /update apply 安装。`
            : `已是最新版本 ${info.current}。`)
        } catch (error) {
          await this.send(event, `检查更新失败：${shortError(error)}`)
        }
        return true
      }

      if (command === 'publish') {
        if (!config.creatorMode) {
          await this.send(event, '当前不是创作者模式，未启用发布命令。')
          return true
        }
        const note = rest.join(' ').trim()
        await this.send(event, '正在发布到 GitHub，请稍候…')
        try {
          const script = fileURLToPath(new URL('./tools/release.mjs', import.meta.url))
          const argv = [script, '--repo', config.repo, '--bump', 'patch']
          if (note !== '') argv.push('--note', note)
          const output = await runProcess(process.execPath, argv, undefined, { ...process.env, ELECTRON_RUN_AS_NODE: '1' })
          const tail = output.text.slice(-700)
          await this.send(event, output.code === 0 ? `发布成功：\n${tail}` : `发布失败：\n${tail}`)
        } catch (error) {
          await this.send(event, `发布出错：${shortError(error)}`)
        }
        return true
      }

      if (command === 'help' || command === '?') {
        await this.send(event, [
          '可用命令：',
          '/owner [QQ号] 查看或设置主人（私聊）',
          '/update 检查 GitHub 上的新版本；/update apply 安装',
          ...config.creatorMode ? ['/publish <说明> 发布新版本到 GitHub（创作者）'] : [],
          '/new 开启新会话（仅主人）',
          '/status 查看会话状态（仅主人）',
          '/reload 从磁盘重新加载当前会话（仅主人）',
          '/stop 停止当前回复（仅主人）',
          '/id 查看当前 DSH 会话 id',
          '/y 或 /n 同意或拒绝待授权的工具调用',
          '其他内容会作为消息交给 DSH 助手。',
        ].join('\n'))
        return true
      }
      if (command === 'y' || command === 'n' || command === 'yes' || command === 'no') {
        if (chat?.approval === undefined) {
          await this.send(event, '当前没有待授权的操作。')
          return true
        }
        const allow = command === 'y' || command === 'yes'
        chat.approval.resolve(allow ? 'allowed-once' : 'rejected')
        await this.send(event, allow ? '已允许，继续执行。' : '已拒绝。')
        return true
      }
      if (command === 'new' || command === 'reset') {
        const old = chats.get(key)
        if (old !== undefined) await this.disposeChat(old, 'reset by user')
        delete state.chats[key]
        saveState()
        await this.send(event, '已开启新会话，之前的内容仍保存在 DSH 会话列表中。')
        return true
      }
      if (command === 'stop') {
        if (chat?.agent === undefined || chat.pendingTurns === 0) {
          await this.send(event, '当前没有正在进行的回复。')
          return true
        }
        try {
          chat.agent.cancel({ kind: 'user' })
          await this.send(event, '已请求停止当前回复。')
        } catch (error) {
          await this.send(event, `停止失败：${shortError(error)}`)
        }
        return true
      }
      if (command === 'id') {
        await this.send(event, `会话 id：${state.chats[key] ?? '（尚未创建）'}`)
        return true
      }
      if (command === 'reload') {
        const sessionId = state.chats[key]
        if (sessionId === undefined) {
          await this.send(event, '当前还没有会话，直接发消息即可。')
          return true
        }
        const current = chats.get(key)
        if (current !== undefined) await this.disposeChat(current, 'reload by user')
        try {
          const reopened = await this.openChat(key, sessionId, event)
          const turns = reopened.agent?.session?.deriveMessages?.().filter((message) => message.role === 'user').length ?? 0
          await this.send(event, `已从磁盘重新加载会话 ${sessionId}（历史包含 ${turns} 条用户消息）。`)
        } catch (error) {
          await this.send(event, `重新加载失败：${shortError(error)}`)
        }
        return true
      }
      if (command === 'status') {
        const lines = [
          `连接：${client?.state ?? 'offline'}`,
          `工作目录：${workdir}`,
          `会话：${state.chats[key] ?? '（尚未创建）'}`,
          `状态：${chat === undefined ? '未加载' : chat.pendingTurns > 0 ? '处理中' : '空闲'}`,
          `模型：${config.provider !== '' ? `${config.provider}/${config.model}` : '跟随 DSH 默认'}`,
          `预设：${chat?.preset ?? (config.preset === '' ? '默认' : config.preset)}`,
          `授权：${config.approvalMode}`,
          `主人：${config.owner === '' ? '（未设置）' : config.owner}`,
        ]
        await this.send(event, lines.join('\n'))
        return true
      }
      return false
    },

    async disposeChat(chat, reason) {
      clearTimeout(chat.noticeTimer)
      if (chat.approval !== undefined) chat.approval.resolve('cancelled')
      chats.delete(chat.key)
      chatsBySession.delete(chat.sessionId)
      if (chat.handle === undefined) return
      try {
        chat.agent?.cancel?.({ kind: 'disposed' })
      } catch {
        /* ignore */
      }
      try {
        await chat.handle.dispose()
        log(`disposed ${chat.sessionId} (${reason})`)
      } catch (error) {
        log(`dispose ${chat.sessionId} failed: ${shortError(error)}`)
      }
    },

    async evictIdle() {
      const deadline = Date.now() - config.idleTimeoutMinutes * 60_000
      for (const chat of [...chats.values()]) {
        if (chat.pendingTurns > 0) continue
        if (chat.approval !== undefined) continue
        if (chat.lastActive > deadline) continue
        await this.disposeChat(chat, 'idle timeout')
      }
    },

    start() {
      client = new OneBotClient({
        url: config.wsUrl,
        token: config.accessToken,
        log: (line) => log(`[onebot] ${line}`),
        onEvent: (event) => {
          if (typeof event.self_id === 'number' || typeof event.self_id === 'string') selfId = String(event.self_id)
          if (event.post_type === 'meta_event') return
          if (event.post_type !== 'message') return
          void this.handleMessage(event).catch((error) => log(`message failed: ${shortError(error)}`))
        },
        onState: (state, detail) => log(`[onebot] state=${state}${detail === undefined ? '' : ` (${detail})`}`),
      })
      void client.start()
      ctx.effect(() => {
        const timer = setInterval(() => {
          void this.evictIdle().catch((error) => log(`evict failed: ${shortError(error)}`))
        }, 60_000)
        timer.unref?.()
        return () => clearInterval(timer)
      }, 'qqBot.evictIdle')
      log(`bridge started: ws=${config.wsUrl} workdir=${workdir} approval=${config.approvalMode}`)
    },
  }

  /** sessionId -> chat, for event routing. */
  const chatsBySession = new Map()
  const findChat = (sessionId) => {
    const chat = chatsBySession.get(sessionId)
    if (chat !== undefined) return chat
    for (const candidate of chats.values()) {
      if (candidate.sessionId === sessionId) {
        chatsBySession.set(sessionId, candidate)
        return candidate
      }
    }
    return undefined
  }

  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      try {
        if (chats.size === 0) return
        bridge.onSessionEvent(session, event)
      } catch (error) {
        log(`session event failed: ${shortError(error)}`)
      }
    })
    return () => {
      dispose?.()
    }
  }, 'qqBot.sessionEvents')

  ctx.effect(() => {
    const tools = ctx.get?.('tools')
    if (tools === undefined) {
      log('tools service is unavailable; qqbot_install_napcat is not registered')
      return () => {}
    }
    try {
      const dispose = tools.register({
        name: 'qqbot_install_napcat',
        description: 'Download and install (or repair) the NapCat Shell that the QQ bot bridge connects to: writes an OneBot v11 forward WebSocket config, registers a logon scheduled task, and starts it. Windows only.',
        parameters: {
          type: 'object',
          properties: {
            port: { type: 'integer', minimum: 1, maximum: 65535, description: 'OneBot v11 WebSocket port, default 3001' },
            account: { type: 'string', description: 'QQ number to quick-login on every start; omit to sign in by QR code' },
            installDir: { type: 'string', description: 'Target directory without spaces or non-ASCII characters; defaults to %USERPROFILE%\\NapCat' },
            force: { type: 'boolean', description: 'Download and extract again even when NapCat is already installed' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, output: { type: 'string' } },
            required: ['ok', 'output'],
            additionalProperties: false,
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.ok ? `NapCat 安装完成。\n\n${value.output}` : `NapCat 安装失败。\n\n${value.output}`,
          }],
        },
        timeoutMs: 1_200_000,
        async execute(args, exec) {
          const script = fileURLToPath(new URL('./tools/install-napcat.ps1', import.meta.url))
          const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
          if (typeof args?.port === 'number') argv.push('-Port', String(args.port))
          if (typeof args?.account === 'string' && args.account.trim() !== '') argv.push('-Account', args.account.trim())
          if (typeof args?.installDir === 'string' && args.installDir.trim() !== '') argv.push('-InstallDir', args.installDir.trim())
          if (args?.force === true) argv.push('-Force')
          const output = await runProcess('powershell.exe', argv, exec?.signal)
          return { ok: output.code === 0, output: output.text }
        },
      })
      const cleanup = () => {
        try {
          dispose?.()
        } catch {
          /* ignore */
        }
      }
      log('registered tool qqbot_install_napcat')
      return cleanup
    } catch (error) {
      log(`tool registration failed: ${shortError(error)}`)
      return () => {}
    }
  }, 'qqBot.tools')

  // 更新：检查 GitHub Release、按需安装；发布只在创作者模式注册。
  ctx.effect(() => {
    const tools = ctx.get?.('tools')
    if (tools === undefined) return () => {}
    const manifest = readManifest()
    const disposers = []

    const register = (definition) => {
      try {
        disposers.push(tools.register(definition))
      } catch (error) {
        log(`tool ${definition.name} registration failed: ${shortError(error)}`)
      }
    }

    register({
      name: 'qqbot_check_update',
      description: 'Check the plugin repository for a newer dsh-qq-bot release and report the version, notes, and whether an update is available.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            current: { type: 'string' },
            latest: { type: 'string' },
            hasUpdate: { type: 'boolean' },
            notes: { type: 'string' },
            url: { type: 'string' },
          },
          required: ['current', 'latest', 'hasUpdate', 'notes', 'url'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.hasUpdate
            ? `发现新版本 ${value.latest}（当前 ${value.current}）\n${value.notes}\n${value.url}`
            : `已是最新版本 ${value.current}。`,
        }],
      },
      timeoutMs: 60_000,
      async execute() {
        const info = await bridge.checkUpdate()
        return { current: info.current, latest: info.latest, hasUpdate: info.hasUpdate, notes: info.notes, url: info.url }
      },
    })

    register({
      name: 'qqbot_apply_update',
      description: 'Install the latest dsh-qq-bot release from its GitHub repository through the DSH plugin manager. Requires pnpm availability and may need a Harness restart.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, message: { type: 'string' }, spec: { type: 'string' } },
          required: ['ok', 'message', 'spec'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.ok ? `更新完成：${value.message}` : `更新失败：${value.message}\n可用安装参数：${value.spec || '(无)'}`,
        }],
      },
      timeoutMs: 600_000,
      async execute() {
        return await bridge.applyUpdate()
      },
    })

    if (config.creatorMode) {
      register({
        name: 'qqbot_publish_release',
        description: 'Creator only: bump the version, update the changelog and market index, commit to GitHub and publish a release for dsh-qq-bot.',
        parameters: {
          type: 'object',
          properties: {
            note: { type: 'string', description: '一句话说明这次改了什么' },
            bump: { type: 'string', enum: ['patch', 'minor', 'major'], description: '版本幅度，默认 patch' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, output: { type: 'string' } },
            required: ['ok', 'output'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: value.output }],
        },
        timeoutMs: 900_000,
        async execute(args, exec) {
          const script = fileURLToPath(new URL('./tools/release.mjs', import.meta.url))
          const argv = [script, '--repo', config.repo, '--bump', String(args?.bump ?? 'patch')]
          if (typeof args?.note === 'string' && args.note.trim() !== '') argv.push('--note', args.note.trim())
          const output = await runProcess(process.execPath, argv, exec?.signal, {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
          })
          return { ok: output.code === 0, output: output.text }
        },
      })
    }

    const cleanup = () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          /* ignore */
        }
      }
    }
    log(`registered update tools (creatorMode=${String(config.creatorMode)})`)
    return cleanup
  }, 'qqBot.updateTools')

  ctx.effect(() => () => {
    client?.close()
    for (const chat of [...chats.values()]) {
      try {
        void chat.handle?.dispose?.()
      } catch {
        /* ignore */
      }
    }
    chats.clear()
    log('bridge stopped')
  }, 'qqBot.shutdown')

  bridge.start()
}

/**
 * Read the optional runtime override file. It wins over the profile patch for
 * every field it names, so settings can be changed without restarting the
 * Harness (disable then enable the plugin in the Plugin Manager).
 */
function readOverride(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    /* no override file is the normal case */
  }
  return {}
}

/**
 * Run one child process and collect its combined output.
 * @param file - executable.
 * @param args - arguments.
 * @param signal - optional cancellation.
 * @returns exit code and captured text (tail-truncated).
 */
function runProcess(file, args, signal) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true })
    let text = ''
    const push = (chunk) => {
      text += chunk.toString('utf8')
      if (text.length > 20000) text = text.slice(-20000)
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    const onAbort = () => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    child.on('error', (error) => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve({ code: -1, text: `${text}\n${String(error)}`.trim() })
    })
    child.on('close', (code) => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve({ code: code ?? -1, text: text.trim() || '(no output)' })
    })
  })
}

/**
 * Merge fields into the runtime override file.
 * @param file - absolute path of override.json.
 * @param patch - fields to write; `null` removes a field.
 * @returns whether the write succeeded.
 */
function writeOverride(file, patch) {
  const current = readOverride(file)
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`)
    fs.renameSync(temporary, file)
    return true
  } catch {
    return false
  }
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.chats === 'object' && parsed.chats !== null) {
      return { chats: { ...parsed.chats } }
    }
  } catch {
    /* missing or malformed state starts empty */
  }
  return { chats: {} }
}

function writeState(file, state) {
  const temporary = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
    fs.renameSync(temporary, file)
  } catch {
    /* a failed state write only loses /new memory */
  }
}

function extensionFor(data, kind) {
  const name = typeof data.file === 'string' ? data.file : ''
  const fromName = path.extname(name)
  if (fromName !== '' && fromName.length <= 8) return fromName
  if (kind === 'image') return '.jpg'
  return ''
}
