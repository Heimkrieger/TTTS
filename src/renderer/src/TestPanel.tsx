// Проверка фильтров: вставить сообщение и сразу увидеть, что прозвучит.
// Кулдаун и дубли здесь не учитываются, роль - стример.
import { useEffect, useState } from 'react'
import type { FilterTestResult } from '@shared/ipc'
import type { PublicSettings } from '@shared/settings'

/** Примеры без префикса: префикс подставляется из настроек, чтобы пример не отклонялся из-за него. */
const EXAMPLES = [
  '[gasp], [gasp], [groan], [pant], (sighs), [gasp], [moan] [moan], [gasp], [groan], [pant], (sighs)',
  '[moan], [moan], [gasp], [groan], [pant], (sighs), *moans*, [moan] [moan], [gasp], [groan], [pant], (sighs), *ухухухуахахахахехехехмоанс*, [moan] \u{E0000}',
  'брбрбрбрбрбрбрбрбрбрбрбрбр',
  'KEKW смотри https://example.com аааааааа 😀'
]

export function TestPanel({ settings }: { settings: PublicSettings }): React.JSX.Element {
  const prefix = settings.filters.prefix.enabled ? (settings.filters.prefix.list[0] ?? '') : ''
  const example = (i: number): string => {
    const body = EXAMPLES[i] ?? ''
    return prefix ? `${prefix} ${body}` : body
  }
  const [text, setText] = useState(() => example(0))
  const [result, setResult] = useState<FilterTestResult | null>(null)

  // Пересчёт при изменении текста или любых настроек.
  useEffect(() => {
    let alive = true
    void window.api.chat.testMessage(text).then((r) => alive && setResult(r))
    return () => {
      alive = false
    }
  }, [text, settings])

  return (
    <div className="panel-scroll">
      <section className="group">
        <h3>Проверка фильтров</h3>
        <p className="muted">
          Вставьте сообщение так, как его напишут в чат (с префиксом). Результат обновляется сразу,
          в том числе при смене настроек в разделе "Фильтры". Кулдаун и повторы здесь не
          проверяются, сообщение считается написанным вами.
        </p>
        <textarea
          rows={4}
          value={text}
          aria-label="Сообщение для проверки"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="examples">
          {EXAMPLES.map((_ex, i) => (
            <button key={i} onClick={() => setText(example(i))}>
              Пример {i + 1}
            </button>
          ))}
        </div>
        {result && (
          <div className={`result ${result.pass ? 'ok' : 'err'}`}>
            {result.pass ? (
              <>
                <div className="muted">Прозвучит:</div>
                <div className="big">{result.text}</div>
              </>
            ) : (
              <div>
                {result.kind === 'no-prefix' ? 'Не озвучится: ' : 'Отклонено: '}
                {result.reason}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
