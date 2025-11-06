import { useEffect, useRef } from 'react'
import Phaser from 'phaser'
import { ScriptRow } from '../types'
import { NovelGameScene } from '../game/NovelGameScene'

interface NovelPlayerProps {
  scriptData: ScriptRow[]
  startIndex?: number
}

function NovelPlayer({ scriptData, startIndex = 0 }: NovelPlayerProps) {
  const gameRef = useRef<Phaser.Game | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      parent: containerRef.current,
      width: 800,
      height: 600,
      backgroundColor: '#667eea',
      scene: NovelGameScene,
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    }

    gameRef.current = new Phaser.Game(config)

    // シーンにデータを渡す
    gameRef.current.scene.start('NovelGameScene', { scriptData, startIndex })

    return () => {
      gameRef.current?.destroy(true)
      gameRef.current = null
    }
  }, [scriptData, startIndex])

  return (
    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900">
      <div
        ref={containerRef}
        className="rounded-xl shadow-2xl overflow-hidden"
        style={{ maxWidth: '100%', maxHeight: '100%' }}
      />
    </div>
  )
}

export default NovelPlayer
