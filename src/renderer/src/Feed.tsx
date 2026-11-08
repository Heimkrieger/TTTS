// Лента "Чат": строки без рамок. Подложка только у сообщений, которые идут в озвучку.
// Действия (озвучить, мьют, в чёрный список) появляются при наведении на строку.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { artLines } from '@shared/art'
import type { FeedEntry, FeedStatus } from '@shared/types'
import { ChatBadges, Nick, ReplyLine } from './badges'
import { BusyRing, IconButton, MuteButton, hhmm } from './ui'

/** Подпись статуса справа от ника. Для обычных сообщений чата подписи нет. */
const STATUS: Record<FeedStatus, [string, string] | null> = {
  'no-prefix': null,
  accepted: ['готовится', 'st-accent'],
  queued: ['в очереди', 'st-accent'],
  speaking: ['звучит', 'st-live'],
  spoken: ['прозвучало', 'st-dim'],
  skipped: ['не прозвучало', 'st-warn'],
  rejected: ['отклонено', 'st-live'],
  deleted: ['удалено', 'st-dim']
}

const TTS: FeedStatus[] = ['accepted', 'queued', 'speaking']

/** Текст сообщения. Рисунок из символов - по строкам, чтобы не разваливался в широком окне. */
function MessageText({ text }: { text: string }): React.JSX.Element {
  const lines = useMemo(() => artLines(text), [text])
  if (!lines) return <div className="txt">{text}</div>
  return (
    <div className="txt art" title="Рисунок из символов">
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  )
}

/** Одна строка ленты. memo: при новом сообщении старые строки не перерисовываются. */
const FeedRow = memo(function FeedRow({
  e,
  error,
  onSpeak,
  rewardMarked,
  onToggleReward
}: {
  e: FeedEntry
  error: string | undefined
  onSpeak: (id: string) => void
  /** Награда этого сообщения отмечена для озвучки (если сообщение - награда). */
  rewardMarked: boolean
  onToggleReward: (rewardId: string) => void
}): React.JSX.Element {
  const rewardId = e.message.rewardId
  const st = STATUS[e.status]
  const tts = TTS.includes(e.status)
  const waiting = e.status === 'queued' || e.status === 'accepted'
  return (
    <div className={`feed-row${tts ? ' tts' : ''}`}>
      <article
        className={`msg ${e.status}${tts ? ' tts' : ''}${waiting ? ' ring-busy' : e.status === 'speaking' ? ' ring-on' : ''}`}
      >
        {waiting && <BusyRing />}
        <ReplyLine m={e.message} />
        <div className="msg-top">
          <ChatBadges m={e.message} />
          <Nick m={e.message} />
          {rewardId && (
            <span
              className={`src reward-chip${rewardMarked ? ' reward-on' : ''}`}
              title={
                rewardMarked
                  ? 'Сообщение за награду за баллы. Эта награда озвучивается'
                  : 'Сообщение за награду за баллы. Эта награда не озвучивается: включить можно кнопкой с подарком справа'
              }
            >
              награда
            </span>
          )}
          <span className="msg-actions">
            {rewardId && (
              <IconButton
                icon="gift"
                on={rewardMarked}
                title={rewardMarked ? 'Не озвучивать эту награду' : 'Озвучивать эту награду'}
                onClick={() => onToggleReward(rewardId)}
              />
            )}
            <IconButton
              icon="play"
              title="Озвучить вручную"
              onClick={() => onSpeak(e.message.id)}
            />
            <MuteButton login={e.message.user} />
            <IconButton
              icon="ban"
              title={`В чёрный список: ${e.message.user}`}
              danger
              onClick={() => void window.api.actions.blacklist(e.message.user, true)}
            />
          </span>
          {st && (
            <span className={`st ${st[1]}`} title={e.reason ?? undefined}>
              {st[0]}
              {e.reason && e.status !== 'queued' ? `: ${e.reason}` : ''}
            </span>
          )}
          <span className="t">{hhmm(e.message.timestamp)}</span>
        </div>
        <MessageText text={e.message.text} />
        {e.finalText !== null && e.finalText !== e.message.text.trim() && tts && (
          <div className="final">прозвучит: {e.finalText}</div>
        )}
        {error && (
          <div className="speak-err" role="alert">
            Не добавлено в очередь. {error}
          </div>
        )}
      </article>
    </div>
  )
})

/** Отступ снизу ленты (внутри прокрутки, чтобы список правильно мерил высоту). */
const Footer = (): React.JSX.Element => <div className="list-foot" />

export function Feed(props: {
  entries: FeedEntry[]
  channel: string
  /** Префиксы для озвучки; null - префикс выключен, озвучивается всё. */
  prefixes: string[] | null
  /** Что запускает озвучку и какие награды отмечены. */
  trigger: 'prefix' | 'reward' | 'both'
  rewardIds: string[]
  onToggleReward: (rewardId: string) => void
  onPrefix: () => void
  onClear: () => void
}): React.JSX.Element {
  const [onlyTts, setOnlyTts] = useState(false)
  const list = useRef<VirtuosoHandle>(null)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const stick = useRef(true)

  // Рисуются только видимые строки (react-virtuoso): 10 сообщений в секунду не тормозят окно.
  // Лента держится внизу, пока пользователь сам не прокрутил вверх. При смене размера окна
  // (развернуть, на весь экран) строки переносятся иначе: если были внизу, остаёмся внизу.
  useEffect(() => {
    if (!scroller) return
    const ro = new ResizeObserver(() => {
      if (stick.current) list.current?.scrollToIndex({ index: 'LAST', align: 'end' })
    })
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [scroller])

  const shown = useMemo(
    () => (onlyTts ? props.entries.filter((e) => e.status !== 'no-prefix') : props.entries),
    [onlyTts, props.entries]
  )

  // "Озвучить вручную": успех видно по переливу рамки (сообщение встало в очередь),
  // отказ - причиной под сообщением на несколько секунд.
  const [errors, setErrors] = useState<Record<string, string>>({})
  const speak = useCallback((id: string): void => {
    void window.api.actions.speak(id).then((r) => {
      if (r.ok) return
      setErrors((f) => ({ ...f, [id]: r.error }))
      setTimeout(
        () => setErrors((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== id))),
        5000
      )
    })
  }, [])

  return (
    <section className="col">
      <header className="col-head">
        <h2>
          Чат <span className="num">{props.entries.length}</span>
        </h2>
        <label className="switch" title="Показывать только сообщения для озвучки">
          <input type="checkbox" checked={onlyTts} onChange={(e) => setOnlyTts(e.target.checked)} />
          <span>только для озвучки</span>
        </label>
      </header>
      <div className="col-sub">
        <span className="mono">{props.channel ? `#${props.channel}` : 'канал не указан'}</span>
        <button
          className="link prefix-link"
          onClick={props.onPrefix}
          title="Настроить, что озвучивается"
        >
          {props.trigger === 'reward' ? (
            'озвучка за награду'
          ) : props.prefixes ? (
            <>
              озвучка по <span className="mono">{props.prefixes.join(' ')}</span>
              {props.trigger === 'both' ? ' и за награду' : ''}
            </>
          ) : (
            `озвучивается весь чат${props.trigger === 'both' ? ' и награды' : ''}`
          )}
        </button>
        <button
          className="link"
          onClick={props.onClear}
          title="Очистить ленту. Очередь не трогается"
        >
          Очистить
        </button>
      </div>
      {shown.length === 0 ? (
        <div className="col-list">
          <p className="empty">
            {!props.channel
              ? 'Укажите канал в разделе "Подключение".'
              : onlyTts && props.entries.length > 0
                ? 'Сообщений для озвучки пока нет. Снимите галку "только для озвучки", чтобы видеть весь чат.'
                : 'Новых сообщений пока нет. Здесь видно только то, что написали после подключения: старые сообщения Twitch программе не отдаёт.'}
          </p>
        </div>
      ) : (
        <Virtuoso
          ref={list}
          className="col-list virt"
          scrollerRef={(el) => setScroller(el instanceof HTMLElement ? el : null)}
          data={shown}
          computeItemKey={(_i, e) => e.message.id}
          initialTopMostItemIndex={shown.length - 1}
          followOutput={(atBottom) => (atBottom ? 'auto' : false)}
          atBottomThreshold={40}
          atBottomStateChange={(b) => (stick.current = b)}
          components={{ Footer }}
          itemContent={(_i, e) => (
            <FeedRow
              e={e}
              error={errors[e.message.id]}
              onSpeak={speak}
              rewardMarked={
                e.message.rewardId !== null &&
                props.trigger !== 'prefix' &&
                props.rewardIds.includes(e.message.rewardId)
              }
              onToggleReward={props.onToggleReward}
            />
          )}
        />
      )}
    </section>
  )
}
