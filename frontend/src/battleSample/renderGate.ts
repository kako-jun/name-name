/**
 * 戦闘サンプルの描画の順序制御 (#760)。pixelArt の切り替えで画像を unload するとき、
 * unload を待っている描画 A の最中に別の描画 B が始まっても、B が unload 前の（破棄される）テクスチャを
 * 受け取らないようにする。
 *
 * 使い方: 各描画の最初に `begin(unloadUrls)` を呼ぶ（同期で番号と unload の予約が決まる）。画面を作る直前に
 * `await wait(seq)` し、false（より新しい描画が始まった）なら何もせず戻る。
 * - unload が必要な描画は、前の unload に続けて新しい unload を予約する（`pending` を差し替える）
 * - どの描画も `pending` を待ってから画面を作る（unload が要らない描画 B も、A の unload を待つ）
 */
export interface RenderGate {
  /** 描画を始める。番号を返す。`urls` が空でなければ、その unload を前の unload の後ろに予約する */
  begin(urls: readonly string[]): number
  /** 予約済みの unload がすべて終わるまで待つ。待っている間に新しい描画が始まったら false */
  wait(seq: number): Promise<boolean>
}

export function createRenderGate(unload: (url: string) => Promise<unknown>): RenderGate {
  let current = 0
  let pending: Promise<unknown> = Promise.resolve()
  return {
    begin(urls) {
      const seq = ++current
      if (urls.length > 0) {
        const before = pending
        pending = before.then(() => Promise.all(urls.map((u) => unload(u).catch(() => undefined))))
      }
      return seq
    },
    async wait(seq) {
      await pending
      return seq === current
    },
  }
}
