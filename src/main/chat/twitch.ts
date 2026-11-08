// Чтение чата Twitch анонимно (без входа и токена) через IRC поверх WebSocket.
// Свой клиент вместо tmi.js: tmi.js не обновлялся с 2021 года, а протокол простой.
import { EventEmitter } from 'node:events'
import type { Badge, ChatMessage, ChatStatus, EmoteRange, ReplyInfo } from '@shared/types'
import { parseIrcLine, type IrcMessage } from './irc'

export const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443'

/** Минимум от WebSocket, который нужен клиенту. Позволяет подменить сокет в тестах. */
export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: ((ev: unknown) => void) | null
}
export type SocketFactory = (url: string) => SocketLike

/** Задержки переподключения, секунды: растут до 30 и дальше не увеличиваются. */
export const BACKOFF_SEC = [1, 2, 4, 8, 16, 30]
/** Как часто проверяем, что соединение живо, и сколько ждём ответ. */
export const KEEPALIVE_MS = 60_000
export const PONG_TIMEOUT_MS = 15_000
/** Сколько ждём подтверждения входа в канал. */
export const JOIN_TIMEOUT_MS = 10_000

const BADGE_MAP: Record<string, Badge> = {
  broadcaster: 'broadcaster',
  moderator: 'moderator',
  lead_moderator: 'moderator',
  vip: 'vip',
  subscriber: 'subscriber',
  founder: 'subscriber',
  premium: 'prime'
}

export function parseBadges(tag: string | undefined): Badge[] {
  if (!tag) return []
  const out = new Set<Badge>()
  for (const part of tag.split(',')) {
    const b = BADGE_MAP[part.split('/')[0] ?? '']
    if (b) out.add(b)
  }
  return [...out]
}

/** badge-info "subscriber/14" или "founder/3" -> 14 / 3 месяца. */
export function parseSubMonths(tag: string | undefined): number | null {
  if (!tag) return null
  for (const part of tag.split(',')) {
    const [name, value] = part.split('/')
    if (name !== 'subscriber' && name !== 'founder') continue
    const n = Number(value)
    if (Number.isInteger(n) && n > 0) return n
  }
  return null
}

/** Теги reply-parent-*: на какое сообщение ответили. */
export function parseReply(tags: Record<string, string | undefined>): ReplyInfo | null {
  const user = (tags['reply-parent-user-login'] ?? '').toLowerCase()
  if (!user) return null
  return {
    user,
    displayName: tags['reply-parent-display-name'] || user,
    text: tags['reply-parent-msg-body'] ?? ''
  }
}

/** "25:0-4,12-16/1902:6-10" -> диапазоны, отсортированные по началу. */
export function parseEmotes(tag: string | undefined): EmoteRange[] {
  if (!tag) return []
  const out: EmoteRange[] = []
  for (const group of tag.split('/')) {
    const [id, ranges] = group.split(':')
    if (!id || !ranges) continue
    for (const r of ranges.split(',')) {
      const [s, e] = r.split('-').map(Number)
      if (s !== undefined && e !== undefined && Number.isInteger(s) && Number.isInteger(e)) {
        out.push({ id, start: s, end: e })
      }
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** PRIVMSG в ChatMessage. null - если это не сообщение чата. */
export function mapPrivmsg(msg: IrcMessage, now: () => number = Date.now): ChatMessage | null {
  if (msg.command !== 'PRIVMSG' || msg.params.length < 2) return null
  let text = msg.params[1] ?? ''
  let isAction = false
  // /me приходит как <SOH>ACTION текст<SOH>, где SOH - символ с кодом 1.
  const SOH = String.fromCharCode(1)
  if (text.startsWith(`${SOH}ACTION `) && text.endsWith(SOH)) {
    text = text.slice(8, -1)
    isAction = true
  }
  const login = (msg.prefix?.split('!')[0] ?? msg.tags['login'] ?? '').toLowerCase()
  const color = msg.tags['color']
  const ts = Number(msg.tags['tmi-sent-ts'])
  return {
    id: msg.tags['id'] || `${login}-${now()}`,
    user: login,
    displayName: msg.tags['display-name'] || login,
    text,
    badges: parseBadges(msg.tags['badges']),
    subMonths: parseSubMonths(msg.tags['badge-info']),
    reply: parseReply(msg.tags),
    rewardId: msg.tags['custom-reward-id'] || null,
    color: color && /^#[0-9a-f]{6}$/i.test(color) ? color : null,
    emotes: parseEmotes(msg.tags['emotes']),
    isAction,
    timestamp: Number.isFinite(ts) && ts > 0 ? ts : now()
  }
}

export interface TwitchChatEvents {
  message: [ChatMessage]
  /** Модератор удалил одно сообщение. */
  deleted: [messageId: string]
  /** Таймаут или бан: все сообщения пользователя убрать. */
  userCleared: [login: string, reason: string]
  /** Модератор очистил весь чат. */
  chatCleared: []
  status: [ChatStatus]
  /** Вход в канал подтверждён: id канала нужен для сторонних эмоутов. */
  room: [channel: string, roomId: string]
}

export class TwitchChat extends EventEmitter<TwitchChatEvents> {
  private socket: SocketLike | null = null
  private channel = ''
  private joined = ''
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private joinTimer: ReturnType<typeof setTimeout> | null = null
  private statusValue: ChatStatus = { state: 'idle', channel: '', detail: 'Канал не указан' }

  constructor(
    private readonly socketFactory: SocketFactory,
    private readonly log: { info(...a: unknown[]): void; warn(...a: unknown[]): void }
  ) {
    super()
  }

  get status(): ChatStatus {
    return this.statusValue
  }

  private setStatus(state: ChatStatus['state'], detail: string | null): void {
    this.statusValue = { state, channel: this.channel, detail }
    this.emit('status', this.statusValue)
  }

  /** Сменить канал без перезапуска. Пустая строка - отключиться. */
  setChannel(channel: string): void {
    if (channel === this.channel) return
    const prev = this.channel
    this.channel = channel
    if (!channel) {
      this.stop()
      this.setStatus('idle', 'Канал не указан')
      return
    }
    if (this.socket && this.statusValue.state !== 'connecting' && this.joined) {
      // Соединение живое: просто выходим из старого канала и заходим в новый.
      if (prev) this.socket.send(`PART #${prev}`)
      this.join()
      return
    }
    this.stop()
    this.attempt = 0
    this.connect()
  }

  /** Полное отключение (выход из программы или пустой канал). */
  stop(): void {
    this.clearTimers()
    if (this.socket) {
      const s = this.socket
      this.socket = null
      s.onclose = null
      s.onmessage = null
      s.onerror = null
      try {
        s.close()
      } catch {
        // сокет уже закрыт
      }
    }
    this.joined = ''
  }

  private clearTimers(): void {
    for (const t of [this.reconnectTimer, this.pongTimer, this.joinTimer]) if (t) clearTimeout(t)
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    this.reconnectTimer = this.pongTimer = this.joinTimer = this.keepaliveTimer = null
  }

  private connect(): void {
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting', 'Подключение к Twitch...')
    let socket: SocketLike
    try {
      socket = this.socketFactory(TWITCH_IRC_URL)
    } catch (e) {
      this.log.warn('chat: не удалось создать соединение', e)
      this.scheduleReconnect('Не удалось подключиться к Twitch. Проверьте интернет')
      return
    }
    this.socket = socket
    socket.onopen = () => {
      socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands')
      socket.send('PASS SCHMOOPIIE')
      socket.send(`NICK justinfan${10000 + Math.floor(Math.random() * 89999)}`)
      this.join()
      this.keepaliveTimer = setInterval(() => this.ping(), KEEPALIVE_MS)
    }
    socket.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : String(ev.data)
      for (const line of data.split('\r\n')) {
        const msg = parseIrcLine(line)
        if (msg) this.handle(msg)
      }
    }
    socket.onerror = (ev) => this.log.warn('chat: ошибка соединения', ev)
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.joined = ''
      this.clearTimers()
      this.scheduleReconnect('Связь с Twitch потеряна')
    }
  }

  private join(): void {
    if (!this.socket) return
    this.joined = ''
    this.socket.send(`JOIN #${this.channel}`)
    this.setStatus('joining', `Вход в канал ${this.channel}...`)
    if (this.joinTimer) clearTimeout(this.joinTimer)
    this.joinTimer = setTimeout(() => {
      this.setStatus(
        'error',
        `Twitch не подтвердил вход в канал "${this.channel}". Проверьте имя канала: возможно, его не существует.`
      )
    }, JOIN_TIMEOUT_MS)
  }

  private ping(): void {
    if (!this.socket) return
    this.socket.send('PING :tts')
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pongTimer = setTimeout(() => {
      // Ответа нет: соединение "зависло" (например, пропал интернет). Рвём и переподключаемся.
      this.log.warn('chat: нет ответа на PING, переподключение')
      const s = this.socket
      this.socket = null
      this.joined = ''
      this.clearTimers()
      try {
        s?.close()
      } catch {
        // уже закрыт
      }
      this.scheduleReconnect('Twitch не отвечает')
    }, PONG_TIMEOUT_MS)
  }

  private scheduleReconnect(why: string): void {
    if (!this.channel) return
    const delay = BACKOFF_SEC[Math.min(this.attempt, BACKOFF_SEC.length - 1)] ?? 30
    this.attempt++
    this.setStatus(
      'reconnecting',
      `${why}. Следующая попытка через ${delay} с (уже ${this.attempt}).`
    )
    this.reconnectTimer = setTimeout(() => this.connect(), delay * 1000)
  }

  private handle(msg: IrcMessage): void {
    switch (msg.command) {
      case 'PING':
        this.socket?.send(`PONG :${msg.params[0] ?? 'tmi.twitch.tv'}`)
        return
      case 'PONG':
        if (this.pongTimer) clearTimeout(this.pongTimer)
        this.pongTimer = null
        return
      case 'RECONNECT':
        // Twitch просит переподключиться (плановые работы).
        this.log.info('chat: RECONNECT от Twitch')
        this.stop()
        this.attempt = 0
        this.connect()
        return
      case 'ROOMSTATE': {
        const room = (msg.params[0] ?? '').replace(/^#/, '')
        if (room !== this.channel || this.joined === room) return
        this.joined = room
        this.attempt = 0
        if (this.joinTimer) clearTimeout(this.joinTimer)
        this.joinTimer = null
        this.setStatus('connected', null)
        const roomId = msg.tags['room-id']
        if (roomId) this.emit('room', room, roomId)
        return
      }
      case 'NOTICE': {
        const id = msg.tags['msg-id']
        const text = msg.params[1] ?? ''
        this.log.warn('chat: NOTICE', id, text)
        if (id === 'msg_channel_suspended') {
          if (this.joinTimer) clearTimeout(this.joinTimer)
          this.setStatus(
            'error',
            `Канал "${this.channel}" заблокирован Twitch или не существует. Проверьте имя канала в разделе "Подключение".`
          )
        }
        return
      }
      case 'PRIVMSG': {
        if ((msg.params[0] ?? '').replace(/^#/, '') !== this.channel) return
        const m = mapPrivmsg(msg)
        if (m) this.emit('message', m)
        return
      }
      case 'CLEARMSG': {
        const id = msg.tags['target-msg-id']
        if (id) this.emit('deleted', id)
        return
      }
      case 'CLEARCHAT': {
        const user = msg.params[1]
        if (user) {
          const dur = msg.tags['ban-duration']
          const sec = Number(dur)
          const timeout =
            sec >= 60 ? `таймаут на ${Math.round(sec / 60)} мин` : `таймаут на ${dur} с`
          this.emit('userCleared', user.toLowerCase(), dur ? timeout : 'бан')
        } else this.emit('chatCleared')
        return
      }
      default:
        return
    }
  }
}
