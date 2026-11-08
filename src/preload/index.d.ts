import type { TtsApi } from '../shared/ipc'

declare global {
  interface Window {
    api: TtsApi
  }
}

export {}
