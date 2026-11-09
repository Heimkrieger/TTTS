// Установка скачанного обновления.
//
// 1. Пока программа открыта, архив распаковывается в data\update\stage. Это самая долгая часть,
//    поэтому идёт здесь: в окне обновления видны проценты, а ошибка показывается сразу.
// 2. Отдельный скрипт PowerShell ждёт закрытия программы, копирует распакованные файлы поверх
//    папки программы (data\ не трогает), пишет итог в install.log и запускает программу заново.
//
// Скрипт запускается через Start-Process. Напрямую из Electron с detached PowerShell не стартует
// вовсе, а без detached закрывается вместе с программой.
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { compareVersions } from '@shared/version'

export interface InstallPlan {
  /** Проверенный архив обновления. */
  zip: string
  /** Рабочая папка обновления (data\update). */
  workDir: string
  /** Папка программы, куда ставим. */
  appDir: string
  /** exe программы: его запускаем после установки. */
  exe: string
  /** Процесс программы: скрипт ждёт его закрытия. */
  appPid: number
  version: string
}

export const INSTALL_LOG = 'install.log'
const STAGE = 'stage'
/** Прежние файлы программы на время замены: при сбое возвращаются на место. */
const BACKUP = 'backup'

/**
 * Строка PowerShell в одинарных кавычках. PowerShell считает кавычками и типографские
 * ‘ ’ ‚ ‛, поэтому удваиваем их тоже.
 */
export function psQuote(s: string): string {
  return `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`
}

/** Скрипт распаковки: печатает "P <проценты>", ошибку пишет в stderr и выходит с кодом 1. */
export function unpackScript(zip: string, dest: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }',
    'try {',
    '  Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `  $zip = ${psQuote(zip)}`,
    `  $dest = ${psQuote(dest)}`,
    '  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }',
    '  [void][IO.Directory]::CreateDirectory($dest)',
    "  $root = [IO.Path]::GetFullPath($dest).TrimEnd('\\') + '\\'",
    '  $z = [IO.Compression.ZipFile]::OpenRead($zip)',
    '  try {',
    '    $total = 0',
    '    foreach ($e in $z.Entries) { $total += $e.Length }',
    '    $done = 0',
    '    $last = -1',
    '    foreach ($e in $z.Entries) {',
    '      $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $e.FullName))',
    '      if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {',
    "        throw ('в архиве недопустимый путь ' + $e.FullName)",
    '      }',
    "      if ($e.FullName.EndsWith('/') -or $e.FullName.EndsWith('\\')) {",
    '        [void][IO.Directory]::CreateDirectory($target)',
    '        continue',
    '      }',
    '      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))',
    '      [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)',
    '      $done += $e.Length',
    '      $p = 100',
    '      if ($total -gt 0) { $p = [int][Math]::Floor($done * 100 / $total) }',
    '      if ($p -ne $last) {',
    '        $last = $p',
    "        [Console]::Out.WriteLine('P ' + $p)",
    '        [Console]::Out.Flush()',
    '      }',
    '    }',
    '  } finally { $z.Dispose() }',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}',
    ''
  ].join('\r\n')
}

/**
 * Скрипт замены файлов после закрытия программы. Все значения вписаны в сам скрипт:
 * так не нужно передавать пути с пробелами и кавычками через командную строку.
 */
export function applyScript(
  p: InstallPlan,
  /** Для проверок: не запускать программу в конце и число попыток замены. */
  opts: { relaunch?: boolean; tries?: number } = {}
): string {
  const stage = join(p.workDir, STAGE)
  return [
    "$ErrorActionPreference = 'Stop'",
    `$stage = ${psQuote(stage)}`,
    `$appDir = ${psQuote(p.appDir)}`,
    `$exe = ${psQuote(p.exe)}`,
    `$zip = ${psQuote(p.zip)}`,
    `$log = ${psQuote(join(p.workDir, INSTALL_LOG))}`,
    `$backup = ${psQuote(join(p.workDir, BACKUP))}`,
    `$version = ${psQuote(p.version)}`,
    `$appPid = ${Math.trunc(p.appPid)}`,
    `$tries = ${Math.max(1, Math.trunc(opts.tries ?? 10))}`,
    '# Вернуть прежние файлы на место: убрать то, что успели положить нового, и перенести старое обратно.',
    'function Restore-Old($names) {',
    '  foreach ($n in $names) {',
    '    $new = Join-Path $appDir $n',
    '    if (Test-Path -LiteralPath $new) { Remove-Item -LiteralPath $new -Recurse -Force }',
    '    Move-Item -LiteralPath (Join-Path $backup $n) -Destination $new -Force',
    '  }',
    '}',
    'try {',
    '  Wait-Process -Id $appPid -Timeout 60 -ErrorAction SilentlyContinue',
    '  # Вспомогательные процессы программы (тот же exe) закрываются чуть позже главного.',
    '  $until = (Get-Date).AddSeconds(30)',
    '  while ((Get-Date) -lt $until) {',
    '    $left = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }',
    '    if (-not $left) { break }',
    '    Start-Sleep -Milliseconds 300',
    '  }',
    "  $items = Get-ChildItem -LiteralPath $stage | Where-Object { $_.Name -ne 'data' }",
    '  # Замена с откатом: прежний файл или папка сначала переносится в backup, потом кладётся новое.',
    '  # Если что-то занято (антивирус, не закрывшийся процесс), всё прежнее возвращается на место,',
    '  # и после паузы пробуем снова. Смеси старых и новых файлов не остаётся.',
    '  $try = 0',
    '  while ($true) {',
    '    $moved = @()',
    '    try {',
    '      if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }',
    '      [void][IO.Directory]::CreateDirectory($backup)',
    '      foreach ($i in $items) {',
    '        $old = Join-Path $appDir $i.Name',
    '        if (Test-Path -LiteralPath $old) {',
    '          Move-Item -LiteralPath $old -Destination (Join-Path $backup $i.Name) -Force',
    '          $moved += $i.Name',
    '        }',
    '        Copy-Item -LiteralPath $i.FullName -Destination $appDir -Recurse -Force',
    '      }',
    '      break',
    '    } catch {',
    '      $why = $_.Exception.Message',
    '      try { Restore-Old $moved } catch {',
    "        throw ('не удалось заменить файлы программы и вернуть прежние (' + $why + '). Программа могла повредиться: скачайте её заново со страницы программы')",
    '      }',
    '      $try++',
    '      if ($try -ge $tries) {',
    "        throw ('не удалось заменить файлы программы (' + $why + '). Прежняя версия возвращена на место, программа работает на ней. Обновление предложится снова')",
    '      }',
    '      Start-Sleep -Seconds 1',
    '    }',
    '  }',
    '  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue',
    '  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue',
    '  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue',
    "  Set-Content -LiteralPath $log -Value ('OK ' + $version) -Encoding UTF8",
    '} catch {',
    "  Set-Content -LiteralPath $log -Value ('FAIL ' + $_.Exception.Message) -Encoding UTF8",
    '}',
    ...(opts.relaunch === false ? [] : ['Start-Process -FilePath $exe']),
    ''
  ].join('\r\n')
}

/**
 * Версия программы внутри распакованного обновления (package.json в app.asar; Electron умеет
 * читать внутри архива asar обычным fs). null - не нашлась.
 */
export function stagedVersion(workDir: string): string | null {
  try {
    const file = join(workDir, STAGE, 'resources', 'app.asar', 'package.json')
    const j = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
    return typeof j.version === 'string' ? j.version : null
  } catch {
    return null
  }
}

/**
 * Подпись стоит на самом архиве, а номер версии релиза в неё не входит. Поэтому сверяем: внутри
 * архива должна быть ровно та версия, что названа в релизе, и она новее установленной. Иначе
 * под видом новой версии можно было бы подсунуть старую настоящую сборку.
 * null - всё сходится, иначе причина отказа.
 */
export function versionMismatch(
  staged: string | null,
  release: string,
  current: string
): string | null {
  if (staged === null) return 'в архиве обновления не нашлась версия программы'
  if (compareVersions(staged, release) !== 0)
    return `в архиве версия ${staged}, а релиз назван ${release}`
  if (compareVersions(staged, current) <= 0)
    return `в архиве версия ${staged}, она не новее установленной ${current}`
  return null
}

/**
 * Убрать хвосты прошлых обновлений (до 500 МБ): распакованную копию, запасные файлы, архивы и
 * скрипты. Недокачанный архив живёт 3 дня, чтобы скачивание можно было продолжить.
 */
export function cleanUpdateDir(workDir: string, now: number = Date.now()): void {
  let names: string[]
  try {
    names = readdirSync(workDir)
  } catch {
    return
  }
  for (const n of names) {
    const file = join(workDir, n)
    try {
      const old = now - statSync(file).mtimeMs > 3 * 24 * 60 * 60_000
      const junk =
        n === STAGE || n === BACKUP || /[.](zip|ps1)$/.test(n) || (/[.]part$/.test(n) && old)
      if (junk) rmSync(file, { recursive: true, force: true })
    } catch {
      // файл занят: уберём в следующий раз
    }
  }
}

/** Записать скрипт PowerShell. BOM обязателен: PowerShell 5.1 без него читает не в UTF-8. */
function writeScript(file: string, text: string): void {
  writeFileSync(file, '\uFEFF' + text, 'utf8')
}

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']

/** Запустить PowerShell, дождаться конца. Строки stdout - в onLine. */
function runPowerShell(
  args: string[],
  onLine: (line: string) => void = () => {}
): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const c = spawn('powershell.exe', [...PS_ARGS, ...args], { windowsHide: true })
    let err = ''
    let buf = ''
    c.stdout.setEncoding('utf8')
    c.stderr.setEncoding('utf8')
    c.stdout.on('data', (d: string) => {
      buf += d
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      lines.forEach(onLine)
    })
    c.stderr.on('data', (d: string) => (err += d))
    c.on('error', (e) => resolve({ code: -1, err: e.message }))
    c.on('close', (code) => resolve({ code: code ?? -1, err: err.trim() }))
  })
}

/** Распаковать архив в data\update\stage. onPercent - ход распаковки. */
export async function unpackUpdate(
  p: InstallPlan,
  onPercent: (percent: number) => void
): Promise<void> {
  mkdirSync(p.workDir, { recursive: true })
  const stage = join(p.workDir, STAGE)
  const script = join(p.workDir, 'unpack-update.ps1')
  writeScript(script, unpackScript(p.zip, stage))
  const r = await runPowerShell(['-File', script], (line) => {
    const m = /^P (\d{1,3})$/.exec(line.trim())
    if (m) onPercent(Number(m[1]))
  })
  rmSync(script, { force: true })
  if (r.code !== 0) {
    throw new Error(`архив не распаковался${r.err ? `: ${firstLine(r.err)}` : ''}`)
  }
  if (!existsSync(join(stage, basename(p.exe)))) {
    throw new Error(`в архиве нет ${basename(p.exe)}`)
  }
}

/**
 * Запустить скрипт замены файлов, который дождётся закрытия программы. После успешного
 * запуска программу нужно закрыть. Если скрипт так и не отработает, при следующем запуске
 * в журнале будет причина: заранее записанный FAIL он не перезаписал.
 */
export async function launchApply(p: InstallPlan): Promise<void> {
  const script = join(p.workDir, 'apply-update.ps1')
  writeScript(script, applyScript(p))
  const log = join(p.workDir, INSTALL_LOG)
  writeFileSync(
    log,
    'FAIL установщик не запустился после закрытия программы. Программа осталась прежней версии, обновление предложится снова',
    'utf8'
  )
  const args = [...PS_ARGS, '-WindowStyle', 'Hidden', '-File'].join(' ')
  // Путь к скрипту в двойных кавычках внутри строки аргументов Start-Process.
  const command = [
    `$a = ${psQuote(args)} + ' "' + ${psQuote(script)} + '"'`,
    'Start-Process -WindowStyle Hidden -FilePath powershell.exe -ArgumentList $a'
  ].join('; ')
  // -EncodedCommand: без проблем с кавычками в командной строке.
  const encoded = Buffer.from(command, 'utf16le').toString('base64')
  const r = await runPowerShell(['-EncodedCommand', encoded])
  if (r.code !== 0) {
    rmSync(log, { force: true })
    throw new Error(`установщик не запустился${r.err ? `: ${firstLine(r.err)}` : ''}`)
  }
}

/** Итог прошлой установки (если была): строка для журнала, файл удаляется. */
export function readInstallResult(workDir: string): { ok: boolean; text: string } | null {
  const file = join(workDir, INSTALL_LOG)
  if (!existsSync(file)) return null
  try {
    const line = readFileSync(file, 'utf8')
      .replace(/^\uFEFF/, '')
      .trim()
    rmSync(file, { force: true })
    if (line.startsWith('OK '))
      return { ok: true, text: `Программа обновлена до версии ${line.slice(3)}` }
    return {
      ok: false,
      text: `Обновление не установилось: ${line.replace(/^FAIL\s*/, '').replace(/[.]$/, '')}.`
    }
  } catch {
    return null
  }
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim() !== '') ?? s
}
