// Антиспам: каждое правило отдельно включается и работает в режиме "сжимать" или "отклонять".
// Чатеры будут специально изощряться, поэтому стример сам решает, что пропускать.
import type { FilterSettings, RuleMode } from '@shared/settings'
import {
  charLength,
  collapseSpaces,
  hasWords,
  joinSegments,
  splitTags,
  tidy,
  type Segment
} from './text'

export type AntispamResult = { pass: true; text: string } | { pass: false; reason: string }

/** Сколько символов оставлять от длинной цепочки смеха. */
export const LAUGH_KEEP = 6
/** Минимальная длина цепочки смеха, с которой правило срабатывает. */
export const LAUGH_MIN = 10

const VOWELS = new Set('аеёиоуыэюяaeiouy')

/** аааааа (больше 4 подряд) -> ааа. */
export function compressLetters(text: string, caseSensitive: boolean): string {
  return text.replace(new RegExp('(\\p{L})\\1{4,}', caseSensitive ? 'gu' : 'giu'), '$1$1$1')
}

/** брбрбрбр (блок 2-5 символов больше 3 раз подряд) -> брбрбр. */
export function compressSyllables(text: string, caseSensitive: boolean): string {
  // Только блоки с буквой: "1000000000" - число, а не "брбрбр".
  return text.replace(
    new RegExp('(\\S{2,5}?)\\1{3,}', caseSensitive ? 'gu' : 'giu'),
    (m, g: string) => (/\p{L}/u.test(g) ? g + g + g : m)
  )
}

/** Фраза из скольких слов максимум ищется как повтор. */
export const PHRASE_MAX_WORDS = 6
/** С какого числа повторов подряд фраза считается спамом и сколько повторов оставить. */
export const PHRASE_MIN_REPEATS = 4
export const PHRASE_KEEP = 2

/**
 * Повтор слов и фраз через пробел: "УМА УМА САМБА САМБА САМБА" x4, "Ы Ы Ы Ы Ы Ы".
 * Фраза из 1-6 слов, повторённая 4 раза и больше подряд, сжимается до 2 повторов.
 * Слова сравниваются без знаков препинания по краям ("эм.." = "эм").
 */
export function compressWords(text: string, caseSensitive: boolean): string {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < PHRASE_MIN_REPEATS) return text
  const key = (w: string): string => {
    const k = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    return caseSensitive ? k : k.toLowerCase()
  }
  const keys = words.map(key)
  const out: string[] = []
  let i = 0
  while (i < words.length) {
    let best: { len: number; reps: number } | null = null
    for (let len = 1; len <= PHRASE_MAX_WORDS && i + len <= words.length; len++) {
      if (keys.slice(i, i + len).some((k) => k === '')) break
      let reps = 1
      while (
        i + (reps + 1) * len <= words.length &&
        keys.slice(i + reps * len, i + (reps + 1) * len).every((k, j) => k === keys[i + j])
      ) {
        reps++
      }
      // Предпочитаем вариант, который покрывает больше слов.
      if (reps >= PHRASE_MIN_REPEATS && (!best || reps * len > best.reps * best.len)) {
        best = { len, reps }
      }
    }
    if (best) {
      out.push(...words.slice(i, i + best.len * PHRASE_KEEP))
      i += best.len * best.reps
    } else {
      out.push(words[i] as string)
      i++
    }
  }
  // Пробелы по краям сегмента сохраняем: сегмент может стоять между тегами.
  const lead = /^\s/.test(text) ? ' ' : ''
  const trail = /\s$/.test(text) ? ' ' : ''
  return lead + out.join(' ') + trail
}

/**
 * Смех и звуки с чередованием слогов: "ухухухуахахахахехехех".
 * Цепочка = буквы, где согласная одна и та же (х), между ними 1-2 гласные, и две согласные подряд не идут.
 * Если цепочка длиннее LAUGH_MIN и в ней не меньше 4 согласных - оставляем первые LAUGH_KEEP символов.
 * Осмысленное слово после цепочки ("моанс") остаётся, через пробел.
 */
export function compressLaughter(text: string): string {
  return text.replace(/\p{L}+/gu, (word) => {
    const lc = word.toLowerCase()
    let out = ''
    let i = 0
    while (i < lc.length) {
      let j = i
      let pivot: string | null = null
      let vowelRun = 0
      let pivots = 0
      while (j < lc.length) {
        const c = lc[j] as string
        if (VOWELS.has(c)) {
          if (++vowelRun > 2) break
        } else {
          if (pivot === null) pivot = c
          if (c !== pivot || (j > i && lc[j - 1] === pivot)) break
          vowelRun = 0
          pivots++
        }
        j++
      }
      if (j - i >= LAUGH_MIN && pivots >= 4) {
        out += word.slice(i, i + LAUGH_KEEP)
        if (j < lc.length) out += ' '
        i = j
      } else {
        out += word[i]
        i++
      }
    }
    return out
  })
}

const ACTION_RE = /\*([^*\n]{1,40})\*/g

/** Правило, которое меняет только текст вне тегов. */
function applyTextRule(
  segments: Segment[],
  mode: RuleMode,
  fn: (s: string) => string
): { segments: Segment[]; changed: boolean } {
  if (mode === 'off') return { segments, changed: false }
  let changed = false
  const out = segments.map((s) => {
    if (s.type !== 'text') return s
    const v = fn(s.value)
    if (v !== s.value) changed = true
    return { ...s, value: v }
  })
  return { segments: out, changed }
}

const textLen = (segments: Segment[]): number =>
  charLength(
    segments
      .filter((s) => s.type === 'text')
      .map((s) => s.value)
      .join('')
      .replace(/\s/g, '')
  )

/** Пустой или пунктуационный текст между тегами: такие теги считаются "подряд". */
const isSeparator = (s: Segment): boolean => s.type === 'text' && /^[\s,.;!?-]*$/.test(s.value)

export function applyAntispam(input: string, cfg: FilterSettings['antispam']): AntispamResult {
  // 1. Действия в звёздочках: *moans*.
  let text = input
  if (cfg.actions === 'tag') text = text.replace(ACTION_RE, '[$1]')
  // После вырезания остаются двойные пробелы: убираем, иначе "повтор слов" увидит изменение.
  else if (cfg.actions === 'strip') text = collapseSpaces(text.replace(ACTION_RE, ' '))

  let segments = splitTags(text)
  const before = textLen(segments)

  // 2. Правила для букв (теги не трогаются).
  const rules: [RuleMode, (s: string) => string, string][] = [
    [cfg.letterRepeat, (s) => compressLetters(s, cfg.caseSensitive), 'повтор букв'],
    [cfg.syllableRepeat, (s) => compressSyllables(s, cfg.caseSensitive), 'повтор слога'],
    [cfg.wordRepeat, (s) => compressWords(s, cfg.caseSensitive), 'повтор слов'],
    [cfg.laughter, compressLaughter, 'длинный смех или звук']
  ]
  for (const [mode, fn, label] of rules) {
    const r = applyTextRule(segments, mode, fn)
    if (r.changed && mode === 'reject') return { pass: false, reason: `антиспам: ${label}` }
    segments = r.segments
  }

  // 3. Порог: сжатие убрало слишком много - это спам.
  const after = textLen(segments)
  if (before > 0) {
    const removed = Math.round(((before - after) / before) * 100)
    if (removed > cfg.threshold.percent && cfg.threshold.mode === 'reject') {
      return { pass: false, reason: `антиспам: повторы заняли ${removed}% текста` }
    }
  }

  // 4. Одинаковые теги подряд: [moan] [moan] -> [moan].
  if (cfg.dupTags) {
    const out: Segment[] = []
    let lastTag: string | null = null
    for (const s of segments) {
      if (s.type === 'tag') {
        if (s.name === lastTag) {
          // убираем и разделитель перед повтором
          while (out.length && isSeparator(out[out.length - 1] as Segment)) out.pop()
          continue
        }
        lastTag = s.name
      } else if (!isSeparator(s)) lastTag = null
      out.push(s)
    }
    segments = out
  }

  // 5. Лимит тегов.
  const tagCount = segments.filter((s) => s.type === 'tag').length
  if (cfg.tagLimit.mode !== 'off' && tagCount > cfg.tagLimit.max) {
    if (cfg.tagLimit.mode === 'reject') {
      return {
        pass: false,
        reason: `антиспам: тегов ${tagCount}, можно не больше ${cfg.tagLimit.max}`
      }
    }
    let kept = 0
    segments = segments.filter((s) => s.type !== 'tag' || ++kept <= cfg.tagLimit.max)
  }

  const result = tidy(joinSegments(segments))

  // 6. Только теги без слов.
  const hasTags = segments.some((s) => s.type === 'tag')
  const words = hasWords(
    segments
      .filter((s) => s.type === 'text')
      .map((s) => s.value)
      .join('')
  )
  if (hasTags && !words && cfg.tagsOnly === 'reject') {
    return { pass: false, reason: 'только теги без слов' }
  }
  return { pass: true, text: result }
}
