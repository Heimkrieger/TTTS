// Очередь: то, что звучит, - подложкой сверху с красной точкой и временем; дальше по порядку
// обычными строками. Ниже - журнал действий (мьюты, пропуски, ошибки).
import type { FishStatus, JournalEntry, QueueItemView, QueueSnapshot } from '@shared/types'
import { useState } from 'react'
import { useConfirm } from './confirm'
import { HistoryList } from './HistoryList'
import { Nick } from './badges'
import { BusyRing, IconButton, MuteButton, hhmmss, useNow } from './ui'

const WAIT_STATUS: Partial<Record<QueueItemView['status'], string>> = {
  synthesizing: 'готовится',
  ready: 'готово'
}

const SOURCE: Record<QueueItemView['source'], string | null> = {
  chat: null,
  manual: 'вручную',
  reward: 'награда'
}

const clock = (sec: number): string => {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function NowPlaying({ it, now }: { it: QueueItemView; now: number }): React.JSX.Element {
  const elapsed = it.startedAt ? (now - it.startedAt) / 1000 : 0
  const total = it.durationSec ?? 0
  const progress = total > 0 ? Math.min(1, elapsed / total) : 0
  return (
    <div className="now">
      <div className="now-top">
        <span className="live-dot" aria-hidden="true" />
        <span className="st st-live">Звучит</span>
        {SOURCE[it.source] && <span className="src">{SOURCE[it.source]}</span>}
        <span className="msg-actions show">
          <IconButton icon="skip" title="Пропустить" onClick={() => void window.api.queue.skip()} />
          <MuteButton login={it.message.user} />
        </span>
        <span className="t">
          {clock(Math.min(elapsed, total))} / {clock(total)}
        </span>
      </div>
      <div className="now-nick">
        <Nick m={it.message} />
      </div>
      <div className="now-text">{it.text}</div>
      <div className="progress" aria-hidden="true">
        <div style={{ transform: `scaleX(${progress})` }} />
      </div>
    </div>
  )
}

function Waiting({ it, index }: { it: QueueItemView; index: number }): React.JSX.Element {
  return (
    <div className={`wait${it.status === 'synthesizing' ? ' ring-busy' : ''}`}>
      {it.status === 'synthesizing' && <BusyRing />}
      <span className="qnum">{index}</span>
      <div className="wait-body">
        <Nick m={it.message} />
        {SOURCE[it.source] && <span className="src">{SOURCE[it.source]}</span>}
        {WAIT_STATUS[it.status] && <span className="src">{WAIT_STATUS[it.status]}</span>}
        <div className="txt">{it.text}</div>
      </div>
      <span className="msg-actions">
        <IconButton
          icon="up"
          title="Поднять в начало"
          onClick={() => void window.api.queue.moveToTop(it.id)}
        />
        <MuteButton login={it.message.user} />
        <IconButton
          icon="close"
          title="Убрать из очереди"
          danger
          onClick={() => void window.api.queue.remove(it.id)}
        />
      </span>
    </div>
  )
}

export function QueuePanel(props: {
  queue: QueueSnapshot
  journal: JournalEntry[]
  /** Состояние ключа: "без звука" объясняется по-разному для "нет ключа" и "не читается". */
  fishKey: FishStatus['key']
}): React.JSX.Element {
  const { queue } = props
  const confirm = useConfirm()
  const now = useNow(250, queue.current !== null)
  const total = queue.items.length + (queue.current ? 1 : 0)
  const [tab, setTab] = useState<'queue' | 'history'>('queue')

  return (
    <section className="col">
      <header className="col-head">
        <div className="col-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'queue'}
            className={tab === 'queue' ? 'on' : ''}
            onClick={() => setTab('queue')}
          >
            Очередь <span className="num">{total}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === 'history'}
            className={tab === 'history' ? 'on' : ''}
            onClick={() => setTab('history')}
          >
            История
          </button>
        </div>
        <IconButton
          icon="trash"
          title="Очистить очередь"
          danger
          disabled={total === 0 || tab === 'history'}
          onClick={() => {
            void confirm({
              title: `Очистить очередь (${total})?`,
              text: 'То, что звучит сейчас, тоже остановится.',
              confirmText: 'Очистить',
              danger: true
            }).then((ok) => {
              if (ok) void window.api.queue.clear()
            })
          }}
        />
      </header>
      <div className="col-sub">
        {tab === 'history' ? (
          <span>последние 500 сообщений, новые сверху. Повторить можно кнопкой справа</span>
        ) : queue.paused ? (
          <span className="st st-warn" title={queue.pauseReason ?? undefined}>
            {queue.pauseReason ? `На паузе: ${queue.pauseReason}` : 'На паузе'}
          </span>
        ) : (
          <span>
            {!total
              ? 'пусто'
              : queue.current
                ? `ещё ${queue.items.length} после текущего`
                : `в очереди ${queue.items.length}`}
          </span>
        )}
        {queue.silent && (
          <span
            className="st st-warn"
            title={
              props.fishKey === 'unreadable'
                ? 'Сохранённый ключ Fish Audio не читается на этом компьютере: очередь идёт без звука. Введите ключ заново в разделе "Подключение".'
                : 'Нет ключа Fish Audio: очередь идёт без звука. Добавьте ключ в разделе "Подключение".'
            }
          >
            без звука
          </span>
        )}
      </div>
      {tab === 'history' && <HistoryList latestId={queue.history[0]?.id ?? null} />}
      <div className="col-list" hidden={tab === 'history'}>
        {queue.current && <NowPlaying it={queue.current} now={now} />}
        {queue.items.map((it, i) => (
          <Waiting key={it.id} it={it} index={i + (queue.current ? 2 : 1)} />
        ))}
        {total === 0 && (
          <p className="empty">
            Очередь пуста. Сюда попадают сообщения, которые прозвучат, по порядку сверху вниз.
          </p>
        )}
      </div>
      <div className="journal" aria-label="Журнал действий">
        {props.journal.length === 0 && <div className="jrow">Журнал пока пуст</div>}
        {props.journal
          .slice(-30)
          .reverse()
          .map((j) => (
            <div key={j.id} className={`jrow ${j.level}`}>
              <span className="mono">{hhmmss(j.at)}</span> {j.text}
            </div>
          ))}
      </div>
    </section>
  )
}
