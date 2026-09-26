const ALREADY_ANSWERED_SIGNAL =
  "(?:(?:i(?:'ve)?|we(?:'ve)?|the\\s+(?:question|answer|reply|message|response))\\s+)?(?:have\\s+|has\\s+|is\\s+|was\\s+)?(?:already\\s+)?(?:answered|replied|responded|addressed)(?:\\s+(?:to\\s+)?(?:the|this|above|your)?\\s*(?:question|inquiry|prompt|request|user))?(?:\\s+(?:in|to|on)\\s+(?:the|this)\\s+(?:session|chat|conversation|thread|group))?(?:\\s+above)?|(?:already\\s+)?(?:answered|replied|responded|addressed)\\s+(?:in|to|on)\\s+(?:the|this)\\s+(?:session|chat|conversation|thread|group)|already\\s+(?:answered|replied|responded|addressed)|(?:the\\s+)?(?:message|reply|response|answer)\\s+(?:has\\s+been\\s+|is\\s+|was\\s+)?(?:already\\s+)?(?:sent|posted|delivered)(?:\\s+(?:in|to)\\s+(?:the|this)\\s+(?:session|chat|conversation|thread|group))?|(?:message|reply|response)\\s+(?:sent|posted|delivered)|already\\s+(?:sent|posted)|(?:(?:本次|本轮|这轮|这一轮|前面|上面)?(?:已经?|已)(?:在|向)?(?:当前|本)?(?:会话|群|聊天|主转录|用户)?(?:中|里)?(?:回答|回复|解答|说明|解释|发[送出过])(?:完毕|过了?|了|过)?(?:用户(?:的)?(?:问题|提问|请求|疑惑))?)|(?:在(?:当前|本)?(?:会话|群|聊天|主转录)(?:中|里)?(?:已经?|已)?(?:回答|回复|解答|说明|解释|发[送出过])(?:完毕|过了?|了|过)?)|(?:(?:消息|回复|回答|解答|答案)(?:已经?|已)?(?:发[送出]|完成|完毕|给出))|(?:已向用户(?:回复|解答|说明))";

const NO_WORK_SIGNAL =
  `(?:这一轮|本轮|本次|这轮|目前)?(?:没有|无)(?:新的?)?(?:实现任务|任务|工作|事项|需求|信息)|无其他事项|无事可做|没有工作要(?:进行|做|处理)|没有要(?:做|处理)的|没有需要(?:做的|处理|补充|回复|发言)|无需(?:再)?(?:发言|发话|发(?:送)?(?:消息|信息)?|回复|说明|行动|补充|处理|再说)|不需要(?:再)?(?:发言|发(?:送)?(?:消息|信息)?|回复)|无需其它(?:操作|处理)|无须(?:再)?(?:发言|发(?:送)?(?:消息|信息)?|回复)|(?:暂)?(?:无|不)发言|保持沉默|(?:stay|staying|remain|remaining) silent|到此结束|本轮结束|这一轮结束|本次交流到此结束|本次任务结束|(?:本次|本轮|这轮|这一轮)?(?:已|已经)?完成自我介绍|自我介绍(?:已|已经)?(?:完成|完毕|发[过出])|(?:已|已经)?(?:完成介绍|介绍完毕)|介绍已经?发[过出]|已经介绍过|(?:the )?introduction is (?:already )?(?:posted|complete(?:d)?)|introduction is (?:complete(?:d)?|done)|no further (?:message|reply|action) is needed|no (?:reply|message) needed|(?:this|the) turn is complete|no new work(?:\\s+this\\s+turn)?|nothing (?:new(?:\\s+work)?|else)(?:\\s+to (?:add|do|say|report))?|nothing to (?:add|do|say|report)|no (?:further|additional) (?:work|action|comment|reply|message)|(?:just )?end(?:ing)? (?:the|this) turn|standing by|no work to do|<\\|eos\\|>|${ALREADY_ANSWERED_SIGNAL}`;

const STATUS_SYNC_CLAUSE =
  "(?:(?:v\\d+\\s*)?(?:设计|方案|内容|代码|文件|任务|报告|记录|结果)?(?:已经?|已)?(?:写进|写入|写到|保存到|更新到|生成到|落到)\\s*(?:工作区(?:根目录)?\\s*)?`?[\\w.-]+`?\\s*(?:并(?:已)?(?:同步|发|发送)到群[里内]?)?|并(?:已)?(?:同步|发|发送)到群[里内]?|(?:the\\s+)?(?:design|draft|code|file|task|result)\\s+(?:has\\s+been|is|was)\\s+(?:written|saved|added)\\s+to\\s+`?[\\w.-]+`?(?:\\s+and\\s+(?:shared|synced)\\s+to\\s+(?:the\\s+)?group)?|and\\s+(?:shared|synced)\\s+to\\s+(?:the\\s+)?group)";

const FILLER =
  `${STATUS_SYNC_CLAUSE}|(?:本次|本轮|这轮|这一轮)?(?:已|已经)?完成自我介绍|自我介绍(?:已|已经)?(?:完成|完毕|发[过出])|(?:已|已经)?(?:完成介绍|介绍完毕)|介绍已经?发[过出]|已经介绍过|this turn|the turn|in\\s+(?:the|this)\\s+(?:session|chat|conversation|thread|group)|在(?:当前)?(?:会话|群|聊天)[中里]?|本次|本轮|这轮|这一轮|好的|嗯|收到|明白|ok(?:ay)?|alright|got it|understood|并\\s*@\\s*了[^。！？.!?]*|等他们各自发言|waiting for (?:them|the others|others) to (?:speak|reply|respond|post)`;

const WORK_MARKERS =
  /```|https?:\/\/|(?:^|\s)(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.(?:md|txt|json|ts|tsx|js|jsx|py|rs|toml|yml|yaml)\b/i;

const MAX_CLOSER_CODE_POINTS = 160;

/** Emphasis, a quote or heading marker, and wrapping brackets only dress a closer up. */
function plainLine(text: string): string {
  return text
    .replace(/^[ \t]*(?:>+|#{1,6})[ \t]*/gm, "")
    .replace(/[*_]+/g, "")
    .replace(/[()（）[\]【】「」]/g, " ");
}

export function isNoWorkCloser(body: string): boolean {
  const text = body.trim();
  if (!text) return true;
  if ([...text].length > MAX_CLOSER_CODE_POINTS) return false;
  if (/@[^\s@]/.test(text) || /[?？]/.test(text)) return false;
  const textWithoutStatusSync = text.replace(new RegExp(STATUS_SYNC_CLAUSE, "gi"), " ");
  if (WORK_MARKERS.test(textWithoutStatusSync)) return false;
  const plain = plainLine(text);
  const signal = new RegExp(NO_WORK_SIGNAL, "gi");
  if (!signal.test(plain)) return false;
  const remainder = plain
    .replace(new RegExp(NO_WORK_SIGNAL, "gi"), " ")
    .replace(new RegExp(FILLER, "gi"), " ")
    .replace(
      /(?:^|\s)(?:时|了|的|地|得|吧|啊|呢|嘛|啦|呀|哦|哈|就|也|还|再|已|已经|本次|这轮|这一轮|其|其他|其它|该|此|各|即|可|且|并|and|the|this|that|just|now|for|to|a|an|i|we|have|has|been|in|on|already)(?=\s|$)/gi,
      " ",
    )
    .replace(/[\s,，.。!！;；:：、'"“”‘’~～…—\-–`]+/g, " ")
    .trim();
  return remainder.length === 0;
}
