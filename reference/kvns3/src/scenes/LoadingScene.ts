import { enable3d, Scene3D, Canvas } from "@enable3d/phaser-extension";

class LoadingScene extends Scene3D {
  constructor() {
    super({ key: "loading" });
  }

  init() {}

  preload() {}

  create() {
    const { width, height } = this.game.canvas;

    this.add.text(width / 2, height / 2 + 60, "Loading...").setOrigin(0.5);

    this.load.image("street", "../assets/street.png");
    this.load.image("robot", "../assets/robot.png");

    this.load.on("complete", () => {
      this.scene.start("title");
    });

    this.load.start();
  }

  update() {}
}

export default LoadingScene;
