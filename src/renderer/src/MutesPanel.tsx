// Раздел "Мьюты и чёрный список": кто сейчас не озвучивается и до какого времени.
import { useState } from 'react'
import type { PublicSettings } from '@shared/settings'
import type { Result } from '@shared/types'
import { IconButton, MUTE_OPTIONS, hhmm, useNow } from './ui'

const left = (ms: number): string => {
  const min = Math.ceil(ms / 60_000)
  if (min < 60) return `${min} мин`
  const h = Math.floor(min / 60)
  return `${h} ч ${min % 60} мин`
}

export function MutesPanel({ s }: { s: PublicSettings }): React.JSX.Element {
  const now = useNow(15_000)
  const [nick, setNick] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mutes = s.mutes.filter((m) => m.until > now).sort((a, b) => a.until - b.until)

  const run = (p: Promise<Result<null>>): void => {
    void p.then((r) => {
      setError(r.ok ? null : r.error)
      if (r.ok) setNick('')
    })
  }
  const login = nick.trim().toLowerCase().replace(/^@/, '')

  return (
    <div className="page">
      <section className="group">
        <h3>Мьют или чёрный список по нику</h3>
        <p className="muted">
          Мьют: сообщения зрителя не озвучиваются, пока он не кончится. Проще ставить его кнопками у
          сообщения в чате или в очереди, здесь можно по нику.
        </p>
        <div className="row wrap">
          <input
            value={nick}
            aria-label="Ник зрителя"
            placeholder="ник зрителя"
            onChange={(e) => setNick(e.target.value)}
          />
          {MUTE_OPTIONS.map(([min, label]) => (
            <button
              key={min}
              disabled={!login}
              onClick={() => run(window.api.actions.mute(login, min))}
            >
              Мьют на {label}
            </button>
          ))}
          <button
            className="danger"
            disabled={!login}
            onClick={() => run(window.api.actions.blacklist(login, true))}
          >
            В чёрный список
          </button>
        </div>
        {error && <div className="banner err inline">{error}</div>}
      </section>

      <section className="group">
        <h3>
          Мьюты <span className="muted mono">{mutes.length}</span>
        </h3>
        {mutes.length === 0 && <p className="muted">Никто не в мьюте.</p>}
        {mutes.map((m) => (
          <div key={m.login} className="row listrow">
            <b>{m.login}</b>
            <span className="muted">
              до {hhmm(m.until)}, осталось {left(m.until - now)}
            </span>
            <IconButton
              icon="close"
              title="Снять мьют"
              onClick={() => run(window.api.actions.unmute(m.login))}
            />
          </div>
        ))}
      </section>

      <section className="group">
        <h3>
          Чёрный список <span className="muted mono">{s.filters.blacklist.length}</span>
        </h3>
        <p className="muted">
          Сообщения этих зрителей не озвучиваются, пока вы не уберёте их из списка.
        </p>
        {s.filters.blacklist.length === 0 && <p className="muted">Список пуст.</p>}
        {s.filters.blacklist.map((n) => (
          <div key={n} className="row listrow">
            <b>{n}</b>
            <IconButton
              icon="close"
              title="Убрать из чёрного списка"
              onClick={() => run(window.api.actions.blacklist(n, false))}
            />
          </div>
        ))}
      </section>
    </div>
  )
}
