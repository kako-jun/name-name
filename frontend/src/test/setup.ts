import '@testing-library/jest-dom'

if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => null,
  })
}

// jsdom には AudioContext が無い (#578 セルフレビュー must 対応)。loadFromSaveData が
// ensureContext() を呼ぶようになったことで、quickLoad() を駆動する既存テスト全般が
// 個別 mock 無しでも `new AudioContext()` に到達するようになった。個々のテストファイルで
// ensureContext を spy 差し替えする箇所（AudioManager 挙動そのものを検証するテスト）は
// 引き続きそちらが優先される（spyOn は実装を丸ごと置き換えるためこの fake には触れない）。
// ここでは「AudioContext が存在しない」ことによる素通りの ReferenceError だけを防ぐ、
// 最小限の no-op fake を用意する（実音声再生は検証しない＝ CLAUDE.md ルール7 の対象外）。
if (typeof globalThis.AudioContext === 'undefined') {
  class FakeGainNode {
    gain = {
      value: 0,
      setValueAtTime: () => {},
      linearRampToValueAtTime: () => {},
      cancelScheduledValues: () => {},
    }
    connect(): void {}
    disconnect(): void {}
  }
  class FakeAudioContext {
    state: AudioContextState = 'running'
    currentTime = 0
    destination = {}
    createGain(): FakeGainNode {
      return new FakeGainNode()
    }
    createMediaStreamDestination(): { stream: unknown } {
      return { stream: {} }
    }
    resume(): Promise<void> {
      return Promise.resolve()
    }
    close(): Promise<void> {
      return Promise.resolve()
    }
  }
  // @ts-expect-error jsdom は AudioContext 未実装。テスト用の最小限 fake を差し込む。
  globalThis.AudioContext = FakeAudioContext
}
