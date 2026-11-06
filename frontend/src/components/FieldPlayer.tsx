import { useEffect, useRef, useState } from 'react'
import { loadFieldConfig, type FieldEntry, type FieldSourceDoc } from '../field/fieldConfigFromDocs'
import { savedFormsFromResume, withResumeSlot } from '../field/fieldResume'
import { parseDebugTiltOff } from '../field/fieldPlayDeps'
import { startFieldGame } from '../field/startFieldGame'
import { SaveManager } from '../game/SaveManager'
import './FieldPlayer.css'

/**
 * 「一枚絵フィールド作品」の描画先 (#1135, 親 #1096 S4c)。`/play/<名前>` でエントリ md の最初の再生イベントが
 * `[フィールド: …]` のときに PlayerScreen が選ぶ(判定は `fieldEntryOfDoc`)。
 *
 * 設定は md 群から `loadFieldConfig` で組み、`startFieldGame` を起動する。メニューの「ロード」は
 * 前回の `startFieldGame` を dispose して `?resume=<slot>` と同じ復元経路で作り直す。呼び出し元の記憶・戻り先は持たない
 * (`[フィールド終了]` の実行側・ノベルへの出口・往復は #1070)。
 */
export interface FieldPlayerProps {
  /** `fieldEntryOfDoc` の結果 */
  entry: FieldEntry
  entryPath: string
  /** セーブの名前空間(= projectName) */
  docKey: string
  /** `${apiBaseUrl}/api/projects/${projectName}/assets/raw` */
  assetBaseUrl: string
  /** hidden を含む全 md */
  loadAllDocs(): Promise<FieldSourceDoc[]>
  /** 場面 ID を含む md を探してロードする。見つからなければ null */
  resolveScene(sceneId: string): Promise<FieldSourceDoc[] | null>
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
  return res.json()
}

function FieldPlayer({
  entry,
  entryPath,
  docKey,
  assetBaseUrl,
  loadAllDocs,
  resolveScene,
}: FieldPlayerProps) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  // 関数 props は最新を ref 越しに呼ぶ(PlayerScreen の再描画で effect を作り直さない)
  const depsRef = useRef({ loadAllDocs, resolveScene })
  depsRef.current = { loadAllDocs, resolveScene }
  const [error, setError] = useState<string | null>(null)
  // 設定の読み込み〜起動(ロードでの作り直しを含む)が終わるまで案内を出す
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let disposed = false
    let generation = 0
    let stop: (() => void) | null = null
    const debugTiltOff = parseDebugTiltOff(window.location.search)

    const run = async (search: string): Promise<void> => {
      const gen = ++generation
      // 作り直しの前に必ず前回を止める
      stop?.()
      stop = null
      setError(null)
      setLoading(true)
      try {
        const result = await loadFieldConfig(
          {
            entryPath,
            entry,
            assetBaseUrl,
            baseUrl: window.location.href,
            savedForms: savedFormsFromResume(search, new SaveManager(docKey)),
          },
          {
            loadAllDocs: () => depsRef.current.loadAllDocs(),
            resolveScene: (id) => depsRef.current.resolveScene(id),
            fetchJson,
          }
        )
        if (disposed || gen !== generation) return
        if (!result.ok) {
          console.error(`[field] ${result.error}`)
          for (const w of result.warnings) console.warn(`[field] ${w}`)
          setError(result.error)
          setLoading(false)
          return
        }
        for (const w of result.warnings) console.warn(`[field] ${w}`)
        const config = { ...result.value.config }
        if (debugTiltOff) delete config.tiltShift
        const dispose = await startFieldGame({
          config,
          mount: stage,
          docKey,
          search,
          containHost: stage,
          scriptEvents: result.value.npcEvents,
          onLoadRequest: (slot) => {
            // 古い世代(作り直し済み・破棄済み)の要求は無視する
            if (disposed || gen !== generation) return
            void run(withResumeSlot('', slot))
          },
        })
        if (disposed || gen !== generation) {
          // 起動が終わる前にアンマウント・作り直しされた: 立ち上がったものを即座に止める
          dispose()
          return
        }
        stop = dispose
        setLoading(false)
      } catch (e) {
        if (disposed || gen !== generation) return
        console.error('[field] 起動に失敗しました', e)
        setError(`起動に失敗しました\n${errText(e)}`)
        setLoading(false)
      }
    }

    void run(window.location.search)
    return () => {
      disposed = true
      generation++
      stop?.()
      stop = null
    }
  }, [entry, entryPath, docKey, assetBaseUrl])

  return (
    <div className="field-play">
      <div ref={stageRef} className="field-play-stage" />
      {loading && (
        <p role="status" className="field-play-loading">
          読み込み中...
        </p>
      )}
      {error !== null && (
        <p role="alert" className="field-play-error">
          {error}
        </p>
      )}
    </div>
  )
}

export default FieldPlayer
