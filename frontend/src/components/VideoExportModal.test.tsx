import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import VideoExportModal from './VideoExportModal'

function setup(inheritFlags: boolean, isRunning = false) {
  const onChangeInheritFlags = vi.fn()
  const onAbort = vi.fn()
  render(
    <VideoExportModal
      isDark={false}
      allSceneIds={['a', 'b']}
      startSceneId="a"
      endSceneId="b"
      fps={30}
      inheritFlags={inheritFlags}
      status={null}
      isRunning={isRunning}
      onChangeStart={() => {}}
      onChangeEnd={() => {}}
      onChangeFps={() => {}}
      onChangeInheritFlags={onChangeInheritFlags}
      onStart={() => {}}
      onAbort={onAbort}
      onClose={() => {}}
    />
  )
  return { onChangeInheritFlags, onAbort }
}

describe('VideoExportModal: プレビューの flags を引き継ぐ (#734)', () => {
  it('チェックボックスは inheritFlags の値を反映する（既定 OFF）', () => {
    setup(false)
    const box = screen.getByRole('checkbox', { name: /プレビューの flags を引き継ぐ/ })
    expect((box as HTMLInputElement).checked).toBe(false)
  })

  it('ON にすると onChangeInheritFlags(true) が呼ばれる', () => {
    const { onChangeInheritFlags } = setup(false)
    fireEvent.click(screen.getByRole('checkbox', { name: /プレビューの flags を引き継ぐ/ }))
    expect(onChangeInheritFlags).toHaveBeenCalledWith(true)
  })
})

describe('VideoExportModal: 中止ボタン (#780)', () => {
  it('録画中だけ中止ボタンが出て、押すと onAbort が呼ばれる', () => {
    const { onAbort } = setup(false, true)
    fireEvent.click(screen.getByRole('button', { name: '中止' }))
    expect(onAbort).toHaveBeenCalledTimes(1)
  })

  it('録画していないときは中止ボタンが無い', () => {
    setup(false, false)
    expect(screen.queryByRole('button', { name: '中止' })).toBeNull()
  })
})
