// Ошибка при отрисовке интерфейса не должна оставлять пустое окно. Звук от интерфейса не зависит
// (плеер запускается отдельно, см. main.tsx), поэтому озвучка при такой ошибке продолжается.
import { Component, type ErrorInfo, type ReactNode } from 'react'

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }

  static getDerivedStateFromError(e: unknown): { error: string } {
    return { error: e instanceof Error ? e.message : String(e) }
  }

  componentDidCatch(e: unknown, info: ErrorInfo): void {
    // Попадает в файл журнала (основная программа записывает ошибки консоли окна).
    console.error('Ошибка интерфейса:', e, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div className="crash" role="alert">
        <h2>В окне программы произошла ошибка</h2>
        <p>
          Озвучка продолжает работать: сообщения из чата звучат, горячие клавиши действуют. Чтобы
          вернуть окно, нажмите кнопку. Сообщение, которое звучит в этот момент, оборвётся.
        </p>
        <button className="btn-primary" onClick={() => void window.api.app.reloadWindow()}>
          Перезагрузить окно
        </button>
        <p className="muted small">
          Если ошибка повторяется, после перезагрузки нажмите "Сообщить о проблеме". Подробности:{' '}
          {this.state.error}
        </p>
      </div>
    )
  }
}
