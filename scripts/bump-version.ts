#!/usr/bin/env -S node

import { execFileSync } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { inc, valid, type ReleaseType } from 'semver'

type UserInfo = [string, string]

function getUserInfo (): UserInfo {
  const username = process.argv[3] ?? process.env.GITHUB_ACTOR
  const defaultUser = 'mcollina'

  const users: Record<string, UserInfo> = {
    mcollina: ['Matteo Collina', 'hello@matteocollina.com'],
    ShogunPanda: ['Paolo Insogna', 'paolo@cowtech.it']
  }

  return users[username] ?? users[defaultUser]
}

async function getVersion (): Promise<string> {
  const requested = process.argv[2]?.replace(/^v/, '')

  if (!requested) {
    throw new Error('Usage: node scripts/bump-version.ts <version|major|minor|patch> [actor]')
  }

  if (['minor', 'major', 'patch'].includes(requested)) {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
    return inc(packageJson.version, requested as ReleaseType)!
  }

  const version = valid(requested)

  if (!version) {
    throw new Error(`Invalid version: ${requested}`)
  }

  return version
}

async function updateVersions (version: string): Promise<void> {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
  packageJson.version = version
  await writeFile('package.json', `${JSON.stringify(packageJson, null, 2)}\n`)

  const packageLock = JSON.parse(await readFile('package-lock.json', 'utf8'))
  packageLock.version = version
  packageLock.packages[''].version = version
  await writeFile('package-lock.json', `${JSON.stringify(packageLock, null, 2)}\n`)
}

const userInfo = getUserInfo()
const version = await getVersion()

await updateVersions(version)

if (process.env.GITHUB_ACTIONS === 'true') {
  execFileSync('git', ['config', '--global', 'user.name', userInfo[0]])
  execFileSync('git', ['config', '--global', 'user.email', userInfo[1]])
}

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`)
}

execFileSync('git', [
  'commit',
  '-am',
  `chore: Bumped v${version}.`,
  '-m',
  `Signed-off-by: ${userInfo[0]} <${userInfo[1]}>`
], { stdio: 'inherit' })
