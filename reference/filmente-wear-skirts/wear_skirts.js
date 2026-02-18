'use strict';
const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const FileController = require('../lib/file_controller');

class WearSkirts {
  constructor(src_dir_path, dst_dir_path, option) {
    // instance variables
    this.src_dir_path = src_dir_path;
    this.dst_dir_path = dst_dir_path;
    this.option = option;

    this.hanasu_i = 0;
  }

  interpret (current_mode, src_line, scene, scene_underbar, series) {
    const dst_lines = [];
    let new_mode = current_mode;

    // remove comments.
    if (src_line.startsWith('//')) {
      return [dst_lines, new_mode];
    }

    if (src_line.startsWith('■')) {
      // command line
      const command = src_line.match(/■(\S+)/)[1];
      switch (command) {
        case 'header': {
          const current_path = process.cwd();
          const header_file_path = path.resolve(current_path, 'src', 'background', 'wear_skirts', 'header.txt');
          let content = fs.readFileSync(header_file_path, { encoding: 'utf-8' });
          content = content.replace('{{{scene}}}', scene);
          dst_lines.push(content);
          break;
        }
        case 'footer':
          new_mode = WearSkirts.Mode.Footer;
          break;
        case 'poem':
          new_mode = WearSkirts.Mode.Poem;
          break;
        case '00:00':
          dst_lines.push('[iscript]');
          dst_lines.push('sf.my.info.current_scene = "' + scene + '";');
          dst_lines.push('[endscript]');
          dst_lines.push('');
          break;
        case '01:00':
        case '02:00':
        case '03:00':
        case '04:00': {
          const m = src_line.match(/0([1-4]):00/);
          if (m) {
            const minute = m[1];
            dst_lines.push('*' + minute + '_00');
            dst_lines.push('[iscript]');
            dst_lines.push('sf.my.info.current_scene = "' + scene + '";');
            dst_lines.push('sf.my.flags.show_' + scene_underbar + '_' + minute + ' = true;');
            dst_lines.push('[endscript]');
            dst_lines.push('');
          } else {
            // error case.

          }
          break;
        }
        case 'bg': {
          const m = src_line.match(/■\S+ (\S+)/);
          if (m) {
            const arg1 = m[1];
            dst_lines.push('[chara_mod_b storage="chara/1/BG_' + arg1 + '.png"]');
          } else {
            // error case.

          }
          break;
        }
        case 'chara': {
          const m = src_line.match(/■\S+ (\S+) (\S+)/);
          if (m) {
            const arg1 = m[1];
            const arg2 = m[2];
            dst_lines.push('[chara_mod_s storage="chara/2/' + arg1 + '_' + arg2 + '.png"]');
          } else {
            dst_lines.push('[chara_hide_s]');
          }
          break;
        }
        case 'bgm': {
          const m = src_line.match(/■\S+ (\S+)/);
          if (m) {
            const arg1 = m[1];
            dst_lines.push('[playbgm2 storage="' + arg1 + '.ogg"]');
          } else {
            // error case.

          }
          break;
        }
        case 'se': {
          const m = src_line.match(/■\S+ (\S+)/);
          if (m) {
            const arg1 = m[1];
            dst_lines.push('[playse2 storage="' + arg1 + '.ogg"]');
          } else {
            // error case.

          }
          break;
        }
        default:
          // error case.
          break;
      }
    } else {
      // scenario line
      if (src_line.startsWith('#')) {
        const name = src_line.match(/#(\S+)/)[1];
        if (name === '私') {
          dst_lines.push('[layopt layer="message0" visible="true"]');
          dst_lines.push('[tb_start_text mode=4 ]');
          dst_lines.push('[mono]');
          dst_lines.push(src_line);
        } else {
          dst_lines.push('[layopt layer="message0" visible="true"]');
          dst_lines.push('[tb_start_text mode=4 ]');
          dst_lines.push(src_line);
        }
      } else {
        switch (src_line) {
          case '-----------------------------------------------------------|-------------------<':
            dst_lines.push('[p2]\n');
            dst_lines.push('[_tb_end_text]\n');
            break;
          case 'hanasu-start-----------------------------------------------|-------------------<': {
            const hanasu_id = ('0000' + this.hanasu_i).slice(-4);
            dst_lines.push('[p_h storage="' + scene + '.ks" target="*h_' + hanasu_id + '" target_else="*h_' + hanasu_id + '_else"]');
            dst_lines.push('[_tb_end_text]');
            dst_lines.push('*h_' + hanasu_id);
            dst_lines.push('[start_hanasu]');
            break;
          }
          case 'hanasu-end-------------------------------------------------|-------------------<': {
            const hanasu_id = ('0000' + this.hanasu_i).slice(-4);
            dst_lines.push('[p2]');
            dst_lines.push('[_tb_end_text]');
            dst_lines.push('[chara_hide_s]');
            dst_lines.push('[stop_hanasu]');
            dst_lines.push('*h_' + hanasu_id + '_else');
            this.hanasu_i++;
            break;
          }
          default:
            dst_lines.push(src_line);
            break;
        }
      }
    }

    return [dst_lines, new_mode];
  }

  replace_arg_lines (current_mode, arg_lines, scene, scene_underbar, series) {
    const dst_lines = [];

    switch (current_mode) {
      case WearSkirts.Mode.Neutral:
        // error case.
        break;
      case WearSkirts.Mode.Footer: {
        const current_path = process.cwd();
        const footer_file_path = path.resolve(current_path, 'src', 'background', 'wear_skirts', 'footer.txt');
        let content = fs.readFileSync(footer_file_path, { encoding: 'utf-8' });

        const next_scene_underbar = arg_lines.pop();
        const num_of_noise = arg_lines.length;
        const noises = _.map(arg_lines, (arg_line) => {
          return 'sf.my.flags.show_' + arg_line + ' = true';
        });

        content = content.replace('{{{scene_underbar}}}', scene_underbar);
        content = content.replace('{{{next_scene_underbar}}}', next_scene_underbar);
        content = content.replace('{{{noises}}}', noises.join('\n'));
        content = content.replace('{{{series}}}', series);
        content = content.replace('{{{num_of_noise}}}', num_of_noise);
        dst_lines.push(content);
        break;
      }
      case WearSkirts.Mode.Poem: {
        dst_lines.push('[start_poem cloud="' + series + '"]');

        const title = arg_lines.pop();

        _.each(arg_lines, (arg_line, i) => {
          const texts = Array(6);
          texts.fill('');

          const splited = arg_line.split(' ');
          _.each(splited, (s, j) => {
            texts[j] = s;
          });

          if (i < arg_lines.length - 1) {
            dst_lines.push('[poem text1="' + texts[0] + '" text2="' + texts[1] + '" text3="' + texts[2] + '" text4="' + texts[3] + '"]');
          } else {
            dst_lines.push('[poem text1="' + texts[0] + '" text2="' + texts[1] + '" text3="' + texts[2] + '" text4="' + texts[3] + '" text5="' + scene + '" text6="' + title + '" last="true"]');
          }
        });

        dst_lines.push('[end_poem]');
        dst_lines.push('[show_menu_button]');
        dst_lines.push('');
        break;
      }
    }

    return dst_lines;
  }

  preview () {
    // enum files.
    let file_paths = FileController.enum_files_recursive(this.src_dir_path);
    file_paths = _.filter(file_paths, (file_path) => {
      return file_path.endsWith('_meta.txt');
    });

    _.each(file_paths, (file_path) => {
      console.log(file_path);
    });

    // ready movers.
    const movers = _.map(file_paths, (file_path, i) => {
      const mover = {
        file_path: file_path,
        new_dir_path: '',
        new_file_path: '',
        result: WearSkirts.Result.Unkown,
      };

      mover.new_dir_path = this.dst_dir_path;

      // S1-1-1
      const scene = path.parse(file_path).base.replace('_meta.txt', '');
      mover.new_file_path = path.resolve(this.dst_dir_path, scene + '.ks');
      return mover;
    });

    return movers;
  }

  start_from_cli () {
    const movers = this.preview();

    // create dst.
    if (!fs.existsSync(this.dst_dir_path)) {
      fs.mkdirSync(this.dst_dir_path);
    }

    // convert files.
    _.each(movers, (mover, i) => {
      // S1-1-1
      const scene = path.parse(mover.file_path).base.replace('_meta.txt', '');
      // S1_1_1
      const scene_underbar = scene.replace(/-/g, '_');
      // 1
      const series = scene.match(/S(.)-/)[1];

      // read from src.
      const src = fs.readFileSync(mover.file_path, { encoding: 'utf-8' });
      const src_lines = src.split(/\r\n|\n/);
      console.log(src_lines);

      // convert
      const dst_lines = [];
      let current_mode = WearSkirts.Mode.Neutral;
      const arg_lines = [];

      _.each(src_lines, (src_line) => {
        switch (current_mode) {
          case WearSkirts.Mode.Neutral: {
            const [lines, new_mode] = this.interpret(current_mode, src_line, scene, scene_underbar, series);
            dst_lines.push(...lines);
            current_mode = new_mode;
            break;
          }
          case WearSkirts.Mode.Footer:
          case WearSkirts.Mode.Poem:
            if (src_line.startsWith('  ')) {
              arg_lines.push(src_line.trim());
            } else {
              const lines = this.replace_arg_lines(current_mode, arg_lines, scene, scene_underbar, series);
              dst_lines.push(...lines);
              current_mode = WearSkirts.Mode.Neutral;
              arg_lines.length = 0;
            }
            break;
        }
      });

      if (current_mode !== WearSkirts.Mode.Neutral) {
        const lines = this.replace_arg_lines(current_mode, arg_lines, scene, scene_underbar, series);
        dst_lines.push(...lines);
        current_mode = WearSkirts.Mode.Neutral;
        arg_lines.length = 0;
      }

      // write to dest.
      fs.writeFileSync(mover.new_file_path, dst_lines.join('\n'), { encoding: 'utf-8' });
    });

    return movers;
  }
}

// class variables
WearSkirts.Result = {
  Unkown: 'Unkown',
  Success: 'Success',
  // NoExif: 'NoExif',
  // Duplicated: 'Duplicated',
  Error: 'Error',
};

WearSkirts.Mode = {
  Neutral: 'Neutral',
  Footer: 'Footer',
  Poem: 'Poem',
};

module.exports = WearSkirts;
