# Тихий тестовый запуск для автопроверок (только разработка).
# Окно скрыто, звук выключен, свои настройки в .devdata-test, горячие клавиши не занимаются,
# порт отладки 9444, страница для OBS на 5290. Основную копию программы не трогает.
# Запуск:  powershell -File scripts\test-instance.ps1          (перезапуск со свежей сборкой)
#          powershell -File scripts\test-instance.ps1 -Stop    (только остановить)
param([switch]$Stop, [switch]$NoBuild, [int]$Fake = 0)

$root = Split-Path -Parent $PSScriptRoot
$port = 9444

# Остановить прежний тестовый запуск: ищем процесс, который слушает порт отладки 9444.
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}
if ($Stop) { "тестовый запуск остановлен"; exit 0 }

Set-Location $root
if (-not $NoBuild) {
  npx electron-vite build *> build.log
  if ($LASTEXITCODE -ne 0) { "сборка не прошла, см. build.log"; exit 1 }
}

$env:TTS_TEST_INSTANCE = '1'
$env:TTS_DEBUG_PORT = "$port"
# -Fake N: фейковый чат, N сообщений в секунду (каждое 11-е - как награда за баллы).
if ($Fake -gt 0) { $env:TTS_FAKE_CHAT = "$Fake" } else { Remove-Item Env:TTS_FAKE_CHAT -ErrorAction SilentlyContinue }
Start-Process -FilePath "$root\node_modules\electron\dist\electron.exe" -ArgumentList '.' -WorkingDirectory $root -WindowStyle Hidden
"тестовый запуск: порт отладки $port"
