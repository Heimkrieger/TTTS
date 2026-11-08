// Теги эмоций перед отправкой в Fish.
//
// - Служебные теги <|speaker:0|>, <|phoneme_start|> из чата вырезаются всегда: их ставит только сама
//   программа (диалоги двумя голосами), иначе зритель сломает синтез.
// - Парные теги <whisper>...</whisper> (drama-3): по умолчанию разметка вырезается, текст остаётся.
// - Режим: как есть / (x) -> [x] / вырезать все теги.
// - Слова-запреты внутри тегов: такой тег вырезается целиком (например, чтобы чат не подставил стримера).
import type { Settings } from '@shared/settings'
import { splitTags, tidy } from '../filters/text'

export type TagSettings = Settings['tts']['tags']

const SERVICE_RE = /<\|[^<>|\n]{0,40}\|>/g
const PAIRED_RE = /<\/?[a-z][a-z_-]{0,20}>/gi

export function processTags(text: string, cfg: TagSettings): string {
  let t = text.replace(SERVICE_RE, ' ')
  if (!cfg.allowPaired) t = t.replace(PAIRED_RE, ' ')
  const blocked = cfg.blockedWords.map((w) => w.trim().toLowerCase()).filter(Boolean)
  const out = splitTags(t).map((seg) => {
    if (seg.type === 'text') return seg.value
    const v = seg.value
    const isPaired = v.startsWith('<')
    if (blocked.some((w) => seg.name.includes(w))) return ' '
    if (isPaired) return v
    if (cfg.mode === 'strip') return ' '
    if (cfg.mode === 'convert' && v.startsWith('(')) return `[${v.slice(1, -1)}]`
    return v
  })
  return tidy(out.join(''))
}
