"use strict";
const _ = require("lodash");
// const os = require("os");
const fs = require("fs");
const path = require("path");

class Converter {
  constructor() {
    // instance variables
    this.mode = "neutral";
    this.argLines = [];
    this.autoTag = "neutral";
    this.iHanasu = 0;
  }

  parseArgs(argv) {
    let srcDirPath = "";
    let dstDirPath = "";
    if (argv.length == 4) {
      srcDirPath = argv[2];
      dstDirPath = argv[3];
    }

    return [srcDirPath, dstDirPath];
  }

  enumSrcFiles(srcDirPath) {
    let filePaths = [];

    const files = fs.readdirSync(srcDirPath);

    filePaths = files.map(file => {
      return path.resolve(srcDirPath, file);
    });

    filePaths = _.filter(filePaths, filePath => {
      if (fs.statSync(filePath).isFile()) {
        if (filePath.match(/.*\.md$/)) {
          return true;
        }
      }

      return false;
    });

    return filePaths;
  }

  trimBlankAndComment(srcLines) {
    const dstLines = [];

    let nowComment = false;
    _.each(srcLines, srcLine => {
      // if (srcLine === "") {
      // } else if (srcLine === "```s") {
      // } else if (srcLine === "```") {
      if (srcLine.startsWith("<!--")) {
        nowComment = true;
      } else if (srcLine.startsWith("-->")) {
        nowComment = false;
      } else if (!nowComment) {
        let temp = srcLine.replace(/\s+$/, "");
        temp = temp.replace(/> > /, "> ");
        dstLines.push(temp);
      }
    });

    return dstLines;
  }

  zeroPadding(num, length) {
    return ("0000000000" + num).slice(-length);
  }

  convertToName(arg) {
    switch (arg) {
      case "カコ":
        return "kako";
      case "トモ":
        return "tomo";
    }

    return "";
  }

  convertToFace(arg) {
    if (arg.match(/嬉/)) {
      return "happy";
    } else if (arg.match(/怒/)) {
      return "angry";
    } else if (arg.match(/とほほ/)) {
      return "tohoho";
    }

    return "";
  }

  replace(srcLine, srcDirPath, scene, sceneUnderbar, series) {
    // console.log("srcLine");
    // console.log(srcLine);
    const dstLines = [];

    let lineMatched = srcLine.match(/^# (\S+)/);
    if (lineMatched && lineMatched.length > 1) {
      const command = lineMatched[1];
      // console.log(command);
      switch (command) {
        case "header":
          let text = fs.readFileSync(path.resolve(srcDirPath, "header.ks"), { encoding: "utf-8" });
          text = text.replace(/{{{scene}}}/, scene);
          dstLines.push(text);
          break;
        case "footer":
          this.mode = "footer";
          return [];
        case "poem":
          this.mode = "poem";
          return [];
        case "00:00":
          dstLines.push("[iscript]");
          dstLines.push('sf.my.info.current_scene = "' + scene + '";');
          dstLines.push("[endscript]");
          dstLines.push("");
          break;
        case "01:00":
        case "02:00":
        case "03:00":
        case "04:00":
          const commandMatched = command.match(/0([1-4]):00/);
          if (commandMatched && commandMatched.length > 1) {
            const minute = commandMatched[1];
            dstLines.push("");
            dstLines.push("");
            dstLines.push("*0" + minute + "_00");
            dstLines.push("[iscript]");
            dstLines.push('sf.my.info.current_scene = "' + scene + '";');
            dstLines.push("sf.my.flags.show_" + sceneUnderbar + "_" + minute + " = true;");
            dstLines.push("[endscript]");
            dstLines.push("");
          }
          break;
      }
    }

    if (dstLines.length > 0) {
      // console.log(dstLines);
      return dstLines;
    }

    lineMatched = srcLine.match(/^> ([^>]+)/);
    if (lineMatched && lineMatched.length > 1) {
      const command = lineMatched[1];
      // console.log(command);
      if (command.startsWith("背景絵を")) {
        const commandMatched = command.match(/背景絵を\s*(\S+)\s*に/);
        if (commandMatched && commandMatched.length > 1) {
          const arg1 = commandMatched[1];
          const line = '[chara_mod_b storage="chara/1/' + arg1 + '.png"]';
          dstLines.push(line);
        }
      } else if (command.startsWith("立ち絵を")) {
        const commandMatched = command.match(/立ち絵を\s*(\S+)\s*の\s*(\S+)\s*に/);
        if (commandMatched && commandMatched.length > 2) {
          const arg1 = commandMatched[1];
          const arg2 = commandMatched[2];

          const name = this.convertToName(arg1);
          const face = this.convertToFace(arg2);

          const line = '[chara_mod_s storage="chara/2/' + name + "_" + face + '.png"]';
          dstLines.push(line);
        } else {
          const line = "[chara_hide_s]";
          dstLines.push(line);
        }
      } else if (command.startsWith("BGM を") || command.startsWith("BGMを")) {
        const commandMatched = command.match(/BGM\s*を\s*(\S+)\s*に/);
        if (commandMatched && commandMatched.length > 1) {
          const arg1 = commandMatched[1];
          if (arg1 === "無し") {
            const line = "[fadeoutbgm2]";
            dstLines.push(line);
          } else {
            const line = '[playbgm2 storage="' + arg1 + '.ogg"]';
            dstLines.push(line);
          }
        }
      } else if (command.endsWith("を鳴らす")) {
        const commandMatched = command.match(/(\S+)\s*を鳴らす/);
        if (commandMatched && commandMatched.length > 1) {
          const arg1 = commandMatched[1];
          const line = '[playse2 storage="' + arg1 + '.ogg"]';
          dstLines.push(line);
        }
      } else if (command === "はなす終わり") {
        const hanasuID = this.zeroPadding(this.iHanasu, 4);
        // dstLines.push("[p2]");
        // dstLines.push("");
        dstLines.push("[chara_hide_s]");
        dstLines.push("[stop_hanasu]");
        dstLines.push("");
        dstLines.push("*h_" + hanasuID + "_else");
        this.iHanasu++;
      }
    }

    if (dstLines.length > 0) {
      // console.log(dstLines);
      return dstLines;
    }

    if (srcLine === "```r") {
      this.autoTag = "auto";

      dstLines.push('[layopt layer="message0" visible="true"]');
      dstLines.push("");
      dstLines.push("[tb_start_text mode=4]");
    } else if (srcLine === "```s") {
      this.autoTag = "manual";

      dstLines.push('[layopt layer="message0" visible="true"]');
      dstLines.push("");
      dstLines.push("[tb_start_text mode=4]");
      return [];
    } else if (srcLine === "```はなす") {
      const hanasuID = this.zeroPadding(this.iHanasu, 4);
      dstLines.push(
        '[p_h storage="' + scene + '.ks" target="*h_' + hanasuID + '" target_else="*h_' + hanasuID + '_else"]'
      );
      dstLines.push("[_tb_end_text]");
      dstLines.push("");
      dstLines.push("*h_" + hanasuID + "");
      dstLines.push("[start_hanasu]");
    } else if (srcLine === "```") {
      if (this.autoTag === "auto") {
        this.autoTag = "neutral";

        dstLines.push("[p2]");
        dstLines.push("[_tb_end_text]");
        dstLines.push("");
      } else {
        dstLines.push("[_tb_end_text]");
      }
    }

    if (srcLine === "#私") {
      dstLines.push("[mono]");
      dstLines.push(srcLine);
    } else if (srcLine.match(/^#(\S+)/)) {
      dstLines.push(srcLine);
    } else if (srcLine === "n") {
      dstLines.push("[r]");
    } else if (srcLine === "cn") {
      dstLines.push("[l][r]");
    } else if (srcLine === "p") {
      dstLines.push("[p2]");
      dstLines.push("");
    } else if (srcLine === "np") {
      dstLines.push("[r]");
      dstLines.push("[p2]");
      dstLines.push("");
    } else if (srcLine.match(/ p$/)) {
      dstLines.push(srcLine.replace(/ p$/, ""));
      dstLines.push("[p2]");
      dstLines.push("");
    }

    if (dstLines.length > 0) {
      // console.log(dstLines);
      return dstLines;
    }

    srcLine = srcLine.replace(/ c /g, "[l]");
    srcLine = srcLine.replace(/ n$/, "[r]");
    srcLine = srcLine.replace(/ cn$/, "[l][r]");

    if (this.autoTag === "auto") {
      if (srcLine === "") {
        dstLines.push("[r]");
      } else {
        dstLines.push(srcLine + "[l][r]");
      }
    } else {
      dstLines.push(srcLine);
    }

    return dstLines;
  }

  replaceArgLines(mode, srcDirPath, argLines, scene, sceneUnderbar, series) {
    const dstLines = [];

    switch (mode) {
      case "footer":
        let nextScene = "";
        if (argLines.length > 0) {
          const nextSceneUnderbar = argLines[argLines.length - 1].replace(/-/g, "_");
          nextScene = "sf.my.flags.show_" + nextSceneUnderbar + " = true;";
        }

        const noiseLines = _.dropRight(argLines);
        const noises = _.map(noiseLines, noiseLine => {
          return "sf.my.flags.show_" + noiseLine.replace(/-/g, "_") + " = true";
        });

        let text = fs.readFileSync(path.resolve(srcDirPath, "footer.ks"), { encoding: "utf-8" });

        text = text.replace("{{{scene_underbar}}}", sceneUnderbar);
        text = text.replace("{{{next_scene}}}", nextScene);
        text = text.replace("{{{noises}}}", noises.join("\n"));
        text = text.replace("{{{series}}}", series);
        text = text.replace("{{{num_of_noise}}}", noises.length);

        dstLines.push("");
        dstLines.push(text);
        break;
      case "poem":
        const title = argLines[argLines.length - 1];

        dstLines.push('[start_poem cloud="' + series + '"]');

        const poemLines = _.dropRight(argLines);
        _.each(poemLines, (poemLine, i) => {
          const splited = poemLine.split(" ");

          const texts = ["", "", "", ""];
          _.each(splited, (s, i) => {
            texts[i] = s;
          });

          if (i < poemLines.length - 1) {
            dstLines.push(
              '[poem text1="' +
                texts[0] +
                '" text2="' +
                texts[1] +
                '" text3="' +
                texts[2] +
                '" text4="' +
                texts[3] +
                '"]'
            );
          } else {
            dstLines.push(
              '[poem text1="' +
                texts[0] +
                '" text2="' +
                texts[1] +
                '" text3="' +
                texts[2] +
                '" text4="' +
                texts[3] +
                '" text5="' +
                scene +
                '" text6="' +
                title +
                '" last="true"]'
            );
          }
        });

        dstLines.push("[end_poem]");
        dstLines.push("[show_menu_button]");
        dstLines.push("");
        dstLines.push("");
        break;
    }

    return dstLines;
  }

  start() {
    const [srcDirPath, dstDirPath] = this.parseArgs(process.argv);
    if (srcDirPath === "" || dstDirPath === "") {
      console.log("Invalid argument.");
      return;
    }

    // console.log(srcDirPath);
    // console.log(dstDirPath);

    const srcFilePaths = this.enumSrcFiles(srcDirPath);
    // console.log(srcFilePaths);

    _.each(srcFilePaths, srcFilePath => {
      this.mode = "neutral";
      this.argLines = [];
      this.autoTag = "neutral";
      this.iHanasu = 0;

      const fileName = path.basename(srcFilePath);
      const scene = fileName.replace(/_meta.md/, "");
      const sceneUnderbar = scene.replace(/-/g, "_");
      const series = scene.match(/S(.)-/)[1];

      // console.log(scene);
      //   console.log(sceneUnderbar);
      //   console.log(series);

      let text = fs.readFileSync(srcFilePath, { encoding: "utf-8" });
      text = text.replace(/(#\S+\n)\n+/g, "$1");
      text = text.replace(/```\n+> はなす/g, "```はなす");
      // console.log(text);

      let srcLines = text.split("\n");
      //   console.log(srcLines);

      srcLines = this.trimBlankAndComment(srcLines);
      //   console.log(srcLines);

      const dstLines = [];
      _.each(srcLines, srcLine => {
        if (srcLine === "") {
          if (this.autoTag === "neutral") {
            return;
          }
        }

        if (this.mode === "neutral") {
          const lines = this.replace(srcLine, srcDirPath, scene, sceneUnderbar, series);
          if (lines.length > 0) {
            dstLines.push(...lines);
          }
        } else {
          if (srcLine.startsWith("- ")) {
            this.argLines.push(srcLine.replace(/- /, ""));
          } else {
            let lines = this.replaceArgLines(this.mode, srcDirPath, this.argLines, scene, sceneUnderbar, series);
            dstLines.push(...lines);
            this.mode = "neutral";
            this.argLines = [];

            lines = this.replace(srcLine, srcDirPath, scene, sceneUnderbar, series);
            if (lines.length > 0) {
              dstLines.push(...lines);
            }
          }
        }
      });
      //   console.log(srcLines);

      if (this.mode !== "neutral") {
        const lines = this.replaceArgLines(this.mode, srcDirPath, this.argLines, scene, sceneUnderbar, series);
        if (lines.length > 0) {
          dstLines.push(...lines);
        }
      }

      // console.log(dstLines);
      fs.writeFileSync(path.resolve(dstDirPath, scene + ".ks"), dstLines.join("\n"));
    });
  }
}

// class variables

module.exports = Converter;
// export default Converter;
