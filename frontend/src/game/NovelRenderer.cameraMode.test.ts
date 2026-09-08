/**
 * NovelRenderer CameraMode 配線統合テスト (#681/#682)。
 *
 * cameraProjection.ts の純粋関数自体の単体挙動は cameraProjection.test.ts でカバー済み。
 * ここでは NovelRenderer 側の「isBlackout と同種の宣言的 settled state」としての配線だけを
 * 検証する:
 *  - シーン遷移（resetAndStartEvents 経由）で既定値（Novel/Audience/水平=null）にリセットされる
 *  - goBack（スナップショットベースの宣言的復元）で直前の cameraMode/cameraOrientation/cameraElevation に戻る
 *
 * 観測は既存の NovelRenderer 系テスト（NovelRenderer.telop.test.ts と同形）: `playScript` で
 * 駆動し、`getSnapshot()` の cameraMode/cameraOrientation/cameraElevation を直接読む
 * （isBlackout 等と同じく getSnapshot() が公開 API のため、private フィールドへの internals
 * キャストは不要）。
 */
import { describe, expect, it } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { CameraElevation, CameraMode, CameraOrientation, Event, EventScene } from '../types'

// --- fixture helpers（NovelRenderer.telop.test.ts と同じスタイル）---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function cameraMode(
  mode: CameraMode,
  orientation?: CameraOrientation | null,
  elevation?: CameraElevation | null
): Event {
  return { CameraMode: { mode, orientation, elevation } } as Event
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  r.setScenes(scenes)
  return r
}

describe('NovelRenderer CameraMode 配線 (#681)', () => {
  // 12: シーンA内で [カメラ: シアター, 向き: 舞台] 実行後、シーン遷移で既定値
  // （Novel/Audience）にリセットされる。isBlackout と同じ規律: シーンをまたいで
  // 暗黙に持ち越さない（resetAndStartEvents 内の明示リセットを固定する）。
  it('12: シーン内で CameraMode(Theater, Stage) を実行後、シーン遷移で Novel/Audience にリセットされる', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), cameraMode('Theater', 'Stage'), narration('two')]),
      scene('b', [narration('three')]),
    ])
    r.startFrom({ sceneId: 'a' })

    await r.playScript([{ type: 'advance' }]) // one -> camera(directive処理) -> two
    expect(r.getSnapshot().cameraMode).toBe('Theater')
    expect(r.getSnapshot().cameraOrientation).toBe('Stage')

    r.jumpToScene('b') // シーン遷移（resetAndStartEvents 経由）

    expect(r.getSnapshot().cameraMode).toBe('Novel')
    expect(r.getSnapshot().cameraOrientation).toBe('Audience')
  })

  // 14: [カメラ: シアター, 向き: 舞台] 実行後に goBack すると直前の cameraMode/cameraOrientation
  // （＝ディレクティブ実行前のスナップショット）に戻る。isBlackout/テロップと同じ
  // スナップショットベースの宣言的復元（applyState 経由）であることを固定する。
  it('14: CameraMode(Theater, Stage) 実行後に goBack すると直前の Novel/Audience に戻る', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), cameraMode('Theater', 'Stage'), narration('two')]),
    ])
    r.startFrom({ sceneId: 'a' })
    // 開始直後（'one' 表示中）の既定値を確認しておく
    expect(r.getSnapshot().cameraMode).toBe('Novel')
    expect(r.getSnapshot().cameraOrientation).toBe('Audience')

    await r.playScript([{ type: 'advance' }]) // one -> camera(directive処理) -> two
    expect(r.getSnapshot().cameraMode).toBe('Theater')
    expect(r.getSnapshot().cameraOrientation).toBe('Stage')

    r.goBack() // two -> one（ディレクティブ実行前のスナップショットへ）

    expect(r.getSnapshot().cameraMode).toBe('Novel')
    expect(r.getSnapshot().cameraOrientation).toBe('Audience')
  })

  // #682: elevation は orientation と同じ独立した第2軸。12/14 と対の確認。
  it('12b: シーン内で CameraMode(Theater, elevation=LookUp) を実行後、シーン遷移で水平(null)にリセットされる', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), cameraMode('Theater', null, 'LookUp'), narration('two')]),
      scene('b', [narration('three')]),
    ])
    r.startFrom({ sceneId: 'a' })

    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().cameraMode).toBe('Theater')
    expect(r.getSnapshot().cameraElevation).toBe('LookUp')

    r.jumpToScene('b')

    expect(r.getSnapshot().cameraMode).toBe('Novel')
    expect(r.getSnapshot().cameraElevation).toBeNull()
  })

  it('14b: CameraMode(Theater, elevation=LookDown) 実行後に goBack すると直前の水平(null)に戻る', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), cameraMode('Theater', null, 'LookDown'), narration('two')]),
    ])
    r.startFrom({ sceneId: 'a' })
    expect(r.getSnapshot().cameraElevation).toBeNull()

    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().cameraMode).toBe('Theater')
    expect(r.getSnapshot().cameraElevation).toBe('LookDown')

    r.goBack()

    expect(r.getSnapshot().cameraMode).toBe('Novel')
    expect(r.getSnapshot().cameraElevation).toBeNull()
  })
})
