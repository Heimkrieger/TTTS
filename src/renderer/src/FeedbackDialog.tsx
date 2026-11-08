// Окно "Сообщить о проблеме": ошибка или идея уходит автору одной кнопкой, без аккаунтов.
// Отчёт собирает и очищает от личных данных основная часть программы; здесь он показывается
// целиком ("Что уйдёт автору"), чтобы пользователь видел, что именно отправляет.
import { useEffect, useState } from 'react'
import type { FeedbackDraft, FeedbackReport } from '@shared/types'
import { sendToAuthor } from '@shared/brand'
import { Segmented } from './controls'

/** Отчёт обычным текстом: для кнопки "Скопировать" и для показа. */
export function reportText(r: FeedbackReport): string {
  return [
    `${r.kind === 'bug' ? 'Ошибка' : 'Идея'} | версия ${r.appVersion} | ${r.os}`,
    `Дата: ${r.sentAt.split(' ')[0]}`,
    `Время: ${r.sentAt.split(' ').slice(1).join(' ')}`,
    r.contact ? `Связаться: ${r.contact}` : '',
    '',
    r.text,
    r.log ? `\n--- журнал ---\n${r.log}` : ''
  ]
    .filter((x, i) => x !== '' || i === 4)
    .join('\n')
}

export function FeedbackDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [draft, setDraft] = useState<FeedbackDraft>({
    kind: 'bug',
    text: '',
    contact: '',
    attachLog: true
  })
  const [preview, setPreview] = useState<FeedbackReport | null>(null)
  const [configured, setConfigured] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void window.api.feedback.configured().then(setConfigured)
  }, [])
  // Предпросмотр обновляется при каждом изменении: видно ровно то, что уйдёт.
  useEffect(() => {
    let alive = true
    void window.api.feedback.preview(draft).then((r) => alive && setPreview(r))
    return () => {
      alive = false
    }
  }, [draft])

  const set = (p: Partial<FeedbackDraft>): void => {
    setResult(null)
    setDraft((d) => ({ ...d, ...p }))
  }

  const send = (): void => {
    setBusy(true)
    void window.api.feedback.send(draft).then((r) => {
      setBusy(false)
      setResult(r.ok ? { ok: true, text: 'Отправлено, спасибо.' } : { ok: false, text: r.error })
    })
  }

  const copy = (): void => {
    if (!preview) return
    void navigator.clipboard.writeText(reportText(preview)).then(
      () => setResult({ ok: true, text: `Скопировано. Текст ${sendToAuthor()}.` }),
      () =>
        setResult({
          ok: false,
          text: 'Не удалось скопировать. Откройте "Что уйдёт автору", выделите текст и нажмите Ctrl+C.'
        })
    )
  }

  const sent = result?.ok === true && result.text.startsWith('Отправлено')
  const empty = draft.text.trim().length < 5

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div
        className="modal feedback"
        role="dialog"
        aria-modal="true"
        aria-label="Сообщить о проблеме"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>Сообщить о проблеме</h3>
        <Segmented
          label=""
          value={draft.kind}
          options={[
            ['bug', 'Что-то не работает'],
            ['idea', 'Идея или неудобство']
          ]}
          onChange={(v) => set({ kind: v })}
        />
        <label className="field">
          <span>
            {draft.kind === 'bug' ? 'Что случилось и что делали перед этим' : 'Что улучшить'}
          </span>
          <textarea
            rows={5}
            value={draft.text}
            maxLength={4000}
            onChange={(e) => set({ text: e.target.value })}
            placeholder={
              draft.kind === 'bug'
                ? 'Например: после смены голоса озвучка замолчала, в очереди висит "готовится"'
                : 'Например: хочу отдельную громкость для наград'
            }
          />
        </label>
        <label className="field">
          <span>Как с вами связаться, если нужно уточнить (необязательно)</span>
          <input
            value={draft.contact}
            maxLength={200}
            onChange={(e) => set({ contact: e.target.value })}
            placeholder="Telegram или почта"
          />
        </label>
        <label className="tick">
          <input
            type="checkbox"
            checked={draft.attachLog}
            onChange={(e) => set({ attachLog: e.target.checked })}
          />
          <span>Приложить журнал работы программы</span>
          <small className="hint">
            последние строки; ключи, имя пользователя Windows, IP и ваш канал из него убраны
          </small>
        </label>

        {preview && (
          <details className="fb-preview">
            <summary>Что уйдёт автору</summary>
            <pre>{reportText(preview)}</pre>
          </details>
        )}

        {!configured && (
          <p className="muted small">
            Отправка из программы в этой версии ещё не подключена: скопируйте текст и{' '}
            {sendToAuthor()}.
          </p>
        )}
        {empty && (
          <p className="muted small">Напишите хотя бы пару слов, тогда кнопки заработают.</p>
        )}
        {result && (
          <p className={`small ${result.ok ? 'ok' : 'err'}`} role="status">
            {result.text}
          </p>
        )}

        <div className="modal-actions">
          <button onClick={copy} disabled={empty || !preview}>
            Скопировать
          </button>
          <button onClick={onClose}>{sent ? 'Закрыть' : 'Отмена'}</button>
          {configured && !sent && (
            <button className="btn-primary" onClick={send} disabled={busy || empty}>
              {busy ? 'Отправляю...' : 'Отправить'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
