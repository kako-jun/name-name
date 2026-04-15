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
  private fadingNodes: { source: AudioBufferSourceNode; gain: GainNode; timer: ReturnType<typeof setTimeout> }[] = []

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
  }

  /**
   * BGM をループ再生する。同じ URL なら何もしない。
   * 別の BGM が再生中なら即座に停止して切り替える。
   */
  async playBgm(url: string): Promise<void> {
    if (!this.ctx) return
    if (this.currentBgmUrl === url) return

    // 現在の BGM を即停止（フェードなし）
    this.stopBgmImmediate()

    const requestId = ++this.bgmRequestId
    const buffer = await this.loadAudio(url)
    if (!buffer || requestId !== this.bgmRequestId) return

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.loop = true

    const gain = this.ctx.createGain()
    gain.gain.value = 1.0
    source.connect(gain)
    gain.connect(this.ctx.destination)

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
   */
  async playSe(url: string): Promise<void> {
    if (!this.ctx) return

    const buffer = await this.loadAudio(url)
    if (!buffer || !this.ctx) return

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.ctx.destination)
    source.onended = () => source.disconnect()
    source.start(0)
  }

  /**
   * 全停止・リソース解放
   */
  destroy(): void {
    this.stopBgmImmediate()
    this.audioCache.clear()
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
