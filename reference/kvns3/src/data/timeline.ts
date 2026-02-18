import { Timelines } from "../types/Timelines";

export const timelineData: Timelines = {
  start: [
    { type: "dialog", text: "・・・・・・ ▼" },
    { type: "dialog", text: "う、うーん・・・ ▼" },
    { type: "setBackground", x: 400, y: 300, key: "street" },
    { type: "dialog", text: "ここは・・・？ ▼" },
    { type: "addForeground", x: 400, y: 300, key: "robot" },
    { type: "dialog", text: "目が覚めましたか ▼", actorName: "???" },
    { type: "dialog", text: "アンドロイド・・・？ ▼" },
    { type: "dialog", text: "私は「ACT-42」 ▼", actorName: "???" },
    { type: "dialog", text: "早速ですが—— ▼", actorName: "ACT-42" },
    { type: "dialog", text: "あなたは追われています ▼", actorName: "ACT-42" },
    { type: "dialog", text: "一刻も早くここから逃げた方がいい ▼", actorName: "ACT-42" },
    { type: "timelineTransition", timelineID: "choice01" },
  ],
  choice01: [
    { type: "setBackground", x: 400, y: 300, key: "street" },
    { type: "addForeground", x: 400, y: 300, key: "robot" },
    { type: "dialog", text: "一緒に逃げましょう ▼", actorName: "ACT-42" },
    {
      type: "choice",
      choices: [
        { text: "はい", timelineID: "choice01_a01" },
        { text: "いいえ", timelineID: "choice01_a02" },
        { text: "アンドロイド風情が話しかけるな", timelineID: "choice01_a03" },
      ],
    },
  ],
  choice01_a01: [
    { type: "setBackground", x: 400, y: 300, key: "street" },
    { type: "addForeground", x: 400, y: 300, key: "robot" },
    { type: "dialog", text: "事情はつかめないけどとりあえず従っておこう ▼" },
    { type: "dialog", text: "よろしい。ではこちらへ来てください ▼", actorName: "ACT-42" },
    { type: "clearForeground" },
    { type: "dialog", text: "こうして銀河を股にかけた物語が始まるのであった・・・ ▼" },
    { type: "sceneTransition", key: "ending" },
  ],
  choice01_a02: [
    { type: "setBackground", x: 400, y: 300, key: "street" },
    { type: "addForeground", x: 400, y: 300, key: "robot" },
    { type: "dialog", text: "・・・困りましたね ▼", actorName: "ACT-42" },
    { type: "dialog", text: "今は事情を話している暇がないんです ▼", actorName: "ACT-42" },
    { type: "dialog", text: "あなたは捕まるべきではない ▼", actorName: "ACT-42" },
    { type: "dialog", text: "もう一度聞きますね？ ▼", actorName: "ACT-42" },
    { type: "timelineTransition", timelineID: "choice01" },
  ],
  choice01_a03: [
    { type: "setBackground", x: 400, y: 300, key: "street" },
    { type: "addForeground", x: 400, y: 300, key: "robot" },
    { type: "dialog", text: "・・・・・・ ▼", actorName: "ACT-42" },
    { type: "dialog", text: "わかりました。それでは私はこれで ▼", actorName: "ACT-42" },
    { type: "clearForeground" },
    { type: "dialog", text: "・・・・・・ ▼" },
    { type: "dialog", text: "この後俺は謎の組織に捕まり色々されてしまうのだった・・・ ▼" },
    { type: "sceneTransition", key: "ending" },
  ],
};
