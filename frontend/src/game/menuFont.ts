/**
 * 全画面メニュー (#880) の文字フォントを、開く前に上限つきで読む。
 * 文字幅の計測（OffscreenCanvas）と描画（lang=ja の canvas）が未ロードの総称フォントだと食い違って情報帯の末尾が切れるため。
 * 応答が返らない回線でメニューが開かなくならないよう、`timeoutMs` を超えたら読み込み完了を待たずに（従来の表示で）開く。
 * 失敗（オフライン）も握る。
 */

/** フォント待ちの上限（ms） */
export const MENU_FONT_TIMEOUT_MS = 1500

export interface MenuFontDeps {
  /** 設定したフォントの CSS を読む（`ensureFontLoaded`） */
  ensure(family: string): Promise<void>
  /** 字を指定してフォントの字の分割ファイルを読む（`document.fonts.load`） */
  load(font: string, text: string): Promise<unknown>
}

/**
 * フォントを読む。固定の見本 `sample` に、そのとき出す情報帯の字 `extraText`（現在地名・通貨名・数字記号）を足して読む
 * （Noto Sans JP は unicode-range で字ごとに分割されるので、実際に出す字を含めないと分割ファイルが未ロードのままになる）
 */
export async function loadMenuFont(
  deps: MenuFontDeps,
  family: string,
  sample: string,
  extraText = '',
  timeoutMs = MENU_FONT_TIMEOUT_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = (async () => {
    await deps.ensure(family).catch(() => undefined)
    await deps.load(`16px ${family}`, sample + extraText).catch(() => undefined)
  })().catch(() => undefined)
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([work, limit])
  } finally {
    clearTimeout(timer)
  }
}

/** 画像の読み込み待ちの上限（ms）。超えたら読めた分だけ（残りは画像なし＝文字だけ）で開く */
export const MENU_IMAGE_TIMEOUT_MS = 1500

/** `work` の完了を `timeoutMs` まで待つ。超えたら待たずに戻る（`work` は裏で続く。失敗も握る） */
export async function waitUpTo(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined
      ),
      limit,
    ])
  } finally {
    clearTimeout(timer)
  }
}
