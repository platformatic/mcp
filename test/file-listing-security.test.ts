import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveWithinRoot } from '../examples/file-listing-security.ts'

async function withTempRoot (t: TestContext, fn: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(join(tmpdir(), 'mcp-file-listing-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fn(root)
}

test('rejects path traversal outside the root', async (t: TestContext) => {
  await withTempRoot(t, async (root) => {
    await t.assert.rejects(resolveWithinRoot('..', root), /outside the allowed root/)
    await t.assert.rejects(resolveWithinRoot('../secrets', root), /outside the allowed root/)
    await t.assert.rejects(resolveWithinRoot('../../etc', root), /outside the allowed root/)
    await t.assert.rejects(resolveWithinRoot('/etc/passwd', root), /outside the allowed root/)
  })
})

test('accepts paths within the root', async (t: TestContext) => {
  await withTempRoot(t, async (root) => {
    await fs.mkdir(join(root, 'sub'))
    await fs.writeFile(join(root, 'sub', 'a.txt'), 'hello')
    const file = await resolveWithinRoot('sub/a.txt', root)
    t.assert.equal(file, await fs.realpath(join(root, 'sub', 'a.txt')))
    const dot = await resolveWithinRoot('.', root)
    t.assert.equal(await fs.realpath(dot), await fs.realpath(root))
  })
})

test('rejects symlinks that escape the root', async (t: TestContext) => {
  await withTempRoot(t, async (root) => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'mcp-file-listing-outside-'))
    t.after(() => fs.rm(outside, { recursive: true, force: true }))
    await fs.writeFile(join(outside, 'secret.txt'), 'secret')
    await fs.symlink(outside, join(root, 'escape'))
    await t.assert.rejects(resolveWithinRoot('escape', root), /outside the allowed root/)
    // A traversal into the symlinked target is also rejected
    await t.assert.rejects(resolveWithinRoot('escape/secret.txt', root), /outside the allowed root/)
  })
})
