import * as Phaser from "phaser";
import { enable3d, Scene3D, Canvas } from "@enable3d/phaser-extension";
import scenes from "../scenes";

class Game {
  constructor() {}

  start(onStarted: any) {
    const config: Phaser.Types.Core.GameConfig = {
      // type: Phaser.AUTO, // webGLを使うかcanvasを使うかをphaserが自動で判断してくれる
      type: Phaser.WEBGL,
      transparent: true,
      width: 800,
      height: 1280,
      // resolution: window.devicePixelRatio, // Retina環境で多少見た目がよくなる
      parent: "the-game", // #game-app内にcanvasを生成
      scale: {
        mode: Phaser.Scale.ScaleModes.FIT,
        // autoCenter: Phaser.Scale.Center.CENTER_HORIZONTALLY,
        // zoom: Phaser.Scale.Zoom.MAX_ZOOM,
      },
      preserveDrawingBuffer: true,
      // backgroundColor: "#111111",
      scene: scenes,
      ...Canvas(),
    };

    enable3d(() => {
      const game = new Phaser.Game(config);
      onStarted();
    }).withPhysics("../assets/ammo");
  }
}

export default Game;
