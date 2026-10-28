/**
 * docs/guide/controls.md「画面遷移を見比べる手順」の脚本が、貼ってそのまま戦闘に入れることの確認 (#953)。
 * docs の脚本そのものを読むので、docs と乖離しない。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseMarkdown } from '../wasm/parser'
import { rpgProjectFromDoc } from './rpgProjectFromDoc'
import type { EventDocument } from '../types'

function guideScript(): string {
  const md = readFileSync(resolve(__dirname, '../../../docs/guide/controls.md'), 'utf8')
  const head = md.indexOf('**画面遷移を見比べる手順')
  expect(head).toBeGreaterThan(-1)
  const open = md.indexOf('```markdown\n', head)
  const close = md.indexOf('\n```', open + 12)
  return md.slice(open + '```markdown\n'.length, close + 1)
}

afterEach(() => vi.restoreAllMocks())

describe('docs の画面遷移の比較用脚本 (#953)', () => {
  it('警告なしで読め、毎歩エンカウント(slime)・ff-mosaic が効く', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const doc = (await parseMarkdown(guideScript())) as EventDocument
    const p = rpgProjectFromDoc(doc)
    expect(p).not.toBeNull()
    expect(p!.map.encounterRate).toBe(1)
    expect(p!.map.encounterGroups).toEqual(['slime'])
    expect(p!.battleTransition).toBe('ff-mosaic')
    expect(Object.keys(p!.party ?? {})).toEqual(['hero'])
    expect(Object.keys(p!.monsters ?? {})).toEqual(['slime'])
    expect(warn).not.toHaveBeenCalled()
  })
})
