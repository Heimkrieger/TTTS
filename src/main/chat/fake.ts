// Фейковый чат для проверки нагрузки.
// Только в разработке: TTS_FAKE_CHAT=10 - сколько сообщений в секунду. В собранной программе
// не подключается. Сообщения без префикса, поэтому в очередь и в Fish они не попадают.
import type { Badge, ChatMessage } from '@shared/types'

const NAMES = [
  'vasya_228',
  'Petya',
  'xX_Killer_Xx',
  'Аня',
  'gloopy',
  'moderka',
  'Streamer',
  'ViPka'
]
const TEXTS = [
  'привет чат',
  'KEKW это было сильно',
  'а когда следующий стрим?',
  'ахахахаха ну ты даёшь',
  'длинное сообщение, чтобы строка переносилась на несколько строк и лента меряла разную высоту у строк',
  'GG',
  'ну и игра конечно, я бы так не смог'
]
const BADGES: Badge[][] = [[], [], ['subscriber'], ['moderator', 'subscriber'], ['vip'], ['prime']]

let seq = 0

export function fakeMessage(now: number): ChatMessage {
  const i = seq++
  const pick = <T>(list: T[]): T => list[i % list.length] as T
  const name = pick(NAMES)
  const badges = BADGES[(i * 7) % BADGES.length] ?? []
  const reply =
    i % 9 === 0 ? { user: 'petya', displayName: 'Petya', text: 'а ты что думаешь?' } : null
  return {
    id: `fake-${i}`,
    user: name.toLowerCase(),
    displayName: name,
    text: (reply ? '@Petya ' : '') + pick(TEXTS),
    badges,
    subMonths: badges.includes('subscriber') ? (i % 30) + 1 : null,
    reply,
    // Каждое 11-е - как будто через награду за баллы (для проверки наград).
    rewardId: i % 11 === 5 ? 'fake-reward-0001' : null,
    color: i % 3 === 0 ? null : pick(['#0000FF', '#FF69B4', '#1E90FF', '#2E8B57', '#000000']),
    emotes: [],
    isAction: false,
    timestamp: now
  }
}
