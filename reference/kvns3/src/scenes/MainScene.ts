import * as Phaser from "phaser";
import { enable3d, Scene3D, Canvas, THREE } from "@enable3d/phaser-extension";

import { DialogBox, DialogBoxConfig } from "../game_objects/DialogBox";
import { TimelinePlayer } from "../models/TimelinePlayer";
import { Timeline } from "../types/Timeline";
import { timelineData } from "../data/timeline";
import Third from "@enable3d/phaser-extension/dist/third";
import { AnimationClip, KeyframeTrack } from "three";

class MainScene extends Scene3D {
  private timeline?: Timeline;

  constructor() {
    super({ key: "main" });
  }

  init(data: any) {
    this.accessThirdDimension();

    const timelineID = data.timelineID || "start";

    if (!(timelineID in timelineData)) {
      console.error(`[ERROR] タイムラインID[${timelineID}]は登録されていません`);
      // 登録されていないタイムラインIDが指定されていたらタイトルシーンに遷移する
      this.scene.start("title");
      return;
    }

    this.timeline = timelineData[timelineID];
  }

  preload() {
    this.load.audio("bgm", "../assets/bgm/13_kumorizora.ogg");
    this.load.audio("se", "../assets/se/battle fx  1.ogg");
    this.load.image("face1", "../assets/kako_face.gif");
    this.third.load.preload("bg", "../assets/BG_1_4.png");
    this.third.load.preload("stand", "../assets/kako_angry.png");
  }

  async create() {
    if (!this.timeline) {
      return;
    }

    const { width, height } = this.game.canvas;

    // this.third.warpSpeed();
    // this.third.warpSpeed("sky", "ground", "light", "orbitControls");
    this.third.warpSpeed("light", "orbitControls");
    this.third.scene.background = new THREE.Color(0x000000);

    this.third.camera.position.set(0, 0, 20);
    this.third.camera.lookAt(0, 0, 0);

    const kft = new KeyframeTrack(".position", [0, 1], [10, 20], THREE.InterpolateSmooth);
    const ac = new AnimationClip("scroll", 1, [kft]);
    this.third.camera.animations.push(ac);
    // this.third.camera..
    // this.third.camera.rotateZ(45);
    // this.third.physics.add.box();

    // this.third.add.box({ x: 1, y: 2 });

    const bg = await this.third.load.texture("bg");
    const stand = await this.third.load.texture("stand");

    // this.third.physics.add.ground({ width: 20, height: 20, y: 0 }, { phong: { map: robot, transparent: true } });
    // this.third.add.plane({ x: 3, y: 2 }, { phong: { map: stand, transparent: true } });
    const bgPlane = this.third.make.plane(
      { x: 0, y: 10, z: -50, width: 130, height: 98 },
      { phong: { map: bg, transparent: true } }
    );
    this.third.add.existing(bgPlane);

    const standPlane = this.third.make.plane(
      { x: 0, y: 0, width: 12, height: 19 },
      { phong: { map: stand, transparent: true } }
    );
    this.third.add.existing(standPlane);

    const timer = this.time.addEvent({ delay: 10, loop: true });
    let t = 0;
    timer.callback = () => {
      if (t >= 0 && t < 10) {
      } else if (t < 50) {
        // this.third.camera.rotateZ(0.001);
        // this.third.camera.translateZ(-0.001);
        standPlane.translateZ(0.001);
        standPlane.rotateZ(-0.00001);
        this.third.camera.translateX(0.0001);
      } else if (t < 950) {
        // this.third.camera.rotateZ(0.01);
        // this.third.camera.translateZ(-0.01);
        standPlane.translateZ(0.01);
        standPlane.rotateZ(-0.0001);
        this.third.camera.translateX(0.001);
      } else if (t < 990) {
        // this.third.camera.rotateZ(0.001);
        // this.third.camera.translateZ(-0.001);
        standPlane.translateZ(0.001);
        standPlane.rotateZ(-0.00001);
        this.third.camera.translateX(0.0001);
      } else if (t < 1000) {
      } else if (t < 1010) {
      } else if (t < 1050) {
        // this.third.camera.rotateZ(-0.001);
        // this.third.camera.translateZ(0.001);
        standPlane.translateZ(-0.001);
        standPlane.rotateZ(0.00001);
        this.third.camera.translateX(-0.0001);
      } else if (t < 1950) {
        // this.third.camera.rotateZ(-0.01);
        // this.third.camera.translateZ(0.01);
        standPlane.translateZ(-0.01);
        standPlane.rotateZ(0.0001);
        this.third.camera.translateX(-0.001);
      } else if (t < 1990) {
        // this.third.camera.rotateZ(-0.001);
        // this.third.camera.translateZ(0.001);
        standPlane.translateZ(-0.001);
        standPlane.rotateZ(0.00001);
        this.third.camera.translateX(-0.0001);
      } else {
      }

      const rad = ((Math.PI * 2) / 2000) * t;
      const x = Math.sin(rad) * 4;
      let y = Math.cos(rad) * 4;
      if (y < 0) {
        y /= 3;
      }
      const z = Math.sin(rad) * 10;

      //   this.third.camera.lookAt(0, 0, 0);
      //   this.third.camera.lookAt(x, y, z);
      this.third.camera.lookAt(x, y, 0);
      console.log("t", t);
      console.log("x", x);
      console.log("y", y);

      t++;
      // 20秒で1ループ
      if (t >= 2000) {
        t = 0;
      }
    };
    // this.third.physics.add.box({ x: -1, y: 2 });

    // this.third.haveSomeFun();

    const bgm = this.sound.add("bgm");
    bgm.play({ loop: true });

    const se = this.sound.add("se");
    se.play();

    this.add.image(width / 2, height / 2, "face1");

    // this.add.text(400, 300, "Hello World", { fontFamily: "arial", fontSize: "60px" }).setOrigin(0.5);

    // this.add.image(width / 2, height / 2, "street");
    // this.add.text(width / 2, height / 2, "クリックでエンディング").setOrigin(0.5);

    const textStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: '"Helvetica Neue", Arial, "Hiragino Kaku Gothic ProN", "Hiragino Sans", Meiryo, sans-serif',
      fontSize: "24px",
    };

    // DialogBoxのコンフィグ
    const dialogBoxHeight = 150;
    const dialogBoxMargin = 10;
    const dialogBoxConfig: DialogBoxConfig = {
      x: width / 2,
      y: height - dialogBoxMargin - dialogBoxHeight / 2,
      width: width - dialogBoxMargin * 2,
      height: dialogBoxHeight,
      padding: 10,
      margin: dialogBoxMargin,
      textStyle: textStyle,
    };

    // DialogBoxの作成
    const dialogBox = new DialogBox(this, dialogBoxConfig);

    // タイムラインプレイヤーの作成
    const timelinePlayer = new TimelinePlayer(this, dialogBox, textStyle);

    // タイムラインの再生開始
    timelinePlayer.start(this.timeline);

    // const zone = this.add.zone(width / 2, height / 2, width, height);

    // zone.setInteractive({
    //   useHandCursor: true,
    // });

    // zone.on("pointerdown", () => {
    //   this.scene.start("ending"); // EndingSceneに遷移
    // });
  }

  update() {}
}

export default MainScene;
