/**
 * 日本語ワードラップ（禁則処理付き）
 *
 * PixiJS にはPhaserの useAdvancedWrap 相当がないため自前実装。
 * 中核ロジックは幅計測関数を注入し、wordwrap() だけが Canvas に依存する。
 */

/** 行頭禁止文字（句読点、閉じ括弧など） */
const LINE_START_PROHIBITED =
  '\u3001\u3002\uFF0C\uFF0E\u30FB\uFF1A\uFF1B\uFF1F\uFF01\u30FC\uFF09\uFF3D\uFF5D\u3015\u3009\u300B\u300D\u300F\u3011\u3019\u3017\u301F\u2019\u201D\uFF60\u00BB\u309D\u309E\u3005\u3041\u3043\u3045\u3047\u3049\u3063\u3083\u3085\u3087\u308E\u30A1\u30A3\u30A5\u30A7\u30A9\u30C3\u30E3\u30E5\u30E7\u30EE\u30F5\u30F6'

/** 行末禁止文字（開き括弧など） */
const LINE_END_PROHIBITED =
  '\uFF08\uFF3B\uFF5B\u3014\u3008\u300A\u300C\u300E\u3010\u3018\u3016\u301D\u2018\u201C\uFF5F\u00AB'

function isLineStartProhibited(ch: string): boolean {
  return LINE_START_PROHIBITED.includes(ch)
}

function isLineEndProhibited(ch: string): boolean {
  return LINE_END_PROHIBITED.includes(ch)
}

/** Canvas / context のモジュールレベルキャッシュ（毎回生成を避ける） */
let cachedCanvas: HTMLCanvasElement | null = null
let cachedCtx: CanvasRenderingContext2D | null = null
function getContext(): CanvasRenderingContext2D | null {
  if (!cachedCtx) {
    cachedCanvas = document.createElement('canvas')
    cachedCtx = cachedCanvas.getContext('2d')
  }
  return cachedCtx
}

type MeasureTextWidth = (text: string) => number

function pushLine(lines: string[], line: string): void {
  if (line.length > 0) {
    lines.push(line)
  }
}

/**
 * テキストを指定幅で折り返す
 * @param text 折り返し対象テキスト（改行なしの1段落）
 * @param maxWidth 折り返し幅（ピクセル）
 * @param measure 文字列の幅を返す関数
 * @returns 折り返し済み行の配列
 */
export function wrapTextWithMeasure(
  text: string,
  maxWidth: number,
  measure: MeasureTextWidth
): string[] {
  if (text.length === 0) return ['']
  if (maxWidth <= 0) return [text]

  const lines: string[] = []
  let currentLine = ''

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const candidate = currentLine + ch

    if (measure(candidate) <= maxWidth) {
      currentLine = candidate
      continue
    }

    // candidate が maxWidth を超えた — ここで折り返す

    // 禁則処理: 次の文字が行頭禁止文字なら、その文字を現在行に含める。
    // この1文字ぶんの超過は許すが、後続文字を同じ超過行へ連鎖させない。
    if (isLineStartProhibited(ch)) {
      pushLine(lines, currentLine + ch)
      currentLine = ''
      continue
    }

    // 禁則処理: 現在行の最後の文字が行末禁止文字なら、その文字を次行に送る
    if (currentLine.length > 0 && isLineEndProhibited(currentLine[currentLine.length - 1])) {
      const lastChar = currentLine[currentLine.length - 1]
      currentLine = currentLine.slice(0, -1)
      pushLine(lines, currentLine)
      currentLine = lastChar + ch
      continue
    }

    // 通常の折り返し
    pushLine(lines, currentLine)
    currentLine = ch
  }

  pushLine(lines, currentLine)

  return lines.length > 0 ? lines : ['']
}

/**
 * テキストを指定幅で折り返す
 * @param text 折り返し対象テキスト（改行なしの1段落）
 * @param maxWidth 折り返し幅（ピクセル）
 * @param font CSS font 文字列（例: "22px 'Noto Sans JP', sans-serif"）
 * @returns 折り返し済み行の配列
 */
export function wordwrap(text: string, maxWidth: number, font: string): string[] {
  if (text.length === 0) return ['']
  if (maxWidth <= 0) return [text]

  const ctx = getContext()
  if (!ctx) return [text]

  ctx.font = font

  return wrapTextWithMeasure(text, maxWidth, (s) => ctx.measureText(s).width)
}
