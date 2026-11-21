/**
 * Minimal OneBot v11 forward-WebSocket client.
 *
 * NapCat / go-cqhttp / Lagrange expose a "forward WebSocket" endpoint: the
 * client connects, receives event JSON objects, and sends action JSON objects
 * with an `echo` field for request/response correlation.
 *
 * This module has no external dependencies: it uses the platform WebSocket
 * (Node >= 22) and falls back to the optional `ws` package when present.
 */

const CONNECT_TIMEOUT_MS = 10_000
const ACTION_TIMEOUT_MS = 30_000
const MIN_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000

/** Resolve a WebSocket constructor without a hard dependency on `ws`. */
async function resolveWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket
  const mod = await import('ws')
  return mod.WebSocket ?? mod.default
}

export class OneBotClient {
  #url
  #token
  #log
  #onEvent
  #onState
  #retry = MIN_RETRY_MS
  #socket
  #closed = false
  #echo = 0
  #pending = new Map()
  #retryTimer
  #state = 'offline'

  /**
   * @param {object} options
   * @param {string} options.url OneBot v11 forward WebSocket URL.
   * @param {string} [options.token] access token.
   * @param {(line: string) => void} options.log logger callback.
   * @param {(event: any) => void} options.onEvent one received event.
   * @param {(state: 'online' | 'offline' | 'error', detail?: string) => void} [options.onState] connection state.
   */
  constructor({ url, token, log, onEvent, onState }) {
    this.#url = url
    this.#token = token ?? ''
    this.#log = log
    this.#onEvent = onEvent
    this.#onState = onState ?? (() => {})
  }

  get state() {
    return this.#state
  }

  /** Connect and keep reconnecting until {@link close}. */
  async start() {
    this.#closed = false
    await this.#connect()
  }

  /** Close the socket and stop reconnecting. */
  close() {
    this.#closed = true
    clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('onebot client closed'))
    }
    this.#pending.clear()
    const socket = this.#socket
    this.#socket = undefined
    try {
      socket?.close()
    } catch {
      /* ignore */
    }
    this.#setState('offline')
  }

  /**
   * Call one OneBot action.
   * @param {string} action action name, such as `send_private_msg`.
   * @param {Record<string, unknown>} params action parameters.
   * @param {number} [timeoutMs] per-call timeout.
   * @returns {Promise<any>} the action `data`, or `undefined` when the peer sent none.
   */
  async call(action, params = {}, timeoutMs = ACTION_TIMEOUT_MS) {
    const socket = this.#socket
    if (socket === undefined || socket.readyState !== 1) {
      throw new Error(`onebot is not connected (${this.#state})`)
    }
    const echo = `qqbot-${++this.#echo}`
    const payload = JSON.stringify({ action, params, echo })
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo)
        reject(new Error(`onebot action timed out: ${action}`))
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(echo, { resolve, reject, timer, action })
      try {
        socket.send(payload)
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(echo)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  #setState(state, detail) {
    if (this.#state === state) return
    this.#state = state
    this.#onState(state, detail)
  }

  async #connect() {
    if (this.#closed) return
    let Endpoint
    try {
      Endpoint = await resolveWebSocket()
    } catch (error) {
      this.#log(`websocket unavailable: ${String(error)}`)
      this.#setState('error', String(error))
      return
    }
    const url = this.#withToken(this.#url)
    this.#log(`connecting ${url.replace(/(access_token=)[^&]+/, '$1***')}`)
    let socket
    try {
      socket = new Endpoint(url)
    } catch (error) {
      this.#log(`connect failed: ${String(error)}`)
      this.#scheduleRetry()
      return
    }
    this.#socket = socket
    const connectTimer = setTimeout(() => {
      if (socket.readyState !== 1) {
        this.#log('connect timed out')
        try {
          socket.close()
        } catch {
          /* ignore */
        }
      }
    }, CONNECT_TIMEOUT_MS)
    connectTimer.unref?.()

    socket.addEventListener?.('open', () => {
      clearTimeout(connectTimer)
      this.#retry = MIN_RETRY_MS
      this.#log('connected')
      this.#setState('online')
    })
    socket.addEventListener?.('message', (event) => {
      this.#handleFrame(event.data)
    })
    socket.addEventListener?.('error', (event) => {
      this.#log(`socket error: ${event?.message ?? 'unknown'}`)
    })
    socket.addEventListener?.('close', (event) => {
      clearTimeout(connectTimer)
      if (this.#socket === socket) this.#socket = undefined
      this.#setState('offline', `code ${event?.code ?? '?'}`)
      this.#scheduleRetry()
    })
  }

  #scheduleRetry() {
    if (this.#closed) return
    const delay = this.#retry
    this.#retry = Math.min(this.#retry * 2, MAX_RETRY_MS)
    this.#log(`reconnect in ${delay}ms`)
    clearTimeout(this.#retryTimer)
    this.#retryTimer = setTimeout(() => {
      void this.#connect()
    }, delay)
    this.#retryTimer.unref?.()
  }

  #withToken(url) {
    if (this.#token.length === 0) return url
    try {
      const parsed = new URL(url)
      parsed.searchParams.set('access_token', this.#token)
      return parsed.toString()
    } catch {
      return url
    }
  }

  #handleFrame(raw) {
    let frame
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'))
    } catch {
      this.#log('received a non-JSON frame')
      return
    }
    if (frame == null || typeof frame !== 'object') return
    if (typeof frame.echo === 'string' && this.#pending.has(frame.echo)) {
      const entry = this.#pending.get(frame.echo)
      this.#pending.delete(frame.echo)
      clearTimeout(entry.timer)
      if (frame.status === 'failed' || frame.retcode !== 0) {
        entry.reject(new Error(`onebot action ${entry.action} failed: retcode=${frame.retcode ?? '?'} ${frame.wording ?? frame.message ?? ''}`.trim()))
      } else {
        entry.resolve(frame.data)
      }
      return
    }
    if (typeof frame.post_type === 'string') {
      try {
        this.#onEvent(frame)
      } catch (error) {
        this.#log(`event handler failed: ${String(error)}`)
      }
    }
  }
}
