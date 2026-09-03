/**
 * Web Audio API ベースのオーディオマネージャ
 *
 * - BGM: ループ再生、GainNode 経由フェードアウト停止、同一URL再生スキップ
 * - SE: ワンショット再生、複数同時再生可能
 * - AudioBuffer キャッシュで同一ファイルの再 fetch を防止
 * - ユーザーインタラクション制約への対応（ensureContext）
 * - SE 複数候補プールのランダム抽出+シャッフル+ランダム間隔再生（#672、`playSeSequence`）。
 *   再生の合間の gap 待機は `TimeController`（`this.time`）経由で、NovelRenderer の
 *   他の全タイマー（wait/auto/skip/shake/toast/intermission 等）と同じ規律で管理する。
 *   これにより `cancelSeSequence()` でシーン遷移・終劇・状態復元時にキャンセルできる
 *   （#672 フォローアップ、再発防止の経緯は `cancelSeSequence` のdoc comment参照）。
 */
import { randomGapMs } from './seSelection'
import { TimeController, defaultTimeController } from './TimeController'

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

  // NovelRenderer が持つ TimeController をコンストラクタ経由で共有する（既定は
  // defaultTimeController、テスト/未指定時は live モード = window.setTimeout と等価）。
  // playSeSequence の gap 待機だけをこれに通す（#672 フォローアップ、他の音声処理
  // ―ロード・decode・onended 等―は引き続き対象外、TimeController.ts のdoc comment参照）。
  private readonly time: TimeController
  // playSeSequence が現在待機中の gap（次の再生までの間隔）一覧。processDirective が
  // 同一フレームで複数の [SE: 複数候補] を連続処理すると、1つの AudioManager に対して
  // 複数の playSeSequence 呼び出しが並行して in-flight になりうる——単一フィールドで
  // 最新の待機だけを追跡すると、後発の呼び出しが先発の待機を上書きしてしまい
  // cancelSeSequence() が先発分を取りこぼす（配列で全件を追跡することで解消）。
  private pendingSeSequenceGapWaits: { timerId: number; settle: () => void }[] = []
  // playSeSequence の「世代」カウンタ。cancelSeSequence() が呼ばれた時だけ増分する
  // （playSeSequence 自身の開始では増やさない——増やすと「新しい [SE:] が発火しただけ」で
  // 既存の並行シーケンスまで巻き込んで打ち切ってしまう、複数 SE の意図的な重なり再生
  // という #672 の設計と矛盾する事故になるため）。実行中のループは開始時に捕まえた世代と
  // 比較し、ずれていれば以後の再生を打ち切る（generation-based cancellation）。
  private seSequenceGeneration = 0

  constructor(time: TimeController = defaultTimeController) {
    this.time = time
  }

  // マスター音量（Issue #138）。BGM / SE をそれぞれの master gain に集約し、
  // setBgmVolume / setSeVolume で動的に変更できるようにする。
  private bgmMasterGain: GainNode | null = null
  private seMasterGain: GainNode | null = null
  private bgmVolume = 1.0
  private seVolume = 1.0

  // per-line voice (#144)
  private voiceSource: AudioBufferSourceNode | null = null

  // 動画入力レイヤの音声ミックス (#252)。動画レイヤの HTMLVideoElement を
  // createMediaElementSource で WebAudio グラフに取り込み、videoMasterGain 経由で
  // destination + captureDest に流す。これにより export 録画にも自動的に音が乗る。
  private videoMasterGain: GainNode | null = null
  private videoVolume = 1.0
  // createMediaElementSource は 1 要素 1 回のみの WebAudio 制約があるため、
  // element → source の対応を保持して二重 attach をガードする。
  private videoSources: Map<HTMLMediaElement, MediaElementAudioSourceNode> = new Map()

  // 動画エクスポート用キャプチャ先 (#228)。enableCapture で生成し、bgm/seMasterGain
  // をここにも繋いで MediaRecorder に流す。
  private captureDest: MediaStreamAudioDestinationNode | null = null

  // 最後に発生した警告 (DebugOverlay 表示用)。
  // ensureContext 未呼び出し等、進行は止めないが原因可視化したい状況で記録する。
  private lastWarning: string | null = null

  getLastWarning(): string | null {
    return this.lastWarning
  }

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
      // 動画録画中で captureDest 先取りの場合は同時に分岐する (#228)。
      // 通常経路では enableCapture → ensureContext → ensureMasterGains の順で
      // bgmMasterGain は既に存在するため、このブランチは「再 init 後の最初の再生時」用の保険。
      if (this.captureDest) this.bgmMasterGain.connect(this.captureDest)
    }
    if (!this.seMasterGain) {
      this.seMasterGain = this.ctx.createGain()
      this.seMasterGain.gain.value = this.seVolume
      this.seMasterGain.connect(this.ctx.destination)
      if (this.captureDest) this.seMasterGain.connect(this.captureDest)
    }
    if (!this.videoMasterGain) {
      // 動画入力レイヤ音声用 master (#252)。BGM/SE と同じく destination + captureDest に分岐。
      this.videoMasterGain = this.ctx.createGain()
      this.videoMasterGain.gain.value = this.videoVolume
      this.videoMasterGain.connect(this.ctx.destination)
      if (this.captureDest) this.videoMasterGain.connect(this.captureDest)
    }
  }

  /**
   * 動画エクスポート用に MediaStream を取得する (#228)。
   * 既存の bgm/seMasterGain を `MediaStreamAudioDestinationNode` にも分岐して、
   * `MediaRecorder` に渡せる音声ストリームを返す。`destination` への通常配線は維持するため、
   * モニタリングはスピーカーから引き続き聴こえる。
   *
   * 録画終了後は `disableCapture()` でノードを解放する。
   */
  enableCapture(): MediaStream | null {
    this.ensureContext()
    if (!this.ctx) return null
    if (!this.captureDest) {
      this.captureDest = this.ctx.createMediaStreamDestination()
      // 既に作成済みの master gain にも接続
      if (this.bgmMasterGain) this.bgmMasterGain.connect(this.captureDest)
      if (this.seMasterGain) this.seMasterGain.connect(this.captureDest)
      // 動画入力レイヤ音声も録画に乗せる (#252)
      if (this.videoMasterGain) this.videoMasterGain.connect(this.captureDest)
    }
    return this.captureDest.stream
  }

  /** enableCapture で繋いだ録音 destination を切断する (#228) */
  disableCapture(): void {
    if (!this.captureDest) return
    try {
      this.bgmMasterGain?.disconnect(this.captureDest)
    } catch {
      // already disconnected
    }
    try {
      this.seMasterGain?.disconnect(this.captureDest)
    } catch {
      // already disconnected
    }
    try {
      this.videoMasterGain?.disconnect(this.captureDest)
    } catch {
      // already disconnected
    }
    this.captureDest = null
  }

  /**
   * 動画入力レイヤの HTMLVideoElement を WebAudio グラフに取り込む (#252)。
   * createMediaElementSource → videoMasterGain（→ destination + captureDest）に接続する。
   * 同一 element の二重 attach はガードする（createMediaElementSource は 1 要素 1 回のみ）。
   * ミュート再生（mute=true）の動画には呼ばない想定（呼び出し側で判定）。
   */
  attachVideoElement(videoEl: HTMLMediaElement): void {
    this.ensureContext()
    if (!this.ctx) return
    // 既に attach 済みなら何もしない（WebAudio 制約）
    if (this.videoSources.has(videoEl)) return
    this.ensureMasterGains()
    let source: MediaElementAudioSourceNode
    try {
      source = this.ctx.createMediaElementSource(videoEl)
    } catch (err) {
      // 別 AudioContext で既に source 化された等の制約違反。音は出ないが進行は止めない。
      this.lastWarning =
        'audio: 動画音声の WebAudio 取り込みに失敗（要素が既に別経路で使用済みの可能性）'
      console.warn('[name-name] attachVideoElement failed', err)
      return
    }
    if (this.videoMasterGain) {
      source.connect(this.videoMasterGain)
    } else {
      source.connect(this.ctx.destination)
    }
    this.videoSources.set(videoEl, source)
  }

  /**
   * 動画入力レイヤの HTMLVideoElement を WebAudio グラフから切り離す (#252)。
   * MediaElementAudioSourceNode を disconnect する。
   * 注意: createMediaElementSource は 1 要素 1 回のみのため、同じ element を再び
   * attach することはできない。動画レイヤは remove() で element ごと破棄する運用。
   */
  detachVideoElement(videoEl: HTMLMediaElement): void {
    const source = this.videoSources.get(videoEl)
    if (!source) return
    try {
      source.disconnect()
    } catch {
      // already disconnected
    }
    this.videoSources.delete(videoEl)
  }

  /** 動画音声マスター音量を設定する（0..1） (#252) */
  setVideoVolume(volume: number): void {
    const v = Math.max(0, Math.min(1, volume))
    this.videoVolume = v
    if (this.videoMasterGain && this.ctx) {
      this.videoMasterGain.gain.setValueAtTime(v, this.ctx.currentTime)
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
    if (typeof fadeInMs === 'number' && Number.isFinite(fadeInMs) && fadeInMs > 0) {
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
    if (typeof fadeInMs === 'number' && Number.isFinite(fadeInMs) && fadeInMs > 0) {
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
   * 既に選択・シャッフル済みの SE URL 一覧を、ランダム間隔を挟みながら順に再生する (#672)。
   *
   * `[SE: p1,p2,..., 選択数=K, 間隔=min-max]` の実際の再生を担う。選択・シャッフル自体は
   * `seSelection.selectAndShuffleSeFiles` が既に済ませている前提（呼び出し元 = NovelRenderer）
   * ——ここは「渡された順に、合間だけランダムに空けて鳴らす」ことだけに責務を絞る
   * （doctrine 規律4「単一責務」）。
   *
   * 各ファイルは `playSe` と同じ fire-and-forget（再生完了を待たない）で発火するため、
   * gap がクリップの長さより短ければ複数の SE が重なって鳴る（衣擦れ等の自然な重なりを
   * 狙った意図的な挙動）。1件のみ（K=1）の場合は間隔を挟む相手がいないため即時再生する。
   *
   * gap 待機は `this.time.setTimeout`（生の `setTimeout` ではない）に通し、待機中の
   * タイマーを `this.pendingSeSequenceGapWaits` に登録する。これにより `cancelSeSequence()`
   * から NovelRenderer の他タイマーと同じ規律でキャンセルできる（#672 フォローアップ）。
   * 開始時に世代カウンタのスナップショットを取り、gap 待機から戻るたびに現在値と比較する
   * ——`cancelSeSequence()` が世代を進めていれば、それ以降の URL は再生せず打ち切る。
   *
   * @param urls 再生する SE の URL 一覧（選択・シャッフル済み）
   * @param gapMinMs ランダム間隔レンジ下限 ms
   * @param gapMaxMs ランダム間隔レンジ上限 ms
   * @param fadeInMs 各再生に適用する fade-in 時間 ms (#145)。未指定なら即時フル音量。
   */
  async playSeSequence(
    urls: readonly string[],
    gapMinMs: number,
    gapMaxMs: number,
    fadeInMs?: number
  ): Promise<void> {
    // 開始時点の世代を捕まえるだけで、ここでは増分しない（生成のたびに増分すると、
    // 同一フレームで連続発火した別の [SE:] がこの世代を捕まえてしまい、cancelSeSequence()
    // 抜きでも先発シーケンスの残りが打ち切られてしまう——フィールド doc comment参照）。
    const generation = this.seSequenceGeneration
    for (let i = 0; i < urls.length; i++) {
      if (generation !== this.seSequenceGeneration) return
      // 再生完了を待たない（fire-and-forget、playSe 単体呼び出しと同じ意味論）。
      void this.playSe(urls[i], fadeInMs)
      if (i + 1 < urls.length) {
        const gap = randomGapMs(gapMinMs, gapMaxMs)
        await new Promise<void>((resolve) => {
          const wait: { timerId: number; settle: () => void } = {
            timerId: 0,
            settle: () => {
              this.pendingSeSequenceGapWaits = this.pendingSeSequenceGapWaits.filter(
                (w) => w !== wait
              )
              resolve()
            },
          }
          wait.timerId = this.time.setTimeout(wait.settle, gap)
          this.pendingSeSequenceGapWaits.push(wait)
        })
        if (generation !== this.seSequenceGeneration) return
      }
    }
  }

  /**
   * 再生中の SE シーケンス（`playSeSequence`）が待機中の gap タイマーを全てキャンセルする (#672)。
   *
   * `NovelRenderer` の他の全タイマー（wait/auto/skip/shake/toast/intermission 等）は
   * `this.time.clearTimeout` で一元管理され、シーン遷移・終劇（`endStory`）・状態復元
   * （`applyState`、goBack/seekTo/セーブロード）・dispose 時にキャンセルされる。
   * `playSeSequence` 導入時（#672 実装）はこの規律から漏れており、シーケンス再生中に
   * シーン遷移が起きても後続の再生がキャンセルされずバックグラウンドで鳴り続ける
   * ギャップがあった（テスト設計フェーズで発見、本メソッドで是正）。
   *
   * 世代カウンタ（`seSequenceGeneration`）を進め、実行中の全 `playSeSequence` ループに
   * 「もう古い呼び出しである」ことを伝える。待機中の gap タイマーはそれぞれ
   * `this.time.clearTimeout` した上で `settle()` を呼び、`await` で止まっていたループを
   * 即座に再開させる（clearTimeout だけだと settle 相当の resolve が呼ばれず、
   * async 関数が Promise pending のまま宙に浮いた状態で止まり続けてしまうため。
   * 再開後は世代の不一致チェックに引っかかって残りの url を再生せず return する）。
   *
   * 既に発火済みの単発 SE（`playSe`）自体は元々 fire-and-forget で止める手段が無い
   * （既存仕様どおり、ここでは変更しない）。止めるのは「次の再生を待っている gap」だけ。
   */
  cancelSeSequence(): void {
    this.seSequenceGeneration++
    const waits = this.pendingSeSequenceGapWaits
    this.pendingSeSequenceGapWaits = []
    for (const wait of waits) {
      this.time.clearTimeout(wait.timerId)
      wait.settle()
    }
  }

  /**
   * ボイス（per-line voice）をワンショット再生する (#144)。
   * 再生終了時に onEnded を呼ぶ。オートモードの voice 終了待ちに使用。
   * 複数呼び出し時は前のボイスを停止して新しいものを再生する。
   */
  async playVoice(url: string, onEnded?: () => void): Promise<void> {
    // 前のボイスを停止
    this.stopVoice()

    if (!this.ctx) {
      // autoMode で「画面に触れず」進行している動画モード等、ensureContext が一度も呼ばれない
      // ケースで voice 付き Dialog に到達すると、ここで return すると onEnded が呼ばれず
      // scheduleAutoAdvance がブロックされて永遠 wait になる (#issue-pending)。
      // 音は出せないが、進行は止めない。原因は lastWarning として DebugOverlay に出す。
      this.lastWarning =
        'audio: AudioContext 未初期化 (画面を 1 回タップ or キー入力で起動)。voice/SE/BGM は鳴らないが進行は継続'
      console.warn('[name-name] playVoice: AudioContext not ready, advancing without playback', url)
      onEnded?.()
      return
    }
    this.lastWarning = null
    const buffer = await this.loadAudio(url)
    if (!buffer || !this.ctx) {
      onEnded?.()
      return
    }

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
   * 選択肢クリック時の確定音 (#146)。
   * Web Audio の OscillatorNode を直接合成するためファイル不要。
   * SE 系統 (seMasterGain) に乗せるため、SE 音量設定と同期する。
   */
  playSelectTone(): void {
    if (!this.ctx) return
    this.ensureMasterGains()
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    const now = this.ctx.currentTime
    gain.gain.setValueAtTime(0.15, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12)
    osc.connect(gain)
    if (this.seMasterGain) {
      gain.connect(this.seMasterGain)
    } else {
      gain.connect(this.ctx.destination)
    }
    osc.start()
    osc.stop(now + 0.15)
  }

  /**
   * 選択肢ホバー時の控えめな確認音 (#146)。
   * 確定音 (880Hz) との聴覚差を確保するため周波数を 600Hz に下げる (R1 N4)。
   */
  playHoverTone(): void {
    if (!this.ctx) return
    this.ensureMasterGains()
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 600
    const now = this.ctx.currentTime
    gain.gain.setValueAtTime(0.05, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06)
    osc.connect(gain)
    if (this.seMasterGain) {
      gain.connect(this.seMasterGain)
    } else {
      gain.connect(this.ctx.destination)
    }
    osc.start()
    osc.stop(now + 0.08)
  }

  /**
   * 全停止・リソース解放
   */
  destroy(): void {
    this.cancelSeSequence()
    this.stopBgmImmediate()
    this.stopVoice()
    this.audioCache.clear()
    this.disableCapture()
    // 動画音声 source を全切断 (#252)
    for (const source of this.videoSources.values()) {
      try {
        source.disconnect()
      } catch {
        // already disconnected
      }
    }
    this.videoSources.clear()
    if (this.videoMasterGain) {
      this.videoMasterGain.disconnect()
      this.videoMasterGain = null
    }
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
