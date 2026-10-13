import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import VideoExportModal from './VideoExportModal'

function setup(inheritFlags: boolean) {
  const onChangeInheritFlags = vi.fn()
  render(
    <VideoExportModal
      isDark={false}
      allSceneIds={['a', 'b']}
      startSceneId="a"
      endSceneId="b"
      fps={30}
      inheritFlags={inheritFlags}
      status={null}
      isRunning={false}
      onChangeStart={() => {}}
      onChangeEnd={() => {}}
      onChangeFps={() => {}}
      onChangeInheritFlags={onChangeInheritFlags}
      onStart={() => {}}
      onClose={() => {}}
    />
  )
  return { onChangeInheritFlags }
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
