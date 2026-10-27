import { expect, test } from 'claude-code/testing'
import { isDownloads } from '../hooks/guard'

test('~/Downloads 直下だけが対象', () => {
  expect(isDownloads('/Users/a/Downloads')).toBe(true)
  expect(isDownloads('/Users/a/Downloads/')).toBe(true)
  expect(isDownloads('/home/a/Downloads')).toBe(true)
  expect(isDownloads('/Users/a/Downloads/x')).toBe(false)
  expect(isDownloads('/Users/a/Documents')).toBe(false)
  expect(isDownloads('/Users/a/lgtm/Downloads')).toBe(false)
})

test('Downloads ではプロンプトを drop し、ツールを deny する', async ($, on) => {
  on('session.cwd', () => ({ value: '/Users/a/Downloads' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {} }))

  const p = await $.prompt.submit({ text: 'hi' } as never)
  expect(p.drop).toMatch(/downloads-guard/)
  const t = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(t.deny).toMatch(/downloads-guard/)
})

test('他のディレクトリでは通す', async ($, on) => {
  on('session.cwd', () => ({ value: '/Users/a/lgtm' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {} }))

  const p = await $.prompt.submit({ text: 'hi' } as never)
  expect(p.drop).toBeUndefined()
  const t = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(t.deny).toBeUndefined()
})
