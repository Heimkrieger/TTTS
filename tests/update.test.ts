import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareVersions } from '../src/shared/version'
import {
  Updater,
  applyScript,
  parseRelease,
  readInstallResult,
  writeApplyScript
} from '../src/main/update/updater'

describe('сравнение версий', () => {
  it('числа, бета старше окончательной, непонятное - самое старое', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', 'мусор')).toBeGreaterThan(0)
  })
})

const ZIP = Buffer.from('это архив новой версии')
const keys = generateKeyPairSync('ed25519')
const pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const sigOf = (data: Buffer): string =>
  sign(
    null,
    Buffer.from(createHash('sha256').update(data).digest('hex')),
    keys.privateKey
  ).toString('base64')

function release(version: string): unknown {
  return {
    tag_name: `v${version}`,
    body: 'Что нового: исправлены ошибки',
    assets: [
      {
        name: `TwitchTTS-${version}-win-x64.zip`,
        browser_download_url: 'https://github.com/x/y/zip',
        size: ZIP.length
      },
      {
        name: `TwitchTTS-${version}-win-x64.zip.sig`,
        browser_download_url: 'https://github.com/x/y/sig',
        size: 88
      }
    ]
  }
}

function fakeFetch(opts: { latest: unknown; zip?: Buffer; sig?: string; status?: number }) {
  return (async (url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/releases/latest')) {
      return new Response(JSON.stringify(opts.latest), { status: opts.status ?? 200 })
    }
    if (u.endsWith('/zip')) {
      const body = opts.zip ?? ZIP
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'content-length': String(body.length) }
      })
    }
    if (u.endsWith('/sig')) return new Response(opts.sig ?? sigOf(ZIP), { status: 200 })
    return new Response('', { status: 404 })
  }) as typeof fetch
}

const make = (fetchImpl: typeof fetch, current = '0.1.0') => {
  const dir = mkdtempSync(join(tmpdir(), 'upd-'))
  return {
    dir,
    u: new Updater({
      repo: 'a/b',
      publicKeyPem: pub,
      currentVersion: current,
      workDir: dir,
      fetchImpl
    })
  }
}

describe('обновление', () => {
  it('нет репозитория или ключа - выключено с причиной', () => {
    const u = new Updater({ repo: '', publicKeyPem: '', currentVersion: '0.1.0', workDir: '.' })
    expect(u.status).toMatchObject({ state: 'off' })
  })

  it('новая версия при запуске: доступна, скачивается, подпись сходится', async () => {
    const { u } = make(fakeFetch({ latest: release('0.2.0') }))
    expect(await u.check(true)).toMatchObject({
      state: 'available',
      version: '0.2.0',
      startup: true
    })
    expect(await u.download()).toMatchObject({ state: 'ready', version: '0.2.0' })
    expect(u.readyZip && readFileSync(u.readyZip).equals(ZIP)).toBe(true)
  })

  it('подменённый архив не ставится', async () => {
    const { u } = make(fakeFetch({ latest: release('0.2.0'), zip: Buffer.from('чужой архив') }))
    await u.check(true)
    const s = await u.download()
    expect(s).toMatchObject({ state: 'error' })
    if (s.state === 'error') expect(s.error).toContain('подпись')
    expect(u.readyZip).toBeNull()
  })

  it('та же или старая версия - "последняя"; ошибка GitHub объясняется', async () => {
    expect(await make(fakeFetch({ latest: release('0.1.0') })).u.check()).toMatchObject({
      state: 'latest'
    })
    const s = await make(fakeFetch({ latest: {}, status: 500 })).u.check()
    expect(s).toMatchObject({ state: 'error' })
  })

  it('релиз без подписи не принимается; только https', () => {
    const r = release('0.2.0') as { assets: unknown[] }
    expect(parseRelease({ ...r, assets: r.assets.slice(0, 1) })).toBeNull()
    const http = JSON.parse(JSON.stringify(r).replaceAll('https://', 'http://')) as unknown
    expect(parseRelease(http)).toBeNull()
  })

  it('итог прошлой установки читается один раз', () => {
    const dir = mkdtempSync(join(tmpdir(), 'upd-'))
    writeFileSync(join(dir, 'install.log'), '\uFEFFOK 0.2.0')
    expect(readInstallResult(dir)).toEqual({
      ok: true,
      text: 'Программа обновлена до версии 0.2.0'
    })
    expect(readInstallResult(dir)).toBeNull()
    writeFileSync(join(dir, 'install.log'), 'FAIL нет доступа')
    expect(readInstallResult(dir)?.ok).toBe(false)
  })

  it('скрипт установки не трогает data и запускает программу заново', () => {
    const s = applyScript()
    expect(s).toContain("$_.Name -ne 'data'")
    expect(s).toContain('Start-Process -FilePath $Exe')
    const dir = mkdtempSync(join(tmpdir(), 'upd-'))
    const file = writeApplyScript(dir)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file)[0]).toBe(0xef) // BOM для PowerShell 5.1
  })
})
