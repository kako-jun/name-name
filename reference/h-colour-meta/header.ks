[_tb_system_call storage=system/_{{{scene}}}.ks]

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
  "data/fgimage/chara/1/1_4.png",
  "data/fgimage/chara/1/2_4.png",
  "data/fgimage/chara/1/3_4.png",
  "data/fgimage/chara/1/4_4.png",
  "data/fgimage/chara/1/5_4.png",
  "data/fgimage/chara/2/kako_angry.png",
  "data/fgimage/chara/2/kako_happy.png",
  "data/fgimage/chara/2/tomo_tohoho.png",
];
[endscript]

[preload storage="&f.preload_images" wait="true"]

[if exp="tf.time === 1"]
  [jump target="*01_00"]
[endif]

[if exp="tf.time === 2"]
  [jump target="*02_00"]
[endif]

[if exp="tf.time === 3"]
  [jump target="*03_00"]
[endif]

[if exp="tf.time === 4"]
  [jump target="*04_00"]
[endif]

