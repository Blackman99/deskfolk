import type { ToolDef } from "../tool-schema";

/**
 * One entry of an endpoint's model list, as add_endpoint and update_endpoint take it. The window,
 * pictures and output cap (ADR 0067) are the Bot's to set as well as yours; the measured speed is
 * written by measure_model only.
 */
const MODEL_ENTRY = {
  anyOf: [
    { type: "string" },
    {
      type: "object",
      properties: {
        name: { type: "string" },
        price: { type: "number" },
        pricing: {
          type: "object",
          properties: {
            input: { type: "number", minimum: 0 },
            output: { type: "number", minimum: 0 },
            cached_input: { type: "number", minimum: 0 },
          },
          required: ["input", "output"],
        },
        thinking_levels: {
          type: "array",
          items: { type: "string" },
        },
        strengths: { type: "array", items: { type: "string" } },
        context_window: { type: ["integer", "null"], minimum: 1 },
        input_image: { type: ["boolean", "null"] },
        max_output: { type: ["integer", "null"], minimum: 1 },
      },
      required: ["name"],
    },
  ],
};

/** What every entry's fields do when left out, said the same way in both tools. */
const MODEL_ENTRY_RULES = {
  zh: "每项是名字字符串，或 { name, price?, pricing?: { input, output, cached_input? }, thinking_levels?, strengths?, context_window?, input_image?, max_output? }。price 是选路参考价；pricing 是 USD / 百万 token 计费单价；context_window 是模型每次能读的 token 数（本地模型服务超出会截断提示词）；input_image 是能不能看图；max_output 是每一步最多写多少 token（不填是 32768）。每一项都会整项替换这个模型原来的设置：没写的 price、pricing 会清空，thinking_levels 回到 none/low/medium/high，strengths 清空；context_window、input_image、max_output 和测出的速度没写就保留，写 null 才清掉。只想改一个字段时，从 list_endpoints 的 model_catalog 把这一项整个抄过来再改那一个字段；只写名字字符串会把这个模型的价格、思考等级和擅长领域都重置掉。",
  en: "Each item is a name string or { name, price?, pricing?: { input, output, cached_input? }, thinking_levels?, strengths?, context_window?, input_image?, max_output? }. price is a routing reference; pricing is USD per million tokens; context_window is how many tokens the model reads per request (a local model server cuts a prompt past it); input_image is whether it takes pictures; max_output is the most tokens one step may write (32768 when unset). Each item replaces that model's settings as a whole: price and pricing left out are cleared, thinking_levels go back to none/low/medium/high, strengths are emptied; context_window, input_image, max_output and the measured speed left out are kept, and null clears them. To change one field, copy the item whole from list_endpoints' model_catalog and change only that field; a bare name string resets the model's prices, thinking levels and strengths.",
};

export const LIST_ENDPOINTS: ToolDef = {
  name: "list_endpoints",
  description: {
    zh: "列出名册级端点和模型设置。每个端点返回 id、名称、URL、接口格式、是否已配密钥、模型名单（model_catalog 里每个模型的价格、思考等级、上下文窗口、能否看图、输出上限和测出的速度）和是否为默认端点；另返回读句用的模型 reader_model（null 表示跟默认模型走；用户选了自己的 Claude 模型时是 { runner: \"claude_code\", model, config_dir }，只读，你改不了）和模型阶梯 model_ladder（从弱到强）。永不返回密钥。",
    en: "List roster-level endpoints and the model settings. Each endpoint comes with id, name, URL, API format, whether a key is set, its model list (model_catalog: each model's prices, thinking levels, context window, whether it takes pictures, output cap and measured speed) and whether it is the default endpoint; also reader_model, the model that reads lines (null follows the default model; { runner: \"claude_code\", model, config_dir } when the user chose one of their own Claude models, which is read-only for you), and model_ladder, weaker to stronger. Never returns secrets.",
  },
  properties: {},
};

export const ADD_ENDPOINT: ToolDef = {
  name: "add_endpoint",
  description: {
    zh: "新建一个名册级端点（OpenAI 兼容或 Anthropic 兼容）。不要传密钥：批准卡上由用户粘贴。新建端点和改 URL、接口格式或工作区 id 会停下来等批准。空名单合法。有名单则 default_model 须在名单里，省略则用第一项。",
    en: "Create a roster-level endpoint (OpenAI-compatible or Anthropic-compatible). Do not pass a key; the user pastes it on the approval card. Adding an endpoint or changing a URL, API format or workspace id pauses for approval. An empty model list is allowed. If a list is given, default_model must be on it; omit to use the first name.",
  },
  properties: {
    name: { type: "string", description: { zh: "端点名称。", en: "Endpoint name." } },
    base_url: {
      type: "string",
      description: {
        zh: "http 或 https URL。OpenAI 兼容的通常以 /v1 结尾；Anthropic 兼容的填 Claude Code 的 ANTHROPIC_BASE_URL 那种（如 https://api.anthropic.com），不带 /v1/messages。",
        en: "http or https URL. An OpenAI-compatible one usually ends in /v1; an Anthropic-compatible one is what Claude Code takes as ANTHROPIC_BASE_URL (e.g. https://api.anthropic.com), without /v1/messages.",
      },
    },
    api_format: {
      type: "string",
      enum: ["openai", "anthropic"],
      description: {
        zh: "接口格式：openai 是 Chat Completions，anthropic 是 Anthropic Messages。省略为 openai。",
        en: "API format: openai is Chat Completions, anthropic is Anthropic Messages. Omit for openai.",
      },
    },
    workspace_id: {
      type: "string",
      description: {
        zh: "Anthropic 工作区 id（wrkspc_…），只对 anthropic 格式有意义：不限定工作区的个人 API 密钥必须带它，否则请求被拒。省略则不设。",
        en: "Anthropic workspace id (wrkspc_…), only meaningful for the anthropic format: a personal API key not scoped to one workspace needs it or its requests are refused. Omit for none.",
      },
    },
    models: {
      type: "array",
      items: MODEL_ENTRY,
      description: {
        zh: `整份模型名单。${MODEL_ENTRY_RULES.zh}省略则为空名单。`,
        en: `The full model list. ${MODEL_ENTRY_RULES.en} Omit for an empty list.`,
      },
    },
    default_model: {
      type: "string",
      description: {
        zh: "该端点的默认模型。须在名单里。省略则用名单第一项。",
        en: "Default model for this endpoint. Must be on the list. Omit to use the first name.",
      },
    },
  },
  required: ["name", "base_url"],
};

export const UPDATE_ENDPOINT: ToolDef = {
  name: "update_endpoint",
  description: {
    zh: "改一个已有端点。id 来自 list_endpoints。提供 models 就是整份新名单。改 URL、接口格式或工作区 id 会停下来等批准；改名、名单、该端点默认模型直接执行。默认端点不能改 URL、接口格式和工作区 id。不能换密钥。",
    en: "Change an existing endpoint. id comes from list_endpoints. Providing models replaces the whole list. Changing the URL, API format or workspace id pauses for approval; renaming, replacing the list, or changing that endpoint's default model runs immediately. You cannot change the default endpoint's URL, API format or workspace id. You cannot rotate keys.",
  },
  properties: {
    id: { type: "string", description: { zh: "端点 id。", en: "Endpoint id." } },
    name: { type: "string", description: { zh: "新名称。", en: "New name." } },
    base_url: {
      type: "string",
      description: { zh: "新的 http 或 https URL。默认端点不能改。", en: "New http or https URL. Forbidden on the default endpoint." },
    },
    api_format: {
      type: "string",
      enum: ["openai", "anthropic"],
      description: {
        zh: "新的接口格式：openai（Chat Completions）或 anthropic（Anthropic Messages）。默认端点不能改。",
        en: "New API format: openai (Chat Completions) or anthropic (Anthropic Messages). Forbidden on the default endpoint.",
      },
    },
    workspace_id: {
      type: "string",
      description: {
        zh: "Anthropic 工作区 id（wrkspc_…），只对 anthropic 格式有意义：不限定工作区的个人 API 密钥必须带它，否则请求被拒。空字符串清除。默认端点不能改。",
        en: "Anthropic workspace id (wrkspc_…), only meaningful for the anthropic format: a personal API key not scoped to one workspace needs it or its requests are refused. An empty string clears it. Forbidden on the default endpoint.",
      },
    },
    models: {
      type: "array",
      items: MODEL_ENTRY,
      description: {
        zh: `整份新名单：没列上的模型会从这个端点去掉。${MODEL_ENTRY_RULES.zh}省略 models 则不改名单。`,
        en: `The full new list: a model left off it is removed from this endpoint. ${MODEL_ENTRY_RULES.en} Omit models to leave the list unchanged.`,
      },
    },
    default_model: {
      type: "string",
      description: { zh: "该端点的新默认模型。须在（更新后的）名单里。", en: "New default model for this endpoint. Must be on the (updated) list." },
    },
  },
  required: ["id"],
};

export const DELETE_ENDPOINT: ToolDef = {
  name: "delete_endpoint",
  description: {
    zh: "删除一个非默认端点。默认端点不能删。",
    en: "Delete a non-default endpoint. The default endpoint cannot be deleted.",
  },
  properties: {
    id: { type: "string", description: { zh: "端点 id。", en: "Endpoint id." } },
  },
  required: ["id"],
};

export const MEASURE_MODEL: ToolDef = {
  name: "measure_model",
  description: {
    zh: "测一个已启用模型：先让它流式写一段，量首字时间和每秒 token，再给它一个工具看会不会调用。测到速度的六成记进这个模型的条目，定每一步最多写多久。本地模型服务最需要；要几秒到几分钟，服务正忙时还要等它手上的请求。不调工具的模型做不了 Bot 的活。直接执行。",
    en: "Test one enabled model: it streams a short reply to time the first token and the tokens per second, then is offered a tool to see whether it calls it. 60% of the measured speed is recorded on the model's entry and sizes how long one step may write. Local model servers need it most; it takes seconds to minutes, longer while the server is busy. A model that does not call tools cannot do a Bot's work. Runs immediately.",
  },
  properties: {
    endpoint_id: { type: "string", description: { zh: "端点 id，来自 list_endpoints。", en: "Endpoint id from list_endpoints." } },
    model: { type: "string", description: { zh: "这个端点名单上的模型名。", en: "A model name on that endpoint's list." } },
  },
  required: ["endpoint_id", "model"],
};

export const UPDATE_MODEL_SETTINGS: ToolDef = {
  name: "update_model_settings",
  description: {
    zh: "改全局的模型设置：哪个端点是默认端点、读句用哪个模型、模型阶梯。至少给一项；只能在已配置的端点和名单上的模型里选。直接执行，不等批准：所有没钉模型的 Bot、读句（没单独设时）、整理和判断都跟着默认端点的默认模型走，改之前先 list_endpoints 看清现状，改完告诉用户改了什么。",
    en: "Change the app-wide model settings: which endpoint is the default, which model reads lines, and the model ladder. Give at least one; choose only among configured endpoints and the models on their lists. Runs immediately, without approval: every Bot not pinned to a model, the readings (unless set apart), organizing and judgements follow the default endpoint's default model, so check list_endpoints first and tell the user what you changed.",
  },
  properties: {
    default_endpoint_id: {
      type: "string",
      description: { zh: "设为默认端点的端点 id。", en: "Id of the endpoint to make the default." },
    },
    reader_model: {
      type: ["object", "null"],
      properties: {
        endpoint_id: { type: "string", description: { zh: "端点 id。", en: "Endpoint id." } },
        model: { type: "string", description: { zh: "那个端点名单上的模型名。", en: "A model name on that endpoint's list." } },
      },
      required: ["endpoint_id", "model"],
      description: {
        zh: "读你每一句话用的模型 { endpoint_id, model }，须在那个端点的名单上；null 回到跟默认模型走。用户在等它读完才会被处理，选个快的。用户自己的 Claude 模型只有用户能选：你只能把它换成端点上的模型或 null。",
        en: "The model that reads each of the user's lines, { endpoint_id, model }, on that endpoint's list; null goes back to following the default model. The user's line waits for it, so pick a fast one. A Claude model of the user's own is the user's to choose: you can only replace it with an endpoint's model or null.",
      },
    },
    model_ladder: {
      type: "array",
      items: {
        type: "object",
        properties: {
          endpoint_id: { type: "string" },
          model: { type: "string" },
        },
        required: ["endpoint_id", "model"],
      },
      description: {
        zh: "整份模型阶梯，从弱到强，最多 8 级，每个模型一次：一件事在当前模型上反复失败时往上换一级。[] 清空阶梯。需要引擎第 7 级。",
        en: "The whole model ladder, weaker to stronger, at most 8 rungs, each model once: a job that keeps failing on its model moves one rung up. [] removes the ladder. Needs engine level 7.",
      },
    },
  },
};

export const LIST_MCP_SERVERS: ToolDef = {
  name: "list_mcp_servers",
  description: {
    zh: "列出名册级 MCP 服务器（stdio 与 HTTP）。",
    en: "List roster-level MCP servers (stdio and HTTP).",
  },
  properties: {},
};

export const ADD_MCP_SERVER: ToolDef = {
  name: "add_mcp_server",
  description: {
    zh: "新增一台名册级 MCP。stdio 传 command（可附 args）；HTTP / Streamable HTTP 传 url（可附非鉴权 headers）。用户给了 MCP URL 就走 url，不要说没有这个工具。会停下来等用户批准；HTTP 的 Authorization 在批准卡上贴，不要放进工具参数。批准后所有 Bot 都能调它的工具。enabled 默认 true。",
    en: "Add a roster-level MCP server. For stdio pass command (optional args); for HTTP / Streamable HTTP pass url (optional non-auth headers). If the user gave an MCP URL, use url — do not claim this tool is missing. Pauses for the user's approval; paste HTTP Authorization on the approval card, never in a tool argument. After approval every Bot can call its tools. enabled defaults to true.",
  },
  properties: {
    name: { type: "string", description: { zh: "服务器名。会出现在 mcp_<name>_<tool> 前缀里。", en: "Server name. Used in the mcp_<name>_<tool> prefix." } },
    transport: {
      type: "string",
      enum: ["stdio", "http"],
      description: {
        zh: "stdio 或 http。省略时：有 url 无 command 则为 http，否则 stdio。",
        en: "stdio or http. Omit: http when url is set and command is not, otherwise stdio.",
      },
    },
    command: { type: "string", description: { zh: "stdio 可执行文件。", en: "stdio executable." } },
    args: {
      type: "array",
      items: { type: "string" },
      description: { zh: "stdio 参数数组。省略则为空。", en: "stdio argument array. Omit for none." },
    },
    url: {
      type: "string",
      description: { zh: "HTTP MCP 的 http 或 https URL。", en: "http or https URL for an HTTP MCP server." },
    },
    headers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "string" },
        },
        required: ["name", "value"],
      },
      description: {
        zh: "额外 HTTP 头。不要放 Authorization；那个在批准卡上贴。",
        en: "Extra HTTP headers. Do not put Authorization here; paste that on the approval card.",
      },
    },
    enabled: {
      type: "boolean",
      description: { zh: "是否启用。默认 true。", en: "Whether it is enabled. Default true." },
    },
    usage_note: {
      type: "string",
      description: {
        zh: "用法备注：这台用来做什么、什么时候用、什么时候不要用。写给所有 Bot 看，进每一跳的「本轮 MCP」段，排在服务器自带说明前面。可省略。",
        en: "Usage note: what this server is for, when to use it, when not to. Visible to every Bot in each hop's MCP block, above the server's own instructions. Optional.",
      },
    },
  },
  required: ["name"],
};

export const UPDATE_MCP_SERVER: ToolDef = {
  name: "update_mcp_server",
  description: {
    zh: "改一台已有 MCP。改 command / args / url / headers 会停下来等批准；改名、启用、停用、改用法备注直接执行。",
    en: "Change an existing MCP server. Changing command / args / url / headers pauses for approval; renaming, enabling, disabling, or changing the usage note runs immediately.",
  },
  properties: {
    id: { type: "string", description: { zh: "MCP id。", en: "MCP server id." } },
    name: { type: "string", description: { zh: "新名称。", en: "New name." } },
    transport: {
      type: "string",
      enum: ["stdio", "http"],
      description: { zh: "stdio 或 http。", en: "stdio or http." },
    },
    command: { type: "string", description: { zh: "新的 stdio 可执行文件。", en: "New stdio executable." } },
    args: {
      type: "array",
      items: { type: "string" },
      description: { zh: "新的 stdio 参数数组。", en: "New stdio argument array." },
    },
    url: {
      type: "string",
      description: { zh: "新的 HTTP MCP URL。", en: "New HTTP MCP URL." },
    },
    headers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "string" },
        },
        required: ["name", "value"],
      },
      description: {
        zh: "新的非鉴权 HTTP 头。不要放 Authorization。",
        en: "New non-auth HTTP headers. Do not put Authorization here.",
      },
    },
    enabled: { type: "boolean", description: { zh: "是否启用。", en: "Whether it is enabled." } },
    usage_note: {
      type: "string",
      description: {
        zh: "新的用法备注（做什么、何时用、何时不用）；传空字符串清掉。直接执行，不等批准；改连接也不会丢。",
        en: "New usage note (what for, when, when not); pass an empty string to clear it. Runs immediately without approval and survives connection changes.",
      },
    },
  },
  required: ["id"],
};

export const DELETE_MCP_SERVER: ToolDef = {
  name: "delete_mcp_server",
  description: {
    zh: "删除一台 MCP 服务器。直接执行，不等批准。",
    en: "Delete an MCP server. Runs immediately; does not wait for approval.",
  },
  properties: {
    id: { type: "string", description: { zh: "MCP id。", en: "MCP server id." } },
  },
  required: ["id"],
};
