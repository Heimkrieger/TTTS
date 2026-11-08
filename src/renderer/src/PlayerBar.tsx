// Нижняя панель управления, одна строка: озвучка вкл/выкл, голос и тест, скорость, громкость,
// повтор, пропуск, стоп и главная кнопка "Пауза". Состояние Fish и чата - в боковом меню.
import { useState } from 'react'
import type { PublicSettings, SettingsPatch } from '@shared/settings'
import type { FishStatus, QueueSnapshot } from '@shared/types'
import { useConfirm } from './confirm'
import { playTest } from './playTest'
import { Icon, IconButton, type IconName } from './ui'

/** Ползунок, который сохраняет значение, когда его отпустили (а не на каждый шаг). */
function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onCommit: (v: number) => void
}): React.JSX.Element {
  const [drag, setDrag] = useState<number | null>(null)
  const v = drag ?? props.value
  const commit = (): void => {
    if (drag !== null) props.onCommit(drag)
    setDrag(null)
  }
  return (
    <label className="pb-slider">
      <span className="pb-label">
        {props.label} <span className="mono">{props.format(v)}</span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={v}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
      />
    </label>
  )
}

/** Кнопка с иконкой и короткой подписью под ней (подсказка по наведению - подробнее). */
function CapButton(props: {
  icon: IconName
  label: string
  title: string
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      className="cap-btn"
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
      <span>{props.label}</span>
    </button>
  )
}

export function PlayerBar(props: {
  s: PublicSettings
  queue: QueueSnapshot
  fish: FishStatus
  set: (p: SettingsPatch) => void
  goVoice: () => void
}): React.JSX.Element {
  const { s, queue } = props
  const confirm = useConfirm()
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const cur = queue.current
  const waiting = queue.items.length
  const canReplay = queue.history.some((h) => h.status === 'done')

  return (
    <footer className="playerbar">
      <label className="switch" title="Включить или выключить озвучку">
        <input
          type="checkbox"
          checked={s.tts.enabled}
          onChange={(e) => props.set({ tts: { enabled: e.target.checked } })}
        />
        <span>{s.tts.enabled ? 'Озвучка вкл' : 'Озвучка выкл'}</span>
      </label>

      <div className="pb-voice">
        <select
          aria-label="Голос"
          value={s.tts.voiceId}
          onChange={(e) => {
            if (e.target.value === '__more') props.goVoice()
            else props.set({ tts: { voiceId: e.target.value } })
          }}
        >
          <option value="">голос по умолчанию Fish</option>
          {s.tts.voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.title}
            </option>
          ))}
          <option value="__more">другой голос...</option>
        </select>
        <IconButton
          icon="play"
          title={testError ?? (testing ? 'Готовлю...' : 'Проверить голос')}
          danger={testError !== null}
          disabled={testing || props.fish.key === 'none'}
          onClick={() => {
            setTesting(true)
            void playTest('Привет, чат. Это проверка голоса.').then((err) => {
              setTesting(false)
              setTestError(err ? `Проверка не прошла: ${err}` : null)
            })
          }}
        />
        {testError && (
          <small className="err pb-err" role="alert" title={testError}>
            {testError}
          </small>
        )}
      </div>

      <Slider
        label="Скорость"
        value={s.tts.speed}
        min={0.5}
        max={2}
        step={0.05}
        format={(v) => `${Math.round(v * 100)} %`}
        onCommit={(v) => props.set({ tts: { speed: v } })}
      />
      <Slider
        label="Громкость"
        value={s.tts.volume}
        min={0}
        max={200}
        step={5}
        format={(v) => `${v} %`}
        onCommit={(v) => props.set({ tts: { volume: v } })}
      />

      <div className="pb-actions">
        <CapButton
          icon="replay"
          label="повтор"
          title={
            canReplay
              ? 'Повторить последнее сообщение (бесплатно)'
              : 'Повторять пока нечего: ещё ничего не прозвучало'
          }
          disabled={!canReplay}
          onClick={() => void window.api.queue.replayLast()}
        />
        <CapButton
          icon="skip"
          label="пропуск"
          title="Пропустить то, что звучит сейчас"
          disabled={!cur}
          onClick={() => void window.api.queue.skip()}
        />
        <CapButton
          icon="stop"
          label="стоп"
          title="Прервать то, что звучит, и очистить всю очередь"
          disabled={!cur && waiting === 0}
          onClick={() => {
            void confirm({
              title: `Очистить очередь (${waiting + (cur ? 1 : 0)})?`,
              text: 'То, что звучит сейчас, тоже остановится.',
              confirmText: 'Очистить',
              danger: true
            }).then((ok) => {
              if (ok) void window.api.queue.clear()
            })
          }}
        />
        <button
          className={`btn-main${queue.paused ? ' paused' : ''}`}
          onClick={() => void (queue.paused ? window.api.queue.resume() : window.api.queue.pause())}
        >
          <Icon name={queue.paused ? 'play' : 'pause'} />
          {queue.paused ? 'Продолжить' : 'Пауза'}
        </button>
      </div>
    </footer>
  )
}
