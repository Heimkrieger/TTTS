// Окно обязательного обновления: при запуске нашлась новая версия -
// "Обновить" или "Выйти". Пропустить нельзя. Если скачать не получилось - причина и
// "Повторить" / "Запустить без обновления" (иначе без интернета программа бы не открывалась).
import { useState } from 'react'
import type { UpdateStatus } from '@shared/types'

export function UpdateDialog({ s }: { s: UpdateStatus }): React.JSX.Element | null {
  // Ошибка после попытки скачать: даём продолжить без обновления.
  const [failed, setFailed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [target, setTarget] = useState<string | null>(null)

  const startupOffer = s.state === 'available' && s.startup
  const inProgress = s.state === 'downloading' || s.state === 'installing' || s.state === 'ready'
  const showError = s.state === 'error' && target !== null
  if (dismissed || !(startupOffer || inProgress || showError)) return null

  const version = 'version' in s ? s.version : (target ?? '')

  const install = (): void => {
    setTarget(version)
    setFailed(false)
    void window.api.update.install().then((r) => setFailed(r.state === 'error'))
  }

  return (
    <div className="modal-back">
      <div className="modal update" role="dialog" aria-modal="true" aria-label="Обновление">
        <h3>Вышла новая версия {version}</h3>
        {s.state === 'available' && (
          <>
            <p>
              Сейчас у вас {s.current}. Чтобы продолжить, обновите программу: это займёт около
              минуты, настройки и ключ сохранятся. Размер: {s.sizeMb} МБ.
            </p>
            {s.notes && <pre className="update-notes">{s.notes}</pre>}
          </>
        )}
        {s.state === 'downloading' && (
          <>
            <p>Скачиваю обновление: {s.percent} %</p>
            <div className="progress" aria-hidden="true">
              <div style={{ transform: `scaleX(${s.percent / 100})` }} />
            </div>
          </>
        )}
        {s.state === 'installing' && (
          <>
            <p>Распаковываю обновление: {s.percent} %</p>
            <div className="progress" aria-hidden="true">
              <div style={{ transform: `scaleX(${s.percent / 100})` }} />
            </div>
          </>
        )}
        {s.state === 'ready' && (
          <p>Обновление готово. Программа закроется и через несколько секунд запустится заново.</p>
        )}
        {s.state === 'error' && (
          <p className="err">
            {s.error}. Попробуйте ещё раз или запустите программу без обновления: окно появится
            снова при следующем запуске.
          </p>
        )}
        <div className="modal-actions">
          {failed || s.state === 'error' ? (
            <>
              <button onClick={() => setDismissed(true)}>Запустить без обновления</button>
              <button className="btn-primary" onClick={install}>
                Повторить
              </button>
            </>
          ) : (
            <>
              <button disabled={inProgress} onClick={() => void window.api.update.quit()}>
                Выйти
              </button>
              <button className="btn-primary" disabled={inProgress} onClick={install}>
                {inProgress ? 'Обновляю...' : 'Обновить'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
