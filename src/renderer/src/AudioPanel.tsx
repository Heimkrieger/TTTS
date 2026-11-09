// Вывод звука и горячие клавиши: устройство (VB-Cable для OBS), монитор в наушники,
// компрессор, сочетания клавиш для пропуска, паузы и вкл/выкл.
import { useEffect, useState } from 'react'
import { accelerator, type OutputDevice } from '@shared/audio'
import type { PublicSettings, SettingsPatch } from '@shared/settings'
import type { HotkeyAction, HotkeyStatus, OverlayStatus } from '@shared/types'
import { NumberField, Segmented, Toggle } from './controls'
import { listOutputs } from './audio'
import { IconButton } from './ui'

/** Похоже ли устройство на виртуальный кабель (VB-CABLE, Voicemeeter, VAC и т.п.). */
const isCable = (label: string): boolean => /cable|vb-audio|virtual|voicemeeter|vac\b/i.test(label)

/**
 * Страница для OBS: адрес, состояние подключения, как добавить источник. Показывается всегда:
 * подпись "кто говорит" на стриме работает при любом выводе звука. В режиме "OBS" туда же
 * идёт и сам звук - тогда добавляются шаги про звук.
 */
function ObsBlock({
  s,
  set,
  withAudio
}: {
  s: PublicSettings
  set: (p: SettingsPatch) => void
  /** Звук тоже идёт в OBS (вывод "OBS: источник "Браузер""). */
  withAudio: boolean
}): React.JSX.Element {
  const [st, setSt] = useState<OverlayStatus | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void window.api.overlay.status().then(setSt)
    return window.api.overlay.onStatus(setSt)
  }, [])
  if (!st) return <p className="muted small">Загрузка...</p>
  return (
    <div className="obs">
      {st.error ? (
        <div className="banner err inline">{st.error}</div>
      ) : (
        <div className="obs-url">
          <span className="mono">{st.url}</span>
          <button
            onClick={() =>
              void navigator.clipboard.writeText(st.url).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }
          >
            {copied ? 'Скопировано' : 'Скопировать адрес'}
          </button>
          <span className={`obs-state ${st.clients > 0 ? 'ok' : 'warn'}`}>
            <span className={`dot ${st.clients > 0 ? 'ok' : ''}`} />
            {st.clients > 0
              ? `OBS подключён${st.clients > 1 ? `, источников: ${st.clients}` : ''}`
              : 'OBS не подключён'}
          </span>
        </div>
      )}
      {st.clients > 1 && (
        <div className="banner warn inline">
          Открыто несколько источников с этим адресом, каждое сообщение прозвучит несколько раз.
          Оставьте один источник "Браузер".
        </div>
      )}
      <ol className="steps">
        <li>В OBS в блоке "Источники" нажмите плюс и выберите "Браузер".</li>
        <li>В поле "URL" вставьте адрес выше. Ширина 1920, высота 1080.</li>
        {withAudio && (
          <li>
            Включите галку "Управлять звуком через OBS": тогда озвучка появится в микшере OBS
            отдельной строкой.
          </li>
        )}
        <li>Готово: здесь появится "OBS подключён".</li>
      </ol>
      {withAudio ? (
        <p className="muted small">
          Пока источник не подключён, озвучка стоит на паузе, сообщения ждут в очереди.
        </p>
      ) : (
        <p className="muted small">
          Звук сейчас идёт не в OBS (см. "Куда идёт звук"), страница показывает только подпись на
          стриме.
        </p>
      )}
      <Toggle
        label="Показывать ник и текст на стриме"
        hint="карточка внизу слева, пока сообщение звучит"
        value={s.audio.overlayText}
        onChange={(v) => set({ audio: { overlayText: v } })}
      />
      <NumberField
        label="Порт"
        value={s.audio.obsPort}
        min={1024}
        max={65535}
        suffix="номер, по которому OBS находит программу. Менять, только если программа написала, что порт занят"
        onChange={(v) => set({ audio: { obsPort: v } })}
      />
    </div>
  )
}

const HOTKEYS: [HotkeyAction, string][] = [
  ['skip', 'Пропустить текущее'],
  ['pause', 'Пауза / продолжить'],
  ['toggle', 'Озвучка вкл/выкл']
]

function DeviceSelect(props: {
  label: string
  devices: OutputDevice[]
  id: string
  deviceLabel: string
  onChange: (d: OutputDevice) => void
}): React.JSX.Element {
  const known = props.devices.some((d) => d.deviceId === props.id || d.label === props.deviceLabel)
  return (
    <label className="ctl">
      <span className="ctl-label">{props.label}</span>
      <select
        value={props.devices.find((d) => d.label === props.deviceLabel)?.deviceId ?? props.id}
        onChange={(e) => {
          const d = props.devices.find((x) => x.deviceId === e.target.value)
          props.onChange(d ?? { deviceId: '', label: '' })
        }}
      >
        <option value="">как в Windows (по умолчанию)</option>
        {props.devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label}
          </option>
        ))}
        {!known && props.id && (
          <option value={props.id}>{props.deviceLabel || props.id} (не подключено)</option>
        )}
      </select>
    </label>
  )
}

/** Поле для сочетания клавиш: щёлкнуть и нажать нужные клавиши. */
function HotkeyField(props: {
  label: string
  value: string
  status: HotkeyStatus | undefined
  onChange: (v: string) => void
}): React.JSX.Element {
  const [listening, setListening] = useState(false)
  return (
    <div className="ctl">
      <span className="ctl-label">{props.label}</span>
      <div className="row">
        <button
          className={`hotkey${listening ? ' listening' : ''}`}
          onClick={() => setListening(true)}
          onBlur={() => setListening(false)}
          onKeyDown={(e) => {
            if (!listening) return
            e.preventDefault()
            if (e.code === 'Escape') {
              setListening(false)
              return
            }
            const acc = accelerator(e)
            if (acc) {
              setListening(false)
              props.onChange(acc)
            }
          }}
        >
          {listening ? 'нажмите сочетание (Esc - отмена)' : props.value || 'не назначено'}
        </button>
        {props.value && (
          <IconButton icon="close" title="Убрать сочетание" onClick={() => props.onChange('')} />
        )}
      </div>
      {props.status && !props.status.ok && <small className="err">{props.status.error}</small>}
    </div>
  )
}

export function AudioPanel({
  s,
  set
}: {
  s: PublicSettings
  set: (p: SettingsPatch) => void
}): React.JSX.Element {
  const [devices, setDevices] = useState<OutputDevice[]>([])
  const [hk, setHk] = useState<HotkeyStatus[]>([])
  const a = s.audio
  const cables = devices.filter((d) => isCable(d.label))

  useEffect(() => {
    const load = (): void => void listOutputs().then(setDevices)
    load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    void window.api.hotkeys.status().then(setHk)
    const off = window.api.hotkeys.onStatus(setHk)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', load)
      off()
    }
  }, [])

  return (
    <div className="page">
      <section className="group">
        <h3>Куда идёт звук</h3>
        <Segmented
          label=""
          value={a.output}
          options={[
            ['device', 'Динамики или наушники'],
            ['cable', 'Виртуальный кабель'],
            ['obs', 'OBS: источник "Браузер"']
          ]}
          onChange={(v) => set({ audio: { output: v } })}
          hint={
            a.output === 'cable'
              ? 'виртуальный кабель - программа, которая передаёт звук в OBS отдельной дорожкой'
              : undefined
          }
        />

        {a.output === 'device' && (
          <DeviceSelect
            label="Устройство"
            devices={devices}
            id={a.deviceId}
            deviceLabel={a.deviceLabel}
            onChange={(d) => set({ audio: { deviceId: d.deviceId, deviceLabel: d.label } })}
          />
        )}

        {a.output === 'cable' && (
          <>
            {cables.length > 0 ? (
              <DeviceSelect
                label="Кабель"
                devices={cables}
                id={a.deviceId}
                deviceLabel={a.deviceLabel}
                onChange={(d) => set({ audio: { deviceId: d.deviceId, deviceLabel: d.label } })}
              />
            ) : (
              <div className="banner warn inline">
                Виртуальный кабель не найден. Бесплатный VB-CABLE: скачайте с vb-audio.com/Cable,
                установите и перезапустите компьютер. Он появится здесь сам.
              </div>
            )}
            {cables.length > 0 && !isCable(a.deviceLabel) && (
              <div className="banner warn inline">
                Сейчас выбрано устройство, которое не похоже на виртуальный кабель. Выберите кабель
                из списка выше.
              </div>
            )}
            <p className="muted small mt">
              В OBS добавьте источник "Захват входного аудиопотока" и выберите в нём этот кабель
              ("CABLE Output"). Тогда громкость озвучки настраивается в микшере OBS отдельно.
            </p>
          </>
        )}

        {a.output !== 'obs' ? (
          <Toggle
            label="Компрессор"
            hint="выравнивает громкость: громкие голоса и крики не бьют по ушам"
            value={a.compressor}
            onChange={(v) => set({ audio: { compressor: v } })}
          />
        ) : (
          <p className="muted small mt">
            Компрессор в режиме OBS ставится фильтром на источник в самом OBS (Фильтры, Компрессор).
          </p>
        )}
      </section>

      <section className="group">
        <h3>Страница для OBS</h3>
        <p className="muted small">
          Подпись "кто говорит" внизу стрима, а в режиме "OBS" ещё и звук озвучки.
        </p>
        <ObsBlock s={s} set={set} withAudio={a.output === 'obs'} />
      </section>

      {a.output === 'obs' ? (
        <section className="group">
          <h3>Слышать озвучку самому</h3>
          <p className="muted small">
            В режиме "OBS" звук играет внутри OBS, поэтому слушают его тоже через OBS. Если в
            наушниках озвучки не слышно: в OBS в микшере нажмите шестерёнку у источника "Браузер",
            "Расширенные свойства аудио", в колонке "Мониторинг звука" выберите "Мониторинг и
            вывод". Так вы слышите ровно то же, что и зрители.
          </p>
        </section>
      ) : (
        <section className="group">
          <h3>Слышать озвучку самому</h3>
          <Toggle
            label="Дублировать в наушники"
            hint="нужно, если основной звук идёт в виртуальный кабель"
            value={a.monitor.enabled}
            onChange={(v) => set({ audio: { monitor: { enabled: v } } })}
          />
          {a.monitor.enabled && (
            <>
              <DeviceSelect
                label="Куда дублировать"
                devices={devices}
                id={a.monitor.deviceId}
                deviceLabel={a.monitor.deviceLabel}
                onChange={(d) =>
                  set({ audio: { monitor: { deviceId: d.deviceId, deviceLabel: d.label } } })
                }
              />
              {(a.monitor.deviceId || '') === (a.deviceId || '') && (
                <div className="banner warn inline">
                  Выбрано то же устройство, что и для основного звука: озвучка будет звучать дважды.
                  Выберите другое устройство или выключите дублирование.
                </div>
              )}
              <NumberField
                label="Громкость в наушниках"
                value={a.monitor.volume}
                min={0}
                max={200}
                suffix="%"
                onChange={(v) => set({ audio: { monitor: { volume: v } } })}
              />
            </>
          )}
        </section>
      )}

      <section className="group">
        <h3>Если озвучка остановилась</h3>
        <Toggle
          label="Подать сигнал"
          hint="когда озвучка встала из-за ошибки или пропал чат, значок программы на панели задач мигает красным и звучит короткий системный звук Windows. Звук слышен там же, где остальные звуки Windows"
          value={s.ui.alertSound}
          onChange={(v) => set({ ui: { alertSound: v } })}
        />
      </section>

      <section className="group">
        <h3>Горячие клавиши</h3>
        <p className="muted small">Работают, даже когда открыта игра.</p>
        {HOTKEYS.map(([action, label]) => (
          <HotkeyField
            key={action}
            label={label}
            value={s.hotkeys[action]}
            status={hk.find((h) => h.action === action)}
            onChange={(v) => set({ hotkeys: { [action]: v } })}
          />
        ))}
      </section>
    </div>
  )
}
