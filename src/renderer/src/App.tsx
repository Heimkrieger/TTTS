// Главное окно: слева разделы, в центре "Весь чат", справа "Очередь TTS" с журналом,
// внизу панель управления озвучкой. Остальные разделы открываются на месте чата и очереди.
import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'
import type { PublicSettings, SettingsPatch } from '@shared/settings'
import type {
  ChatStatus,
  EmoteProviderStatus,
  FeedEntry,
  FishStatus,
  JournalEntry,
  QueueSnapshot,
  UpdateStatus
} from '@shared/types'
import { ChannelField, ConnectionCheckBlock, FishKeyField } from './ConnectionFields'
import { Feed } from './Feed'
import { Wizard } from './Wizard'
import { FeedbackDialog } from './FeedbackDialog'
import { UpdateDialog } from './UpdateDialog'
import { FilterPanel } from './FilterPanel'
import { MutesPanel } from './MutesPanel'
import { PlayerBar } from './PlayerBar'
import { QueuePanel } from './QueuePanel'
import { SoundPanel } from './SoundPanel'
import { AudioPanel } from './AudioPanel'
import { VoicePanel } from './VoicePanel'
import { HelpPanel } from './HelpPanel'
import { startPlayerBridge } from './playerBridge'
import { configure as configureAudio } from './audio'
import { TestPanel } from './TestPanel'
import { Icon, type IconName } from './ui'
import { APP_NAME } from '@shared/brand'

/** Коротко о Fish для бокового меню и подробно для подсказки. */
/**
 * Путь без начала: полный путь часто содержит имя пользователя Windows, а окно программы
 * бывает в кадре стрима. Полный путь - при наведении и кнопкой "Открыть папку данных".
 */
/** Блок "Обновления" в разделе "Подключение": версия, состояние, проверить сейчас. */
function UpdateInfo({ s }: { s: UpdateStatus }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const text =
    s.state === 'off'
      ? `Обновления выключены: ${s.reason}.`
      : s.state === 'checking'
        ? 'Проверяю...'
        : s.state === 'latest'
          ? 'Это последняя версия.'
          : s.state === 'available'
            ? `Вышла версия ${s.version}: окно обновления появится при следующем запуске.`
            : s.state === 'downloading'
              ? `Скачиваю версию ${s.version}: ${s.percent} %`
              : s.state === 'installing'
                ? `Распаковываю версию ${s.version}: ${s.percent} %`
                : s.state === 'ready'
                  ? `Версия ${s.version} скачана и проверена, ставится.`
                  : s.state === 'error'
                    ? `Не получилось: ${s.error}.`
                    : 'Программа проверяет обновления при запуске и раз в 6 часов.'
  return (
    <>
      <p className="small">
        Версия <span className="mono">{s.current}</span>. {text}
      </p>
      {s.state !== 'off' && (
        <button
          disabled={
            busy || s.state === 'checking' || s.state === 'downloading' || s.state === 'installing'
          }
          onClick={() => {
            setBusy(true)
            void window.api.update.check().then(() => setBusy(false))
          }}
        >
          Проверить сейчас
        </button>
      )}
    </>
  )
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length > 3 ? `...\\${parts.slice(-3).join('\\')}` : p
}

function fishShort(f: FishStatus): string {
  if (f.error) return 'ошибка'
  if (f.key === 'none') return 'нет ключа'
  if (f.key === 'unreadable') return 'ключ не читается'
  return f.balance !== null ? `$${Number(f.balance).toFixed(2)}` : 'ключ есть'
}
function fishTitle(f: FishStatus): string {
  const st = f.stats
  const head =
    f.error ??
    (f.key === 'env'
      ? 'Ключ из .env (разработка)'
      : f.key === 'ok'
        ? 'Ключ добавлен'
        : 'Нет ключа: озвучка без звука')
  return `${head}. С запуска программы: озвучено ${st.requests}, повторов без оплаты ${st.cacheHits}, потрачено около $${st.costUsd.toFixed(4)}`
}

const modeLabel: Record<AppInfo['dataMode'], string> = {
  portable: 'портативный (рядом с программой)',
  dev: 'разработка',
  fallback: 'запасной (системная папка Windows)'
}

const stateLabel: Record<ChatStatus['state'], string> = {
  idle: 'не подключено',
  connecting: 'подключение',
  joining: 'вход в канал',
  connected: 'подключено',
  reconnecting: 'переподключение',
  error: 'ошибка'
}

type View = 'main' | 'voice' | 'sound' | 'filters' | 'test' | 'mutes' | 'connection' | 'help'
const NAV: [View, string, IconName][] = [
  ['main', 'Чат и очередь', 'chat'],
  ['voice', 'Голос', 'volume'],
  ['sound', 'Звук', 'play'],
  ['filters', 'Фильтры', 'filter'],
  ['test', 'Проверка', 'check'],
  ['mutes', 'Мьюты и ЧС', 'users'],
  ['connection', 'Подключение', 'plug'],
  ['help', 'Справка', 'help']
]
const FEED_MAX = 200
const EMPTY_QUEUE: QueueSnapshot = {
  current: null,
  items: [],
  history: [],
  paused: false,
  pauseReason: null,
  stalled: null,
  silent: true
}

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [status, setStatus] = useState<ChatStatus | null>(null)
  const [emotes, setEmotes] = useState<EmoteProviderStatus[]>([])
  const [feed, setFeed] = useState<FeedEntry[]>([])
  const [queue, setQueue] = useState<QueueSnapshot>(EMPTY_QUEUE)
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [view, setView] = useState<View>('main')
  const [error, setError] = useState<string | null>(null)
  const [fish, setFish] = useState<FishStatus | null>(null)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)

  // Звук: очередь в main присылает команды проигрывания.
  useEffect(() => startPlayerBridge(), [])
  // Устройство вывода, монитор, компрессор - при запуске и при каждом изменении.
  const audioKey = settings ? JSON.stringify(settings.audio) : ''
  useEffect(() => {
    if (audioKey) void configureAudio(JSON.parse(audioKey) as PublicSettings['audio'])
  }, [audioKey])

  useEffect(() => {
    void window.api.app.info().then(setInfo)
    void window.api.settings.get().then(setSettings)
    void window.api.chat.status().then(setStatus)
    void window.api.chat.emotes().then(setEmotes)
    void window.api.chat.feed().then(setFeed)
    void window.api.queue.snapshot().then(setQueue)
    void window.api.journal.get().then(setJournal)
    void window.api.fish.status().then(setFish)
    void window.api.update.status().then(setUpdate)
    const offs = [
      window.api.settings.onChanged(setSettings),
      window.api.chat.onStatus(setStatus),
      window.api.chat.onEmotes(setEmotes),
      window.api.chat.onFeedReset(() => setFeed([])),
      window.api.queue.onUpdate(setQueue),
      window.api.fish.onStatus(setFish),
      window.api.update.onStatus(setUpdate),
      window.api.journal.onEntry((e) => setJournal((prev) => [...prev.slice(-99), e])),
      window.api.chat.onFeed((entries) =>
        setFeed((prev) => {
          // Новые записи - в конец, изменённые (статус очереди, удаление) - на своё место.
          const next = [...prev]
          for (const e of entries) {
            const i = next.findIndex((x) => x.message.id === e.message.id)
            if (i >= 0) next[i] = e
            else next.push(e)
          }
          return next.length > FEED_MAX ? next.slice(next.length - FEED_MAX) : next
        })
      )
    ]
    return () => offs.forEach((off) => off())
  }, [])

  const set = (patch: SettingsPatch): void => {
    void window.api.settings.set(patch).then((r) => setError(r.ok ? null : r.error))
  }

  if (!info || !settings || !status || !fish) return <div className="loading">Загрузка...</div>

  const emoteErrors = emotes.filter((e) => e.state === 'error')
  const showChatBanner =
    status.detail !== null && status.state !== 'connected' && status.state !== 'idle'

  return (
    <div className="shell">
      {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} />}
      {update && <UpdateDialog s={update} />}
      {!settings.ui.wizardDone && <Wizard s={settings} status={status} fish={fish} feed={feed} />}
      <nav className="sidebar">
        <div className="brand">
          {APP_NAME} <span className="mono">{info.version}</span>
        </div>
        {NAV.map(([v, label, icon]) => (
          <button
            key={v}
            className={`nav${view === v ? ' on' : ''}`}
            title={v === 'mutes' ? 'Мьюты и чёрный список' : undefined}
            onClick={() => setView(v)}
          >
            <Icon name={icon} />
            {label}
            {v === 'mutes' && settings.mutes.some((m) => m.until > Date.now()) && (
              <span className="dot" />
            )}
          </button>
        ))}
        <div className="side-foot">
          {update?.state === 'available' && !update.startup && (
            <div
              className="stat-sub"
              title="Окно обновления появится при следующем запуске программы. Сейчас ничего не прерывается."
            >
              вышла версия {update.version}
            </div>
          )}
          <div className="side-links">
            <button className="support" onClick={() => setFeedbackOpen(true)}>
              Сообщить о проблеме
            </button>
          </div>
          <div className="stat" title={status.detail ?? ''}>
            <span
              className={`dot ${status.state === 'connected' ? 'ok' : status.state === 'error' ? 'live' : 'warn'}`}
            />
            <span className="mono">
              {status.channel ? `#${status.channel}` : 'канал не указан'}
            </span>
            {status.state !== 'connected' && status.channel && (
              <span className="stat-sub">{stateLabel[status.state]}</span>
            )}
          </div>
          <div className="stat" title={fishTitle(fish)}>
            <span
              className={`dot ${fish.error || fish.key === 'none' || fish.key === 'unreadable' ? 'live' : 'ok'}`}
            />
            <span>Fish</span>
            <span className="stat-sub mono">{fishShort(fish)}</span>
          </div>
          {fish.budget.active && (
            <div
              className={fish.budget.exceeded ? 'stat' : 'stat-sub'}
              title={
                fish.budget.exceeded
                  ? fish.budget.onLimit === 'free'
                    ? 'Дневной лимит кончился. До полуночи читает бесплатная модель'
                    : 'Дневной лимит кончился, озвучка на паузе. Поднимите лимит в разделе "Голос" или подождите до полуночи'
                  : 'Сколько потрачено сегодня на платную модель и какой лимит. Меняется в разделе "Голос"'
              }
            >
              {fish.budget.exceeded && <span className="dot warn" />}
              <span className="mono">
                сегодня ${fish.budget.spentUsd.toFixed(2)} из ${fish.budget.limitUsd.toFixed(2)}
              </span>
            </div>
          )}
          <div
            className={emoteErrors.length ? 'stat' : 'stat-sub'}
            title={
              emotes
                .map((e) => `${e.provider}: ${e.state === 'error' ? e.error : e.count}`)
                .join(', ') +
              (emoteErrors.length
                ? '. Эмоуты этих сервисов не загрузились и могут читаться вслух как слова. Программа попробует снова через 10 минут.'
                : '')
            }
          >
            {emoteErrors.length > 0 && <span className="dot warn" />}
            <span>эмоуты {emotes.reduce((n, e) => n + e.count, 0)}</span>
            {emoteErrors.length > 0 && (
              <span className="stat-sub">
                не загрузились: {emoteErrors.map((e) => e.provider).join(', ')}
              </span>
            )}
          </div>
        </div>
      </nav>

      <div className="content">
        <div className="banners">
          {info.dataNotice && <div className="banner warn">{info.dataNotice}</div>}
          {info.settingsNotice && <div className="banner warn">{info.settingsNotice}</div>}
          {showChatBanner && (
            <div className={`banner ${status.state === 'error' ? 'err' : 'warn'}`}>
              {status.detail}
            </div>
          )}
          {error && <div className="banner err">Настройка не сохранена: {error}</div>}
        </div>

        {view === 'main' && (
          <div className="board">
            <Feed
              entries={feed}
              channel={status.channel}
              prefixes={settings.filters.prefix.enabled ? settings.filters.prefix.list : null}
              onPrefix={() => setView('filters')}
              onClear={() => setFeed([])}
              trigger={settings.filters.trigger}
              rewardIds={settings.filters.rewards.map((r) => r.id)}
              onToggleReward={(id) => {
                const f = settings.filters
                const marked = f.trigger !== 'prefix' && f.rewards.some((r) => r.id === id)
                if (marked) {
                  set({ filters: { rewards: f.rewards.filter((r) => r.id !== id) } })
                  return
                }
                // Отметили награду в режиме "только префикс" - включаем "префикс и награда",
                // иначе отметка ничего бы не изменила.
                const rewards = f.rewards.some((r) => r.id === id)
                  ? f.rewards
                  : [...f.rewards, { id, title: `Награда ${f.rewards.length + 1}` }]
                set({
                  filters: { rewards, trigger: f.trigger === 'prefix' ? 'both' : f.trigger }
                })
              }}
            />
            <QueuePanel queue={queue} journal={journal} fishKey={fish.key} />
          </div>
        )}
        {view === 'filters' && (
          <div className="page-wrap">
            <FilterPanel s={settings} set={set} />
          </div>
        )}
        {view === 'test' && (
          <div className="page-wrap">
            <TestPanel settings={settings} />
          </div>
        )}
        {view === 'help' && (
          <div className="page-wrap">
            <HelpPanel s={settings} />
          </div>
        )}
        {view === 'voice' && (
          <div className="page-wrap">
            <VoicePanel s={settings} fish={fish} set={set} onHelp={() => setView('help')} />
          </div>
        )}
        {view === 'sound' && (
          <div className="page-wrap">
            <SoundPanel s={settings} set={set} />
            <AudioPanel s={settings} set={set} />
          </div>
        )}
        {view === 'mutes' && (
          <div className="page-wrap">
            <MutesPanel s={settings} />
          </div>
        )}
        {view === 'connection' && (
          <div className="page-wrap">
            <div className="page">
              <section className="group">
                <h3>Подключение</h3>
                <ChannelField value={settings.twitch.channel} />
                <FishKeyField status={settings.fishKey} />
                <ConnectionCheckBlock />
                <div className="row mt">
                  <button
                    onClick={() => void window.api.settings.set({ ui: { wizardDone: false } })}
                  >
                    Пройти первую настройку заново
                  </button>
                  <small className="muted">канал, ключ, голос и проверка первым сообщением</small>
                </div>
              </section>
              <section className="group">
                <h3>Обновления</h3>
                {update && <UpdateInfo s={update} />}
              </section>
              <section className="group">
                <h3>Данные программы</h3>
                <dl>
                  <dt>Режим</dt>
                  <dd>{modeLabel[info.dataMode]}</dd>
                  <dt>Папка</dt>
                  <dd className="mono" title={info.dataDir}>
                    {shortPath(info.dataDir)}
                  </dd>
                  <dt>Файл журнала</dt>
                  <dd className="mono" title={info.logFile}>
                    {shortPath(info.logFile)}
                  </dd>
                </dl>
                <button onClick={() => void window.api.app.openDataDir()}>
                  Открыть папку данных
                </button>
              </section>
            </div>
          </div>
        )}
      </div>

      <PlayerBar
        s={settings}
        queue={queue}
        fish={fish}
        set={set}
        goVoice={() => setView('voice')}
      />
    </div>
  )
}
