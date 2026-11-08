// Мастер первого запуска: канал, ключ Fish, первое сообщение. Голос не выбирается: стоит голос по умолчанию, поиск и выбор - в
// разделе "Голос". Показывается, пока ui.wizardDone = false. Каждый шаг можно
// пропустить: всё то же самое есть в разделах слева.
import { useState } from 'react'
import type { PublicSettings } from '@shared/settings'
import type { ChatStatus, FeedEntry, FishStatus } from '@shared/types'
import { ChannelField, FishKeyField } from './ConnectionFields'

const STEPS = ['Канал', 'Ключ Fish Audio', 'Первое сообщение'] as const

/** Мастер пройден или закрыт: больше не показывать. */
function finish(): void {
  void window.api.settings.set({ ui: { wizardDone: true } })
}

export function Wizard(props: {
  s: PublicSettings
  status: ChatStatus
  fish: FishStatus
  feed: FeedEntry[]
}): React.JSX.Element {
  const { s, status, fish, feed } = props
  const [step, setStep] = useState(0)

  const hasKey = fish.key === 'ok' || fish.key === 'env'
  const prefix = s.filters.prefix.enabled ? (s.filters.prefix.list[0] ?? '') : ''
  const spoken = feed.some((e) => e.status === 'speaking' || e.status === 'spoken')

  const voice = s.tts.voices.find((v) => v.id === s.tts.voiceId)?.title ?? null
  const ready = [status.state === 'connected', hasKey, spoken][step] ?? false
  const last = step === STEPS.length - 1

  return (
    <div className="modal-back">
      <div className="modal wizard" role="dialog" aria-modal="true" aria-label="Первая настройка">
        <ol className="wizard-steps">
          {STEPS.map((t, i) => (
            <li key={t} className={i === step ? 'on' : i < step ? 'past' : ''}>
              <span className="mono">{i + 1}</span> {t}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="wizard-body">
            <p>Укажите, чей чат озвучивать. Обычно это ваш канал.</p>
            <ChannelField value={s.twitch.channel} />
            <p className="muted small">
              {status.state === 'connected'
                ? `Подключено к #${status.channel}: сообщения чата уже идут в ленту.`
                : (status.detail ?? 'Введите имя канала.')}
            </p>
          </div>
        )}

        {step === 1 && (
          <div className="wizard-body">
            <p>
              Голос делает сервис Fish Audio, ему нужен ваш ключ. Ключ берётся бесплатно: войдите на{' '}
              <a href="https://fish.audio/app/api-keys/" target="_blank" rel="noreferrer">
                fish.audio, страница API Keys
              </a>
              , нажмите "Create", скопируйте ключ и вставьте сюда.
            </p>
            {fish.key === 'env' ? (
              <p className="ok">Ключ уже задан (режим разработки).</p>
            ) : (
              <FishKeyField status={s.fishKey} />
            )}
            <p className="muted small">
              Ключ хранится только на этом компьютере в зашифрованном виде. Сначала стоит бесплатная
              модель голоса (s2.1-pro-free), она денег не тратит.
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="wizard-body">
            <p>
              Напишите в чат канала <span className="mono">#{s.twitch.channel || '...'}</span>{' '}
              сообщение
              {prefix ? (
                <>
                  , начиная с <span className="mono">{prefix}</span>, например:{' '}
                  <span className="mono">{prefix} привет</span>
                </>
              ) : (
                ', любое: сейчас озвучивается весь чат'
              )}
              .
            </p>
            {s.audio.output === 'obs' && !spoken && (
              <p className="banner warn inline">
                Звук сейчас идёт в OBS: пока там не добавлен источник "Браузер" с адресом из раздела
                "Звук", озвучка стоит на паузе и сообщение не прозвучит.
              </p>
            )}
            <p className={spoken ? 'ok' : 'muted small'}>
              {spoken
                ? 'Первое сообщение прозвучало. Настройка закончена.'
                : 'Жду сообщение. Если оно не появилось в чате за этим окном, проверьте имя канала. Если появилось, но не звучит, причина написана рядом с ним.'}
            </p>
            <p className="muted small">
              {voice ? `Читает голос "${voice}".` : 'Читает стандартный голос Fish.'} Найти другой
              можно в разделе "Голос".
            </p>
          </div>
        )}

        <div className="modal-actions">
          <button className="link wizard-skip" onClick={finish}>
            Пропустить настройку
          </button>
          {step > 0 && <button onClick={() => setStep(step - 1)}>Назад</button>}
          {last ? (
            <button className="btn-primary" onClick={finish}>
              Готово
            </button>
          ) : (
            <button className={ready ? 'btn-primary' : ''} onClick={() => setStep(step + 1)}>
              {ready ? 'Дальше' : 'Пропустить шаг'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
