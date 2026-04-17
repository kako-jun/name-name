import type { Event } from '../types'

interface EventDisplayProps {
  event: Event
  isDark: boolean
}

/**
 * Event の variant ごとに読み取り専用の表示を返す。
 * EventCard 内の編集 UI と同じカードに差し替える形で使われる。
 */
function EventDisplay({ event, isDark }: EventDisplayProps) {
  if (typeof event === 'string') {
    // SceneTransition
    return (
      <div className={`text-sm italic ml-2 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
        [場面転換]
      </div>
    )
  }

  if ('Dialog' in event) {
    const d = event.Dialog
    return (
      <div className="space-y-1">
        <div className={`text-sm font-semibold ml-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
          {d.character || '（キャラクター名）'}
        </div>
        <div
          className={`text-sm ml-2 font-mono whitespace-pre-wrap ${isDark ? 'text-gray-400' : 'text-gray-600'}`}
        >
          {d.text.join('\n') || '（テキスト）'}
        </div>
        {d.expression && (
          <div className={`text-xs italic ml-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
            {d.expression}
          </div>
        )}
      </div>
    )
  }

  if ('Narration' in event) {
    return (
      <div
        className={`text-sm ml-2 font-mono whitespace-pre-wrap ${isDark ? 'text-gray-400' : 'text-gray-600'}`}
      >
        {event.Narration.text.join('\n') || '（ナレーション）'}
      </div>
    )
  }

  if ('Background' in event) {
    return (
      <div className={`text-xs italic ml-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
        背景: {event.Background.path}
      </div>
    )
  }

  if ('Bgm' in event) {
    return (
      <div className={`text-xs italic ml-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
        BGM {event.Bgm.action === 'Play' ? '再生' : '停止'}: {event.Bgm.path ?? '(なし)'}
      </div>
    )
  }

  if ('Se' in event) {
    return (
      <div className={`text-xs italic ml-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
        SE: {event.Se.path}
      </div>
    )
  }

  if ('Blackout' in event) {
    return (
      <div className={`text-xs italic ml-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
        暗転{event.Blackout.action === 'On' ? '' : '解除'}
      </div>
    )
  }

  if ('Exit' in event) {
    return (
      <div className={`text-xs italic ml-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
        退場: {event.Exit.character}
      </div>
    )
  }

  if ('Wait' in event) {
    return (
      <div className={`text-xs italic ml-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
        待機: {event.Wait.ms}ms
      </div>
    )
  }

  if ('ExpressionChange' in event) {
    return (
      <div className={`text-xs italic ml-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
        表情変更: {event.ExpressionChange.character} → {event.ExpressionChange.expression}
      </div>
    )
  }

  if ('Choice' in event) {
    return (
      <div className={`text-xs italic ml-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
        選択肢: {event.Choice.options.map((o) => o.text).join(' / ')}
      </div>
    )
  }

  if ('Flag' in event) {
    const v = event.Flag.value
    let valueStr = ''
    if ('Bool' in v) valueStr = String(v.Bool)
    else if ('String' in v) valueStr = v.String
    else if ('Number' in v) valueStr = String(v.Number)
    return (
      <div className={`text-xs italic ml-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
        フラグ: {event.Flag.name} = {valueStr}
      </div>
    )
  }

  if ('Condition' in event) {
    return (
      <div className={`text-xs italic ml-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
        条件分岐: {event.Condition.flag}（{event.Condition.events.length} イベント）
      </div>
    )
  }

  return null
}

export default EventDisplay
