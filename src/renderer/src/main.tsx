import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ConfirmProvider } from './confirm'
import { ErrorBoundary } from './ErrorBoundary'
import { startPlayerBridge } from './playerBridge'
import '@fontsource/golos-text/400.css'
import '@fontsource/golos-text/500.css'
import '@fontsource/golos-text/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './tokens.css'
import './styles.css'
import './layout.css'

// Перетащенный в окно файл или ссылка не должны открываться вместо программы.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

const root = document.getElementById('root')
if (!root) throw new Error('Нет элемента #root в index.html')

// Звук запускается отдельно от интерфейса: ошибка при отрисовке любого раздела не должна
// выключать озвучку.
startPlayerBridge()

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ErrorBoundary>
  </StrictMode>
)
