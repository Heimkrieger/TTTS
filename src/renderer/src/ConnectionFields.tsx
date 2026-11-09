// Поля вкладки "Подключение": канал Twitch и ключ Fish Audio.
import { useRef, useState } from 'react'
import type { PublicSettings } from '@shared/settings'
import type { ConnectionCheck } from '@shared/types'

const STATE_ICON: Record<ConnectionCheck['steps'][number]['state'], string> = {
  ok: 'st-ok',
  warn: 'st-warn',
  fail: 'st-err',
  skip: 'st-muted'
}
const STATE_TEXT: Record<ConnectionCheck['steps'][number]['state'], string> = {
  ok: 'норма',
  warn: 'медленно',
  fail: 'ошибка',
  skip: 'пропущено'
}

/** Проверка связи с Fish: сервер, ключ, синтез - с временем каждого шага. */
export function ConnectionCheckBlock(): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<ConnectionCheck | null>(null)
  return (
    <div className="field">
      <span>Связь с Fish Audio</span>
      <div className="row">
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setRes(null)
            void window.api.fish.checkConnection().then((r) => {
              setRes(r)
              setBusy(false)
            })
          }}
        >
          {busy ? 'Проверяю...' : 'Проверить связь'}
        </button>
        <small className="muted">сервер, ключ и пробная озвучка на бесплатной модели</small>
      </div>
      {res && (
        <div className={`check ${res.ok ? 'ok' : 'err'}`}>
          {res.steps.map((s) => (
            <div key={s.title} className="check-row">
              <span className={STATE_ICON[s.state]}>{STATE_TEXT[s.state]}</span>
              <b>{s.title}</b>
              <span className="muted">
                {s.detail}
                {s.ms !== null ? ` · ${(s.ms / 1000).toFixed(1)} с` : ''}
              </span>
            </div>
          ))}
          <div className="check-verdict">{res.verdict}</div>
        </div>
      )}
    </div>
  )
}

/** Канал сохраняется сам через полсекунды после ввода, без кнопки "Сохранить". */
export function ChannelField({ value }: { value: string }): React.JSX.Element {
  const [text, setText] = useState(value)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onChange = (v: string): void => {
    setText(v)
    setSaved(false)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void window.api.settings.set({ twitch: { channel: v } }).then((res) => {
        if (res.ok) {
          setError(null)
          setSaved(true)
          setText(res.value.twitch.channel)
        } else setError(res.error)
      })
    }, 500)
  }

  return (
    <label className="field">
      <span>Канал Twitch</span>
      <input
        value={text}
        placeholder="имя канала или ссылка twitch.tv/..."
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <small className="err">{error}</small>}
      {saved && !error && <small className="ok">Сохранено</small>}
    </label>
  )
}

/** Адрес страницы ключей Fish Audio. */
export const FISH_KEYS_URL = 'https://fish.audio/app/api-keys/'

/** Как получить бесплатный ключ: по шагам, кнопки названы как на сайте fish.audio. */
export function FishKeyGuide(): React.JSX.Element {
  return (
    <>
      <ol className="steps">
        <li>
          Откройте{' '}
          <a href={FISH_KEYS_URL} target="_blank" rel="noreferrer">
            страницу ключей на fish.audio
          </a>
          .
        </li>
        <li>
          Нажмите "Вход / Регистрация" справа вверху. Войти можно через Google, GitHub, Apple или по
          почте. Карта не нужна.
        </li>
        <li>Нажмите "Создать ключ API". Название ключа любое, например TTS.</li>
        <li>
          Сразу скопируйте ключ: Fish показывает его один раз. Не успели - удалите ключ на сайте и
          создайте новый.
        </li>
        <li>Вставьте ключ в поле ниже и нажмите "Сохранить ключ".</li>
      </ol>
      <p className="muted small">
        Бесплатно работает модель s2.1-pro-free, в программе она стоит сразу. Если сайт спросит срок
        действия ключа, выберите подольше: когда срок кончится, понадобится новый ключ.
      </p>
    </>
  )
}

export function FishKeyField({ status }: { status: PublicSettings['fishKey'] }): React.JSX.Element {
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  const save = (): void => {
    void window.api.secrets.setFishKey(key).then((res) => {
      if (res.ok) {
        setKey('')
        setError(null)
      } else setError(res.error)
    })
  }

  if (status === 'ok') {
    return (
      <div className="field">
        <span>Ключ Fish Audio</span>
        <div className="row">
          <span className="ok">Ключ добавлен</span>
          <button onClick={() => void window.api.secrets.clearFishKey()}>Удалить ключ</button>
        </div>
      </div>
    )
  }

  return (
    <div className="field">
      <span>Ключ Fish Audio</span>
      <small className="hint">по нему Fish узнаёт ваш аккаунт, ключ бесплатный</small>
      <FishKeyGuide />
      {status === 'unreadable' && (
        <small className="err">
          Сохранённый ключ не читается на этом компьютере (папку перенесли с другого ПК или
          пользователя Windows). Введите ключ заново.
        </small>
      )}
      <div className="row">
        <input
          type="password"
          value={key}
          aria-label="Ключ Fish Audio"
          placeholder="вставьте ключ с fish.audio"
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <button onClick={save} disabled={key.trim() === ''}>
          Сохранить ключ
        </button>
      </div>
      {error && <small className="err">{error}</small>}
    </div>
  )
}
