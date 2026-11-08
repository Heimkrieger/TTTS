// Связь окна с очередью в main: main присылает "играй / стоп / пауза", окно отвечает "доиграло".
import {
  pauseAudio,
  playAudio,
  resumeAudio,
  setProblemHandler,
  setVolume,
  stopAudio
} from './audio'

export function startPlayerBridge(): () => void {
  setProblemHandler((text) => window.api.player.problem(text))
  const offs = [
    window.api.player.onPlay((p) => {
      playAudio(p.id, p.audio, p.volume, p.trimSec)
        .then((r) => window.api.player.ended(p.id, r))
        .catch((e: unknown) => {
          window.api.player.ended(p.id, 'stopped', e instanceof Error ? e.message : String(e))
        })
    }),
    window.api.player.onStop((p) => stopAudio(p.id, p.fadeMs)),
    window.api.player.onPause(() => pauseAudio()),
    window.api.player.onResume(() => resumeAudio()),
    window.api.player.onVolume((p) => setVolume(p.volume))
  ]
  return () => offs.forEach((off) => off())
}
