// История озвученного: последние 500 (прозвучали, пропущены, ошибки), новые сверху.
// "Ещё раз" ставит сообщение в начало очереди: звук из памяти или из кэша, если голос не менялся.
import { useEffect, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { QueueItemView, QueueStatus } from '@shared/types'
import { Nick } from './badges'
import { IconButton, hhmm } from './ui'

/** Отступ снизу списка. */
const Footer = (): React.JSX.Element => <div className="list-foot" />

const STATUS: Partial<Record<QueueStatus, [string, string]>> = {
  done: ['прозвучало', 'st-dim'],
  skipped: ['не прозвучало', 'st-warn'],
  failed: ['ошибка', 'st-live']
}

export function HistoryList({ latestId }: { latestId: string | null }): React.JSX.Element {
  const [items, setItems] = useState<QueueItemView[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Полная история приходит отдельным запросом, когда в ней появляется новое.
  useEffect(() => {
    let alive = true
    void window.api.queue.history().then((h) => alive && setItems(h))
    return () => {
      alive = false
    }
  }, [latestId])

  const replay = (id: string): void => {
    void window.api.queue.replay(id).then((r) => {
      if (r.ok) return
      setErrors((e) => ({ ...e, [id]: r.error }))
    })
  }

  if (items.length === 0) {
    return (
      <p className="empty">
        Здесь будет то, что уже прозвучало или было пропущено: последние 500 сообщений.
      </p>
    )
  }
  return (
    <Virtuoso
      className="col-list virt"
      components={{ Footer }}
      data={items}
      computeItemKey={(_i, it) => it.id}
      itemContent={(_i, it) => {
        const st = STATUS[it.status]
        return (
          <div className="wait">
            <span className="qnum">{hhmm(it.startedAt ?? it.message.timestamp)}</span>
            <div className="wait-body">
              <Nick m={it.message} />
              {st && (
                <span className={`st ${st[1]}`} title={it.reason ?? undefined}>
                  {st[0]}
                  {it.reason ? `: ${it.reason}` : ''}
                </span>
              )}
              <div className="txt">{it.text}</div>
              {errors[it.id] && (
                <div className="speak-err" role="alert">
                  {errors[it.id]}
                </div>
              )}
            </div>
            <span className="msg-actions">
              <IconButton
                icon="replay"
                title="Озвучить ещё раз, первым в очереди. Если голос не меняли, бесплатно"
                onClick={() => replay(it.id)}
              />
            </span>
          </div>
        )
      }}
    />
  )
}
