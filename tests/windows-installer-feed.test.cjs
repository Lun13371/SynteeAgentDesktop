/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Test the release feed with Node's test runner. */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { findWindowsInstallerUpdate, parseWindowsInstallerReleases, windowsInstallerUrl } = require('../src/main/updater/windowsInstallerFeed.ts')

const REPOSITORY = 'Lun13371/SynteeAgentDesktop'

function release(version, patch = {}) {
  return {
    tag_name: `v${version}`,
    draft: false,
    body: 'Changes',
    published_at: '2026-11-17T12:00:00Z',
    assets: [{
      browser_download_url: windowsInstallerUrl(version),
      size: 300_000_000,
      digest: 'sha256:' + 'a'.repeat(64),
      state: 'uploaded',
    }],
    ...patch,
  }
}

test('Windows installer feed points at this repository with the v<version> tag', () => {
  assert.equal(
    windowsInstallerUrl('1.1.5'),
    `https://github.com/${REPOSITORY}/releases/download/v1.1.5/Syntee-Helper-Setup-1.1.5-x64.exe`,
  )
})

test('Windows installer feed sorts numerically and requires a newer installed version', () => {
  const releases = parseWindowsInstallerReleases([release('1.2.0'), release('1.10.0'), release('1.1.5')])
  assert.deepEqual(releases.map(entry => entry.version), ['1.10.0', '1.2.0', '1.1.5'])
  const latest = findWindowsInstallerUpdate(releases, '1.2.1')
  assert.equal(latest.zip_url, windowsInstallerUrl('1.10.0'))
  assert.equal(latest.delivery, 'installer')
  assert.equal(latest.force, false)
  assert.equal(findWindowsInstallerUpdate(releases, '1.10.0'), null)
  assert.equal(findWindowsInstallerUpdate(releases, '2.0.0'), null)
})

test('Windows installer feed ignores other platforms, drafts, bad assets and untrusted URLs', () => {
  const wrongHost = release('9.0.0')
  wrongHost.assets[0].browser_download_url = 'https://example.org/setup.exe'
  const noDigest = release('8.0.0')
  delete noDigest.assets[0].digest
  const noFile = release('7.0.0', { assets: [] })
  const releases = parseWindowsInstallerReleases([
    release('10.0.0', { tag_name: 'arch-v10.0.0-1' }),
    release('11.0.0', { tag_name: 'windows-v11.0.0' }),
    release('12.0.0', { draft: true }),
    release('13.0.0-beta'),
    release('14.0.0.1'),
    wrongHost, noDigest, noFile, release('1.1.5'),
  ])
  assert.deepEqual(releases.map(entry => entry.version), ['1.1.5'])
  assert.equal(windowsInstallerUrl('1.1.5/../../file'), null)
})
