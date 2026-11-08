// Рисунки из символов (брайль, рамки, блоки), которые зрители вставляют в чат.
// На Twitch рисунок держит форму за счёт узкого чата: каждое "слово" из символов
// переносится на свою строку. В широком окне слова встают в одну строку и рисунок
// разваливается, поэтому строки рисунка показываем явно, по одному слову на строку.

/** Брайль U+2800-28FF, рамки U+2500-257F, блоки U+2580-259F, фигуры U+25A0-25FF. */
const ART_CHAR = /[─-◿⠀-⣿]/gu

/**
 * Если сообщение - рисунок, возвращает его строки (слова через пробел), иначе null.
 * Рисунок: минимум 2 строки, 16+ непробельных символов, из них 60%+ символы рисунка.
 */
export function artLines(text: string): string[] | null {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length < 2) return null
  const solid = words.join('')
  if (solid.length < 16) return null
  const art = solid.match(ART_CHAR)?.length ?? 0
  return art / [...solid].length >= 0.6 ? words : null
}
