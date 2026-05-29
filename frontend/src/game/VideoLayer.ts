/**
 * 動画入力レイヤ (#252)。
 *
 * `[動画: ...]` ディレクティブで指定された動画ファイルを、立ち絵/背景と同じく
 * PixiJS の Container 上に Sprite として配置・再生する。背景と同じ単一スロット意味論で、
 * 同時に表示できる動画は 1 枚。新しい show() は前の動画を置換する。
 *
 * 音声トラックを持つ動画は AudioManager 経由で WebAudio グラフにミックスし、
 * 動画 export（MediaRecorder リアルタイム録画 #228）にも自動的に音が乗る。
 *
 * 端フェードマスク (#250) は edgeFadeMask の共通ユーティリティを流用する。
 */

import { Container, Sprite, Texture, VideoSource } from 'pixi.js'
import { BackgroundFade, VideoState } from './GameState'
import { buildEdgeFadeMask, normalizeEdgeFade } from './edgeFadeMask'
import { AudioManager } from './AudioManager'

/** 配置位置（screenWidth に対する中心 x の比率）。背景的に敷く用途では中央が既定。 */
const VIDEO_X_RATIO: Record<string, number> = {
  left: 0.25,
  center: 0.5,
  right: 0.75,
}

/** 日本語/英語ゆれを left/center/right に正規化する。未知/空は center。 */
export function normalizeVideoPosition(position?: string | null): string {
  if (!position) return 'center'
  const map: Record<string, string> = {
    左: 'left',
    左寄り: 'left',
    左端: 'left',
    中央: 'center',
    真ん中: 'center',
    まんなか: 'center',
    中: 'center',
    右: 'right',
    右寄り: 'right',
    右端: 'right',
    Left: 'left',
    Center: 'center',
    Centre: 'center',
    Right: 'right',
  }
  return map[position] ?? position.toLowerCase()
}

export interface VideoShowOptions {
  position?: string | null
  scale?: number | null
  loop?: boolean | null
  mute?: boolean | null
  fade?: BackgroundFade | null
  /** 復元時の再生位置（秒）。ベストエフォートで seek する */
  playhead?: number | null
}

export class VideoLayer extends Container {
  private readonly screenWidth: number
  private readonly screenHeight: number
  private audioManager: AudioManager | null = null

  /** 現在表示中の動画要素。なければ null */
  private videoEl: HTMLVideoElement | null = null
  private sprite: Sprite | null = null
  private maskSprite: Sprite | null = null

  /** 現在の表示状態（スナップショット用） */
  private current: {
    path: string
    position: string
    scale?: number
    loop: boolean
    mute: boolean
    fade: BackgroundFade | null
  } | null = null

  constructor(screenWidth: number, screenHeight: number, audioManager?: AudioManager) {
    super()
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.audioManager = audioManager ?? null
  }

  setAudioManager(audioManager: AudioManager): void {
    this.audioManager = audioManager
  }

  /**
   * 動画を表示・再生する。既に動画があれば置換する（背景と同じ単一スロット意味論）。
   *
   * @param url 完全な動画 URL（呼び出し側で assetBaseUrl + '/videos/' + path を構築する）
   * @param opts 位置 / スケール / ループ / ミュート / フェード / 復元用 playhead
   */
  show(url: string, opts: VideoShowOptions = {}): void {
    // 既存動画があれば先に解放（単一スロット）
    this.remove()

    const position = normalizeVideoPosition(opts.position)
    const loop = opts.loop === true
    const mute = opts.mute === true
    const fade = normalizeEdgeFade(opts.fade)
    const scale =
      typeof opts.scale === 'number' && Number.isFinite(opts.scale) ? opts.scale : undefined

    const videoEl = document.createElement('video')
    videoEl.src = url
    videoEl.loop = loop
    videoEl.muted = mute
    videoEl.playsInline = true
    videoEl.crossOrigin = 'anonymous'
    videoEl.preload = 'auto'
    this.videoEl = videoEl

    // PixiJS v8 VideoSource で HTMLVideoElement をテクスチャ化する。
    // autoPlay=false にして再生開始は明示的に video.play() で行う（export 頭出し制御のため）。
    const source = new VideoSource({
      resource: videoEl,
      autoPlay: false,
      autoLoad: true,
      loop,
      muted: mute,
      crossorigin: true,
    })
    const texture = new Texture({ source })
    const sprite = new Sprite(texture)
    sprite.anchor.set(0.5, 0.5)
    this.sprite = sprite
    this.addChild(sprite)

    this.current = { path: url, position, scale, loop, mute, fade }

    // 再生位置の復元（ベストエフォート）
    const seekTo = typeof opts.playhead === 'number' && opts.playhead > 0 ? opts.playhead : 0

    // メタデータが揃ったら配置（intrinsic サイズ確定後に cover-fit / position を計算）。
    const layout = () => {
      if (sprite.destroyed) return
      this.applyLayout(sprite, videoEl, position, scale)
    }
    if (videoEl.readyState >= 1 /* HAVE_METADATA */) {
      layout()
    } else {
      videoEl.addEventListener('loadedmetadata', layout, { once: true })
    }

    // 音声ミックス: ミュートでなければ AudioManager に attach（録画にも乗る）。
    if (!mute && this.audioManager) {
      this.audioManager.attachVideoElement(videoEl)
    }

    // フェードマスク適用
    this.applyMask(sprite, fade)

    // 再生開始。autoplay policy 対策: muted なら確実、音ありは export / ユーザー操作起点なので通常 OK。
    const startPlayback = () => {
      if (!this.videoEl || this.videoEl !== videoEl) return
      if (seekTo > 0) {
        try {
          videoEl.currentTime = seekTo
        } catch {
          // seek 不可（メタデータ未読込等）は無視
        }
      }
      videoEl.play().catch((err) => {
        console.warn('[name-name] 動画の再生開始に失敗（autoplay policy 等）: ' + url, err)
      })
    }
    if (videoEl.readyState >= 2 /* HAVE_CURRENT_DATA */) {
      startPlayback()
    } else {
      videoEl.addEventListener('loadeddata', startPlayback, { once: true })
    }
  }

  /**
   * sprite を cover-fit（scale 未指定時）または指定 scale で配置する。
   * position で中心 x を、中心 y は常に画面中央に置く。
   */
  private applyLayout(
    sprite: Sprite,
    videoEl: HTMLVideoElement,
    position: string,
    scale?: number
  ): void {
    const vw = videoEl.videoWidth || this.screenWidth
    const vh = videoEl.videoHeight || this.screenHeight

    if (typeof scale === 'number') {
      // 等倍 × scale（中心アンカー）
      sprite.scale.set(scale, scale)
    } else {
      // cover-fit: 画面いっぱいに敷く（背景と同じ）
      const s = Math.max(this.screenWidth / vw, this.screenHeight / vh)
      sprite.scale.set(s, s)
    }
    const xRatio = VIDEO_X_RATIO[position] ?? VIDEO_X_RATIO.center
    sprite.x = this.screenWidth * xRatio
    sprite.y = this.screenHeight * 0.5
  }

  private applyMask(sprite: Sprite, fade: BackgroundFade | null): void {
    const maskSprite = buildEdgeFadeMask(fade, this.screenWidth, this.screenHeight)
    if (!maskSprite) return
    this.maskSprite = maskSprite
    this.addChild(maskSprite)
    sprite.mask = maskSprite
  }

  /**
   * 動画レイヤをクリアする。video 停止・要素解放・AudioManager から detach・
   * Sprite/Texture/mask を破棄する。
   */
  remove(): void {
    if (this.videoEl) {
      const el = this.videoEl
      // AudioManager から切り離す
      if (this.audioManager) {
        this.audioManager.detachVideoElement(el)
      }
      try {
        el.pause()
      } catch {
        // ignore
      }
      // src を外して load() でデコーダ/ネットワークリソースを解放する
      el.removeAttribute('src')
      try {
        el.load()
      } catch {
        // ignore
      }
      this.videoEl = null
    }
    if (this.maskSprite) {
      this.maskSprite.removeFromParent()
      // canvas 由来テクスチャは textureCache に乗らないので確実に破棄する
      this.maskSprite.destroy({ texture: true, textureSource: true })
      this.maskSprite = null
    }
    if (this.sprite) {
      this.sprite.mask = null
      this.sprite.removeFromParent()
      // VideoSource 由来のテクスチャも一緒に破棄
      this.sprite.destroy({ texture: true, textureSource: true })
      this.sprite = null
    }
    this.current = null
  }

  /** 現在表示中の動画があるか */
  hasVideo(): boolean {
    return this.current !== null
  }

  /**
   * 録画/export 用に動画を頭出し（currentTime=0）して ready を待つ。
   * 動画が無ければ即解決。seek 完了 or タイムアウトで解決する（ベストエフォート）。
   */
  async prepareForExport(): Promise<void> {
    const el = this.videoEl
    if (!el) return
    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        el.removeEventListener('seeked', done)
        resolve()
      }
      el.addEventListener('seeked', done, { once: true })
      try {
        el.currentTime = 0
      } catch {
        done()
        return
      }
      // 既に 0 で seeked が来ない場合に備えてタイムアウト保険
      setTimeout(done, 500)
    })
    // 録画先頭から鳴る/映るよう play() を呼び直す
    try {
      await el.play()
    } catch (err) {
      console.warn('[name-name] export 用の動画再生開始に失敗', err)
    }
  }

  /**
   * 現在の表示状態を返す（スナップショット用）。なければ null。
   * playhead は現在の再生位置（秒）。
   */
  getState(): VideoState | null {
    if (!this.current) return null
    return {
      path: this.current.path,
      position: this.current.position,
      scale: this.current.scale,
      loop: this.current.loop,
      mute: this.current.mute,
      fade: this.current.fade,
      playhead: this.videoEl ? this.videoEl.currentTime : 0,
    }
  }

  /**
   * 状態から復元する（巻き戻し・ロード）。playhead はベストエフォートで seek する。
   * path は完全 URL を保持しているのでそのまま show() に渡す。
   */
  restore(state: VideoState | null): void {
    if (!state) {
      this.remove()
      return
    }
    this.show(state.path, {
      position: state.position,
      scale: state.scale,
      loop: state.loop,
      mute: state.mute,
      fade: state.fade,
      playhead: state.playhead,
    })
  }
}
