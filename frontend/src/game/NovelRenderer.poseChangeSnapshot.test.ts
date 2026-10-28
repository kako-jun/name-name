/**
 * ポーズ変更の台詞行で取る履歴スナップショット（戻る・自動セーブの元）が新ポーズを記録すること (#952)。
 * 新ポーズの state は読み込み完了前でも同期で作られるので、show 直後の同期 pushSnapshot が最新を見る。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Assets, BufferImageSource, Texture } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'

const dlg = (expr: string, s: string) => ({
  Dialog: { character: 'hero', expression: expr, position: 'Center', text: [s] },
})
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('ポーズ変更の台詞行のスナップショット (#952)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('履歴スナップショットは新ポーズを記録し、goBack で a→b→a と戻れる', async () => {
    vi.spyOn(Assets, 'load').mockImplementation(
      (async () =>
        new Texture({
          source: new BufferImageSource({
            resource: new Uint8Array(4 * 4 * 4),
            width: 4,
            height: 4,
          }),
        })) as never
    )
    const r = new NovelRenderer()
    r.setDialogStyle('adv')
    r.setAssetBaseUrl('/assets')
    r.setScenes([
      {
        id: 's',
        title: 's',
        view: 'TopDown',
        events: [dlg('a', 'one'), dlg('b', 'two'), dlg('b', 'three')],
      } as never,
    ])
    r.startFrom({ sceneId: 's' })
    await flush()
    await flush()
    await r.playScript([{ type: 'advance' }])
    await flush()
    await flush()
    const hist = (
      r as unknown as { cursor: { history: Array<{ characters: Array<{ expression: string }> }> } }
    ).cursor.history
    expect(hist[hist.length - 1].characters[0].expression).toBe('b')
    expect(r.getSnapshot().characters[0].expression).toBe('b')
    await r.playScript([{ type: 'advance' }])
    await flush()
    await flush()
    r.goBack()
    await flush()
    expect(r.getSnapshot().characters[0].expression).toBe('b')
    r.goBack()
    await flush()
    expect(r.getSnapshot().characters[0].expression).toBe('a')
  })
})
