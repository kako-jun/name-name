/**
 * シアターモードの回転舞台 `[舞台回転]` (#704 第2弾)。舞台全体（壁・背景板・大道具・床）を
 * 画面中央の鉛直軸まわりに 1 枚の板のように回し、旧い舞台（0°→90° で消える）から裏側の舞台
 * （-90°→0° で現れる）へ一斉に切り替える。
 *
 * 第1弾 (`boardFaceFlip.ts`) は板ごとの中心軸だったが、ここでは全板が同じ軸（画面中央）・同じ消失点・
 * 同じカメラ距離・同じ角度で回る（`computeStageTurnCorners`）。角度の時間変化は `boardFlip.ts` と共通。
 *
 * このファイルは
 * - 純粋関数（回転の四隅・経過時間からの見え方）
 * - 回転 1 回分の実行体 `StageTurnRun`（旧面・新面の mesh を所有して毎フレーム更新）
 * - `[舞台回転]` と裏側の指定を束ねて回転を起こす `StageTurnController`
 * を提供する。各レイヤー（`WallLayer` / `BackgroundBoardLayer` / `FloorLayer` / `PropLayer`）は
 * `StageTurnParticipant` として `beginStageTurn(run)` で旧面を `run` に渡し、新面のロード完了を `run` に伝える。
 *
 * ADR 0002: 入力は経過時間だけ（`TimeController.now()` との差）。`Math.random` も実時計も使わない。
 * 回転途中の状態はレイヤーの settled state（`getState()`）に持たない（保存状態は回転後の最終状態）。
 */
import { Container, PerspectiveMesh, type Filter, type Texture } from 'pixi.js'
import { isBoardFaceFlipEnabled, prefersReducedMotion } from './boardFaceFlip'
import {
  BOARD_FLIP_CAMERA_DISTANCE_RATIO,
  BOARD_FLIP_MAX_ANGLE_RAD,
  computeBoardFlipFrame,
  type BoardFlipCorners,
} from './boardFlip'
import { clampFadeMs } from './novelLayout'
import type { TimeController } from './TimeController'

/** `[舞台回転]` の所要時間の上限（ms）。パーサの `STAGE_TURN_MAX_MS` と同じ。 */
export const STAGE_TURN_MAX_MS = 5000

/** 新面のロードを待つ上限（ms）。超えても着かない新面は読み込み失敗と同じ扱いで、回転を始める。 */
export const STAGE_TURN_MAX_WAIT_MS = 3000

/** 板 1 面の配置（中心 `x, y` と幅・高さ。`anchor=0.5` の Sprite と同じ）。 */
export interface StageTurnGeometry {
  x: number
  y: number
  width: number
  height: number
}

/** 全板が共有する回転軸・消失点・カメラ距離。 */
export interface StageTurnView {
  /** 回転軸の x（画面中央）。 */
  axisX: number
  /** 消失点の y（画面の縦の中央）。 */
  vanishY: number
  /** カメラ距離。全板で共通（舞台が 1 枚の板として回って見える）。 */
  distance: number
}

/** 画面サイズから回転の見え方（軸・消失点・距離）を決める。 */
export function computeStageTurnView(screenWidth: number, screenHeight: number): StageTurnView {
  return {
    axisX: screenWidth / 2,
    vanishY: screenHeight / 2,
    distance: Math.max(screenHeight * BOARD_FLIP_CAMERA_DISTANCE_RATIO, screenWidth * 2, 1),
  }
}

/**
 * 板（中心 `(x, y)`・幅 `width`・高さ `height`）を画面中央の鉛直軸まわりに `angleRad` 回し、透視投影した
 * 四隅（左上・右上・右下・左下）を返す。軸から離れた板ほど大きく振れ、奥へ回る側ほど小さく・消失点
 * （画面の縦の中央）寄りに縮む。角度は退化角（ちょうど 90°）を避けて丸める。
 */
export function computeStageTurnCorners(
  face: StageTurnGeometry,
  angleRad: number,
  view: StageTurnView
): BoardFlipCorners {
  const angle = Math.min(
    BOARD_FLIP_MAX_ANGLE_RAD,
    Math.max(-BOARD_FLIP_MAX_ANGLE_RAD, Number.isFinite(angleRad) ? angleRad : 0)
  )
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const halfW = face.width / 2
  const halfH = face.height / 2
  const offsetX = face.x - view.axisX
  const offsetY = face.y - view.vanishY
  const project = (lx: number, ly: number): [number, number] => {
    const rx = offsetX + lx
    const z = rx * sin
    // 分母が 0 以下にならないよう下限を置く（距離は画面幅の 2 倍以上なので通常は効かない）。
    const s = view.distance / Math.max(view.distance + z, view.distance * 0.05)
    return [view.axisX + rx * cos * s, view.vanishY + (offsetY + ly) * s]
  }
  const [x0, y0] = project(-halfW, -halfH)
  const [x1, y1] = project(halfW, -halfH)
  const [x2, y2] = project(halfW, halfH)
  const [x3, y3] = project(-halfW, halfH)
  return { x0, y0, x1, y1, x2, y2, x3, y3 }
}

/** ある時点での旧面・新面の見え方（可視と角度）。全板に共通。 */
export function computeStageTurnAngles(
  elapsedMs: number,
  totalMs: number
): { old: { visible: boolean; angleRad: number }; next: { visible: boolean; angleRad: number } } {
  return {
    old: computeBoardFlipFrame('out', elapsedMs, totalMs),
    next: computeBoardFlipFrame('in', elapsedMs, totalMs),
  }
}

/** `[舞台回転]` の所要時間（ms）。未指定・非有限は既定、0〜5000 に丸める。 */
export function resolveStageTurnDuration(
  durationMs: number | null | undefined,
  defaultMs: number
): number {
  const fallback = Math.min(STAGE_TURN_MAX_MS, clampFadeMs(defaultMs, 700))
  if (durationMs == null || !Number.isFinite(durationMs)) return fallback
  return Math.min(STAGE_TURN_MAX_MS, Math.max(0, Math.round(durationMs)))
}

/** 回転に参加するレイヤー。回転が終わる（または打ち切られる）と `endTurn()` が呼ばれる。 */
export interface StageTurnParticipant {
  endTurn(): void
}

interface TurnMesh {
  mesh: PerspectiveMesh
  geometry: StageTurnGeometry
  role: 'old' | 'new'
  host: Container
  /** 回転用に作った一時テクスチャ（床のタイルを焼いたものなど）。dispose で破棄する。 */
  ownedTexture: Texture | null
}

/**
 * 進行中の 1 回の回転。旧面・新面の `PerspectiveMesh` を所有する。
 *
 * 旧面は `addOld` で渡された時点から（角度 0 で）表示され、全ての新面が `resolveNew`（または
 * `failNew`）で出そろってから回転が始まる（新面のロード中は旧面を残す）。
 * `finish()` は冪等で、全 mesh を破棄して各レイヤーの `endTurn()` を呼ぶ。
 */
export class StageTurnRun {
  private readonly meshes: TurnMesh[] = []
  private readonly participants: StageTurnParticipant[] = []
  private readonly halfHooks: Array<() => void> = []
  private readonly pending = new Set<number>()
  private nextToken = 1
  private sealed = false
  private startMs: number | null = null
  private timer: number | null = null
  private waitTimer: number | null = null
  private halfFired = false
  private _ended = false
  /** コントローラが裏側の指定を流し込んでいる間だけ true（この間のレイヤーの `clear()` は回転を打ち切らない）。 */
  replaying = false

  constructor(
    private readonly time: TimeController,
    private readonly view: StageTurnView,
    readonly durationMs: number
  ) {}

  get ended(): boolean {
    return this._ended
  }

  get started(): boolean {
    return this.startMs !== null
  }

  register(participant: StageTurnParticipant): void {
    if (!this.participants.includes(participant)) this.participants.push(participant)
  }

  /** 回転の中間（旧面が消えて新面が現れる瞬間）に呼ぶ処理を登録する。動画の壁など回さない面の入れ替えに使う。 */
  onHalf(hook: () => void): void {
    this.halfHooks.push(hook)
  }

  /** 旧面を足す。回転が始まるまで角度 0 のまま表示される。 */
  addOld(
    host: Container,
    texture: Texture,
    geometry: StageTurnGeometry,
    depth: number,
    opts?: { filters?: Filter[] | null; ownedTexture?: Texture | null }
  ): void {
    if (this._ended) {
      opts?.ownedTexture?.destroy(true)
      return
    }
    this.addMesh('old', host, texture, geometry, depth, opts)
  }

  /** 新面の登場を予約する。戻り値のトークンで `resolveNew` / `failNew` する。 */
  expectNew(): number {
    const token = this.nextToken++
    this.pending.add(token)
    return token
  }

  /** 新面のロードが終わった。回転が始まるまで非表示で待つ。 */
  resolveNew(
    token: number,
    host: Container,
    texture: Texture,
    geometry: StageTurnGeometry,
    depth: number,
    opts?: { filters?: Filter[] | null; ownedTexture?: Texture | null }
  ): void {
    if (this._ended || !this.pending.delete(token)) {
      opts?.ownedTexture?.destroy(true)
      return
    }
    const entry = this.addMesh('new', host, texture, geometry, depth, opts)
    entry.mesh.visible = false
    this.maybeStart()
  }

  /** 新面のロードに失敗した・差し替え／撤去された（新面なしとして回転を進める）。 */
  failNew(token: number): void {
    if (this._ended) return
    if (this.pending.delete(token)) this.maybeStart()
  }

  /** 裏側の指定を流し終えた。以後、新面が出そろっていれば回転を始める。 */
  seal(): void {
    if (this._ended || this.sealed) return
    this.sealed = true
    if (this.startMs === null && this.pending.size > 0) {
      // 新面のロードが済まなくても、上限で見切って回し始める（未着の新面は読み込み失敗と同じ扱い）。
      this.waitTimer = this.time.setTimeout(() => {
        this.waitTimer = null
        this.pending.clear()
        this.maybeStart()
      }, STAGE_TURN_MAX_WAIT_MS)
    }
    this.maybeStart()
  }

  /** 全ての mesh（`host` に載せたもの）に輪郭などのフィルタを付け替える。 */
  setFilters(host: Container, filters: Filter[] | null): void {
    for (const m of this.meshes) {
      if (m.host === host) m.mesh.filters = filters
    }
  }

  private addMesh(
    role: 'old' | 'new',
    host: Container,
    texture: Texture,
    geometry: StageTurnGeometry,
    depth: number,
    opts?: { filters?: Filter[] | null; ownedTexture?: Texture | null }
  ): TurnMesh {
    const mesh = new PerspectiveMesh({ texture })
    // 奥（depth が大きい）ほど先に描く。host は sortableChildren で zIndex を見る。
    mesh.zIndex = -depth
    if (opts?.filters) mesh.filters = opts.filters
    host.addChild(mesh)
    const entry: TurnMesh = {
      mesh,
      geometry,
      role,
      host,
      ownedTexture: opts?.ownedTexture ?? null,
    }
    this.meshes.push(entry)
    this.apply(entry, 0, true)
    return entry
  }

  private maybeStart(): void {
    if (this._ended || this.startMs !== null || !this.sealed || this.pending.size > 0) return
    if (this.waitTimer !== null) {
      this.time.clearTimeout(this.waitTimer)
      this.waitTimer = null
    }
    if (this.meshes.length === 0) {
      // 回すものが何も無い（旧面も新面も無い）。
      this.finish()
      return
    }
    this.startMs = this.time.now()
    this.tick()
    this.timer = this.time.setInterval(() => this.tick(), 16)
  }

  private tick(): void {
    if (this._ended || this.startMs === null) return
    const elapsed = this.time.now() - this.startMs
    if (elapsed >= this.durationMs) {
      this.finish()
      return
    }
    this.updateFrame(elapsed)
  }

  private updateFrame(elapsed: number): void {
    const a = computeStageTurnAngles(elapsed, this.durationMs)
    if (!this.halfFired && elapsed >= this.durationMs / 2) this.fireHalf()
    for (const m of this.meshes) {
      const f = m.role === 'old' ? a.old : a.next
      this.apply(m, f.angleRad, f.visible)
    }
  }

  private apply(m: TurnMesh, angleRad: number, visible: boolean): void {
    m.mesh.visible = visible
    if (!visible) return
    const c = computeStageTurnCorners(m.geometry, angleRad, this.view)
    m.mesh.setCorners(c.x0, c.y0, c.x1, c.y1, c.x2, c.y2, c.x3, c.y3)
  }

  private fireHalf(): void {
    if (this.halfFired) return
    this.halfFired = true
    for (const hook of this.halfHooks) hook()
  }

  /** 回転を打ち切って（または終えて）最終状態にする。冪等。 */
  finish(): void {
    if (this._ended) return
    this._ended = true
    if (this.waitTimer !== null) {
      this.time.clearTimeout(this.waitTimer)
      this.waitTimer = null
    }
    if (this.timer !== null) {
      this.time.clearInterval(this.timer)
      this.timer = null
    }
    this.fireHalf()
    for (const m of this.meshes) {
      const mesh = m.mesh
      if (!mesh.destroyed) {
        const geometry = mesh.geometry
        mesh.removeFromParent()
        mesh.destroy()
        geometry.destroy()
      }
      m.ownedTexture?.destroy(true)
    }
    this.meshes.length = 0
    this.pending.clear()
    for (const p of this.participants) p.endTurn()
    this.participants.length = 0
  }
}

/** コントローラが触る 4 レイヤー。 */
export interface StageTurnLayers {
  wall: StageTurnLayerLike
  backgroundBoard: StageTurnLayerLike
  floor: StageTurnLayerLike
  prop: StageTurnLayerLike
}

export interface StageTurnLayerLike {
  /** 旧面を `run` に渡して空になり、以後の追加は新面として `run` に結び付く。 */
  beginStageTurn(run: StageTurnRun): void
  /** 即時切替用に全消去する。 */
  clear(): void
}

export interface StageTurnHost {
  layers(): StageTurnLayers
  /** `[カメラ: シアター]` か。 */
  isTheater(): boolean
  isSkip(): boolean
  isExporting(): boolean
  /** 既定の所要時間（`character_fade_ms`）。 */
  defaultMs(): number
  screenSize(): { width: number; height: number }
}

/**
 * `[舞台回転]` と、直後から「進行を止めるイベント」までの裏側の指定（壁・背景板・大道具・床）を束ねる。
 *
 * - `begin()` で範囲を開く。範囲の間、ディレクティブは `defer()` で一旦ためる（実行は後）。
 * - `flush()` で範囲を閉じる。ためた指定が 1 つも無ければ何もせず警告。あれば、シアターなら 4 レイヤーの
 *   旧面を回転へ渡して空にし、ためた指定を新面として流し込んで回す。それ以外（ノベル・スキップ・書き出し・
 *   動きを減らす設定・時間 0）は旧面を全消去してから流し込み、即時に最終状態にする。
 * - 範囲の終わりは `NovelRenderer.processUntilNextTextEvent` のループ終端（台詞・ナレーション・選択肢・待機・
 *   ジャンプ）。`cancel()` は場面転換などで範囲ごと捨てるとき。
 */
export class StageTurnController {
  private pending: { durationMs: number | null; skip: boolean; queue: Array<() => void> } | null =
    null
  private active: StageTurnRun | null = null

  constructor(
    private readonly host: StageTurnHost,
    private readonly time: TimeController
  ) {}

  /** `[舞台回転]`。連続して来たら後勝ち（所要時間は最後の指定）。 */
  begin(durationMs: number | null | undefined): void {
    // スキップ中かは範囲を開く時点で控える。範囲を閉じる時点では、待機・選択肢の到達で解除済みのことがある。
    const skip = this.host.isSkip()
    if (this.pending) {
      this.pending.durationMs = durationMs ?? null
      this.pending.skip ||= skip
      return
    }
    this.pending = { durationMs: durationMs ?? null, skip, queue: [] }
  }

  /** 範囲の中なら指定をためて true を返す（呼び出し側は即時実行しない）。 */
  defer(fn: () => void): boolean {
    if (!this.pending) return false
    this.pending.queue.push(fn)
    return true
  }

  /** 範囲が開いているか。 */
  get isOpen(): boolean {
    return this.pending !== null
  }

  /** 進行中の回転（テスト用）。 */
  get run(): StageTurnRun | null {
    return this.active && !this.active.ended ? this.active : null
  }

  /** 範囲ごと捨てる（場面転換・終劇）。進行中の回転は触らない（各レイヤーの clear が打ち切る）。 */
  cancel(): void {
    this.pending = null
  }

  /** 範囲を閉じて回転（または即時切替）を実行する。 */
  flush(): void {
    const pending = this.pending
    this.pending = null
    if (!pending) return
    if (pending.queue.length === 0) {
      console.warn(
        '[name-name] [舞台回転] の直後に裏側の指定（[壁:] [背景板:] [大道具:] [床:]）が無いため、何も回しません'
      )
      return
    }
    // 回転中の再指定: 先の回転は最終状態へ畳む（その舞台が今度の旧面になる）。
    this.active?.finish()
    this.active = null
    const layers = this.host.layers()
    const list = [layers.wall, layers.backgroundBoard, layers.floor, layers.prop]
    const durationMs = resolveStageTurnDuration(pending.durationMs, this.host.defaultMs())
    const enabled = isBoardFaceFlipEnabled({
      isTheater: this.host.isTheater(),
      skip: pending.skip || this.host.isSkip(),
      exporting: this.host.isExporting(),
      reducedMotion: prefersReducedMotion(),
      durationMs,
    })
    if (!enabled) {
      // 即時: 旧い舞台を全消去してから裏側の指定を流し込む（最終状態は回転の場合と同じ）。
      for (const layer of list) layer.clear()
      for (const fn of pending.queue) fn()
      return
    }
    const { width, height } = this.host.screenSize()
    const run = new StageTurnRun(this.time, computeStageTurnView(width, height), durationMs)
    this.active = run
    run.replaying = true
    try {
      for (const layer of list) layer.beginStageTurn(run)
      for (const fn of pending.queue) fn()
    } finally {
      run.replaying = false
      // 流し込み中に例外が出ても、回転が始まらないまま旧面が残らないよう必ず seal する。
      run.seal()
    }
  }
}

/**
 * レイヤー側の回転参加の共通部品。回転用の mesh を載せる `host`（`sortableChildren`）をレイヤーの
 * 最前に持ち、回転が終わる／打ち切られると `onEnd` でレイヤーに最終状態を描き直させる。
 */
export class LayerTurn implements StageTurnParticipant {
  private _run: StageTurnRun | null = null
  private _host: Container | null = null
  private slotToken: number | null = null

  constructor(
    private readonly layer: Container,
    private readonly onEnd: () => void
  ) {}

  /** 進行中の回転（終わっていれば null）。 */
  get run(): StageTurnRun | null {
    return this._run && !this._run.ended ? this._run : null
  }

  get host(): Container | null {
    return this._host
  }

  /** 回転が進行中か。 */
  get active(): boolean {
    return this.run !== null
  }

  /** 回転に参加する。mesh を載せる host を作って返す。 */
  begin(run: StageTurnRun): Container {
    this._run?.finish()
    const host = new Container()
    host.sortableChildren = true
    host.eventMode = 'none'
    this.layer.addChild(host)
    this._host = host
    this._run = run
    this.slotToken = null
    run.register(this)
    return host
  }

  /** 単一スロット（壁・床）の新面を予約する。回転中でなければ予約しない。 */
  expectSlot(): void {
    this.slotToken = this.run?.expectNew() ?? null
  }

  /** 予約済みの新面のトークンを取り出す（以後は resolve する側が持つ）。無ければ null。 */
  takeSlot(): number | null {
    const token = this.slotToken
    this.slotToken = null
    return token
  }

  /** 予約済みの新面を失敗（または取り消し）として run に伝える。 */
  failSlot(): void {
    const token = this.takeSlot()
    if (token != null) this.run?.failNew(token)
  }

  /** 回転を打ち切って最終状態にする（`replaying` 中は打ち切らない）。 */
  interrupt(): void {
    const run = this.run
    if (run && !run.replaying) run.finish()
  }

  /** 書き出し開始・カメラ変更など、`replaying` に関わらず打ち切る。 */
  finish(): void {
    this._run?.finish()
  }

  endTurn(): void {
    const host = this._host
    this._host = null
    this._run = null
    this.slotToken = null
    if (host) {
      host.removeFromParent()
      host.destroy()
    }
    this.onEnd()
  }
}
