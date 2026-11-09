// Мост между renderer и main. Renderer видит только эти функции через window.api.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type TtsApi } from '@shared/ipc'
import type { PublicSettings } from '@shared/settings'

/** Подписка на событие из main. Возвращает функцию отписки. */
function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: TtsApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    openDataDir: () => ipcRenderer.invoke(IPC.appOpenDataDir),
    reloadWindow: () => ipcRenderer.invoke(IPC.appReloadWindow),
    onCloseAsk: (cb) => subscribe(IPC.evAppCloseAsk, cb),
    closeAskShown: () => ipcRenderer.send(IPC.appCloseAskShown),
    closeNow: () => ipcRenderer.invoke(IPC.appCloseNow)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, s: PublicSettings): void => cb(s)
      ipcRenderer.on(IPC.settingsChanged, listener)
      return () => ipcRenderer.removeListener(IPC.settingsChanged, listener)
    }
  },
  secrets: {
    setFishKey: (key) => ipcRenderer.invoke(IPC.secretsSetFishKey, key),
    clearFishKey: () => ipcRenderer.invoke(IPC.secretsClearFishKey)
  },
  chat: {
    status: () => ipcRenderer.invoke(IPC.chatStatus),
    feed: () => ipcRenderer.invoke(IPC.chatFeed),
    emotes: () => ipcRenderer.invoke(IPC.chatEmotes),
    testMessage: (text) => ipcRenderer.invoke(IPC.chatTest, text),
    onStatus: (cb) => subscribe(IPC.evChatStatus, cb),
    onFeed: (cb) => subscribe(IPC.evChatFeed, cb),
    onFeedReset: (cb) => subscribe(IPC.evChatFeedReset, cb),
    onEmotes: (cb) => subscribe(IPC.evChatEmotes, cb)
  },
  queue: {
    snapshot: () => ipcRenderer.invoke(IPC.queueSnapshot),
    pause: () => ipcRenderer.invoke(IPC.queuePause),
    resume: () => ipcRenderer.invoke(IPC.queueResume),
    skip: () => ipcRenderer.invoke(IPC.queueSkip),
    remove: (itemId) => ipcRenderer.invoke(IPC.queueRemove, itemId),
    moveToTop: (itemId) => ipcRenderer.invoke(IPC.queueMoveToTop, itemId),
    clear: () => ipcRenderer.invoke(IPC.queueClear),
    replayLast: () => ipcRenderer.invoke(IPC.queueReplay),
    replay: (itemId) => ipcRenderer.invoke(IPC.queueReplayItem, itemId),
    history: () => ipcRenderer.invoke(IPC.queueHistory),
    onUpdate: (cb) => subscribe(IPC.evQueue, cb)
  },
  update: {
    status: () => ipcRenderer.invoke(IPC.updateStatus),
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    cancel: () => ipcRenderer.invoke(IPC.updateCancel),
    quit: () => ipcRenderer.invoke(IPC.updateQuit),
    onStatus: (cb) => subscribe(IPC.evUpdate, cb)
  },
  feedback: {
    preview: (draft) => ipcRenderer.invoke(IPC.feedbackPreview, draft),
    send: (draft) => ipcRenderer.invoke(IPC.feedbackSend, draft),
    configured: () => ipcRenderer.invoke(IPC.feedbackConfigured)
  },
  journal: {
    get: () => ipcRenderer.invoke(IPC.journalGet),
    onEntry: (cb) => subscribe(IPC.evJournal, cb)
  },
  fish: {
    status: () => ipcRenderer.invoke(IPC.fishStatus),
    refresh: () => ipcRenderer.invoke(IPC.fishRefresh),
    searchVoices: (q, lang) => ipcRenderer.invoke(IPC.fishSearch, q, lang),
    addVoice: (input) => ipcRenderer.invoke(IPC.fishAddVoice, input),
    saveVoice: (id, title) => ipcRenderer.invoke(IPC.fishSaveVoice, id, title),
    removeVoice: (id) => ipcRenderer.invoke(IPC.fishRemoveVoice, id),
    test: (text, voiceId) => ipcRenderer.invoke(IPC.fishTest, text, voiceId),
    checkConnection: () => ipcRenderer.invoke(IPC.fishCheck),
    onStatus: (cb) => subscribe(IPC.evFish, cb)
  },
  player: {
    onPlay: (cb) => subscribe('player:play', cb),
    onStop: (cb) => subscribe('player:stop', cb),
    onPause: (cb) => subscribe('player:pause', cb),
    onResume: (cb) => subscribe('player:resume', cb),
    onVolume: (cb) => subscribe('player:volume', cb),
    ended: (id, result, error) => ipcRenderer.send(IPC.playerEnded, id, result, error),
    problem: (text) => ipcRenderer.send(IPC.playerProblem, text)
  },
  overlay: {
    status: () => ipcRenderer.invoke(IPC.overlayStatus),
    onStatus: (cb) => subscribe(IPC.evOverlay, cb)
  },
  hotkeys: {
    status: () => ipcRenderer.invoke(IPC.hotkeysStatus),
    onStatus: (cb) => subscribe(IPC.evHotkeys, cb)
  },
  actions: {
    speak: (messageId) => ipcRenderer.invoke(IPC.actSpeak, messageId),
    mute: (login, minutes) => ipcRenderer.invoke(IPC.actMute, login, minutes),
    unmute: (login) => ipcRenderer.invoke(IPC.actUnmute, login),
    blacklist: (login, on) => ipcRenderer.invoke(IPC.actBlacklist, login, on)
  }
}

contextBridge.exposeInMainWorld('api', api)
