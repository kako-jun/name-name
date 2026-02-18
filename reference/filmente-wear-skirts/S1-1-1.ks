
[_tb_system_call storage=system/_S1-1-1.ks]

*0
[jump target="*preload"]

*1
[iscript]
tf.time = 1;
[endscript]

[jump target="*preload"]

*2
[iscript]
tf.time = 2;
[endscript]

[jump target="*preload"]

*3
[iscript]
tf.time = 3;
[endscript]

[jump target="*preload"]

*4
[iscript]
tf.time = 4;
[endscript]

*preload

[iscript]
f.preload_images = [
  "data/fgimage/chara/1/black.png",
  "data/fgimage/chara/1/white.png",
  "data/fgimage/chara/1/BG_1_4.png",
  "data/fgimage/chara/1/BG_2_4.png",
  "data/fgimage/chara/1/BG_3_4.png",
  "data/fgimage/chara/1/BG_4_4.png",
  "data/fgimage/chara/1/BG_5_4.png",
  "data/fgimage/chara/2/kako_angry.png",
  "data/fgimage/chara/2/kako_happy.png",
  "data/fgimage/chara/2/tomo_tohoho.png",
];
[endscript]

[preload storage="&f.preload_images" wait="true"]

[if exp="tf.time === 1"]
  [jump target="*1_00"]
[endif]

[if exp="tf.time === 2"]
  [jump target="*2_00"]
[endif]

[if exp="tf.time === 3"]
  [jump target="*3_00"]
[endif]

[if exp="tf.time === 4"]
  [jump target="*4_00"]
[endif]


[start_poem cloud="1"]
[poem text1="ああ" text2="なんで" text3="" text4=""]
[poem text1="くそ……" text2="" text3="" text4=""]
[poem text1="こまったなぁ……" text2="" text3="" text4=""]
[poem text1="……" text2="" text3="" text4="" text5="S1-1-1" text6="月とパジャマ" last="true"]
[end_poem]
[show_menu_button]


[iscript]
sf.my.info.current_scene = "S1-1-1";
[endscript]


[chara_mod_b storage="chara/1/BG_1_4.png"]
[chara_mod_s storage="chara/2/kako_angry.png"]

[layopt layer="message0" visible="true"]
[tb_start_text mode=4 ]
#カコ
てすと[l][r]
[p2]
[_tb_end_text]

[playbgm2 storage="eternal_three_or.ogg"]

[r]

[chara_mod_b storage="chara/1/BG_3_4.png"]

改ページするよ
[p_h storage="S1-1-1.ks" target="*h_0000" target_else="*h_0000_else"]
[_tb_end_text]
*h_0000
[start_hanasu]

[chara_mod_s storage="chara/2/tomo_tohoho.png"]

[layopt layer="message0" visible="true"]
[tb_start_text mode=4 ]
#トモ
はなしたよ[l][r]
[r]
はなすの中で改ページするよ
[p2]
[_tb_end_text]

はなすの中で改ページしたよ
[p2]
[_tb_end_text]
[chara_hide_s]
[stop_hanasu]
*h_0000_else

[chara_mod_b storage="chara/1/BG_4_4.png"]
[chara_mod_s storage="chara/2/kako_happy.png"]

[layopt layer="message0" visible="true"]
[tb_start_text mode=4 ]
[mono]
#私
こんにちは[l][r]
これは新しいプロジェクトです[l][r]
[r]

[playse2 storage="mechanical_61.ogg"]

ドラッグ＆ドロップして要素を追加してください
[p2]
[_tb_end_text]

*1_00
[iscript]
sf.my.info.current_scene = "S1-1-1";
sf.my.flags.show_S1_1_1_1 = true;
[endscript]


[playbgm2 storage="aiju.ogg"]
[chara_mod_b storage="chara/1/BG_5_4.png"]
[chara_mod_s storage="chara/2/kako_angry.png"]

[layopt layer="message0" visible="true"]
[tb_start_text mode=4 ]
[mono]
#私
こんにちは[l][r]
これは新しいプロジェクトです[l][r]
[r]
ドラッグ＆ドロップして要素を追加してください
[p2]
[_tb_end_text]

[chara_hide_s]


[iscript]
sf.my.flags.clear_S1_1_1 = true;
sf.my.flags.show_S1_1_A = true;

sf.my.flags.show_N1_1 = true
[endscript]

[intermission series="1" num_of_noise="1"]
[s]
