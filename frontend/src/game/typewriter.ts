/**
 * 1 文字ずつ表示する typewriter の pure 計算ヘルパー (#137)
 *
 * ノベルエンジン / RPG DialogBox で同じロジックを使えるよう、PixiJS 依存無しで切り出す。
 * 単体テストもこの helper に集約する。
 */

export interface TypewriterState {
  /** ワードラップ済みの完全テキスト。改行は \n。空文字なら typewriter は何もしない */
  fullText: string
  /** 現在表示中の文字数 (0..fullText.length) */
  displayedCharCount: number
  /** deltaMS の累積（端数を次フレームに繰り越すため） */
  acc: number
}

export function makeInitialTypewriterState(): TypewriterState {
  return { fullText: '', displayedCharCount: 0, acc: 0 }
}

/**
 * 新しいテキストで typewriter を開始する。
 * displayedCharCount を 0 に戻し、acc もリセット。
 */
export function startTypewriter(fullText: string): TypewriterState {
  return { fullText, displayedCharCount: 0, acc: 0 }
}

/**
 * 1 フレーム分進める。msPerChar<=0 (0 / 負 / NaN扱い) のときは即座に最後まで進む。
 *
 * - 既完了 state は同一参照で早期 return
 * - 負の deltaMS は 0 にクランプ (時刻巻き戻り耐性)
 *
 * @returns 新しい state（immutable）
 */
export function tickTypewriter(
  state: TypewriterState,
  deltaMS: number,
  msPerChar: number
): TypewriterState {
  if (state.displayedCharCount >= state.fullText.length) return state
  if (!(msPerChar > 0)) {
    // 0 / 負 / NaN は即時完了
    return {
      fullText: state.fullText,
      displayedCharCount: state.fullText.length,
      acc: 0,
    }
  }
  // 負の deltaMS / NaN はフレーム進行 0 とみなす (acc は元の値を維持)
  const safeDelta = deltaMS > 0 ? deltaMS : 0
  const acc = state.acc + safeDelta
  if (acc < msPerChar) {
    return { fullText: state.fullText, displayedCharCount: state.displayedCharCount, acc }
  }
  const charsToAdd = Math.floor(acc / msPerChar)
  const newAcc = acc - charsToAdd * msPerChar
  const newCount = Math.min(state.fullText.length, state.displayedCharCount + charsToAdd)
  return { fullText: state.fullText, displayedCharCount: newCount, acc: newAcc }
}

/**
 * 全文を即時表示する（typewriter スキップ）。
 */
export function skipTypewriter(state: TypewriterState): TypewriterState {
  if (state.displayedCharCount >= state.fullText.length) return state
  return { fullText: state.fullText, displayedCharCount: state.fullText.length, acc: 0 }
}

export function isTypingActive(state: TypewriterState): boolean {
  return state.displayedCharCount < state.fullText.length
}

/** 現在表示すべき文字列を返す（描画用）。 */
export function visibleText(state: TypewriterState): string {
  return state.fullText.substring(0, state.displayedCharCount)
}
