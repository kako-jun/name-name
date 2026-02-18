# coding: utf-8
'''convert.py'''

from __future__ import unicode_literals
import os
import sys
import codecs
import re


class Convert(object):
    '''Convert'''

    # class variables

    def __init__(self):
        # instance variables
        self.mode = ''
        self.arg_lines = []
        self.hanasu_i = 0

    def __del__(self):
        pass

    def __parse_args(self):
        file_path = ''
        if len(sys.argv) == 2:
            file_path = sys.argv[1]
        else:
            pass

        return file_path

    def __replace(self, src_line, scene, scene_underbar, series):
        dst_lines = []

        # print src_line

        m = re.match(r'//', src_line)
        if m:
            return dst_lines

        m = re.match(r'■\S+', src_line)
        if m:
            command = m.group(0)
            if command == '■header':
                file = codecs.open('header.txt', 'r', 'utf-8')
                content = file.read()
                file.close()

                content = content.replace('{{{scene}}}', scene)
                dst_lines.append(content)
            elif command == '■footer':
                self.mode = 'footer'
            elif command == '■poem':
                self.mode = 'poem'
            elif command == '■00:00':
                dst_lines.append('[iscript]\n')
                dst_lines.append(
                    'sf.my.info.current_scene = "' + scene + '";\n')
                dst_lines.append('[endscript]\n')
                dst_lines.append('\n')
            elif command == '■01:00' or command == '■02:00' or command == '■03:00' or command == '■04:00':
                m = re.match(r'■0([1-4]):00', command)
                if m:
                    minute = m.group(1)
                    dst_lines.append('*' + minute + '_00\n')
                    dst_lines.append('[iscript]\n')
                    dst_lines.append(
                        'sf.my.info.current_scene = "' + scene + '";\n')
                    dst_lines.append(
                        'sf.my.flags.show_' + scene_underbar + '_' + minute + ' = true;\n')
                    dst_lines.append('[endscript]\n')
                    dst_lines.append('\n')
            elif command == '■bg':
                m = re.match(r'(■\S+) (\S+)', src_line)
                if m:
                    arg1 = m.group(2)
                    line = '[chara_mod_b storage="chara/1/BG_' + \
                        arg1 + '.png"]\n'
                    dst_lines.append(line)
            elif command == '■chara':
                m = re.match(r'(■\S+) (\S+) (\S+)', src_line)
                if m:
                    arg1 = m.group(2)
                    arg2 = m.group(3)
                    line = '[chara_mod_s storage="chara/2/' + \
                        arg1 + '_' + arg2 + '.png"]\n'
                    dst_lines.append(line)
                else:
                    line = '[chara_hide_s]\n'
                    dst_lines.append(line)
            elif command == '■bgm':
                m = re.match(r'(■\S+) (\S+)', src_line)
                if m:
                    arg1 = m.group(2)
                    line = '[playbgm2 storage="' + arg1 + '.ogg"]\n'
                    dst_lines.append(line)
            elif command == '■se':
                m = re.match(r'(■\S+) (\S+)', src_line)
                if m:
                    arg1 = m.group(2)
                    line = '[playse2 storage="' + arg1 + '.ogg"]\n'
                    dst_lines.append(line)
        else:
            m = re.match(r'#\S+', src_line)
            if m:
                name = m.group(0)
                if name == '#私':
                    dst_lines.append(
                        '[layopt layer="message0" visible="true"]\n')
                    dst_lines.append('[tb_start_text mode=4 ]\n')
                    dst_lines.append('[mono]\n')
                    dst_lines.append(src_line)
                else:
                    dst_lines.append(
                        '[layopt layer="message0" visible="true"]\n')
                    dst_lines.append('[tb_start_text mode=4 ]\n')
                    dst_lines.append(src_line)
            else:
                if src_line == '-----------------------------------------------------------|-------------------<\n':
                    dst_lines.append('[p2]\n')
                    dst_lines.append('[_tb_end_text]\n')
                elif src_line == 'hanasu-start-----------------------------------------------|-------------------<\n':
                    hanasu_id = '{:0=4}'.format(self.hanasu_i)
                    dst_lines.append('[p_h storage="' + scene + '.ks" target="*h_' +
                                     hanasu_id + '" target_else="*h_' + hanasu_id + '_else"]\n')
                    dst_lines.append('[_tb_end_text]\n')
                    dst_lines.append('*h_' + hanasu_id + '\n')
                    dst_lines.append('[start_hanasu]\n')
                elif src_line == 'hanasu-end-------------------------------------------------|-------------------<\n':
                    hanasu_id = '{:0=4}'.format(self.hanasu_i)
                    dst_lines.append('[p2]\n')
                    dst_lines.append('[_tb_end_text]\n')
                    dst_lines.append('[chara_hide_s]\n')
                    dst_lines.append('[stop_hanasu]\n')
                    dst_lines.append('*h_' + hanasu_id + '_else\n')
                    self.hanasu_i += 1
                else:
                    dst_lines.append(src_line)

        return dst_lines

    def __replace_arg_lines(self, mode, arg_lines, scene, scene_underbar, series):
        dst_lines = []

        if mode == 'footer':
            file = codecs.open('footer.txt', 'r', 'utf-8')
            content = file.read()
            file.close()

            next_scene_underbar = arg_lines[-1]
            del arg_lines[-1]
            num_of_noise = str(len(arg_lines))

            noises = []
            for arg_line in arg_lines:
                line = 'sf.my.flags.show_' + arg_line + ' = true'
                noises.append(line)

            content = content.replace('{{{scene_underbar}}}', scene_underbar)
            content = content.replace(
                '{{{next_scene_underbar}}}', next_scene_underbar)
            content = content.replace('{{{noises}}}', '\n'.join(noises))
            content = content.replace('{{{series}}}', series)
            content = content.replace('{{{num_of_noise}}}', num_of_noise)
            dst_lines.append(content)
        elif mode == 'poem':
            dst_lines.append('[start_poem cloud="' + series + '"]\n')

            title = arg_lines[-1]
            del arg_lines[-1]

            for i, arg_line in enumerate(arg_lines):
                texts = [''] * 6
                splited = arg_line.split(' ')
                for j, s in enumerate(splited):
                    texts[j] = s

                if i < len(arg_lines) - 1:
                    dst_lines.append('[poem text1="' + texts[0] + '" text2="' + texts[1] +
                                     '" text3="' + texts[2] + '" text4="' + texts[3] + '"]\n')
                else:
                    dst_lines.append('[poem text1="' + texts[0] + '" text2="' + texts[1] + '" text3="' + texts[2] +
                                     '" text4="' + texts[3] + '" text5="' + scene + '" text6="' + title + '" last="true"]\n')

            dst_lines.append('[end_poem]\n')
            dst_lines.append('[show_menu_button]\n')
            dst_lines.append('\n')
            dst_lines.append('\n')

        return dst_lines

    def run(self):
        '''run'''
        file_path = self.__parse_args()

        if file_path == '':
            print 'Invalid argument.'
            sys.exit()

        scene = re.sub('_meta.txt', '', os.path.basename(file_path))
        scene_underbar = scene.replace('-', '_')
        series = re.match('S(.)-', scene).group(1)

        src = codecs.open(file_path, 'r', 'utf-8')
        src_lines = src.readlines()
        src.close()

        for src_line in src_lines:
            src_line = src_line.replace('\n', '')

        dst_lines = []
        for src_line in src_lines:
            if self.mode != '':
                if src_line.startswith('  '):
                    self.arg_lines.append(src_line.strip())
                else:
                    lines = self.__replace_arg_lines(
                        self.mode, self.arg_lines, scene, scene_underbar, series)
                    dst_lines.extend(lines)
                    self.mode = ''
                    self.arg_lines = []
            else:
                lines = self.__replace(src_line, scene, scene_underbar, series)
                dst_lines.extend(lines)

        if self.mode != '':
            lines = self.__replace_arg_lines(
                self.mode, self.arg_lines, scene, scene_underbar, series)
            dst_lines.extend(lines)
            self.mode = ''
            self.arg_lines = []

        # print dst_lines

        dst = codecs.open(scene + '.ks', 'w', 'utf-8')
        dst.write(''.join(dst_lines))
        dst.close()


if __name__ == '__main__':
    convert = Convert()
    convert.run()
