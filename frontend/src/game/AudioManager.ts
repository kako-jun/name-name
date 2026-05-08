/**
 * Web Audio API ベースのオーディオマネージャ
 *
 * - BGM: ループ再生、GainNode 経由フェードアウト停止、同一URL再生スキップ
 * - SE: ワンショット再生、複数同時再生可能
 * - AudioBuffer キャッシュで同一ファイルの再 fetch を防止
 * - ユーザーインタラクション制約への対応（ensureContext）
 */

export class AudioManager {
  private ctx: AudioContext | null = null
  private bgmSource: AudioBufferSourceNode | null = null
  private bgmGain: GainNode | null = null
  private currentBgmUrl: string | null = null
  private audioCache: Map<string, AudioBuffer> = new Map()
  private bgmRequestId = 0
  private fadingNodes: {
    source: AudioBufferSourceNode
    gain: GainNode
    timer: ReturnType<typeof setTimeout>
  }[] = []

  // マスター音量（Issue #138）。BGM / SE をそれぞれの master gain に集約し、
  // setBgmVolume / setSeVolume で動的に変更できるようにする。
  private bgmMasterGain: GainNode | null = null
  private seMasterGain: GainNode | null = null
  private bgmVolume = 1.0
  private seVolume = 1.0

  // per-line voice (#144)
  private voiceSource: AudioBufferSourceNode | null = null

  /**
   * AudioContext を生成/再開する。
   * ユーザーインタラクション（クリック等）のタイミングで呼ぶこと。
   */
  ensureContext(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext()
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume()
    }
    this.ensureMasterGains()
  }

  /** master gain が未生成なら作って destination に繋ぐ */
  private ensureMasterGains(): void {
    if (!this.ctx) return
    if (!this.bgmMasterGain) {
      this.bgmMasterGain = this.ctx.createGain()
      this.bgmMasterGain.gain.value = this.bgmVolume
      this.bgmMasterGain.connect(this.ctx.destination)
    }
    if (!this.seMasterGain) {
      this.seMasterGain = this.ctx.createGain()
      this.seMasterGain.gain.value = this.seVolume
      this.seMasterGain.connect(this.ctx.destination)
    }
  }

  /** BGM マスター音量を設定する（0..1） */
  setBgmVolume(volume: number): void {
    const v = Math.max(0, Math.min(1, volume))
    this.bgmVolume = v
    if (this.bgmMasterGain && this.ctx) {
      this.bgmMasterGain.gain.setValueAtTime(v, this.ctx.currentTime)
    }
  }

  /** SE マスター音量を設定する（0..1） */
  setSeVolume(volume: number): void {
    const v = Math.max(0, Math.min(1, volume))
    this.seVolume = v
    if (this.seMasterGain && this.ctx) {
      this.seMasterGain.gain.setValueAtTime(v, this.ctx.currentTime)
    }
  }

  /**
   * BGM をループ再生する。同じ URL なら何もしない。
   * 別の BGM が再生中なら即座に停止して切り替える。
   *
   * @param url 再生する BGM の URL
   * @param fadeInMs fade-in 時間 ms (#145)。未指定なら即時フル音量。
   *   gain を 0 から 1 まで線形に上げる。
   */
  async playBgm(url: string, fadeInMs?: number): Promise<void> {
    if (!this.ctx) return
    if (this.currentBgmUrl === url) return

    // 現在の BGM を即停止（フェードなし）
    this.stopBgmImmediate()

    const requestId = ++this.bgmRequestId
    const buffer = await this.loadAudio(url)
    if (!buffer || requestId !== this.bgmRequestId) return
    if (!this.ctx) return

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.loop = true

    const gain = this.ctx.createGain()
    const now = this.ctx.currentTime
    if (fadeInMs && fadeInMs > 0) {
      gain.gain.setValueAtTime(0, now)
      gain.gain.linearRampToValueAtTime(1.0, now + fadeInMs / 1000)
    } else {
      gain.gain.value = 1.0
    }
    source.connect(gain)
    this.ensureMasterGains()
    if (this.bgmMasterGain) {
      gain.connect(this.bgmMasterGain)
    } else {
      gain.connect(this.ctx.destination)
    }

    source.start(0)

    this.bgmSource = source
    this.bgmGain = gain
    this.currentBgmUrl = url
  }

  /**
   * BGM をフェードアウトして停止する。
   */
  stopBgm(fadeMs: number = 1000): void {
    if (!this.ctx || !this.bgmSource || !this.bgmGain) {
      this.currentBgmUrl = null
      return
    }

    const gain = this.bgmGain
    const source = this.bgmSource
    const now = this.ctx.currentTime

    gain.gain.cancelScheduledValues(now)
    gain.gain.setValueAtTime(gain.gain.value, now)
    gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000)

    // フェード完了後にノードを停止（参照を保持して新規再生時にキャンセル可能に）
    const timer = setTimeout(() => {
      try {
        source.stop()
      } catch {
        // already stopped
      }
      source.disconnect()
      gain.disconnect()
      this.fadingNodes = this.fadingNodes.filter((n) => n.source !== source)
    }, fadeMs + 50)

    this.fadingNodes.push({ source, gain, timer })

    this.bgmSource = null
    this.bgmGain = null
    this.currentBgmUrl = null
  }

  /**
   * SE をワンショット再生する。複数同時再生可能。
   *
   * @param url 再生する SE の URL
   * @param fadeInMs fade-in 時間 ms (#145)。未指定なら即時フル音量で再生。
   *   指定時は GainNode を挟んで 0 → 1 に線形補間する。
   */
  async playSe(url: string, fadeInMs?: number): Promise<void> {
    if (!this.ctx) return

    const buffer = await this.loadAudio(url)
    if (!buffer || !this.ctx) return

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    this.ensureMasterGains()
    if (fadeInMs && fadeInMs > 0) {
      const gain = this.ctx.createGain()
      const now = this.ctx.currentTime
      gain.gain.setValueAtTime(0, now)
      gain.gain.linearRampToValueAtTime(1.0, now + fadeInMs / 1000)
      source.connect(gain)
      if (this.seMasterGain) {
        gain.connect(this.seMasterGain)
      } else {
        gain.connect(this.ctx.destination)
      }
      source.onended = () => {
        source.disconnect()
        gain.disconnect()
      }
    } else {
      if (this.seMasterGain) {
        source.connect(this.seMasterGain)
      } else {
        source.connect(this.ctx.destination)
      }
      source.onended = () => source.disconnect()
    }
    source.start(0)
  }

  /**
   * ボイス（per-line voice）をワンショット再生する (#144)。
   * 再生終了時に onEnded を呼ぶ。オートモードの voice 終了待ちに使用。
   * 複数呼び出し時は前のボイスを停止して新しいものを再生する。
   */
  async playVoice(url: string, onEnded?: () => void): Promise<void> {
    // 前のボイスを停止
    this.stopVoice()

    if (!this.ctx) return
    const buffer = await this.loadAudio(url)
    if (!buffer || !this.ctx) return

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    this.ensureMasterGains()
    // TODO (#144 follow-up): voice 専用 masterGain を追加して SE と独立して音量制御できるようにする。
    // 現状は seMasterGain に繋いでいるため、SE 音量を下げるとボイスも小さくなる。
    if (this.seMasterGain) {
      source.connect(this.seMasterGain)
    } else {
      source.connect(this.ctx.destination)
    }
    source.onended = () => {
      source.disconnect()
      if (this.voiceSource === source) {
        this.voiceSource = null
      }
      onEnded?.()
    }
    this.voiceSource = source
    source.start(0)
  }

  /**
   * 再生中のボイスを停止する。onEnded は呼ばれない。
   */
  stopVoice(): void {
    if (this.voiceSource) {
      const s = this.voiceSource
      // 先に null にして onended ハンドラ内のガードを有効化し、
      // さらに onended を解除して stop() 後の非同期発火を完全に防ぐ
      this.voiceSource = null
      s.onended = null
      try {
        s.stop()
      } catch {
        // already stopped
      }
      s.disconnect()
    }
  }

  /**
   * 全停止・リソース解放
   */
  destroy(): void {
    this.stopBgmImmediate()
    this.stopVoice()
    this.audioCache.clear()
    if (this.bgmMasterGain) {
      this.bgmMasterGain.disconnect()
      this.bgmMasterGain = null
    }
    if (this.seMasterGain) {
      this.seMasterGain.disconnect()
      this.seMasterGain = null
    }
    if (this.ctx) {
      this.ctx.close()
      this.ctx = null
    }
  }

  // --- private ---

  /**
   * BGM を即座に停止する（フェードなし）
   */
  private stopBgmImmediate(): void {
    // フェード中のノードも即停止
    for (const node of this.fadingNodes) {
      clearTimeout(node.timer)
      try {
        node.source.stop()
      } catch {
        // already stopped
      }
      node.source.disconnect()
      node.gain.disconnect()
    }
    this.fadingNodes = []

    if (this.bgmSource) {
      try {
        this.bgmSource.stop()
      } catch {
        // already stopped
      }
      this.bgmSource.disconnect()
      this.bgmSource = null
    }
    if (this.bgmGain) {
      this.bgmGain.disconnect()
      this.bgmGain = null
    }
    this.currentBgmUrl = null
  }

  /**
   * URL から AudioBuffer をロードする（キャッシュ付き）
   */
  private async loadAudio(url: string): Promise<AudioBuffer | null> {
    const cached = this.audioCache.get(url)
    if (cached) return cached

    try {
      const response = await fetch(url)
      if (!response.ok) {
        console.warn(`[name-name] 音声ファイルの読み込みに失敗: ${url} (${response.status})`)
        return null
      }
      const arrayBuffer = await response.arrayBuffer()
      if (!this.ctx) return null
      const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer)
      this.audioCache.set(url, audioBuffer)
      return audioBuffer
    } catch (error) {
      console.warn(`[name-name] 音声ファイルのデコードに失敗: ${url}`, error)
      return null
    }
  }
}
