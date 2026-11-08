import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseIrcLine, unescapeTag } from '../src/main/chat/irc'
import {
  JOIN_TIMEOUT_MS,
  KEEPALIVE_MS,
  PONG_TIMEOUT_MS,
  TwitchChat,
  mapPrivmsg,
  parseBadges,
  parseSubMonths,
  parseEmotes,
  type SocketLike
} from '../src/main/chat/twitch'
import { ChatFeed } from '../src/main/chat/feed'
import type { ChatMessage, ChatStatus } from '../src/shared/types'

// Реальные по форме строки чата Twitch.
const PRIVMSG =
  '@badge-info=subscriber/14;badges=moderator/1,subscriber/12;color=#1E90FF;display-name=Вася\\sПупкин;emotes=25:6-10;id=b34ccfc7-4977-403a-8a94-33c6bac34fb8;mod=1;room-id=1337;tmi-sent-ts=1762560000000;user-id=42 :vasya!vasya@vasya.tmi.twitch.tv PRIVMSG #artem :!!! 😀 Kappa привет'

describe('разбор IRC', () => {
  it('теги, префикс, команда, параметры', () => {
    const m = parseIrcLine(PRIVMSG)
    expect(m?.command).toBe('PRIVMSG')
    expect(m?.prefix).toBe('vasya!vasya@vasya.tmi.twitch.tv')
    expect(m?.params).toEqual(['#artem', '!!! 😀 Kappa привет'])
    expect(m?.tags['display-name']).toBe('Вася Пупкин')
  })
  it('PING без тегов', () => {
    expect(parseIrcLine('PING :tmi.twitch.tv')).toEqual({
      tags: {},
      prefix: null,
      command: 'PING',
      params: ['tmi.twitch.tv']
    })
  })
  it('экранирование значений тегов', () => {
    expect(unescapeTag('a\\sb\\:c\\\\d')).toBe('a b;c\\d')
  })
  it('пустая строка', () => expect(parseIrcLine('')).toBeNull())
})

describe('маппинг в ChatMessage', () => {
  it('полное сообщение', () => {
    const m = mapPrivmsg(parseIrcLine(PRIVMSG)!)
    expect(m).toEqual({
      id: 'b34ccfc7-4977-403a-8a94-33c6bac34fb8',
      user: 'vasya',
      displayName: 'Вася Пупкин',
      text: '!!! 😀 Kappa привет',
      badges: ['moderator', 'subscriber'],
      color: '#1E90FF',
      emotes: [{ id: '25', start: 6, end: 10 }],
      subMonths: 14,
      reply: null,
      rewardId: null,
      isAction: false,
      timestamp: 1762560000000
    })
  })
  it('/me, без цвета и бейджей', () => {
    const m = mapPrivmsg(
      parseIrcLine('@color=;badges=;id=1 :x!x@x PRIVMSG #c :\u0001ACTION танцует\u0001')!
    )
    expect(m?.text).toBe('танцует')
    expect(m?.isAction).toBe(true)
    expect(m?.color).toBeNull()
    expect(m?.badges).toEqual([])
  })
  it('бейджи: founder = саб, lead_moderator = модератор', () => {
    expect(parseBadges('founder/0,lead_moderator/1,premium/1')).toEqual([
      'subscriber',
      'moderator',
      'prime'
    ])
  })
  it('ответ на сообщение: кому ответили и текст', () => {
    const m = mapPrivmsg(
      parseIrcLine(
        '@reply-parent-user-login=petya;reply-parent-display-name=Петя;reply-parent-msg-body=как\\sдела;id=2 :x!x@x PRIVMSG #c :@Петя норм'
      )!
    )
    expect(m?.reply).toEqual({ user: 'petya', displayName: 'Петя', text: 'как дела' })
    const r = mapPrivmsg(
      parseIrcLine('@custom-reward-id=abc-123;id=3 :x!x@x PRIVMSG #c :озвучь меня')!
    )
    expect(r?.rewardId).toBe('abc-123')
    expect(parseSubMonths('subscriber/7')).toBe(7)
    expect(parseSubMonths('founder/0')).toBeNull()
  })
  it('эмоуты: несколько групп, сортировка', () => {
    expect(parseEmotes('25:12-16,0-4/1902:6-10')).toEqual([
      { id: '25', start: 0, end: 4 },
      { id: '1902', start: 6, end: 10 },
      { id: '25', start: 12, end: 16 }
    ])
  })
})

/** Поддельный WebSocket: запоминает отправленное, позволяет "получить" строки. */
class FakeSocket implements SocketLike {
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(d: string): void {
    this.sent.push(d)
  }
  close(): void {
    this.closed = true
  }
  receive(...lines: string[]): void {
    this.onmessage?.({ data: lines.join('\r\n') + '\r\n' })
  }
}

describe('TwitchChat', () => {
  let sockets: FakeSocket[]
  let chat: TwitchChat
  let statuses: ChatStatus[]
  const last = (): FakeSocket => sockets[sockets.length - 1]!
  const silent = { info: () => {}, warn: () => {} }

  beforeEach(() => {
    vi.useFakeTimers()
    sockets = []
    statuses = []
    chat = new TwitchChat(() => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    }, silent)
    chat.on('status', (s) => statuses.push(s))
  })
  afterEach(() => {
    chat.stop()
    vi.useRealTimers()
  })

  const connectAndJoin = (channel = 'artem'): void => {
    chat.setChannel(channel)
    last().onopen?.()
    last().receive(`@room-id=1337 :tmi.twitch.tv ROOMSTATE #${channel}`)
  }

  it('анонимный вход и подтверждение канала', () => {
    const rooms: string[] = []
    chat.on('room', (c, id) => rooms.push(`${c}:${id}`))
    chat.setChannel('artem')
    last().onopen?.()
    expect(last().sent).toContain('PASS SCHMOOPIIE')
    expect(last().sent.some((l) => /^NICK justinfan\d+$/.test(l))).toBe(true)
    expect(last().sent).toContain('JOIN #artem')
    expect(chat.status.state).toBe('joining')
    last().receive('@room-id=1337 :tmi.twitch.tv ROOMSTATE #artem')
    expect(chat.status.state).toBe('connected')
    expect(rooms).toEqual(['artem:1337'])
  })

  it('сообщения приходят событием', () => {
    const got: ChatMessage[] = []
    chat.on('message', (m) => got.push(m))
    connectAndJoin()
    last().receive(PRIVMSG.replace('#artem', '#artem'))
    expect(got).toHaveLength(1)
    expect(got[0]?.user).toBe('vasya')
  })

  it('отвечает на PING', () => {
    connectAndJoin()
    last().receive('PING :tmi.twitch.tv')
    expect(last().sent).toContain('PONG :tmi.twitch.tv')
  })

  it('удаление сообщения, таймаут, бан, очистка чата', () => {
    const events: string[] = []
    chat.on('deleted', (id) => events.push(`del:${id}`))
    chat.on('userCleared', (u, r) => events.push(`user:${u}:${r}`))
    chat.on('chatCleared', () => events.push('clear'))
    connectAndJoin()
    last().receive(
      '@login=vasya;target-msg-id=abc :tmi.twitch.tv CLEARMSG #artem :текст',
      '@ban-duration=600 :tmi.twitch.tv CLEARCHAT #artem :Vasya',
      ':tmi.twitch.tv CLEARCHAT #artem :petya',
      ':tmi.twitch.tv CLEARCHAT #artem'
    )
    expect(events).toEqual(['del:abc', 'user:vasya:таймаут на 10 мин', 'user:petya:бан', 'clear'])
  })

  it('обрыв связи: переподключение с растущей задержкой и понятным статусом', () => {
    connectAndJoin()
    last().onclose?.()
    expect(chat.status.state).toBe('reconnecting')
    expect(chat.status.detail).toContain('Следующая попытка через 1 с')
    vi.advanceTimersByTime(1000)
    expect(sockets).toHaveLength(2)
    last().onclose?.()
    expect(chat.status.detail).toContain('Следующая попытка через 2 с')
    vi.advanceTimersByTime(2000)
    last().onopen?.()
    last().receive('@room-id=1 :tmi.twitch.tv ROOMSTATE #artem')
    expect(chat.status.state).toBe('connected')
    // После успешного входа счётчик попыток сбрасывается.
    last().onclose?.()
    expect(chat.status.detail).toContain('Следующая попытка через 1 с')
  })

  it('"зависшее" соединение (пропал интернет): нет PONG -> переподключение', () => {
    connectAndJoin()
    vi.advanceTimersByTime(KEEPALIVE_MS)
    expect(last().sent).toContain('PING :tts')
    vi.advanceTimersByTime(PONG_TIMEOUT_MS)
    expect(sockets[0]?.closed).toBe(true)
    expect(chat.status.state).toBe('reconnecting')
    vi.advanceTimersByTime(1000)
    expect(sockets).toHaveLength(2)
  })

  it('смена канала без переподключения', () => {
    connectAndJoin('artem')
    chat.setChannel('other')
    expect(sockets).toHaveLength(1)
    expect(last().sent).toContain('PART #artem')
    expect(last().sent).toContain('JOIN #other')
    last().receive('@room-id=2 :tmi.twitch.tv ROOMSTATE #other')
    expect(chat.status).toEqual({ state: 'connected', channel: 'other', detail: null })
  })

  it('канал не подтверждён за 10 с -> понятная ошибка', () => {
    chat.setChannel('nosuchchannel')
    last().onopen?.()
    vi.advanceTimersByTime(JOIN_TIMEOUT_MS)
    expect(chat.status.state).toBe('error')
    expect(chat.status.detail).toContain('Проверьте имя канала')
  })

  it('сообщения из чужого канала игнорируются', () => {
    const got: ChatMessage[] = []
    chat.on('message', (m) => got.push(m))
    connectAndJoin('artem')
    last().receive(PRIVMSG.replace('#artem', '#someoneelse'))
    expect(got).toHaveLength(0)
  })

  it('пустой канал - отключение', () => {
    connectAndJoin()
    chat.setChannel('')
    expect(sockets[0]?.closed).toBe(true)
    expect(chat.status.state).toBe('idle')
  })
})

describe('ChatFeed', () => {
  const m = (id: string, user = 'u'): ChatMessage => ({
    id,
    user,
    displayName: user,
    text: id,
    badges: [],
    color: null,
    emotes: [],
    subMonths: null,
    reply: null,
    rewardId: null,
    isAction: false,
    timestamp: 0
  })

  it('хранит последние 200', () => {
    const f = new ChatFeed()
    for (let i = 0; i < 250; i++) f.add(m(String(i)), 'accepted', null, null)
    const s = f.snapshot()
    expect(s).toHaveLength(200)
    expect(s[0]?.message.id).toBe('50')
  })

  it('удаление, бан пользователя, очистка', () => {
    const f = new ChatFeed()
    f.add(m('1', 'a'), 'accepted', null, null)
    f.add(m('2', 'b'), 'accepted', null, null)
    f.add(m('3', 'b'), 'no-prefix', 'без префикса', null)
    expect(f.markDeleted('1')?.status).toBe('deleted')
    expect(f.markUserCleared('b', 'бан')).toHaveLength(2)
    expect(f.snapshot().every((e) => e.status === 'deleted')).toBe(true)
  })
})
