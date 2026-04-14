import { useEffect, useRef } from 'react'
import Phaser from 'phaser'
import { RPGScene } from '../game/RPGScene'
import { RPG_PARENT_ID, rpgGameConfig } from '../game/rpgConfig'
import { RPGProject } from '../types/rpg'

interface RPGPlayerProps {
  gameData?: RPGProject
}

function RPGPlayer({ gameData }: RPGPlayerProps) {
  const gameRef = useRef<Phaser.Game | null>(null)

  useEffect(() => {
    if (!gameData) return

    // gameData を scene に直接渡して起動する（ready後のrestartは不要）
    const config = {
      ...rpgGameConfig,
      scene: [
        {
          scene: RPGScene,
          key: 'RPGScene',
        },
      ],
    }

    gameRef.current = new Phaser.Game(config)

    gameRef.current.events.once('ready', () => {
      gameRef.current?.scene.start('RPGScene', { gameData })
    })

    return () => {
      if (gameRef.current) {
        gameRef.current.destroy(true)
        gameRef.current = null
      }
    }
  }, [gameData])

  if (!gameData) {
    return (
      <div className="flex items-center justify-center w-full h-full">
        <p className="text-gray-500">ゲームデータを読み込み中...</p>
      </div>
    )
  }

  return (
    <div className="w-full h-full flex items-center justify-center">
      <div id={RPG_PARENT_ID} />
    </div>
  )
}

export default RPGPlayer
