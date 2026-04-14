import { useEffect, useRef } from 'react'
import Phaser from 'phaser'
import { rpgGameConfig } from '../game/rpgConfig'
import { RPGProject } from '../types/rpg'

interface RPGPlayerProps {
  gameData?: RPGProject
}

function RPGPlayer({ gameData }: RPGPlayerProps) {
  const gameRef = useRef<Phaser.Game | null>(null)

  useEffect(() => {
    if (!gameRef.current && gameData) {
      gameRef.current = new Phaser.Game(rpgGameConfig)

      // ゲーム起動後にシーンを開始（データを渡す）
      gameRef.current.events.once('ready', () => {
        const rpgScene = gameRef.current?.scene.getScene('RPGScene')
        if (rpgScene) {
          rpgScene.scene.restart({ gameData })
        }
      })
    }

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
      <div id="rpg-game" />
    </div>
  )
}

export default RPGPlayer
