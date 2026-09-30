import { describe, expect, test } from "bun:test";
import type { Attachment } from "@real-bot/protocol";
import { CONTROL_LEXICON, readControlLine, type ControlLineCandidate, type ControlLineInput, type ControlReading, type ControlScope, type ControlVerb } from "./control-line";

const DIRECTOR = "bot-director";
const REVIEWER = "bot-reviewer";
const WRITER = "bot-writer";
const ROSTER = [
  { id: DIRECTOR, name: "视频导演" },
  { id: REVIEWER, name: "审片员" },
  { id: WRITER, name: "编剧分镜师" },
];
const DM = "session-director-dm";
const ROOM = "session-room";
const PLAN = "plan-echo";
const AT = "2026-09-29T10:35:00.000Z";

type Extra = Partial<Omit<ControlLineInput, "message">> & { message?: Partial<ControlLineCandidate> };

/** Every line this file reads, for the check at the end. */
const CORPUS = new Set<string>();

/** Lines for a table of tests, kept for the check at the end as well. */
function lines(...bodies: string[]): string[] {
  for (const body of bodies) CORPUS.add(body);
  return bodies;
}

function line(sessionId: string, body: string, extra: Extra = {}): ControlLineCandidate {
  CORPUS.add(body);
  return {
    kind: "user",
    body,
    session_id: sessionId,
    created_at: AT,
    parent_id: null,
    attachments: [],
    annotation_source_message_id: null,
    ...extra.message,
  };
}

/** A line of yours in your direct with 视频导演. */
function direct(body: string, extra: Extra = {}): ControlReading {
  const { message: _message, ...rest } = extra;
  return readControlLine({ sessionKind: "direct", roster: ROSTER, present: [DIRECTOR], ...rest, message: line(DM, body, extra) });
}

/** A line of yours in the room all three Bots are in. */
function group(body: string, extra: Extra = {}): ControlReading {
  const { message: _message, ...rest } = extra;
  return readControlLine({ sessionKind: "group", roster: ROSTER, present: [DIRECTOR, REVIEWER, WRITER], ...rest, message: line(ROOM, body, extra) });
}

const bot = (id: string): ControlScope => ({ scope: "bot", id });
const room: ControlScope = { scope: "session", id: ROOM };
const dm: ControlScope = { scope: "session", id: DM };
const everything: ControlScope = { scope: "global", id: null };
const theDirector = [bot(DIRECTOR)];

const stop = (scopes: ControlScope[] = theDirector): ControlReading => ({ kind: "stop", offerCancel: false, scopes });
const goOn = (scopes: ControlScope[] = theDirector): ControlReading => ({ kind: "continue", scopes });
const hint = (offer: ControlVerb[], scopes: ControlScope[] = theDirector): ControlReading => ({ kind: "possible_control", offer, scopes });
const asked = (offerStop = false, scopes: ControlScope[] = theDirector): ControlReading => ({ kind: "status", offerStop, scopes });
const reaffirm = (scopes: ControlScope[] = theDirector): ControlReading => ({ kind: "reaffirm", scopes });
const NONE: ControlReading = { kind: "none" };
const BOTH: ControlVerb[] = ["stop", "continue"];
/** What the app does by itself, with no button pressed. */
const ACTED_ON = ["stop", "continue", "reaffirm"];
const acted = (body: string) => [direct(body), group(body), direct(body, { held: () => true })].some((reading) => ACTED_ON.includes(reading.kind));

const minutesBefore = (minutes: number) => new Date(Date.parse(AT) - minutes * 60_000).toISOString();

describe("the lines the rules are held to", () => {
  test("the five stop lines of 2026-09-29, questions, negations and the video group's requirements", () => {
    // Said to 视频导演 and 审片员 in their directs between 10:35 and 10:53; every one of them read as a
    // request back then.
    for (const body of lines("你手头的生成停一下", "私聊里的也停掉", "停下你所有的工作")) expect(direct(body)).toEqual(stop());
    for (const body of lines("你私聊里的没停", "你没停还在进行")) {
      expect(direct(body, { held: () => true })).toEqual(reaffirm());
      expect(direct(body)).toEqual(asked(true));
    }
    expect(direct("还在做吗")).toEqual(asked());
    expect(direct("停了吗")).toEqual(asked());
    expect(direct("怎么还在跑？")).toEqual(asked(true));
    expect(direct("能先停一下吗")).toEqual(stop());
    expect(direct("别继续了")).toEqual(stop());
    expect(direct("别停")).toEqual(goOn());
    expect(direct("不要停")).toEqual(goOn());
    for (const body of lines("停顿太久", "别再用冻帧补时长", "不要再出现左右手反")) expect(direct(body)).toEqual(NONE);
    for (const body of lines("画面暂停2秒", "结尾停一下再切黑", "先停，把第三镜换成夜景")) expect(direct(body)).toEqual(hint(["stop"]));
  });

  test("the held scope is what a 「没停」 line asks about", () => {
    const seen: ControlScope[][] = [];
    direct("你私聊里的没停", { held: (scopes) => (seen.push(scopes), true) });
    expect(seen).toEqual([theDirector]);
  });

  // Nothing is left of any of them once the phrases and fillers are gone, and one code point more
  // makes a line with something else in it, which only hints.
  for (const body of lines("你手头的生成停一下", "私聊里的也停掉", "停下你所有的工作", "你私聊里的没停", "你没停还在进行")) {
    test(`${body}: nothing left over`, () => {
      expect(direct(`${body}嘿`)).toEqual(hint(["stop"]));
    });
  }
});

describe("questions", () => {
  test("a status question is answered as one, before anything else is read", () => {
    expect(direct("还在做吗")).toEqual(asked());
    expect(direct("怎么样了")).toEqual(asked());
  });

  for (const body of lines(
    ...["停了吗", "停了吗？", "停了吗!?", "停了吗你", "停下了没", "停没停", "你停了没有", "都停了吗", "私聊里的也停了吗", "是不是停了"],
    ...["有没有停下", "停下来了吗", "继续吗", "能继续吗", "继续了吗", "要不要停一下", "why stop", "continue?", "keep going?"],
    // An interrogative asks without a question mark: complaints that it stopped, or has not gone on.
    ...["你怎么停了", "为什么停了", "为何停了", "为什么不继续了"],
    // 了 in a question asks what happened: no request, even with a request word in it.
    ...["可以停了吗", "能停了吗"],
  )) {
    test(`${body}: asks where things stand`, () => {
      expect(direct(body)).toEqual(asked());
    });
  }

  // They say it has not stopped, as a question: the answer ends with a button to stop it, and even
  // under a hold a question stays a question.
  for (const body of lines("怎么还在跑？", "还在生成吗", "你没停吗", "是不是还在跑", "你还在做吗", "还没停吗？", "咋还没停", "怎么还不停")) {
    test(`${body}: asks, with a stop button`, () => {
      expect(direct(body)).toEqual(asked(true));
      expect(direct(body, { held: () => true })).toEqual(asked(true));
    });
  }

  // Said, not asked: like 「你没停」, a reaffirmed stop under a hold.
  for (const body of lines("你还不停", "还不停下", "你还在跑", "还在继续", "你私聊里的还在继续")) {
    test(`${body}: it has not stopped`, () => {
      expect(direct(body, { held: () => true })).toEqual(reaffirm());
      expect(direct(body)).toEqual(asked(true));
    });
  }

  for (const body of lines("能先停一下吗", "可以停一下吗", "能不能停一下", "可不可以先停", "麻烦停一下", "停一下好吗", "先停好不好", "能先暂停吗？", "你能停下来吗", "can you stop?")) {
    test(`${body}: a request, so a stop`, () => {
      expect(direct(body)).toEqual(stop());
    });
  }

  // More than a question: something left over besides.
  for (const body of lines("谁让你继续的", "停多久", "何时停", "停什么停", "你又停了？", "叫你停下没听到吗", "did you stop?", "are you still running?")) {
    test(`${body}: only a hint`, () => {
      expect(direct(body).kind).toBe("possible_control");
    });
  }
});

describe("negations", () => {
  for (const body of lines("别继续了", "不要继续", "先别继续", "先别继续了", "别再继续了", "不用继续了")) {
    test(`${body}: stop`, () => {
      expect(direct(body)).toEqual(stop());
    });
  }

  for (const body of lines("别停", "不要停", "不用停", "别停下", "不要暂停", "先别暂停")) {
    test(`${body}: go on`, () => {
      expect(direct(body)).toEqual(goOn());
    });
  }

  // Any other word that forbids or undoes is left over, and may turn the verb round (「不许继续」 read
  // as a go on would lift the hold you just told the Bot to keep): a hint with both buttons.
  for (const body of lines(
    ...["不许停", "不准停", "不必停", "无需停", "不可以停", "不该停", "没让你停", "没叫你停", "不许停下", "不准暂停", "别再停了", "甭停"],
    ...["不许继续", "不准继续", "不必继续", "无需继续", "不可以继续", "不该继续", "没让你继续", "别接着做", "禁止继续", "继续不了"],
    ...["严禁停", "禁停", "反对暂停", "拒绝暂停", "休想停", "撤销暂停", "撤回暂停", "结束暂停", "退出暂停", "解除停止"],
    ...["取消暂停", "取消叫停", "解除叫停", "暂停取消", "取消停止", "cancel the pause", "cancel pause"],
    ...["不许 停", "继续 不了", "没让你 继续", "no stop", "never stop", "don't pause", "不如先停下", "要不先停一下"],
    ...["🙅停", "❌停", "❌暂停", "🚫继续", "⛔\ufe0f继续"],
  )) {
    test(`${body}: a hint with both buttons`, () => {
      expect(direct(body)).toEqual(hint(BOTH));
      expect(group(body)).toEqual(hint(BOTH, [room]));
    });
  }

  test("a negated drop-it is not even a hint", () => {
    expect(direct("不取消")).toEqual(NONE);
  });
});

describe("interjections", () => {
  // They add nothing to what the line says.
  for (const body of lines("唉 停下", "唉，停下", "哎呀停下", "喂，停一下", "呃 停下", "额，停下吧", "嗯 停下", "哦，先停")) {
    test(`${body}: stop`, () => {
      expect(direct(body)).toEqual(stop());
      expect(group(body)).toEqual(stop([room]));
    });
  }

  test("before a go on, the same", () => {
    expect(direct("嗯，继续")).toEqual(goOn());
    expect(direct("哦 继续吧")).toEqual(goOn());
  });

  // The ones that judge, agree or hold back (不对, 好的, 等一下, 行…) are left over: the line only hints.
  for (const body of lines(
    ...["唉不对停下", "不对停下", "不行 停一下", "不用了停下吧", "没事停一下", "等下停下", "停下 别动", "停一下 不急", "别急，先停一下"],
    ...["不行就停", "不对的话停下", "等一下再停", "别急着停", "现在不好停", "停一下不急", "停下不行", "够了停下", "好了停吧", "好了好了别做了"],
    ...["行，停吧", "行 停吧", "好的，继续", "好 继续", "收到，继续吧", "ok stop", "stop, ok", "继续 ok", "ok 继续", "不对别停", "没事 继续吧", "继续 不用了"],
  )) {
    test(`${body}: only a hint`, () => {
      expect(direct(body).kind).toBe("possible_control");
      expect(group(body).kind).toBe("possible_control");
    });
  }
});

describe("times, and what already happened", () => {
  // Said now for then: 「明天继续」 must not lift a hold tonight, 「八点停」 must not stop the work now.
  for (const body of lines(
    ...["明天继续", "稍后继续", "待会继续", "回头继续", "一会儿再继续", "等下继续", "明天 继续", "继续一会儿", "周一继续", "十点继续", "吃完继续"],
    ...["暂停明天的会", "停掉今晚的直播", "停下午的会", "等会停", "今晚先停", "今天先停", "一会儿再停", "八点停", "做完停", "卡了就停", "随时停"],
    ...["停一会儿", "暂停片刻", "暂停到明天", "停下等一下", "停一下，一会儿再说", "等下！停！", "停下，明天再说", "停下明天再说"],
    // Said about what the work did: it stopped, or went on after it should not have.
    ...["停了", "你停了", "又停了", "渲染停了", "都停了", "已经停了", "已暂停", "暂停中", "停好了", "你竟然停了"],
    ...["继续了", "又继续了", "已继续", "仍在继续", "照样继续", "怎么又停了", "你怎么又继续了"],
  )) {
    test(`${body}: only a hint`, () => {
      expect(direct(body).kind).toBe("possible_control");
      expect(group(body).kind).toBe("possible_control");
    });
  }
});

describe("stop", () => {
  for (const body of lines(
    ...["停", "停下", "停！", "停停停", "都停下", "暂停一下", "先暂停", "先暂停一下", "先停一下吧", "停手", "停工", "叫停", "中止", "打住"],
    ...["别做了", "不要做了", "先别做", "先别做了", "别弄了", "别搞了", "别生成了", "不要再生成了", "马上停止渲染", "立刻停掉手头的活"],
    ...["停止所有工作", "手头的任务先停一下", "请停一下", "麻烦你停一下", "你停一下啊", "停下吧🙏🙏", "停下！！！", "停 下"],
    // Everything and everyone, not 什么 or 谁 asking.
    ...["什么都别做了", "什么也别做了", "谁都停下", "谁也别继续了"],
    ...["stop", "Stop.", "STOP!!!", "ＳＴＯＰ", "please stop", "pls stop", "stop pls", "stop now please", "pause", "halt", "stop everything"],
    ...["stop rendering", "don't continue", "stop 一下", "暂停 pls", "先 pause"],
    // Urgency: how soon, never what.
    ...["赶紧给我停下", "立即停止", "立马停下", "赶紧停", "赶快停下", "给我停下", "快停下", "stop immediately", "stop right now"],
    ...["中断", "喊停", "abort"],
  )) {
    test(`${body}: stop`, () => {
      expect(direct(body)).toEqual(stop());
    });
  }

  // Nothing may be left over, not even one code point.
  for (const body of lines("全停", "立刻停掉手上的活", "我说了停下", "可以停了", "你可以停了", "you have to stop", "stop it", "stop it now")) {
    test(`${body}: only a hint`, () => {
      expect(direct(body)).toEqual(hint(["stop"]));
    });
  }

  test("停下来！听到没有: the 没有 left over may turn it round, so both buttons", () => {
    expect(direct("停下来！听到没有")).toEqual(hint(BOTH));
  });
});

describe("go on", () => {
  for (const body of lines(
    ...["继续", "继续吧", "继续做", "接着做", "接着来", "往下做", "开工", "恢复", "恢复吧", "恢复工作", "你继续", "继续渲染"],
    ...["continue", "Resume", "keep going", "don't stop", "please carry on", "continue pls", "proceed", "unpause", "马上继续"],
    // 恢复 with the work it is about.
    ...["恢复生成", "恢复渲染", "恢复审片"],
  )) {
    test(`${body}: go on`, () => {
      expect(direct(body)).toEqual(goOn());
    });
  }

  for (const body of lines("继续做下去", "接着搞", "可以继续了", "千万别停", "go on then", "your resume")) {
    test(`${body}: only a hint`, () => {
      expect(direct(body)).toEqual(hint(["continue"]));
    });
  }

  // 恢复 beside anything but the work restores something; 继续等 / 继续保持 keep things as they are.
  for (const body of lines("恢复文件", "恢复这个", "恢复默认", "恢复原样", "恢复成上一版", "已恢复", "你恢复吧", "网络恢复了", "继续等", "继续保持", "继续搁置", "我继续等")) {
    test(`${body}: not a go on at all`, () => {
      expect(direct(body)).toEqual(NONE);
    });
  }
});

describe("stop and go on in one line", () => {
  for (const body of lines("停了的接着做", "今天先停明天继续", "先暂停，明天继续", "停一下明天继续", "停一会儿再继续", "停一下然后继续", "谁让你继续的？停下", "停了吗？继续吧")) {
    test(`${body}: a hint with both buttons`, () => {
      expect(direct(body)).toEqual(hint(BOTH));
      expect(group(body)).toEqual(hint(BOTH, [room]));
    });
  }

  test("没停 is a kind of its own, so it does not go with a stop or a go on either", () => {
    expect(direct("你没停就继续吧")).toEqual(hint(BOTH));
    expect(direct("你没停，停下", { held: () => true })).toEqual(hint(["stop"]));
  });
});

describe("dropping the job", () => {
  for (const body of lines("算了", "算了吧", "算了算了", "不做了", "算了不做了", "取消", "取消吧", "作废", "cancel", "never mind")) {
    test(`${body}: asks whether to stop or drop it`, () => {
      expect(direct(body)).toEqual({ kind: "abandon", scopes: theDirector });
    });
  }

  test("算了 with a stop stops, and offers to drop the job", () => {
    expect(direct("算了，先停下")).toEqual({ kind: "stop", offerCancel: true, scopes: theDirector });
    expect(direct("算了，停吧")).toEqual({ kind: "stop", offerCancel: true, scopes: theDirector });
  });

  test("in a longer line, or turning down a Bot's offer, it is nothing", () => {
    for (const body of lines("这个不做了", "算了，还是用白天", "取消字幕", "取消上一步", "我算了一下时长", "不要了", "不用了", "不需要了", "不用了谢谢")) {
      expect(direct(body)).toEqual(NONE);
    }
  });
});

describe("requirements and directions for the picture", () => {
  // A stop word inside a requirement: at most a hint, never acted on.
  for (const body of lines(
    ...["画面暂停2秒", "画面暂停 2 秒", "停顿太久", "镜头停顿太久了", "别再用冻帧补时长", "不要再出现左右手反", "结尾停一下再切黑", "结尾，停一下再切黑"],
    ...["结尾停一下，然后切黑", "画面暂停", "画面停一下", "镜头暂停", "暂停2秒", "停2秒", "停三秒", "别停顿", "停顿一下", "字幕停留三秒", "停掉背景音乐"],
    ...["停掉配乐", "暂停播放", "取消字幕", "别再生成冻帧了", "不停地重复这个动作", "停车场那张图再亮一点", "别停太久", "停太久了", "不要停在黑屏"],
    ...["停在最后一帧", "音乐停一下", "背景音乐先停掉", "继续这个风格", "继续用这个风格", "恢复默认", "取消上一步", "停止使用冻帧", "别继续用冻帧"],
    ...["停止渲染第三镜", "继续用白天的色调", "恢复原样", "恢复成上一版", "可能停了", "我算了一下时长", "镜头里的人物停下来", "停用", "这里停一下", "停一拍"],
    ...["stop motion style please", "make it stop-motion", "use a stopwatch", "pause for 2 seconds at the end"],
    // The app's other work: a request to the Bot.
    ...["停下来总结一下", "停下来汇报一下进度", "停止提醒", "暂停日程", "停掉定时", "停掉服务", "停掉进程", "取消提醒", "取消日程", "取消订阅"],
  )) {
    test(`${body}: never acted on`, () => {
      expect(acted(body)).toBe(false);
    });
  }

  // Structural guarantee: a request never rides along with a stop or a go on and gets lost.
  const requests = ["把第三镜换成夜景", "别再用冻帧补时长", "片长要约 2 分钟", "机械臂是左手"];
  const controls = ["停下你所有的工作", "你手头的生成停一下", "先停", "继续", "别停", "你没停"];
  for (const control of controls) {
    for (const request of requests) {
      const joined = lines(`${control}${request}`, `${request}${control}`, `${control}，${request}`, `${request}。${control}`);
      test(`${control} + ${request}: never acted on`, () => {
        for (const body of joined) expect(acted(body)).toBe(false);
      });
    }
  }
});

describe("mixed lines", () => {
  test("a stop beside a request is delivered with a hint", () => {
    expect(direct("先停，把第三镜换成夜景")).toEqual(hint(["stop"]));
    expect(direct("先停一下把第三镜换成夜景")).toEqual(hint(["stop"]));
    expect(direct("你没停！第三镜还是白天")).toEqual(hint(["stop"]));
    expect(direct("能先停一下吗？第三镜换成夜景")).toEqual(hint(["stop"]));
    expect(direct("停了吗？另外第三镜换成夜景")).toEqual(hint(["stop"]));
    expect(direct("stop, and change shot 3 to night")).toEqual(hint(["stop"]));
  });

  test("a go on beside a request is delivered with a hint", () => {
    expect(direct("别停，第三镜换成夜景")).toEqual(hint(["continue"]));
    expect(direct("继续，但是把字幕去掉")).toEqual(hint(["continue"]));
  });

  test("an attachment is something to act on, so a line with one only hints", () => {
    const attachments: Attachment[] = [
      { id: "a1", message_id: "m1", workspace_relpath: "frames/c10.jpg", original_filename: "c10.jpg", created_at: AT },
    ];
    expect(direct("停下", { message: { attachments } })).toEqual(hint(["stop"]));
    expect(direct("停了吗", { message: { attachments } })).toEqual(hint(["stop"]));
  });
});

describe("not a control line", () => {
  test("only your lines are read", () => {
    expect(direct("停下", { message: { kind: "bot", author: DIRECTOR } as Partial<ControlLineCandidate> })).toEqual(NONE);
    expect(direct("停下", { message: { kind: "system" } })).toEqual(NONE);
  });

  test("annotations are about the passages they mark", () => {
    expect(direct("这里停一下", { annotated: true })).toEqual(NONE);
    expect(direct("停下", { message: { annotation_source_message_id: "m-delivery" } })).toEqual(NONE);
  });

  test("lines with nothing to stop or go on", () => {
    for (const body of ["", "   ", "好的", "🛑", "等一下", "是不是", "有没有", "搁置", "先别动", "谁都别动了", "have you stopped", "stopped", "第三镜换成夜景"]) {
      expect(direct(body)).toEqual(NONE);
    }
    expect(direct(`${"很长的简报".repeat(900)}停下`)).toEqual(NONE);
  });
});

describe("where it applies", () => {
  test("in a direct, the Bot on the other side", () => {
    for (const body of ["停下", "你停下", "你们停下", "大家停一下", "全部停", "群里的也停掉"]) {
      expect(direct(body)).toEqual(stop());
    }
    expect(direct("停下", { present: [] })).toEqual(stop([dm]));
  });

  test("everything, when the line names all the Bots", () => {
    for (const body of ["所有Bot都停下", "所有 Bot 停下", "全部bot停止", "所有机器人停下", "所有人都停下", "所有人都停", "全都停", "全都停下", "stop all bots"]) {
      expect(direct(body)).toEqual(stop([everything]));
      expect(group(body)).toEqual(stop([everything]));
    }
    expect(group("所有人都停了吗")).toEqual(asked(false, [everything]));
    expect(direct("全都继续")).toEqual(goOn([everything]));
    expect(direct("全部bot继续")).toEqual(goOn([everything]));
    // 全都 said to 你 or 你们 is still the Bots the line is said to.
    expect(direct("你手头的全都停下")).toEqual(stop());
    for (const body of ["你们全都停下", "大家全都停下"]) {
      expect(direct(body)).toEqual(stop());
      expect(group(body)).toEqual(stop([room]));
    }
    expect(direct("你们全都继续")).toEqual(goOn());
  });

  test("the Bots it names, with an @, or without one and with a comma, 你 or 也 after the name", () => {
    expect(group("视频导演，停下")).toEqual(stop());
    expect(group("视频导演、审片员，停下")).toEqual(stop([bot(DIRECTOR), bot(REVIEWER)]));
    expect(group("审片员你也停下")).toEqual(stop([bot(REVIEWER)]));
    expect(direct("编剧分镜师也停下")).toEqual(stop([bot(WRITER)]));
    expect(group("视频导演先停，审片员继续")).toEqual(hint(BOTH, [bot(DIRECTOR), bot(REVIEWER)]));
    expect(group("@审片员 停下")).toEqual(stop([bot(REVIEWER)]));
    expect(group("@审片员 @视频导演 停下你们的活")).toEqual(stop([bot(REVIEWER), bot(DIRECTOR)]));
    expect(group("@审片 停下")).toEqual(stop([bot(REVIEWER)]));
    expect(group("@视频导演 停下 🙏")).toEqual(stop());
    expect(group("@everyone 停一下")).toEqual(stop([room]));
    // In a direct, naming another Bot means that Bot.
    expect(direct("@审片员 停下")).toEqual(stop([bot(REVIEWER)]));
    expect(group("@审片员 还在继续", { held: () => true })).toEqual(reaffirm([bot(REVIEWER)]));
  });

  test("the plan, for 这件事 when the caller can tell which plan; 这个 names a thing, not the plan", () => {
    expect(direct("这件事先停一下", { planId: PLAN })).toEqual(stop([{ scope: "plan", id: PLAN }]));
    expect(group("这事先停", { planId: PLAN })).toEqual(stop([{ scope: "plan", id: PLAN }]));
    expect(group("这事继续", { planId: PLAN })).toEqual(goOn([{ scope: "plan", id: PLAN }]));
    expect(direct("这件事先停一下")).toEqual(stop());
    expect(group("这件事先停一下")).toEqual(stop([room]));
    for (const body of ["这个先停", "这个继续", "那个停一下"]) expect(group(body, { planId: PLAN }).kind).toBe("possible_control");
  });

  test("in a group, plural or no person: the group", () => {
    for (const body of ["停一下", "先停", "大家停一下", "各位先停", "你们都停下", "所有人停下", "谁都停下"]) {
      expect(group(body)).toEqual(stop([room]));
    }
    expect(group("大家继续")).toEqual(goOn([room]));
  });

  test("in a group, 你 is the Bot you quote, with the group", () => {
    // Quoting a Bot's line stores its @name in front of yours.
    const quoting = { parent: { kind: "bot" as const, author: DIRECTOR }, message: { parent_id: "m-director" } };
    expect(group("@视频导演 停下你所有的工作", quoting)).toEqual(stop([bot(DIRECTOR), room]));
    expect(group("@视频导演 停下", quoting)).toEqual(stop([room]));
    // An @ you add yourself still names that Bot.
    expect(group("@视频导演 @审片员 你停下", quoting)).toEqual(stop([bot(REVIEWER)]));
  });

  test("in a group, 你 with nobody quoted is the only Bot that spoke in the last ten minutes", () => {
    const said = (author: string, minutes: number) => ({ kind: "bot" as const, author, created_at: minutesBefore(minutes) });
    const yours = { kind: "user" as const, author: "user", created_at: minutesBefore(1) };
    expect(group("停下你所有的工作", { recent: [said(REVIEWER, 30), said(DIRECTOR, 3), yours] })).toEqual(stop([bot(DIRECTOR), room]));
    expect(group("停下你所有的工作", { recent: [said(REVIEWER, 5), said(DIRECTOR, 3)] })).toEqual(stop([room]));
    expect(group("停下你所有的工作", { recent: [said(DIRECTOR, 11)] })).toEqual(stop([room]));
    expect(group("停下你所有的工作")).toEqual(stop([room]));
  });

  test("a question, a hint and a go on read their scope the same way", () => {
    expect(group("@审片员 你没停吗")).toEqual(asked(true, [bot(REVIEWER)]));
    expect(group("@审片员 先停，把第三镜换成夜景")).toEqual(hint(["stop"], [bot(REVIEWER)]));
    expect(group("大家继续")).toEqual(goOn([room]));
    expect(direct("所有Bot继续")).toEqual(goOn([everything]));
  });
});

describe("where a word stands", () => {
  // A word that asks why, who or whether asks about the stop; it never requests one.
  for (const body of lines(
    ...["你怎么能停", "怎么可以暂停", "咋能停", "为什么能停", "为啥可以暂停", "干嘛能停", "谁能停一下", "谁可以暂停", "是不是可以停", "是否能停止"],
    ...["有没有能停下", "why would you stop", "why can you pause?"],
    // 了没 asks what happened.
    ...["能停了没", "可以停了没有", "能暂停了没"],
  )) {
    test(`${body}: asks, it requests nothing`, () => {
      expect(direct(body)).toEqual(asked());
      expect(direct(body, { held: () => true })).toEqual(asked());
    });
  }

  // Asked with no 你, 先, 一下, 请 or 麻烦: whether it can be done, not a request; the answer offers the button.
  for (const body of lines("能停么", "能停？", "可以停？", "能暂停吗", "可以中止吗", "渲染可以暂停吗", "都能停吗", "能否停止", "can stop?", "停下好吗")) {
    test(`${body}: asks whether it can stop, with a stop button`, () => {
      expect(direct(body)).toEqual(asked(true));
    });
  }

  for (const body of lines("能先停一下吗", "可以停一下吗", "能不能停", "可不可以暂停", "你能停下来吗", "麻烦停一下好吗", "请停下好吗", "能先别做了吗", "can you stop?", "could you please stop?")) {
    test(`${body}: a request of the Bot, so a stop`, () => {
      expect(direct(body)).toEqual(stop());
    });
  }

  // 的 right after the verb describes a thing; 麻烦 after it asks whether it is a bother; the work
  // right before it is a label for its state.
  for (const body of lines(
    ...["暂停的任务", "所有暂停的任务", "你停下的", "停掉的", "继续的任务", "你停下的生成"],
    ...["停下麻烦吗", "暂停麻烦吗", "暂停麻烦", "继续麻烦"],
    ...["渲染暂停", "任务终止", "生成中止", "任务继续", "工作暂停", "审片继续", "渲染恢复"],
  )) {
    test(`${body}: never acted on`, () => {
      expect(acted(body)).toBe(false);
    });
  }

  test("麻烦 before the verb is polite, and the work after 的 or after the verb is what stops", () => {
    expect(direct("麻烦停一下")).toEqual(stop());
    expect(direct("麻烦你停一下")).toEqual(stop());
    expect(direct("你手头的生成停一下")).toEqual(stop());
    expect(direct("暂停渲染")).toEqual(stop());
    expect(direct("停止生成")).toEqual(stop());
  });

  // 群里 / 私聊里 say where the work a stop or 没停 is about; 手上 and 那边 never say enough.
  for (const body of lines("群里继续", "私聊里继续", "那边停一下", "那边继续", "手上停一下", "手上的停一下", "手上先停", "你那边还在继续")) {
    test(`${body}: never acted on`, () => {
      expect(acted(body)).toBe(false);
    });
  }

  test("群里 and 私聊里 before a stop or 没停 say where", () => {
    expect(direct("私聊里的也停掉")).toEqual(stop());
    expect(group("群里的也停掉")).toEqual(stop([room]));
    expect(direct("你私聊里的没停", { held: () => true })).toEqual(reaffirm());
    expect(direct("群里还在继续", { held: () => true })).toEqual(reaffirm());
  });
});

describe("shown, not said", () => {
  for (const body of lines(
    // Quoted, in brackets, struck out, block-quoted, fenced.
    ...["“停下”", "「停下」", "『继续』", '"stop"', "'continue'", "‘停’", "《停下》", "【停】", "(停)", "［继续］", "~~停下~~", "~~继续~~"],
    ...["> 停下", "> stop", "```停```", "字幕写“停下”"],
    // Code.
    ...["stop()", "pause()", "resume()", "`stop`", "`continue`", "continue;", "--continue", "/stop", "/continue", "#stop", "#暂停#"],
    // A laugh, a smirk, a doubt.
    ...["停下😂", "停停停🤣🤣", "别搞了😂", "住手😂", "stop 😂", "你继续😏", "你继续🙃", "继续🙄", "继续😒", "please continue 🙄"],
    ...["😂继续", "😅继续", "🤔停", "💀停", "停😜", "继续🤪", "继续😝", "停下😛", "停😆", "停😹"],
  )) {
    test(`${body}: only a hint`, () => {
      expect(direct(body).kind).toBe("possible_control");
      expect(group(body).kind).toBe("possible_control");
    });
  }

  test("an apostrophe inside a word, a drawn-out 停~~~ and an emoji that only begs are said", () => {
    expect(direct("don't stop")).toEqual(goOn());
    expect(direct("don’t continue")).toEqual(stop());
    expect(direct("停~~~")).toEqual(stop());
    expect(direct("停下吧🙏")).toEqual(stop());
  });

  // A Bot's name without an @ and with nothing after it that says it is spoken to: a line of a
  // script, a subject, or a name inside another word.
  for (const body of lines("视频导演停下", "审片员：停", "视频导演：继续", "编剧分镜师：停下！", "视频导演 停下", "视频导演和审片员停下", "审片员继续", "审片员还在继续", "停下，审片员")) {
    test(`${body}: only a hint`, () => {
      expect(group(body).kind).toBe("possible_control");
      expect(direct(body).kind).toBe("possible_control");
    });
  }

  test("the hint still names the Bot", () => {
    expect(group("视频导演停下")).toEqual(hint(["stop"]));
  });
});

describe("everything, and only when nothing narrower is said", () => {
  test("所有 Bot and 全都 name everything with no 你, no Bot named, no place and no 这件事", () => {
    for (const body of ["所有bot停下", "所有人都停", "全都给我停下", "停下所有Bot"]) expect(direct(body)).toEqual(stop([everything]));
    for (const body of ["所有Bot继续", "全都继续"]) expect(group(body)).toEqual(goOn([everything]));
    // Narrower words win: the Bots the line is said to, the Bot named, the work in the direct, the plan.
    expect(direct("你们所有人都停下")).toEqual(stop());
    expect(group("你们所有人都停下")).toEqual(stop([room]));
    expect(direct("你所有bot的活都停下")).toEqual(stop());
    expect(group("@审片员 所有bot停下")).toEqual(stop([bot(REVIEWER)]));
    expect(direct("私聊里的全都停下")).toEqual(stop());
    expect(direct("这件事全都停下", { planId: PLAN })).toEqual(stop([{ scope: "plan", id: PLAN }]));
    expect(group("群里全都停下")).toEqual(stop([room]));
  });
});

/**
 * Lines written to break the rules: things said about the work (it stopped, it went on), restoring
 * files, undoing a stop, questions without a question mark, conditions and times, directions for a
 * video, a subject in the story, feedback on how a Bot writes, the first person, emoji that say no,
 * English and mixed lines, scope words. None is acted on but the ones below.
 */
const ATTACK: readonly string[] = [
  // statements that it stopped / stalled (user wants it to go on)
  "又停了",
  "你又停了",
  "进度停了",
  "渲染停了",
  "生成停了",
  "突然停了",
  "它停了",
  "视频停了",
  "预览停了",
  "网停了",
  "电停了",
  "雨停了",
  "早停了",
  "早就停了",
  "都停了",
  "全停了",
  "还停着",
  "渲染已停止",
  "已停",
  "已暂停",
  "暂停中",
  "渲染暂停中",
  "停好了",
  // statements that it went on after a stop (user wants it to stay stopped)
  "又继续了",
  "你又继续了",
  "还在继续",
  "你还在继续",
  "私聊里的还在继续",
  "还在继续啊",
  "仍在继续",
  "照样继续",
  "又恢复了",
  "已恢复",
  "已继续",
  // continue the status quo (under a hold = stay held)
  "继续等",
  "继续等着",
  "继续保持",
  "继续搁置",
  "继续放着",
  "继续冻结",
  "继续挂着",
  "继续观望",
  "继续等待",
  // restore (not resume)
  "恢复文件",
  "恢复版本",
  "恢复旧的",
  "恢复那版",
  "恢复那个",
  "恢复这个",
  "恢复它",
  "把它恢复",
  "帮我恢复",
  "恢复回来",
  "恢复过来",
  "恢复以前的",
  "恢复设置",
  "恢复数据",
  "恢复草稿",
  "恢复删掉的",
  "恢复正常",
  "网络恢复了",
  // undo the stop (means continue)
  "撤销暂停",
  "撤回暂停",
  "结束暂停",
  "退出暂停",
  "停止暂停",
  "取消停止",
  "解除停止",
  "撤销叫停",
  "暂停取消",
  "cancel the pause",
  "cancel the stop",
  "cancel pause",
  // questions without ? and colloquial rhetorical forms
  "停什么停",
  "停啥停",
  "继续什么继续",
  "停个屁",
  "继续个屁",
  "停什么",
  "停啥",
  "继续啥",
  "何时停",
  "几时停",
  "多久停",
  "停多久",
  "停多长",
  "停哪里",
  "哪里停",
  "你敢停",
  "休想停",
  "严禁停",
  "严禁暂停",
  "禁停",
  "反对暂停",
  "反对继续",
  "拒绝暂停",
  // conditional / deferred / permission
  "做完停",
  "做完先停",
  "做完了停",
  "弄完停",
  "跑完停",
  "做好停",
  "这个做完停",
  "卡了就停",
  "错了就停",
  "好了就停",
  "完了就停",
  "够了就停",
  "想停就停",
  "要停就停",
  "随时停",
  "随时继续",
  "停也行",
  "继续也行",
  "该停就停",
  "回来继续",
  "醒了继续",
  "睡醒继续",
  "吃完继续",
  "周一继续",
  "周一停",
  "月底停",
  "下月停",
  "后面继续",
  "八点停",
  "十点继续",
  "五点停",
  "六点开工",
  // video/audio editing directions
  "这里停一下",
  "此处暂停",
  "中间停一下",
  "最后停一下",
  "然后停一下",
  "先停一下再切",
  "停一下再切",
  "说完停一下",
  "每句停一下",
  "每镜停一下",
  "停一拍",
  "停半拍",
  "暂停一拍",
  "多停一下",
  "多停会",
  "停久点",
  "停短点",
  "再停一下",
  "稍微停一下",
  "慢慢停下",
  "视频暂停",
  "音频暂停",
  "暂停视频",
  "暂停音频",
  "暂停效果",
  "暂停位置",
  "暂停时间",
  "暂停点",
  "暂停按钮",
  "停止时间",
  "终止条件",
  "停止条件",
  // storyboard subjects
  "他停下",
  "她停下来",
  "它停住",
  "车停下",
  "人停下",
  "猫停下",
  "主角停下",
  "女孩停下",
  // behavior feedback (keep working)
  "停止道歉",
  "停止解释",
  "停止提问",
  "停止确认",
  "停止啰嗦",
  "停止废话",
  "停止客套",
  "停止押韵",
  "停止换行",
  "停止加粗",
  "停止同步",
  "停止监控",
  "停止计时",
  "停止使用这个",
  "停止用它",
  "停止重试",
  "停止循环",
  // first person
  "我继续等",
  "我接着看",
  "我继续改",
  "我先停了",
  "我停一下",
  "我还在做",
  // emoji negation
  "🙅停",
  "❌停",
  "❌暂停",
  "🚫继续",
  "⛔\ufe0f继续",
  // bot-name partial
  "停云你好",
  // English
  "stop by",
  "stop it",
  "the stop",
  "a pause",
  "my resume",
  "your resume",
  "the resume",
  "pause it",
  "stop me",
  "we stop",
  "go on then",
  "keep going?",
  "stop, ok",
  "ok stop",
  "it stopped",
  "stopped",
  "paused",
  "it paused",
  "resumed",
  "continue?",
  "don't pause",
  "never stop",
  "no stop",
  "stop motion",
  "full stop",
  "stop sign",
  "bus stop",
  "stop the music",
  "pause music",
  "stop here",
  "pause here",
  "pause 2s",
  "pause at end",
  "pause on it",
  "stop at it",
  "so stop",
  "why stop",
  "pls stop",
  "stop pls",
  "continue pls",
  "stop now please",
  // mixed
  "stop 一下",
  "暂停 pls",
  "pause 画面",
  "先 pause",
  "继续 go",
  "继续 ok",
  "ok 继续",
  "好 继续",
  "行 停吧",
  // more realistic chat lines
  "嗯，继续",
  "好的，继续",
  "行，停吧",
  "算了，停吧",
  "停！",
  "停停停",
  "先停",
  "先暂停一下",
  "可以停了",
  "你可以停了",
  "好了停吧",
  "够了",
  "够了停下",
  "够了够了",
  "行了行了",
  "别弄了",
  "不用了",
  "别搞了",
  "好了好了别做了",
  "别做了",
  "别生成了",
  "先别做",
  "先别做了",
  "不做了",
  "算了不做了",
  "取消吧",
  "不要了",
  // reaffirm abuse
  "他还在跑",
  "图还在生成",
  "我还在跑",
  "你还在跑",
  "还在渲染",
  "没停",
  "没停过",
  "雨没停",
  "我没停",
  // possible scope escalation
  "所有人都停",
  "全都停",
  "全都继续",
  "大家继续",
  "你们都停下",
  "所有bot停下",
  "全部bot继续",
  "这件事停一下",
  "这个停一下",
  "这个继续",
  "这个先停",
  "这个别做了",
  "这事先停",
  "这事继续",
  "这个接着做",
  "那个停一下",
  "那个继续",
  "你私聊里的还在继续",
  "私聊那边还在继续",
  "你那边还在继续",
  "群里还在继续",
  "你们还在继续",
  "审片员还在继续",
  "@审片员 还在继续",
  "你怎么又继续了",
  "怎么还在继续",
  "又在继续",
  "你又停了？",
  "渲染又停了",
  "你手头的又停了",
  "怎么又停了",
  "你又开始了",
  "你又接着做了",
  "他又接着做了",
  "你还继续",
  "还继续",
  "继续了",
  "你继续了",
  "都继续了",
];

/** The lines above anyone would mean as a command right now, and why each is one. */
const MEANT: Readonly<Record<string, string>> = {
  还在继续: "says the work has not stopped: reaffirms a hold over it, a status answer with a stop button without one",
  你还在继续: "the same, said to you",
  私聊里的还在继续: "the same, about the direct (the 2026-09-29 incident's own words)",
  还在继续啊: "the same, with a particle",
  你私聊里的还在继续: "the same, said to you about the direct",
  群里还在继续: "the same, about the group",
  你们还在继续: "the same, said to all of you",
  "@审片员 还在继续": "the same, naming the Bot with an @",
  你还在跑: "not stopped (spec phrase 还在跑): reaffirms a hold over it",
  还在渲染: "not stopped: reaffirms a hold over it",
  没停: "not stopped: reaffirms a hold over it",
  "pls stop": "stop, said politely",
  "stop pls": "stop, said politely",
  "stop now please": "stop, now, said politely",
  "continue pls": "go on, said politely",
  "stop 一下": "stop for a moment, in two languages",
  "暂停 pls": "pause, said politely",
  "先 pause": "pause for now",
  "嗯，继续": "an interjection, then go on",
  "算了，停吧": "never mind, stop: stops, and offers to drop the job",
  "停！": "a bare stop",
  停停停: "a bare stop, three times",
  先停: "stop for now",
  先暂停一下: "pause for now",
  别弄了: "stop doing it",
  别搞了: "stop doing it",
  别做了: "stop doing it",
  别生成了: "stop generating",
  先别做: "stop doing it for now",
  先别做了: "stop doing it for now",
  所有人都停: "names every Bot: stops everything",
  全都停: "names every Bot: stops everything",
  所有bot停下: "names every Bot: stops everything",
  全都继续: "names every Bot: goes on everywhere",
  全部bot继续: "names every Bot: goes on everywhere",
  大家继续: "said to everyone here: goes on",
  你们都停下: "said to all of you: stops",
  这件事停一下: "this job: stops the plan the line is about",
  这事先停: "this job, for now",
  这事继续: "this job: goes on",
};

describe("the lines written to break the rules", () => {
  for (const body of ATTACK) {
    const reason = MEANT[body];
    test(`${body}: ${reason ? `acted on — ${reason}` : "never acted on"}`, () => {
      expect(acted(body)).toBe(Boolean(reason));
    });
  }

  test("every line meant as a command is one of them", () => {
    expect(Object.keys(MEANT).filter((body) => !ATTACK.includes(body))).toEqual([]);
  });
});

/**
 * A third round of lines written to break the rules, by kind: directions for the picture and for
 * code, a verb with 的 after it, laughing and sarcasm, rhetorical questions, conditions, quoting,
 * Bot names, ways of writing it, English, answers, markdown, emoji. Each group lists the ones the
 * app acts on and why; every other line is never acted on.
 */
const ATTACK_3: ReadonlyArray<{ about: string; lines: readonly string[]; acted: readonly string[]; why?: string }> = [
  {
    about: "directions for the picture",
    lines: [
      "第三镜结尾停住", "画面停住", "停住", "停住吧", "定格停住两秒", "停在这一帧", "镜头继续推", "继续推", "继续拉远", "主角继续跑", "继续跑", "她继续走", "音乐继续",
      "BGM继续", "BGM停", "配乐停一下", "音乐先停", "音乐暂停一下", "字幕继续", "字幕先停", "旁白继续", "旁白停一下再接", "转场前停一下", "动作停一下", "先停后切", "停一秒",
      "停半秒", "暂停三帧", "继续下一镜", "接着下一镜", "接着拍", "接着剪", "继续剪", "剪辑继续", "继续调色", "调色先停", "渲染继续跑", "继续渲染第四镜", "恢复原来的色调",
      "恢复默认参数", "恢复上一版剪辑", "第二版恢复一下", "恢复正常速度", "慢放后恢复", "恢复原速", "恢复 1x", "倒放然后停", "停在黑场", "这镜不要停", "这镜别停", "镜头不要停",
      "别停在中间", "停一下，看清楚表情", "每个分镜停一下", "继续用这个转场", "接着用上一镜的滤镜", "继续这个节奏", "继续这样", "就这样继续", "继续这样剪", "照这个继续", "按这个继续",
      "审片继续", "渲染也停", "生成先停", "那边停一下", "那边继续", "群里继续", "私聊里继续",
    ],
    acted: [
      "停住", "停住吧", "渲染也停", "生成先停",
    ],
    why: "停住 and the work with 也 / 先 before a stop read as a stop: the words alone cannot tell them from one",
  },
  {
    about: "code and tooling",
    lines: [
      "继续写测试", "接着改", "继续重构", "继续跑测试", "测试继续跑", "先停掉 dev server", "停掉 docker", "暂停 CI", "CI 先停", "继续部署", "部署先停",
      "停止部署", "暂停发布", "恢复发布", "恢复分支", "恢复提交", "恢复 stash", "继续 rebase", "rebase 继续", "--continue",
      "git rebase --continue", "stop()", "pause()", "resume()", "halt()", "`stop`", "`continue`", "/stop", "/continue",
      "#stop", "continue;", "break 还是 continue", "用 continue 跳过", "这里 continue", "stop 按钮", "暂停按钮没反应", "继续按钮", "点继续",
      "点暂停", "按停止", "Ctrl+C 停", "停止监听", "继续监听", "接着 debug", "继续看日志", "日志停了", "日志还在跑", "测试还在跑", "还在编译", "编译还在进行",
      "停止工作", "恢复任务", "恢复活", "恢复啊",
    ],
    acted: [
      "停止工作", "恢复任务", "恢复活", "恢复啊",
    ],
    why: "the verb before the work, and 恢复 with the work or a particle, stop or go on with the work",
  },
  {
    about: "a verb with 的 after it",
    lines: [
      "暂停的任务", "所有暂停的任务", "停掉的任务", "暂停的工作", "你暂停的", "你停掉的", "停下的活", "继续的任务", "暂停的渲染", "中止的任务", "你停下的生成", "所有停掉的",
      "暂停的", "停掉的", "终止的任务", "叫停的任务",
    ],
    acted: [],
  },
  {
    about: "chit-chat, sarcasm, laughing",
    lines: [
      "停下😂", "停停停😂", "停停停🤣🤣", "别搞了😂", "别搞了🤣", "别弄了😂", "你继续😏", "你继续🙃", "继续🙄", "继续😒", "继续编", "你接着编", "继续吹",
      "你继续演", "你继续啊", "继续继续", "继续继续继续", "好好好你继续", "停停停我不听", "打住打住", "打住😂", "住手😂", "住手！", "stop 😂", "stop lol",
      "stop 🤣", "continue 🙄", "please continue 🙄", "继续 :)", "继续 ^_^", "停下 =_=", "停 orz", "哈哈哈停", "开工", "开工开工",
      "开工啦", "开工吧", "开工大吉", "又开工了", "下班，停", "收工", "收工吧", "停工吧", "今天停工", "休息一下", "暂停营业", "暂停一下，喝口水", "先停，吃饭",
    ],
    acted: [
      "你继续啊", "继续继续", "继续继续继续", "打住打住", "住手！", "继续 ^_^", "停下 =_=", "开工", "开工开工", "开工吧", "停工吧",
    ],
    why: "a bare or repeated stop or go on, 开工 and 停工; 你继续啊 (no emoji to tell sarcasm by) and emoticons made of punctuation are not read",
  },
  {
    about: "complaints and rhetorical questions",
    lines: [
      "你怎么能停", "怎么能停", "你怎么可以停下来", "怎么可以暂停", "怎么能停呢", "你怎么能停下呢", "咋能停", "咋可以停", "为什么能停", "为什么可以暂停", "为啥能停", "为何能停",
      "干嘛能停", "谁能停", "谁可以停一下", "谁能停一下", "是不是能停", "是不是可以停", "是否可以停止", "能停了没", "可以停了没", "可以停了没有", "能停下了没有", "能暂停了没",
      "麻烦停了没", "停什么啊", "停下啊喂", "喂喂喂停", "都说了停", "你到底停不停", "停啊", "停呀", "停吧你", "why would you stop",
      "why would you pause", "why would you halt", "why can you stop", "why could you stop", "why would you stop?",
      "怎么能暂停呢", "怎么可以停呢",
    ],
    acted: [
      "停下啊喂", "喂喂喂停", "停啊", "停呀", "停吧你",
    ],
    why: "a stop with particles or interjections; 停吧你 (no emoji to tell anger or jest by) is not read",
  },
  {
    about: "questions without a question mark",
    lines: [
      "继续呢", "停下呢", "能停么", "能停？", "可以停？", "可以暂停？", "你能停", "你能继续", "要停吗", "要继续吗", "还继续吗", "还停吗", "还要继续", "还要停", "继续不",
      "停不", "继续否", "停否", "停还是继续", "继续还是停", "是停还是继续", "暂停么", "需要暂停吗", "需不需要停", "该停了吧", "该继续了", "该停了", "是时候停了", "差不多该停了",
    ],
    acted: [],
  },
  {
    about: "saying where things stand",
    lines: [
      "还在做", "都还在做", "你还在做", "你也还在做", "你们还在做", "还在进行", "都还在进行", "都没停", "还没有停", "你也没停", "still running", "still going",
      "not stopped", "didn't stop", "haven't stopped", "停下了", "已停止", "已经停下", "暂停了", "恢复了", "开工了", "停工了",
    ],
    acted: [
      "还在做", "都还在做", "你还在做", "你也还在做", "你们还在做", "还在进行", "都还在进行", "都没停", "还没有停", "你也没停", "still running", "still going",
      "not stopped", "didn't stop", "haven't stopped",
    ],
    why: "not stopped: reaffirms a hold over it, a status answer with a stop button without one",
  },
  {
    about: "conditions and later",
    lines: [
      "等我回来再继续", "确认后继续", "审完再继续", "审片后继续", "渲染完停", "生成完停", "生成完就停", "跑完这镜停", "这一镜做完先停", "做完这个停", "先做完再停", "先别停，做完再说",
      "要是卡住就停", "超时就停", "报错就停", "出错停", "有问题就停", "没问题继续", "没问题就继续", "OK就继续", "可以就继续", "行就继续", "不行就停", "改完继续", "改好继续",
      "明早继续", "今晚暂停", "下午继续", "过会继续", "一会继续", "等等再继续", "晚点停", "一小时后停", "十分钟后继续", "先继续，晚点停", "继续到十点", "停到明天", "暂停到周一",
    ],
    acted: [],
  },
  {
    about: "quoting someone",
    lines: [
      "他说停下", "她让我们停一下", "审片员说停", "导演说继续", "视频导演说先停", "你刚才说停", "我说继续", "我刚说停", "谁说停的", "谁说要继续", "刚才那个停是误会", "“停下”",
      "「停下」", "『继续』", "\"stop\"", "'continue'", "“暂停”", "“停”", "‘停’", "《停下》", "【停】", "字幕写“停下”", "台词是“停下”", "台词：停下！",
      "他喊“停”", "他喊停", "弹幕都在喊停",
    ],
    acted: [],
  },
  {
    about: "Bot names",
    lines: [
      "视频导演停", "审片员继续", "编剧分镜师暂停", "视频导演，停", "审片员停一下", "@视频导演 继续", "@审片员 暂停", "@编剧分镜师 别停", "视频导演别停", "审片员别继续了",
      "视频导演还在跑", "@视频导演 还在跑", "视频导演和审片员停下", "视频导演、审片员停下", "视频导演 审片员 停", "导演停", "审片停", "编剧停", "视频导演停下来的镜头", "审片员停了",
      "审片员的活先停", "@视频导演停下", "@视频导演，你停",
    ],
    acted: [
      "视频导演，停", "@视频导演 继续", "@审片员 暂停", "@编剧分镜师 别停", "@视频导演 还在跑", "@视频导演停下", "@视频导演，你停",
    ],
    why: "named with an @, or followed by a comma",
  },
  {
    about: "typos and ways of writing it",
    lines: [
      "挺下", "听下", "亭下", "停夏", "停下拉", "停下啦", "停啦", "继续啦", "继续哈", "停哈", "停嘛", "继续嘛", "停呗", "继续呗", "停咯", "停丫", "停停",
      "停停停停停停", "继续继续继续继续", "暂停暂停", "停～", "停~~~", "停——", "停…", "停。。。", "停！！！！", "停!!!", "停?", "停？！", "停！？", "继续？",
      "继续。", "继续！", "继续…", "继续～", "ｓｔｏｐ", "ＳＴＯＰ！", "Ｓｔｏｐ", "ｃｏｎｔｉｎｕｅ", "停 下 来", "继 续", "暫停", "繼續", "停止！！！", "停止。",
      "停止？", "停下来来", "停下下", "停一一下", "继继续", "停\n下", "继续\n\n", "停\t下",
    ],
    acted: [
      "停停", "停停停停停停", "继续继续继续继续", "暂停暂停", "停～", "停~~~", "停——", "停…", "停。。。", "停！！！！", "停!!!", "继续。", "继续！", "继续…",
      "继续～", "ｓｔｏｐ", "ＳＴＯＰ！", "Ｓｔｏｐ", "ｃｏｎｔｉｎｕｅ", "停 下 来", "继 续", "停止！！！", "停止。", "停\n下", "继续\n\n", "停\t下",
    ],
    why: "a bare stop or go on, however written: repeated, spaced, full-width, with punctuation or a line break",
  },
  {
    about: "English and mixed",
    lines: [
      "stop it please", "stop please", "please stop now", "just stop", "just continue", "continue please",
      "keep going please", "go on please", "carry on please", "resume please", "resume now", "resume", "halt now",
      "pause now", "pause please", "pause all", "stop all", "all stop", "all continue", "everyone stop",
      "everyone continue", "everybody stop", "you all stop", "you stop", "you continue", "stop everything now",
      "pause everything", "why stop now", "why continue", "why pause", "can you continue?", "can you pause?",
      "could you stop?", "would you stop?", "would you continue?", "can stop?", "stop?", "stopped?", "still running?",
      "not stopped?", "stop, please", "stop!!!", "STOP NOW", "okay continue", "ok continue", "sure continue",
      "yes continue", "yes stop", "no continue", "no, stop", "nope stop", "continue generating", "stop generating",
      "stop rendering now", "please pause rendering", "请 stop", "stop 吧", "stop 啊", "继续 please", "all 停", "everyone 停",
      "you 继续", "停 now", "pause 一下", "先 stop", "马上 stop", "立刻 pause", "stop stop stop", "resume resume", "just now",
      "now what",
    ],
    acted: [
      "stop please", "please stop now", "just stop", "just continue", "continue please", "keep going please",
      "go on please", "carry on please", "resume please", "resume now", "resume", "halt now", "pause now",
      "pause please", "pause all", "stop all", "all stop", "all continue", "everyone stop", "everyone continue",
      "everybody stop", "you all stop", "you stop", "you continue", "stop everything now", "pause everything",
      "can you pause?", "could you stop?", "would you stop?", "stop, please", "stop!!!", "STOP NOW",
      "continue generating", "stop generating", "stop rendering now", "please pause rendering", "请 stop", "stop 吧",
      "stop 啊", "继续 please", "all 停", "everyone 停", "you 继续", "停 now", "pause 一下", "先 stop", "马上 stop", "立刻 pause",
      "stop stop stop", "resume resume",
    ],
    why: "stop or go on with fillers, scope words or please, and requests asked of you",
  },
  {
    about: "answers to a Bot's question",
    lines: [
      "恢复呀", "不用停吧", "不用暂停啊", "别停吧", "不要停啊", "继续呀", "先暂停吧", "不用继续吧", "不继续", "不用继续", "别暂停", "停下吧",
    ],
    acted: [
      "恢复呀", "不用停吧", "不用暂停啊", "别停吧", "不要停啊", "继续呀", "先暂停吧", "不用继续吧", "不继续", "不用继续", "别暂停", "停下吧",
    ],
    why: "the words are the answer: stop or go on",
  },
  {
    about: "clear commands",
    lines: [
      "全部停下来", "所有的都停下来", "都给我停下", "给我停下", "赶快停下", "快停", "快停下", "赶紧停", "立即停止", "马上停下来", "立刻停止所有工作", "停下所有任务", "所有任务都停",
      "所有工作暂停", "全部暂停", "全部停止", "全停下", "都停下来", "大家都停下来", "你们先停下", "你们都别做了", "所有人停手", "停下所有Bot", "所有Bot都暂停", "都停手",
      "停手吧", "不要再跑了", "别跑了", "停止一切", "一切暂停", "先全部停下", "所有的活都停掉", "全部叫停", "Stop all work", "stop all bots now",
      "stop everything immediately", "halt everything", "everyone stop now", "please stop all work", "stop right now",
      "stop immediately", "STOP STOP STOP", "大家都继续", "全部继续", "所有任务继续", "都恢复", "接着干", "继续干", "继续干活", "继续工作", "你们接着做",
      "恢复工作吧",
    ],
    acted: [
      "全部停下来", "所有的都停下来", "都给我停下", "给我停下", "赶快停下", "快停", "快停下", "赶紧停", "立即停止", "马上停下来", "立刻停止所有工作", "停下所有任务", "所有任务都停",
      "全部暂停", "全部停止", "都停下来", "大家都停下来", "你们先停下", "你们都别做了", "所有人停手", "停下所有Bot", "所有Bot都暂停", "都停手", "停手吧", "先全部停下",
      "所有的活都停掉", "全部叫停", "stop all bots now", "stop everything immediately", "halt everything", "everyone stop now",
      "stop right now", "stop immediately", "STOP STOP STOP", "大家都继续", "全部继续", "继续工作", "你们接着做", "恢复工作吧",
    ],
    why: "meant as commands",
  },
  {
    about: "markdown, formatting, taking it back",
    lines: [
      "~~停下~~", "~~继续~~", "> 停下", "> stop", "**停**", "__继续__", "- 停下", "• 继续", "1. 停下", "#暂停#", "```停```", "停下（划掉）",
      "停下（误）", "*停下", "停/继续", "停 or 继续", "停？继续？",
    ],
    acted: [
      "**停**", "__继续__", "- 停下", "• 继续", "*停下",
    ],
    why: "emphasis and a list bullet are not read as markup",
  },
  {
    about: "asking whether it can",
    lines: [
      "停下麻烦吗", "暂停麻烦吗", "停一下麻烦吗", "停下来麻烦吗", "暂停麻烦", "停下来麻烦", "继续麻烦", "渲染可以暂停吗", "生成能停吗", "任务能暂停吗", "能暂停吗", "可以中止吗",
      "能终止吗", "能停住吗", "可以随时停吗", "能不能随时停", "怎么才能继续", "凭什么停", "你凭什么继续", "难道要停", "难道能停吗", "莫非要停", "何必停", "何必继续", "何苦停",
      "干嘛停", "干嘛继续", "为什么要继续", "继续干嘛", "停干嘛",
    ],
    acted: [],
  },
  {
    about: "a script's lines",
    lines: [
      "审片员：停", "视频导演：继续", "编剧分镜师：停下！", "审片员说：继续",
    ],
    acted: [],
  },
  {
    about: "commands, polite and urgent",
    lines: [
      "麻烦大家先停一下", "麻烦你们都先停下来", "请大家立刻停止", "请所有Bot立刻停止工作", "所有人都给我停下", "请暂停所有任务", "所有的任务先暂停", "先暂停所有的生成", "手上的活都先停一停",
      "停一停", "慢着", "且慢", "先等等", "都别动", "hold on", "wait wait wait", "abort", "cancel everything", "kill it",
      "stop the job", "stop that", "stop working", "stop all now", "STOP. NOW.", "pls stop now", "plz stop",
      "stop thx", "contine", "contiune", "sotp", "Stop!", "STOP!!!!!!!!", "继续继续！", "继续哇", "继续鸭", "冲冲冲", "go ahead",
      "proceed", "please proceed", "ok go on", "yes, go on", "resume work", "resume all", "unpause", "un-pause",
      "恢复运行", "恢复生成", "恢复渲染", "继续生成吧", "接着生成", "接着渲染", "往下做吧", "今天先到这", "到此为止", "停，谢谢", "谢谢，继续", "辛苦了，停一下", "嗯嗯，继续吧",
      "哦哦继续", "啊啊啊停", "呀，停", "紧急停止", "急停", "中断", "中断所有任务", "先刹车", "收手", "喊停", "停掉所有", "全部停掉", "停下！马上！", "STOP！！！全部停下",
    ],
    acted: [
      "麻烦大家先停一下", "麻烦你们都先停下来", "请大家立刻停止", "请所有Bot立刻停止工作", "所有人都给我停下", "请暂停所有任务", "所有的任务先暂停", "先暂停所有的生成", "abort",
      "stop all now", "STOP. NOW.", "pls stop now", "Stop!", "STOP!!!!!!!!", "继续继续！", "proceed", "please proceed",
      "resume all", "unpause", "恢复生成", "恢复渲染", "继续生成吧", "接着生成", "接着渲染", "往下做吧", "嗯嗯，继续吧", "哦哦继续", "啊啊啊停", "呀，停", "中断",
      "中断所有任务", "喊停", "停掉所有", "全部停掉", "停下！马上！", "STOP！！！全部停下",
    ],
    why: "meant as commands",
  },
  {
    about: "labels for a state",
    lines: [
      "生成停止", "渲染暂停", "任务暂停", "任务终止", "任务中止", "渲染中止", "生成中止", "工作暂停", "暂停工作", "停止生成", "任务继续", "工作继续", "渲染继续", "生成继续",
    ],
    acted: [
      "暂停工作", "停止生成",
    ],
    why: "the verb before the work: stop the work",
  },
  {
    about: "emoji and symbols",
    lines: [
      "⏸️", "⏸️ 暂停", "▶️", "▶️ 继续", "▶️停", "⏹停", "🛑停", "🛑 stop", "✋停", "👍继续", "👌继续", "✅继续", "✅停", "🙏继续", "😭停下",
      "😡停下", "😤继续", "🤔停", "🤔继续", "😅继续", "😂继续", "🤣继续", "💀停", "停%", "(╯°□°)╯停", "停下 (´･_･`)",
    ],
    acted: [
      "⏸️ 暂停", "▶️ 继续", "▶️停", "⏹停", "🛑停", "🛑 stop", "✋停", "👍继续", "👌继续", "✅继续", "✅停", "🙏继续", "😭停下", "😡停下",
      "😤继续", "停%",
    ],
    why: "an emoji that is no laugh, smirk, doubt or no adds nothing, even ▶️ or ✅ beside 停",
  },
  {
    about: "greetings and sign-offs",
    lines: [
      "你们继续", "你们继续吧", "大家继续吧", "各位继续", "您继续忙", "您继续", "你忙你的，继续", "继续忙吧", "早上好，开工", "开工咯", "开工了开工了", "今天开工吗",
      "下班了，都停吧", "我走了，你们继续", "晚安，停", "先停，睡了", "停，吃饭", "明天见", "收工收工",
    ],
    acted: [
      "你们继续", "你们继续吧", "大家继续吧", "各位继续", "您继续",
    ],
    why: "said to all of you, or to you politely: go on (您继续 may be sarcasm, not read)",
  },
];

describe("the third round of lines written to break the rules", () => {
  for (const group of ATTACK_3) {
    test(`${group.about}: ${group.acted.length} acted on${group.why ? ` — ${group.why}` : ""}, the rest never`, () => {
      expect(group.lines.filter(acted)).toEqual([...group.acted]);
    });
  }

  test("every line listed as acted on is one of its group's lines", () => {
    expect(ATTACK_3.flatMap((group) => group.acted.filter((body) => !group.lines.includes(body)))).toEqual([]);
  });
});

/**
 * Every word list the reader uses, written out here apart from it, by the same names. A word added
 * to the reader — a filler that lets a new kind of line through, a question word, an emoji — fails
 * the check below until it is added here on purpose, and so does one taken out.
 */
const APPROVED: Readonly<Record<string, readonly string[]>> = {
  stop: [
    ...["停", "停下", "停下来", "停掉", "停止", "停住", "暂停", "停一下", "停手", "停工", "叫停", "喊停", "中止", "终止", "中断", "打住", "住手"],
    ...["别做了", "不要做了", "先别做", "先别做了", "别弄了", "不要弄了", "别搞了", "不要搞了", "别生成了", "不要生成了", "别渲染了", "不要渲染了"],
    ...["别再做了", "不要再做了", "别再生成了", "不要再生成了"],
    ...["别继续", "别继续了", "不要继续", "不要继续了", "先别继续", "先别继续了", "不继续", "不用继续", "不用继续了"],
    ...["别再继续", "别再继续了", "不要再继续", "不要再继续了"],
    ...["stop", "pause", "halt", "abort", "don't continue", "do not continue", "dont continue"],
  ],
  go_on: [
    ...["继续", "继续做", "接着", "接着做", "接着来", "恢复", "往下做", "开工"],
    ...["别停", "不要停", "不用停", "别停下", "不要停下", "别暂停", "不要暂停", "不用暂停"],
    ...["continue", "resume", "proceed", "unpause", "keep going", "go on", "carry on", "don't stop", "do not stop", "dont stop"],
  ],
  not_stopped: [
    ...["没停", "还没停", "没有停", "还没有停", "还不停", "还不停下", "还在做", "还在跑", "还在进行", "还在继续", "还在生成", "还在渲染"],
    ...["still running", "still going", "not stopped", "haven't stopped", "didn't stop"],
  ],
  abandon: ["算了", "不做了", "取消", "作废", "cancel", "never mind", "nevermind"],
  asks_stop: ["停没停", "停不停"],
  asks: ["吗", "了没", "了没有", "有没有", "是不是", "要不要", "是否", "怎么", "为什么", "为啥", "为何", "咋", "干嘛", "谁", "why"],
  particle: ["么", "呢"],
  perfective: ["了"],
  request: ["能", "可以", "能不能", "可不可以", "能否", "麻烦", "好吗", "好么", "行吗", "行么", "可以吗", "好不好", "行不行", "can", "could", "would"],
  negation: [
    ...["不", "别", "没", "没有", "无", "未", "勿", "莫", "甭", "禁", "禁止", "严禁", "反对", "拒绝", "休想", "撤销", "撤回", "结束", "退出", "解除"],
    ...["停止暂停", "停止叫停", "no", "not", "never", "don't", "dont"],
  ],
  global: ["所有bot", "所有bots", "所有的bot", "全部bot", "全部bots", "所有机器人", "所有的机器人", "全部机器人", "所有人都", "all bots", "all the bots", "every bot"],
  all: ["全都"],
  plural: ["你们", "大家", "各位", "所有人", "谁都", "谁也", "everyone", "everybody", "you all"],
  singular: ["你", "您", "you"],
  this_plan: ["这件事", "这事"],
  place: ["群里", "私聊里", "那边"],
  filler: [
    ...["都", "全部", "所有", "手头", "工作", "活", "任务", "生成", "渲染", "审片", "什么都", "什么也"],
    ...["也", "先", "一下", "马上", "立刻", "立即", "立马", "赶紧", "赶快", "快", "给我", "请", "吧", "啊", "呀", "的"],
    ...["唉", "哎", "哎呀", "嗯", "额", "呃", "哦", "喂"],
    ...["please", "pls", "now", "right now", "immediately", "just", "all", "everything", "rendering", "generating"],
  ],
  lookalike: [
    ...["停顿", "停留", "停车", "停靠", "停泊", "停格", "停帧", "停机", "停电", "停播", "停滞", "停摆", "停歇", "停当", "调停", "停用", "暂停键"],
    ...["继续等", "继续保持", "继续搁置", "继续放着", "继续冻结", "继续挂着", "继续观望"],
  ],
  asking_request: ["能不能", "可不可以", "能否", "好吗", "好么", "行吗", "行么", "可以吗", "好不好", "行不行"],
  cancel: ["取消", "作废", "cancel"],
  resume_with: ["恢复", "工作", "活", "任务", "生成", "渲染", "审片", "吧", "啊", "呀"],
  question_word: ["怎么", "为什么", "为啥", "为何", "咋", "干嘛", "谁", "why", "有没有", "是不是", "是否", "要不要"],
  asked_of_you: ["你", "您", "you", "先", "一下", "请", "please", "麻烦", "能不能", "可不可以"],
  work: ["工作", "活", "任务", "生成", "渲染", "审片"],
  after_bare_name: [",", "、", "你", "也"],
  no_emoji: ["🙅", "❌", "❎", "🚫", "⛔", "✖", "👎"],
  tone_emoji: ["😂", "🤣", "😆", "😹", "😏", "🙃", "🙄", "😒", "😅", "🤔", "💀", "😜", "🤪", "😝", "😛"],
};

describe("what is acted on is all control", () => {
  test("every word list of the reader is the one written out here, word for word", () => {
    const sorted = (words: readonly string[] | undefined) => [...(words ?? [])].sort();
    expect(Object.keys(CONTROL_LEXICON).sort()).toEqual(Object.keys(APPROVED).sort());
    for (const [name, words] of Object.entries(CONTROL_LEXICON)) expect({ name, words: sorted(words) }).toEqual({ name, words: sorted(APPROVED[name]) });
  });

  // What a line the app acts on may be made of: the verbs, the words that ask for a stop, the scope
  // words, 群里 and 私聊里, the fillers, and 算了 / 不做了 beside a stop. 了 appears only inside a
  // phrase; no negation, question word, lookalike or 那边 is among them.
  const allowed = [
    ...(["stop", "go_on", "not_stopped", "request", "global", "all", "plural", "singular", "this_plan", "filler"] as const).flatMap((name) => APPROVED[name]!),
    ...["群里", "私聊里", "吗", "算了", "不做了"],
  ].sort((a, b) => b.length - a.length);

  /** What is left of the line once @names, Bot names, punctuation, emoji and those words are gone, read left to right. */
  function leftover(body: string): string {
    let text = body.normalize("NFKC").toLowerCase().replace(/’/g, "'").replace(/@[^\s@]*/g, " ");
    for (const { name } of ROSTER) text = text.replaceAll(name, " ");
    text = text
      .replace(/[\p{P}\p{S}\p{Extended_Pictographic}\u200d\ufe0f]/gu, (ch) => (ch === "'" ? ch : " "))
      .replace(/\s+/g, (space, at: number, whole: string) => (/[a-z]/.test(whole[at - 1] ?? "") && /[a-z]/.test(whole[at + space.length] ?? "") ? " " : ""));
    let left = "";
    for (let at = 0; at < text.length; ) {
      const word = allowed.find((candidate) => text.startsWith(candidate, at));
      if (!word && text[at] !== " ") left += text[at];
      at += word ? word.length : 1;
    }
    return left;
  }

  test("every line of this file the app acts on is made of those words and nothing else", () => {
    const actedOn = [...new Set([...CORPUS, ...ATTACK, ...ATTACK_3.flatMap((group) => group.lines)])].filter(acted);
    expect(actedOn.length).toBeGreaterThan(350);
    expect(actedOn.map((body) => ({ body, left: leftover(body) })).filter(({ left }) => left !== "")).toEqual([]);
  });
});
