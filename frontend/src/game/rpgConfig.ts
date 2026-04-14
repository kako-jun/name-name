import Phaser from 'phaser'
import { RPGScene } from './RPGScene'

export const RPG_PARENT_ID = 'rpg-game'

export const rpgGameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  parent: RPG_PARENT_ID,
  backgroundColor: '#1a4d1a',
  scene: [RPGScene],
}
