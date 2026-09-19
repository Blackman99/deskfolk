export type StarterPromptInput = {
  name?: string | null;
  duties?: string | null;
  boundaries?: string | null;
  locale?: "zh" | "en" | string;
};

export type StarterOption = {
  id: string;
  icon: string;
  label: string;
  prompt: string;
};

function isChinese(text: string): boolean {
  return /[\u4e00-\u9fa5]/.test(text);
}

export function detectDutyIcon(text: string): string {
  const lower = text.toLowerCase();

  // 1. Review / Audit / Security (checked early so "代码审查" or "code review" gets 🔍)
  if (
    /审查|审计|检查|排查|评估|漏洞|安全|风控|review|audit|security|vuln|inspect/i.test(
      lower,
    )
  ) {
    return "🔍";
  }

  // 2. Architecture / Design / Modeling
  if (
    /架构|选型|拓扑|蓝图|模型|设计|规范|architecture|architect|design|model|blueprint|schema/i.test(
      lower,
    )
  ) {
    return "📐";
  }

  // 3. Testing / QA
  if (/测试|用例|质检|断言|qa|test|testing|spec|e2e|assert/i.test(lower)) {
    return "🧪";
  }

  // 4. Performance / Optimization
  if (
    /性能|优化|调优|加速|瓶颈|高并发|optimize|optimization|performance|profiling|speed|concurrency/i.test(
      lower,
    )
  ) {
    return "⚡";
  }

  // 5. Code / Development / Refactoring
  if (
    /代码|开发|编程|重构|组件|接口|前端|后端|全栈|算法|库|函数|dev|code|coding|develop|refactor|component|api|frontend|backend/i.test(
      lower,
    )
  ) {
    return "💻";
  }

  // 6. Documentation / Writing
  if (
    /文档|写作|撰写|文案|总结|记录|笔记|文章|doc|document|write|writing|notes|article/i.test(
      lower,
    )
  ) {
    return "📝";
  }

  // 7. Translation / Localization
  if (
    /翻译|双语|中英|互译|本地化|语言|translate|translation|localize|i18n|l10n/i.test(
      lower,
    )
  ) {
    return "🌐";
  }

  // 8. Data / Analytics
  if (
    /数据|分析|统计|报表|指标|数仓|data|analysis|analytics|metrics|report|sql/i.test(
      lower,
    )
  ) {
    return "📊";
  }

  // 9. Bug / Fix / Debug
  if (/bug|修复|调试|缺陷|排错|fix|debug|error|issue/i.test(lower)) {
    return "🐛";
  }

  // 10. Workspace / Files
  if (/文件|目录|工作区|工程|workspace|file|dir|folder/i.test(lower)) {
    return "📂";
  }

  // 11. Tasks / Plans
  if (/任务|计划|规划|路线图|task|plan|roadmap|schedule/i.test(lower)) {
    return "✨";
  }

  return "🎯";
}

function cleanPrefix(text: string): string {
  return text
    .replace(
      /^[\s*\-•+]+/,
      "",
    )
    .replace(
      /^[0-9]+[.)、\s]+/,
      "",
    )
    .replace(
      /^[一二三四五六七八九十]+[、.\s]+/,
      "",
    )
    .replace(
      /^\([0-9]+\)\s*/,
      "",
    )
    .replace(
      /^(主要负责|负责|专注于|协助用户进行|协助开展|协助进行|协助完成|协助|帮助|用于|致力于|从事|主要工作是|核心工作是)\s*/,
      "",
    )
    .replace(
      /^(responsible for|primarily responsible for|focuses on|focusing on|specializes in|helps with|assists with|dedicated to)\s*/i,
      "",
    )
    .replace(/[。.;；,，]+$/, "")
    .trim();
}

export function parseDutyItems(duties: string): string[] {
  const raw = duties.trim();
  if (!raw) return [];

  // 1. Try splitting by newlines first
  const lines = raw
    .split(/\r?\n/)
    .map(cleanPrefix)
    .filter((line) => line.length >= 2);

  if (lines.length >= 2) {
    return Array.from(new Set(lines));
  }

  const single = lines[0] ?? cleanPrefix(raw);
  if (!single) return [];

  // 2. Try splitting by semicolon
  if (/[;；]/.test(single)) {
    const parts = single
      .split(/[;；]/)
      .map(cleanPrefix)
      .filter((p) => p.length >= 2);
    if (parts.length >= 2) {
      return Array.from(new Set(parts));
    }
  }

  // 3. Try splitting by Chinese comma / enumeration comma / conjunctions
  if (/[、，,]/.test(single) || /\s+(?:和|并|以及)\s+/.test(single)) {
    const parts = single
      .split(/[、，,]|\s+(?:和|并|以及)\s+/)
      .map(cleanPrefix)
      .filter((p) => p.length >= 2 && p.length <= 40);
    if (parts.length >= 2) {
      return Array.from(new Set(parts));
    }
  }

  return [single];
}

function truncateLabel(text: string, maxLen = 22): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function formatDutyItemLabel(item: string, isZh: boolean): string {
  if (!isZh) {
    return truncateLabel(item, 32);
  }
  const startsWithAction = /^(编写|开发|审查|优化|评估|设计|分析|排查|制定|搭建|重构|测试|整理|实现|构建|梳理|维护|校对|翻译)/.test(
    item,
  );
  const label = startsWithAction ? item : `开展${item}`;
  return truncateLabel(label, 22);
}

function formatDutyItemPrompt(item: string, isZh: boolean): string {
  if (!isZh) {
    return `Please assist me with ${item} in the current workspace.`;
  }
  const startsWithAction = /^(编写|开发|审查|优化|评估|设计|分析|排查|制定|搭建|重构|测试|整理|实现|构建|梳理|维护|校对|翻译)/.test(
    item,
  );
  return startsWithAction
    ? `请结合当前工作区，协助我${item}。`
    : `请结合当前工作区，协助我开展${item}。`;
}

export function getStarterOptions(input: StarterPromptInput): StarterOption[] {
  const name = input.name?.trim() ?? "";
  const duties = input.duties?.trim() ?? "";
  const boundaries = input.boundaries?.trim() ?? "";
  const hasChinese =
    isChinese(duties) || isChinese(name) || isChinese(boundaries);
  const isZh = input.locale === "en" ? hasChinese : true;

  const items = parseDutyItems(duties);

  // Scenario 1: Multi-item duties
  if (items.length >= 2) {
    const options: StarterOption[] = [];
    const topItems = items.slice(0, 3);

    topItems.forEach((item, index) => {
      options.push({
        id: `duty-${index}`,
        icon: detectDutyIcon(item),
        label: formatDutyItemLabel(item, isZh),
        prompt: formatDutyItemPrompt(item, isZh),
      });
    });

    const introPrompt = isZh
      ? name
        ? `作为${name}，请介绍一下你的核心能力、工作流程${boundaries ? `以及职责边界（如：${boundaries}）` : ""}。`
        : `请介绍一下你的核心职责与工作流程${boundaries ? `以及职责边界（如：${boundaries}）` : ""}。`
      : name
        ? `As ${name}, please introduce your core capabilities, workflow${boundaries ? ` and boundaries (${boundaries})` : ""}.`
        : `Please introduce your core capabilities and workflow${boundaries ? ` and boundaries (${boundaries})` : ""}.`;

    options.push({
      id: "intro",
      icon: "💬",
      label: isZh
        ? name
          ? `介绍${name}的核心职责与工作方式`
          : "介绍你的核心职责与工作方式"
        : name
          ? `Introduce what ${name} can do`
          : "Introduce your core duties",
      prompt: introPrompt,
    });

    return options;
  }

  // Scenario 2: Single-focus duty (e.g. "架构设计")
  if (items.length === 1 && items[0].length > 0) {
    const focus = items[0];
    const dutyIcon = detectDutyIcon(focus);

    const introPrompt = isZh
      ? name
        ? `作为${name}，请介绍一下你在“${focus}”方面能为我提供哪些支持${boundaries ? `，以及你的职责边界是什么（如：${boundaries}）` : ""}？`
        : `请介绍一下你在“${focus}”方面能为我提供哪些支持${boundaries ? `，以及你的职责边界是什么（如：${boundaries}）` : ""}？`
      : name
        ? `As ${name}, what can you help me with regarding "${focus}"${boundaries ? `, and what are your boundaries (${boundaries})` : ""}?`
        : `What can you help me with regarding "${focus}"${boundaries ? `, and what are your boundaries (${boundaries})` : ""}?`;

    const introOption: StarterOption = {
      id: "intro",
      icon: "💬",
      label: isZh
        ? truncateLabel(`介绍你在${focus}方面的能力与支持`, 24)
        : truncateLabel(`Introduce capabilities in ${focus}`, 36),
      prompt: introPrompt,
    };

    const workspaceOption: StarterOption = {
      id: "workspace",
      icon: dutyIcon,
      label: isZh
        ? truncateLabel(`结合当前工作区开展${focus}`, 22)
        : `Apply to workspace: ${truncateLabel(focus, 16)}`,
      prompt: isZh
        ? `请查看当前工作区的文件和项目结构，为本项目开展${focus}，并给出第一步分析或建议。`
        : `Please review current workspace files and project structure, and help with ${focus}.`,
    };

    const analysisOption: StarterOption = {
      id: "analysis",
      icon: "🔍",
      label: isZh
        ? truncateLabel(`评估当前项目的${focus}合理性与潜在风险`, 24)
        : truncateLabel(`Evaluate ${focus} and risks`, 36),
      prompt: isZh
        ? `请分析当前工作区，评估现有项目的${focus}合理性与技术实现，指出潜在的技术风险与改进空间。`
        : `Please analyze the current workspace to evaluate the project's ${focus}, pointing out potential risks and improvements.`,
    };

    const taskOption: StarterOption = {
      id: "task",
      icon: "✨",
      label: isZh
        ? truncateLabel(`开始一个关于${focus}的新任务`, 22)
        : truncateLabel(`Start a new task on ${focus}`, 36),
      prompt: isZh
        ? `我想开始一个关于${focus}的新任务，请告诉我需要准备哪些信息或从哪里开始入手。`
        : `I'd like to start a new task on ${focus}. What information should I provide to get started?`,
    };

    return [introOption, workspaceOption, analysisOption, taskOption];
  }

  // Scenario 3: Duties empty, but name provided
  if (name.length > 0) {
    const nameIcon = detectDutyIcon(name);
    return [
      {
        id: "intro",
        icon: "💬",
        label: isZh
          ? truncateLabel(`了解${name}的核心职责与工作方式`, 22)
          : truncateLabel(`Introduce what ${name} can do`, 36),
        prompt: isZh
          ? `作为${name}，请介绍一下你可以帮我做什么${boundaries ? `，以及你的职责边界（如：${boundaries}）` : ""}？`
          : `As ${name}, what can you help me with${boundaries ? `, and what are your boundaries (${boundaries})` : ""}?`,
      },
      {
        id: "workspace",
        icon: nameIcon !== "🎯" ? nameIcon : "📂",
        label: isZh ? "查看当前工作区并分析项目结构" : "Inspect current workspace",
        prompt: isZh
          ? "请查看当前工作区的文件和目录结构，给出整体概述与可改进建议。"
          : "Please inspect the files and directory structure in the current workspace and provide an overview.",
      },
      {
        id: "task",
        icon: "✨",
        label: isZh
          ? truncateLabel(`开始一个与${name}协作的新任务`, 22)
          : truncateLabel(`Start a new task with ${name}`, 36),
        prompt: isZh
          ? `我想开始一个新任务，请协助我完成。`
          : `I'd like to start a new task. Please assist me.`,
      },
    ];
  }

  // Scenario 4: Empty fallback
  return [
    {
      id: "intro",
      icon: "💬",
      label: isZh ? "你可以帮我做什么？" : "What can you help me with?",
      prompt: isZh ? "你可以帮我做什么？" : "What can you help me with?",
    },
    {
      id: "workspace",
      icon: "📂",
      label: isZh ? "查看当前工作区有哪些文件" : "List files in the workspace",
      prompt: isZh
        ? "查看当前工作区有哪些文件"
        : "List files in the workspace",
    },
    {
      id: "task",
      icon: "✨",
      label: isZh ? "开始一个新任务" : "Start a new task",
      prompt: isZh ? "开始一个新任务" : "Start a new task",
    },
  ];
}
