/**
 * NovelRenderer 立ち絵・背景の先読み (#389) 単体テスト。
 *
 * 観察された不具合の緩和策: 立ち絵・背景は従来「表示の瞬間に初めて Assets.load」する遅延ロード
 * （初出は必ずコールドロード）で、遅延/瞬断すると #293 のフォールバック（ロード成否に関わらず
 * onReady 発火でテキスト解禁）により「立ち絵なし・テキストあり」に倒れる。これを緩和するため、
 * 現在の eventIndex から resolvedEvents を前方走査し、次に出る立ち絵/背景 URL を
 * `Assets.backgroundLoad` に積んで温めておく（`preloadUpcomingAssets`）。
 *
 * ここで縛る仕様（テスト設計エージェントの観点 1〜18、および #414 追加の 19〜25）:
 *   - 収集対象は Dialog / ExpressionChange の立ち絵（webp+png の 2 候補）と Background の背景画像。
 *   - 走査は次の分岐（Choice / Condition）に当たるまで、または末尾まで。
 *   - 緩い上限: テキストイベント（getTextEvent 非 null = Dialog/Narration）を最大
 *     PRELOAD_MAX_TEXT_EVENTS(=8) 個で打ち切る。ExpressionChange/Background は予算に数えない。
 *   - 重複除去: preloadedUrls Set でクロス呼び出しの再送を防ぐ。
 *   - ガード: assetBaseUrl 空なら no-op。
 *   - #414: backgroundLoad に渡す fresh 配列は PixiJS BackgroundLoader の LIFO pop 消化
 *     （_maxConcurrent=1・末尾 push/pop、複数回呼び出しをまたいだキュー蓄積込み）に対処するため
 *     reverse() してから渡す。テスト 19〜25 は「渡した配列」ではなく simulateLifoConsumeOrder を
 *     通した「実消化順」で nearest-first を検証する（観点 1〜18 は配列一致のみで手段レベルの回帰しか
 *     検知できないため、振る舞いレベルの検証として追加）。
 *
 * テスト設計（jsdom・canvas 非依存。既存 NovelRenderer.tachieTiming.test.ts の構築・spy 流儀に合わせる）:
 *   - `Assets.load`（立ち絵/背景の実表示ロード）と `Assets.unload` はモックで握り潰す。
 *   - 観測点は `Assets.backgroundLoad` の spy。先読みが積んだ URL 集合だけを見る（実表示ロードの
 *     Assets.load とは別経路なので、backgroundLoad spy に先読み分だけが乗る）。
 *   - render の実 body は PixiJS 依存なので spy で差し替える（initialized を立てて renderOnce を通す）。
 *   - 期待 URL は候補を組み立てる当の関数 resolveCharacterImageUrls / resolveAssetUrl で作り、
 *     生 URL 文字列を直書きしない（doctrine 規律4・#262 直書き禁止）。
 *   - 発火は原則 setScenes / advance の公開経路（実挙動に近い）。resolveEvents で消える raw Condition
 *     と Choice 待機停止の 2 観点だけは、その状態が公開経路では作れないため private を cast で直接叩く。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Assets, Texture } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'
import { resolveAssetUrl, resolveCharacterImageUrls } from './novelLayout'
import type { Event, EventScene } from '../types'

const BASE = '/assets'

function dialog(character: string | null, expression: string | null, ...text: string[]): Event {
  return {
    Dialog: { character, expression, position: '中央', text, voice_path: null, font_family: null },
  }
}
function narration(...text: string[]): Event {
  return { Narration: { text, voice_path: null, font_family: null } }
}
function background(path: string): Event {
  return { Background: { path } }
}
function expressionChange(character: string, expression: string): Event {
  return { ExpressionChange: { character, expression } }
}
function choice(jump = 's'): Event {
  return { Choice: { options: [{ text: 'go', jump }] } }
}
function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}
/** 表情 ex/e0, ex/e1, ... の Dialog を n 件（互いに別 URL）作る。境界・予算テスト用。 */
function distinctDialogs(n: number): Event[] {
  return Array.from({ length: n }, (_, i) => dialog('c' + i, 'ex/e' + i, 't'))
}

interface PreloadHooks {
  render(): void
  advance(): void
  initialized: boolean
  eventIndex: number
  resolvedEvents: Event[]
  preloadUpcomingAssets(): void
  preloadedUrls: Set<string>
}
function hooks(r: NovelRenderer): PreloadHooks {
  return r as unknown as PreloadHooks
}

/**
 * 立ち絵/背景の実表示ロード（Assets.load）と unload を握り潰し、先読みの Assets.backgroundLoad を
 * spy する共通セットアップ。render は spy で no-op 化し initialized を立てる（tachieTiming と同流儀）。
 */
function setup(assetBaseUrl: string = BASE) {
  vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
  vi.spyOn(Assets, 'load').mockResolvedValue(Texture.WHITE as never)
  const bgSpy = vi.spyOn(Assets, 'backgroundLoad').mockResolvedValue(undefined as never)
  const r = new NovelRenderer()
  r.setAssetBaseUrl(assetBaseUrl)
  const h = hooks(r)
  vi.spyOn(h, 'render').mockImplementation(() => {})
  h.initialized = true
  return { r, h, bgSpy }
}

/** backgroundLoad に積まれた URL を全 call ぶん平坦化する（各 call の第1引数は string[]）。 */
function preloadedUrls(bgSpy: { mock: { calls: unknown[][] } }): string[] {
  return bgSpy.mock.calls.flatMap((c) => c[0] as string[])
}

/**
 * resolveCharacterImageUrls は [webp, png] の近い順で候補を返すが、preloadUpcomingAssets は
 * BackgroundLoader の LIFO 消化に対処するため fresh 配列全体を reverse してから backgroundLoad に
 * 渡す (#414)。単一 Dialog/ExpressionChange だけが走査枠に入るケースでは、その 1 アセット分の
 * [webp, png] 自体も丸ごと反転されて [png, webp] で観測される。期待値側もこの反転を織り込む。
 */
function reversedUrls(urls: string[]): string[] {
  return [...urls].reverse()
}

/**
 * PixiJS v8 の BackgroundLoader（node_modules/pixi.js/lib/assets/BackgroundLoader.mjs）の消化順を、
 * 実ローダーを動かさずテスト側で再現する純粋関数。`_maxConcurrent = 1` の直列 LIFO
 * （add() で配列末尾へ push → _next() が Array.pop() で1件ずつ取り出し）を、複数回の
 * backgroundLoad 呼び出し（callsInOrder）をまたいだキュー蓄積込みで模擬する: 呼び出し順に
 * 全呼び出し分を共有スタックへ push し尽くしてから、末尾から pop し尽くす。これは「前回呼び出し分が
 * 1件も消化されないうちに次の呼び出しが積まれる」worst-case を固定した模擬であり、Issue #414 が
 * 問題にした「複数回の呼び出しをまたいだキュー蓄積」を最も厳しい形で検証できる。
 *
 * ⚠️ このヘルパーが無いと、「backgroundLoad に渡した配列が reverse() 後の期待値と一致するか」という
 * 実装手段レベルの検証しかできず、Issue #414 本文が要求する「LIFO pop で消化したときに実際に
 * nearest-first になるか」という振る舞いレベルの回帰を検知できない。TC-19 / TC-22 / TC-24 は
 * このヘルパーを通した消化順で判定する。
 */
function simulateLifoConsumeOrder(callsInOrder: string[][]): string[] {
  const stack: string[] = []
  for (const call of callsInOrder) {
    for (const url of call) stack.push(url)
  }
  const consumed: string[] = []
  while (stack.length > 0) {
    consumed.push(stack.pop() as string)
  }
  return consumed
}

describe('NovelRenderer 立ち絵・背景の先読み preloadUpcomingAssets (#389)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // 1: Dialog(character+expression) 1 件で、その立ち絵の webp/png 2 URL が backgroundLoad に積まれる。
  it('1: Dialog(char+expr) 1 件で立ち絵の webp/png 2 URL が積まれる', () => {
    const { r, bgSpy } = setup()
    r.setScenes([scene('s', [dialog('ひな', 'aa/happy', 'x')])])
    expect(preloadedUrls(bgSpy)).toEqual(reversedUrls(resolveCharacterImageUrls(BASE, 'aa/happy')))
  })

  // 2: Background 1 件で images 配下の背景 URL が 1 本積まれる（Narration をアンカーに後続へ置く）。
  it('2: Background 1 件で images パスの背景 URL が 1 本積まれる', () => {
    const { r, bgSpy } = setup()
    r.setScenes([scene('s', [narration('n'), background('bg/room.png')])])
    expect(preloadedUrls(bgSpy)).toEqual([resolveAssetUrl(BASE, 'images', 'bg/room.png')])
  })

  // 3: ExpressionChange(char+expr) は立ち絵 2 URL を積み、かつ「テキストイベント予算」を消費しない。
  //    Dialog×8（予算をちょうど 8 まで使う）直後に置いた ExpressionChange の 2 URL も積まれることで
  //    「EC は予算に数えない」を裏取りする（EC が予算を食うなら 8 個目までで打ち切られ EC は落ちる）。
  it('3: ExpressionChange は 2 URL 積み・予算を消費しない（Dialog×8+末尾 EC が積まれる）', () => {
    const { r, bgSpy } = setup()
    r.setScenes([scene('s', [...distinctDialogs(8), expressionChange('c0', 'ec/x')])])
    const urls = preloadedUrls(bgSpy)
    // Dialog 8 件（16 URL）+ EC（2 URL）= 18。EC の 2 URL が確かに含まれる。
    expect(urls.length).toBe(18)
    for (const u of resolveCharacterImageUrls(BASE, 'ec/x')) expect(urls).toContain(u)
  })

  // 4: Dialog の character が null なら立ち絵は積まない（後続の有効 Dialog だけが積まれる）。
  it('4: Dialog character=null は積まない', () => {
    const { r, bgSpy } = setup()
    r.setScenes([scene('s', [dialog(null, 'x/a', 't'), dialog('c', 'y/b', 't')])])
    const urls = preloadedUrls(bgSpy)
    expect(urls).toEqual(reversedUrls(resolveCharacterImageUrls(BASE, 'y/b')))
    for (const u of resolveCharacterImageUrls(BASE, 'x/a')) expect(urls).not.toContain(u)
  })

  // 5: Dialog の expression が null なら立ち絵は積まない（後続の有効 Dialog だけが積まれる）。
  it('5: Dialog expression=null は積まない', () => {
    const { r, bgSpy } = setup()
    r.setScenes([scene('s', [dialog('c', null, 't'), dialog('c2', 'y/b', 't')])])
    expect(preloadedUrls(bgSpy)).toEqual(reversedUrls(resolveCharacterImageUrls(BASE, 'y/b')))
  })

  // 6: Narration は立ち絵を積まないが、テキストイベント予算は 1 消費する。Narration×8 で予算を
  //    使い切ると、9 個目のテキストイベント（有効 Dialog）は打ち切りで積まれない。
  it('6: Narration は積まないが予算を 1 消費する（Narration×8→9 個目 Dialog は積まれない）', () => {
    const { r, bgSpy } = setup()
    const narrs = Array.from({ length: 8 }, (_, i) => narration('n' + i))
    r.setScenes([scene('s', [...narrs, dialog('c', 'z/x', 't')])])
    // 予算切れで 9 個目 Dialog は走査打ち切り。立ち絵は 1 本も積まれない。
    expect(bgSpy).not.toHaveBeenCalled()
  })

  // 7: Video / BackgroundColor / Bgm / Blackout は先読み対象外（1 本も積まれない）。
  it('7: Video/BackgroundColor/Bgm/Blackout は非対象で積まない', () => {
    const { r, bgSpy } = setup()
    r.setScenes([
      scene('s', [
        narration('n'),
        { Video: { path: 'v.mp4' } } as Event,
        { BackgroundColor: { color: '#ffffff' } } as Event,
        { Bgm: { path: 'b.mp3', action: 'Play' } } as Event,
        { Blackout: { action: 'On' } } as Event,
      ]),
    ])
    expect(bgSpy).not.toHaveBeenCalled()
  })

  // 8: 文字列 variant（'SceneTransition' / 'PageBreak'）は読み飛ばして、その後ろの立ち絵まで積む。
  it('8: 文字列 variant(SceneTransition/PageBreak)を跨いで後続立ち絵まで積む', () => {
    const { r, bgSpy } = setup()
    r.setScenes([
      scene('s', [
        narration('n'),
        'SceneTransition' as Event,
        'PageBreak' as Event,
        dialog('c', 'w/x', 't'),
      ]),
    ])
    expect(preloadedUrls(bgSpy)).toEqual(reversedUrls(resolveCharacterImageUrls(BASE, 'w/x')))
  })

  // 9: 境界 — 連続 Dialog 7 件（予算未満）は 7×2=14 URL 全部積む。
  it('9: 連続 Dialog 7 件は 7×2=14 URL 全部積む', () => {
    const { r, bgSpy } = setup()
    r.setScenes([scene('s', distinctDialogs(7))])
    const urls = preloadedUrls(bgSpy)
    expect(urls.length).toBe(14)
    for (let i = 0; i < 7; i++) {
      for (const u of resolveCharacterImageUrls(BASE, 'ex/e' + i)) expect(urls).toContain(u)
    }
  })

  // 10: 境界 — 連続 Dialog 8 件（予算ちょうど）は 8×2=16 URL 全部積む。
  it('10: 連続 Dialog 8 件は 8×2=16 URL 全部積む', () => {
    const { r, bgSpy } = setup()
    r.setScenes([scene('s', distinctDialogs(8))])
    const urls = preloadedUrls(bgSpy)
    expect(urls.length).toBe(16)
    for (let i = 0; i < 8; i++) {
      for (const u of resolveCharacterImageUrls(BASE, 'ex/e' + i)) expect(urls).toContain(u)
    }
  })

  // 11: 境界 — 連続 Dialog 9 件は先頭 8 件のみ（9 個目のテキストイベントで打ち切り、その立ち絵は落ちる）。
  it('11: 連続 Dialog 9 件は先頭 8 件のみ積む（9 件目は積まない）', () => {
    const { r, bgSpy } = setup()
    r.setScenes([scene('s', distinctDialogs(9))])
    const urls = preloadedUrls(bgSpy)
    expect(urls.length).toBe(16)
    // 9 件目（index 8 = ex/e8）の立ち絵は積まれない。
    for (const u of resolveCharacterImageUrls(BASE, 'ex/e8')) expect(urls).not.toContain(u)
  })

  // 12: Choice に当たったら走査停止。Choice より後ろの Dialog は積まない。
  it('12: Choice で走査停止（Choice 以降の Dialog は積まない）', () => {
    const { r, bgSpy } = setup()
    r.setScenes([scene('s', [dialog('a', 'aa/happy', 'x'), choice(), dialog('b', 'bb/sad', 'y')])])
    const urls = preloadedUrls(bgSpy)
    expect(urls).toEqual(reversedUrls(resolveCharacterImageUrls(BASE, 'aa/happy')))
    for (const u of resolveCharacterImageUrls(BASE, 'bb/sad')) expect(urls).not.toContain(u)
  })

  // 13: eventIndex が Choice を指す（選択肢待機で停止した）状態からの preload は no-op。
  //     公開経路ではこの eventIndex 状態を安定に作れないため、private を cast で直接叩いて縛る。
  it('13: eventIndex=Choice の状態からの preload は no-op（backgroundLoad 未呼出）', () => {
    const { h, bgSpy } = setup()
    h.resolvedEvents = [choice(), dialog('a', 'ex/e0', 't')]
    h.eventIndex = 0
    h.preloadUpcomingAssets()
    expect(bgSpy).not.toHaveBeenCalled()
  })

  // 14: raw Condition は resolveEvents で展開され通常 resolvedEvents に現れないが、防御的仕様として
  //     Condition に当たったら走査を止める。resolvedEvents へ直接注入して境界扱いを固定する。
  it('14: raw Condition を resolvedEvents に注入すると走査が break する', () => {
    const { h, bgSpy } = setup()
    h.resolvedEvents = [
      dialog('a', 'ex/before', 't'),
      { Condition: { flag: 'f', events: [] } } as Event,
      dialog('b', 'ex/after', 't'),
    ]
    h.eventIndex = 0
    h.preloadUpcomingAssets()
    const urls = preloadedUrls(bgSpy)
    // Condition 手前までは積み、Condition 以降（ex/after）は積まない。
    expect(urls).toEqual(reversedUrls(resolveCharacterImageUrls(BASE, 'ex/before')))
    for (const u of resolveCharacterImageUrls(BASE, 'ex/after')) expect(urls).not.toContain(u)
  })

  // 15: assetBaseUrl が空なら（描画不能）先読みは no-op。backgroundLoad を一切呼ばない。
  it('15: assetBaseUrl 空なら backgroundLoad 未呼出', () => {
    const { r, bgSpy } = setup('')
    r.setScenes([scene('s', [dialog('a', 'ex/e0', 't')])])
    expect(bgSpy).not.toHaveBeenCalled()
  })

  // 16: 一度先読み済みの expression が別 Dialog で再登場しても、preloadedUrls の dedup で再送しない。
  //     予算超過で初回スキャン枠の外に置いた同一 expression の Dialog を、advance で枠に入れて確認する。
  it('16: 既に先読み済みの同一 expression 再登場は backgroundLoad に再送しない', () => {
    const { r, h, bgSpy } = setup()
    // dialog(same/e) を先頭に置き、Narration×7 で予算を使い切って 2 個目の same/e を初回枠の外に出す。
    const narrs = Array.from({ length: 7 }, (_, i) => narration('n' + i))
    r.setScenes([scene('s', [dialog('a', 'same/e', 't'), ...narrs, dialog('b', 'same/e', 't')])])
    // 初回は same/e を 1 度だけ積む（重複なし）。
    expect(preloadedUrls(bgSpy)).toEqual(reversedUrls(resolveCharacterImageUrls(BASE, 'same/e')))

    bgSpy.mockClear()
    // advance で 2 個目 same/e が走査枠に入るが、既に積み済みなので再送されない。
    h.advance()
    expect(bgSpy).not.toHaveBeenCalled()
  })

  // 17: advance 跨ぎの累積 dedup。予算で初回に積めなかった新規立ち絵だけが 2 手目 advance で積まれ、
  //     既に積んだ URL は再送されない。
  it('17: advance 跨ぎで既積み URL は再送せず新規 URL だけ積む', () => {
    const { r, h, bgSpy } = setup()
    // Dialog 10 件。初回は予算 8 で ex/e0..e7 を積み、ex/e8/e9 は枠外。
    r.setScenes([scene('s', distinctDialogs(10))])
    expect(preloadedUrls(bgSpy).length).toBe(16)

    bgSpy.mockClear()
    // 1 手 advance すると走査枠が index1..index8 に移り、ex/e8 が新規で入る（ex/e9 はまだ予算外）。
    h.advance()
    const urls = preloadedUrls(bgSpy)
    // 新規 ex/e8 の 2 URL だけが積まれる。
    expect(urls).toEqual(reversedUrls(resolveCharacterImageUrls(BASE, 'ex/e8')))
    // 既に積んだ ex/e1 等は再送されない。
    for (const u of resolveCharacterImageUrls(BASE, 'ex/e1')) expect(urls).not.toContain(u)
  })

  // 18: 予算超過後の Background は積まれる（Background は予算に数えないため、Dialog×8 直後でも積む）。
  //     コード通りの挙動を回帰固定する（テキストイベントだけが予算対象・Background は素通り）。
  it('18: 予算超過後（Dialog×8 直後）の Background も積まれる', () => {
    const { r, bgSpy } = setup()
    r.setScenes([scene('s', [...distinctDialogs(8), background('bg/room.png')])])
    const urls = preloadedUrls(bgSpy)
    expect(urls).toContain(resolveAssetUrl(BASE, 'images', 'bg/room.png'))
    // Dialog 8 件（16 URL）+ Background（1 URL）= 17。
    expect(urls.length).toBe(17)
  })

  // 19: 過去事故パターン直撃・最重要 — Dialog/ExpressionChange/Background混在の走査枠で、
  //     backgroundLoad に「渡された配列」ではなく、LIFO pop で「実際に消化した順序」が
  //     nearest-first（Dialog→ExpressionChange→Background の走査順）になることを検証する。
  //     ⚠️ このテストが無いと、reverse() を将来 unshift 等に「最適化」されて Issue #414 の
  //     順序逆転が再発してもテストが検知できない。
  it('19: Dialog/ExpressionChange/Background混在でpop消化順がnearest-firstになる (#414 回帰検知)', () => {
    const { r, bgSpy } = setup()
    r.setScenes([
      scene('s', [
        dialog('a', 'aa/happy', 'x'),
        expressionChange('b', 'bb/sad'),
        background('bg/room.png'),
      ]),
    ])
    const consumeOrder = simulateLifoConsumeOrder(bgSpy.mock.calls.map((c) => c[0] as string[]))
    expect(consumeOrder).toEqual([
      ...resolveCharacterImageUrls(BASE, 'aa/happy'),
      ...resolveCharacterImageUrls(BASE, 'bb/sad'),
      resolveAssetUrl(BASE, 'images', 'bg/room.png'),
    ])
  })

  // 20: 境界値=1件 — urls収集が1件（Background単体）のときは、reverse前後で消化順が変わらない
  //     （長さ1の配列の reverse は無変化）ことを明示する。
  it('20: 境界値=1件（Background単体）はreverse前後で消化順が不変', () => {
    const { r, bgSpy } = setup()
    r.setScenes([scene('s', [narration('n'), background('bg/room.png')])])
    const consumeOrder = simulateLifoConsumeOrder(bgSpy.mock.calls.map((c) => c[0] as string[]))
    expect(consumeOrder).toEqual([resolveAssetUrl(BASE, 'images', 'bg/room.png')])
  })

  // 21: 境界値-1=0件（記録目的） — urls収集が0件だと fresh.length===0 の早期 return で
  //     reverse() にすら到達しない経路であることを明示する。
  it('21: 境界値-1=0件はreverseに到達せずbackgroundLoad未呼出', () => {
    const { r, bgSpy } = setup()
    r.setScenes([scene('s', [])])
    expect(bgSpy).not.toHaveBeenCalled()
  })

  // 22: 境界値+1=2件・核心 — 1イベント2URL（webp/png候補）で、pop消化順が「渡された配列が
  //     reverseと一致する」ではなく「popしたら元の意図順（webp→png）が出る」ことを検証する。
  //     ⚠️ このテストが無いと、reverse() の対象範囲が「1候補ペア内」だけに縮退する誤修正でも
  //     テストが気づけない。
  it('22: 境界値+1=2件（webp/png）はpop消化順がwebp→pngの意図順になる (#414 回帰検知)', () => {
    const { r, bgSpy } = setup()
    r.setScenes([scene('s', [dialog('a', 'aa/happy', 'x')])])
    const consumeOrder = simulateLifoConsumeOrder(bgSpy.mock.calls.map((c) => c[0] as string[]))
    expect(consumeOrder).toEqual(resolveCharacterImageUrls(BASE, 'aa/happy'))
  })

  // 23: 同値分割の空白セル — urls=1件・fresh=0（唯一のURLが既にpreload済み）で早期returnし、
  //     backgroundLoadが呼ばれないこと。
  it('23: 唯一のURLが既にpreload済みなら早期returnしbackgroundLoad未呼出', () => {
    const { r, h, bgSpy } = setup()
    r.setScenes([scene('s', [narration('n'), background('bg/room.png')])])
    expect(bgSpy).toHaveBeenCalledTimes(1)
    bgSpy.mockClear()
    // 同じ eventIndex から再走査すると urls=[bg] だが、既に preloadedUrls 済みで fresh=0。
    h.preloadUpcomingAssets()
    expect(bgSpy).not.toHaveBeenCalled()
  })

  // 24: Issue必須シナリオ④・最重要 — advance跨ぎで複数回backgroundLoadが呼ばれるとき、前回
  //     呼び出し分の未消化キュー残と今回の新規reverse分を合成したpop順で、新規（今回分＝より近い）
  //     が前回残存分より先に消化されること。
  //     ⚠️ このテストが無いと、「1回の呼び出し内だけreverseすれば足りる」という誤った縮退実装でも
  //     テストが気づけない（Issue #414 の本質は複数回呼び出しをまたいだキュー蓄積）。
  it('24: advance跨ぎの2回目backgroundLoad新規分が1回目残存分より先にpopされる (#414 回帰検知・最重要)', () => {
    const { r, h, bgSpy } = setup()
    // Dialog 10 件。初回は予算8でex/e0..e7（16URL・1回目backgroundLoad呼び出し）を積み、
    // advanceでex/e8（2URL・2回目backgroundLoad呼び出し）が新規で入る（test17と同じ走査）。
    r.setScenes([scene('s', distinctDialogs(10))])
    h.advance()
    expect(bgSpy.mock.calls.length).toBe(2)

    const consumeOrder = simulateLifoConsumeOrder(bgSpy.mock.calls.map((c) => c[0] as string[]))
    const firstBatch = Array.from({ length: 8 }, (_, i) =>
      resolveCharacterImageUrls(BASE, 'ex/e' + i)
    ).flat()
    const secondBatch = resolveCharacterImageUrls(BASE, 'ex/e8')
    // 2回目（新規・より近い）の全URLが、1回目残存分より先に消化される。
    expect(consumeOrder).toEqual([...secondBatch, ...firstBatch])
  })

  // 25(任意・回帰固定・低優先): fresh.reverse() は破壊的操作（fresh 自体を in-place で反転する）
  //     だが、reverse() 呼び出しより前に確定済みの preloadedUrls への登録内容（Set への追加順）には
  //     影響しない。
  it('25: reverse()の破壊的操作はpreloadedUrls登録順に影響しない', () => {
    const { r, h } = setup()
    r.setScenes([scene('s', [dialog('a', 'aa/happy', 'x')])])
    const registered = Array.from(h.preloadedUrls)
    expect(registered).toEqual(resolveCharacterImageUrls(BASE, 'aa/happy'))
  })
})
