// Общие операции с текстом сообщения: невидимые символы, теги, пробелы.

/**
 * Невидимые символы. Главный - U+E0000: его добавляют Chatterino и 7TV, чтобы обойти запрет Twitch
 * на одинаковое сообщение дважды. Если его не убрать, фильтр дублей не сработает.
 */
const INVISIBLE_RE = new RegExp(
  // \p{Cf} - все форматирующие символы (направление текста, нулевой ширины). U+E0000-E007F -
  // "теги" от Chatterino и 7TV: сам U+E0000 в класс Cf не входит, поэтому указан отдельно.
  // Плюс символы, которые выглядят пустыми, но считаются буквами или модификаторами:
  // U+034F, U+115F, U+1160, U+3164, U+FFA0 (корейские "заполнители"), U+180B-180F,
  // вариационные селекторы U+FE00-FE0F и U+E0100-E01EF. Через них обходили стоп-слова и повторы.
  // eslint-disable-next-line no-misleading-character-class
  '[\\p{Cf}\\u{E0000}-\\u{E007F}\\u034F\\u115F\\u1160\\u180B-\\u180F\\u3164\\uFFA0\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}]',
  'gu'
)

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_RE, '')
}

export function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export type Segment = { type: 'tag'; value: string; name: string } | { type: 'text'; value: string }

/**
 * Теги эмоций в тексте:
 * [что угодно], (короткое, до 3 слов), <|служебный|>, <whisper> и </whisper>.
 * Длинные скобки "(кстати я тут сижу давно)" - обычный текст, не тег.
 */
const TAG_RE =
  /\[[^[\]\n]{1,60}\]|\([^()\n]{1,40}\)|<\|[^<>|\n]{1,40}\|>|<\/?[a-z][a-z_-]{0,20}>/giu

/** Имя тега для сравнения: без скобок, в нижнем регистре. [Moan] и (moan) - один тег. */
export function tagName(tag: string): string {
  return tag
    .replace(/^<\|?\/?|\|?>$|^[[(]|[\])]$/g, '')
    .trim()
    .toLowerCase()
}

export function splitTags(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(TAG_RE)) {
    const value = m[0]
    if (value.startsWith('(') && value.slice(1, -1).trim().split(/\s+/).length > 3) continue
    const idx = m.index
    if (idx > last) out.push({ type: 'text', value: text.slice(last, idx) })
    out.push({ type: 'tag', value, name: tagName(value) })
    last = idx + value.length
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) })
  return out
}

export function joinSegments(segments: Segment[]): string {
  return segments.map((s) => s.value).join('')
}

/** Текст без тегов (для подсчёта длины и проверок слов). */
export function textWithoutTags(text: string): string {
  return collapseSpaces(
    splitTags(text)
      .filter((s) => s.type === 'text')
      .map((s) => s.value)
      .join(' ')
  )
}

/**
 * Уборка "осиротевших" разделителей после удаления тегов или слов:
 * "[a], , , [b]" -> "[a], [b]", ", привет ," -> "привет".
 */
export function tidy(text: string): string {
  return collapseSpaces(
    text
      .replace(/(?:\s*[,;]\s*){2,}/g, ', ')
      .replace(/\s+([,;.!?])/g, '$1')
      .replace(/^[\s,;]+|[\s,;]+$/g, '')
  )
}

/** Длина в символах (кодовых точках): эмодзи и редкие буквы считаются за один символ. */
export function charLength(text: string): number {
  return Array.from(text).length
}

export function hasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}
