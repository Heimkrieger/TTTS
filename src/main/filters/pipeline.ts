// Пайплайн фильтров: решает, озвучить сообщение или нет, и почему.
// Фильтры применяются по порядку, остановка на первом отказе.
// Каждый фильтр - чистая функция; состояние (кулдауны, недавние тексты) обновляется только
// когда сообщение прошло ВСЕ фильтры (commit), чтобы отказ по длине не запускал кулдаун.
import type { RolesSettings, Settings } from '@shared/settings'
import type { Badge, ChatMessage } from '@shared/types'
import { isRiskyRegex } from '@shared/regexSafety'
import { applyAntispam } from './antispam'
import { processTags } from '../tts/tags'
import {
  charLength,
  collapseSpaces,
  hasWords,
  splitTags,
  stripInvisible,
  textWithoutTags,
  tidy
} from './text'

export type FilterOutcome =
  /** dupText - текст до шаблона "ник пишет:", по нему считаются повторы. */
  | { pass: true; text: string; dupText?: string }
  /** no-prefix: обычное сообщение чата без префикса, это не отказ. */
  | { pass: false; kind: 'no-prefix' | 'rejected'; reason: string }

export interface FilterState {
  /** Когда зритель последний раз прошёл в очередь (мс). */
  lastByUser: Map<string, number>
  /** Недавние тексты (нормализованные) и когда они прошли. */
  recentTexts: Map<string, number>
}

export interface FilterContext {
  now: number
  queueLength: number
  /** Слово - эмоут 7TV/BTTV/FFZ этого канала. */
  isThirdPartyEmote: (word: string) => boolean
  /**
   * Имена эмоутов Twitch из исходного сообщения. Нужны, когда в фильтры идёт уже обрезанный
   * текст (ручная озвучка): позиции эмоутов от Twitch считаются по исходному.
   */
  twitchEmotes?: Set<string>
}

export function createFilterState(): FilterState {
  return { lastByUser: new Map(), recentTexts: new Map() }
}

type Step = (
  text: string,
  msg: ChatMessage,
  settings: Settings,
  state: FilterState,
  ctx: FilterContext
) => FilterOutcome

const reject = (reason: string): FilterOutcome => ({ pass: false, kind: 'rejected', reason })

// 1. Глобальный тумблер.
const enabledStep: Step = (text, _m, s) =>
  s.tts.enabled ? { pass: true, text } : reject('озвучка выключена')

// 2. Чёрный список ников.
const blacklistStep: Step = (text, m, s) =>
  s.filters.blacklist.some((n) => n.trim().toLowerCase() === m.user)
    ? reject('ник в чёрном списке')
    : { pass: true, text }

// 2б. Мьют на время (ставит стример кнопкой в ленте или очереди).
const muteStep: Step = (text, m, s, _st, ctx) => {
  const mute = s.mutes.find((x) => x.login === m.user && x.until > ctx.now)
  if (!mute) return { pass: true, text }
  const until = new Date(mute.until).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit'
  })
  return reject(`мьют до ${until}`)
}

/**
 * Сообщение пришло через награду за баллы, которую стример отметил для озвучки, и награды
 * включены в "Что запускает озвучку".
 */
export function isTtsReward(m: ChatMessage, s: Settings): boolean {
  return (
    m.rewardId !== null &&
    s.filters.trigger !== 'prefix' &&
    s.filters.rewards.some((r) => r.id === m.rewardId)
  )
}

// 3. Что запускает озвучку: награда за баллы и/или префикс (сам префикс срезается).
const prefixStep: Step = (text, m, s) => {
  const { enabled, list } = s.filters.prefix
  if (isTtsReward(m, s)) {
    // Зритель мог по привычке поставить префикс и в награде - срезаем его.
    const p = matchPrefix(text, list)
    return { pass: true, text: p ? text.trimStart().slice(p.length).trim() : text }
  }
  if (s.filters.trigger === 'reward') {
    return {
      pass: false,
      kind: 'no-prefix',
      reason: m.rewardId ? 'эта награда не отмечена для озвучки' : 'озвучка только за награду'
    }
  }
  if (!enabled || list.length === 0) return { pass: true, text }
  const p = matchPrefix(text, list)
  if (p === null) return { pass: false, kind: 'no-prefix', reason: 'без префикса' }
  return { pass: true, text: text.slice(p.length).trim() }
}

/**
 * Какой префикс из списка стоит в начале текста (без учёта регистра). Длинные проверяются первыми,
 * чтобы "!tts" не перехватывался коротким "!". null - ни одного.
 */
export function matchPrefix(text: string, list: readonly string[]): string | null {
  const t = text.trimStart().toLowerCase()
  const sorted = [...list].filter((p) => p !== '').sort((a, b) => b.length - a.length)
  return sorted.find((p) => t.startsWith(p.toLowerCase())) ?? null
}

// 4. Роли: подходит под любую отмеченную галку; стример может всегда.
const ROLE_CHECKS: { key: keyof RolesSettings; label: string; badge: Badge | null }[] = [
  { key: 'followers', label: 'фолловеры', badge: null },
  { key: 'subscribers', label: 'подписчики', badge: 'subscriber' },
  { key: 'vip', label: 'VIP', badge: 'vip' },
  { key: 'moderators', label: 'модераторы', badge: 'moderator' }
]
const rolesStep: Step = (text, m, s) => {
  const r = s.filters.roles
  if (r.everyone || m.badges.includes('broadcaster')) return { pass: true, text }
  const on = ROLE_CHECKS.filter((c) => r[c.key])
  if (on.some((c) => c.badge !== null && m.badges.includes(c.badge))) return { pass: true, text }
  const why = `озвучивают только: ${on.map((c) => c.label).join(', ')}`
  // Фоловеров видно только через Twitch API со входом стримера, без входа не проверить.
  return reject(r.followers ? `${why} (фолловеров без входа в Twitch не проверить)` : why)
}

// 5. Кулдаун зрителя (засчитывается только прошедшим сообщениям, см. commit).
const cooldownStep: Step = (text, m, s, st, ctx) => {
  const cd = s.filters.userCooldownSec * 1000
  const last = st.lastByUser.get(m.user)
  if (cd > 0 && last !== undefined && ctx.now - last < cd) {
    return reject(`кулдаун: ещё ${Math.ceil((cd - (ctx.now - last)) / 1000)} с`)
  }
  return { pass: true, text }
}

// 6. Ссылки.
const LINK_RE =
  /(?:https?:\/\/|www\.)\S+|(?<![\p{L}\p{N}])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:com|ru|net|org|tv|gg|io|me|ly|be|рф|su|xyz|link|site|online|info|co|app|dev)(?![\p{L}\p{N}])(?:\/\S*)?/giu
const linksStep: Step = (text, _m, s) => {
  if (s.filters.links === 'off') return { pass: true, text }
  if (!LINK_RE.test(text)) return { pass: true, text }
  LINK_RE.lastIndex = 0
  if (s.filters.links === 'reject') return reject('ссылка в сообщении')
  return { pass: true, text: tidy(text.replace(LINK_RE, ' ')) }
}

// 7. Эмоуты: Twitch (по диапазонам из сообщения), 7TV/BTTV/FFZ (по словам), эмодзи.
const EMOJI_RE = new RegExp(
  '\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier}|\\u200D\\p{Extended_Pictographic})*',
  'gu'
)
export function twitchEmoteNames(m: ChatMessage): Set<string> {
  const chars = Array.from(m.text)
  return new Set(m.emotes.map((e) => chars.slice(e.start, e.end + 1).join('')))
}
const emotesStep: Step = (text, m, s, _st, ctx) => {
  const cfg = s.filters.emotes
  const twitchNames = cfg.twitch ? (ctx.twitchEmotes ?? twitchEmoteNames(m)) : new Set<string>()
  // Делим по пробелам, сохраняя теги целыми: эмоуты убираются только из текста вне тегов.
  const out = splitTags(text).map((seg) => {
    if (seg.type === 'tag') return seg.value
    let v = seg.value
      .split(/(\s+)/)
      .filter((w) => !(twitchNames.has(w) || (cfg.thirdParty && ctx.isThirdPartyEmote(w))))
      .join('')
    if (cfg.emoji) v = v.replace(EMOJI_RE, ' ')
    return v
  })
  return { pass: true, text: tidy(out.join('')) }
}

// 8. Антиспам.
const antispamStep: Step = (text, _m, s) => {
  const r = applyAntispam(text, s.filters.antispam)
  return r.pass ? { pass: true, text: r.text } : reject(r.reason)
}

// 9. Стоп-слова: слово целиком (без учёта регистра) или /регулярка/флаги.
const BEEP = 'пип'
function stopWordRegex(w: string): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/.exec(w)
  try {
    // Опасное выражение (повтор внутри повтора) не выполняем: настройки его и так не пропустят,
    // это защита для старых файлов настроек.
    if (m)
      return isRiskyRegex(m[1] ?? '')
        ? null
        : new RegExp(m[1] ?? '', (m[2] ?? '').replace('g', '') + 'g')
    const esc = w.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!esc) return null
    return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu')
  } catch {
    return null
  }
}
const stopWordsStep: Step = (text, _m, s) => {
  let out = text
  for (const w of s.filters.stopWords.list) {
    const re = stopWordRegex(w)
    if (!re || !re.test(out)) continue
    re.lastIndex = 0
    if (s.filters.stopWords.mode === 'reject') return reject(`стоп-слово: ${w}`)
    out = out.replace(re, BEEP)
  }
  return { pass: true, text: out }
}

// 9б. Теги эмоций: служебные вырезать, (x) -> [x] или как настроено, слова-запреты в тегах.
const tagsStep: Step = (text, _m, s) => ({ pass: true, text: processTags(text, s.tts.tags) })

// 10. Длина (без тегов). Сообщение из одних тегов проходит, если антиспам это разрешил.
const lengthStep: Step = (text, _m, s) => {
  const plain = textWithoutTags(text)
  const len = charLength(plain)
  const hasTags = splitTags(text).some((x) => x.type === 'tag')
  if (!hasWords(plain) && !hasTags) return reject('после чистки ничего не осталось')
  if (!hasWords(plain) && hasTags) return { pass: true, text }
  const { min, max } = s.filters.length
  if (len < min) return reject(`слишком коротко: ${len} симв., минимум ${min}`)
  if (len > max) return reject(`слишком длинно: ${len} симв., максимум ${max}`)
  return { pass: true, text }
}

// 11. Дубли: тот же текст от любого зрителя за N секунд.
export const dupKey = (text: string): string => collapseSpaces(text.toLowerCase())
const duplicateStep: Step = (text, _m, s, st, ctx) => {
  const win = s.filters.duplicateSec * 1000
  if (win <= 0) return { pass: true, text }
  const last = st.recentTexts.get(dupKey(text))
  if (last !== undefined && ctx.now - last < win) {
    return reject(`повтор: такой же текст был ${Math.round((ctx.now - last) / 1000)} с назад`)
  }
  return { pass: true, text }
}

// 12. Размер очереди.
const queueStep: Step = (text, _m, s, _st, ctx) =>
  ctx.queueLength >= s.filters.maxQueue
    ? reject(`очередь заполнена, в ней уже максимум (${s.filters.maxQueue})`)
    : { pass: true, text }

// 13. Ник перед сообщением (галка в разделе "Голос"): после всех проверок, чтобы длина,
// дубли и кулдаун считались по тексту зрителя, а не по шаблону.
/**
 * Ник для чтения вслух: без цифр, "_" и повторов букв ("xX_Vasyaaa_228" -> "xX Vasya").
 * Если от ника ничего не осталось, читается "зритель".
 */
export function speakableNick(displayName: string): string {
  const s = displayName
    .replace(/[_\-.]+/g, ' ')
    .replace(/\p{N}+/gu, ' ')
    .replace(/(\p{L})\1{2,}/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return /\p{L}/u.test(s) ? s : 'зритель'
}
const readNickStep: Step = (text, m, s) => {
  const r = s.tts.readNick
  if (!r.enabled) return { pass: true, text }
  // Замена функцией: "$&" и "$`" в тексте зрителя - обычные символы, а не шаблоны замены.
  const nick = speakableNick(m.displayName)
  const out = r.template.replaceAll('{ник}', () => nick).replaceAll('{текст}', () => text)
  return { pass: true, text: tidy(out) }
}

/**
 * Подпись для стрима (страница OBS): текст как в чате, с тегами эмоций, но без шаблона "ник пишет:" - ник и так показан отдельно.
 */
export function captionText(text: string, displayName: string, s: Settings): string {
  let t = text
  const r = s.tts.readNick
  if (r.enabled) {
    const nick = speakableNick(displayName)
    const [before = '', after = ''] = r.template.split('{текст}')
    const head = tidy(before.replaceAll('{ник}', () => nick))
    const tail = tidy(after.replaceAll('{ник}', () => nick))
    if (head && t.startsWith(head)) t = t.slice(head.length)
    if (tail && t.endsWith(tail)) t = t.slice(0, t.length - tail.length)
  }
  return collapseSpaces(t)
}

export const STEPS: Step[] = [
  enabledStep,
  blacklistStep,
  muteStep,
  prefixStep,
  // Награда и префикс равноценны: все фильтры для них одинаковые.
  rolesStep,
  cooldownStep,
  linksStep,
  emotesStep,
  antispamStep,
  stopWordsStep,
  tagsStep,
  lengthStep,
  duplicateStep,
  queueStep,
  readNickStep
]

/**
 * В ответе Twitch сам ставит "@ник " в начало текста. Убираем его, иначе префикс не найдётся
 * ("@Петя !!! привет") и ник прочитается вслух.
 */
export function stripReplyMention(text: string, msg: ChatMessage): string {
  if (!msg.reply) return text
  const lower = text.toLowerCase()
  for (const name of [msg.reply.displayName, msg.reply.user]) {
    const at = `@${name.toLowerCase()}`
    if (lower.startsWith(at) && !/[\p{L}\p{N}_]/u.test(text.charAt(at.length))) {
      return text.slice(at.length).trimStart()
    }
  }
  return text
}

export function runFilters(
  msg: ChatMessage,
  settings: Settings,
  state: FilterState,
  ctx: FilterContext
): FilterOutcome {
  // 0. Всегда: невидимые символы и лишние пробелы.
  let text = stripReplyMention(collapseSpaces(stripInvisible(msg.text)), msg)
  let dupText = text
  for (const step of STEPS) {
    if (step === readNickStep) dupText = text
    const r = step(text, msg, settings, state, ctx)
    if (!r.pass) return r
    text = r.text
  }
  return dupText === text ? { pass: true, text } : { pass: true, text, dupText }
}

/** Сообщение прошло фильтры и встало в очередь: запомнить для кулдауна и дублей. */
export function commitFiltered(
  msg: ChatMessage,
  text: string,
  state: FilterState,
  now: number,
  settings: Settings
): void {
  state.lastByUser.set(msg.user, now)
  state.recentTexts.set(dupKey(text), now)
  // Чистим старое, чтобы карты не росли весь стрим.
  const keep = Math.max(settings.filters.duplicateSec, settings.filters.userCooldownSec) * 1000
  for (const [k, t] of state.recentTexts) if (now - t > keep) state.recentTexts.delete(k)
  for (const [k, t] of state.lastByUser) if (now - t > keep) state.lastByUser.delete(k)
}
