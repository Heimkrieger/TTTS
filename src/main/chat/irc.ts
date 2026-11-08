// Разбор строк IRC с тегами IRCv3 (формат чата Twitch).
// Пример: @badges=moderator/1;color=#FF0000;display-name=Вася :vasya!vasya@vasya.tmi.twitch.tv PRIVMSG #chan :привет

export interface IrcMessage {
  tags: Record<string, string>
  /** Префикс без ":" (например, vasya!vasya@vasya.tmi.twitch.tv), или null. */
  prefix: string | null
  command: string
  params: string[]
}

/** Снятие экранирования значений тегов по IRCv3: \s пробел, \: ";", \\ "\", \r, \n. */
export function unescapeTag(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = value[++i]
    if (next === undefined) break
    out +=
      next === 's'
        ? ' '
        : next === ':'
          ? ';'
          : next === '\\'
            ? '\\'
            : next === 'r'
              ? '\r'
              : next === 'n'
                ? '\n'
                : next
  }
  return out
}

/** Разбор одной строки IRC. Возвращает null для пустой или битой строки. */
export function parseIrcLine(raw: string): IrcMessage | null {
  let line = raw.replace(/\r?\n$/, '')
  if (line === '') return null
  const tags: Record<string, string> = {}
  if (line.startsWith('@')) {
    const sp = line.indexOf(' ')
    if (sp === -1) return null
    for (const part of line.slice(1, sp).split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) tags[part] = ''
      else tags[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1))
    }
    line = line.slice(sp + 1).trimStart()
  }
  let prefix: string | null = null
  if (line.startsWith(':')) {
    const sp = line.indexOf(' ')
    if (sp === -1) return null
    prefix = line.slice(1, sp)
    line = line.slice(sp + 1).trimStart()
  }
  const params: string[] = []
  const trailingAt = line.indexOf(' :')
  let head = line
  let trailing: string | null = null
  if (trailingAt !== -1) {
    head = line.slice(0, trailingAt)
    trailing = line.slice(trailingAt + 2)
  }
  const parts = head.split(' ').filter((p) => p !== '')
  const command = parts.shift()
  if (!command) return null
  params.push(...parts)
  if (trailing !== null) params.push(trailing)
  return { tags, prefix, command: command.toUpperCase(), params }
}
