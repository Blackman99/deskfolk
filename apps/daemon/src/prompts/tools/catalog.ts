import type { ToolDef } from "../tool-schema";

export const LIST_ENDPOINTS: ToolDef = {
  name: "list_endpoints",
  description: {
    zh: "列出名册级端点。返回 id、名称、URL、是否已配密钥、模型名单和是否为默认端点。永不返回密钥。",
    en: "List roster-level endpoints. Returns id, name, URL, whether a key is set, the model list, and whether it is the default endpoint. Never returns secrets.",
  },
  properties: {},
};

export const ADD_ENDPOINT: ToolDef = {
  name: "add_endpoint",
  description: {
    zh: "新建一个名册级 OpenAI 兼容端点。不要传密钥：批准卡上由用户粘贴。新建端点和改 URL 会停下来等批准。空名单合法。有名单则 default_model 须在名单里，省略则用第一项。",
    en: "Create a roster-level OpenAI-compatible endpoint. Do not pass a key; the user pastes it on the approval card. Adding an endpoint or changing a URL pauses for approval. An empty model list is allowed. If a list is given, default_model must be on it; omit to use the first name.",
  },
  properties: {
    name: { type: "string", description: { zh: "端点名称。", en: "Endpoint name." } },
    base_url: {
      type: "string",
      description: { zh: "OpenAI 兼容的 http 或 https URL。", en: "OpenAI-compatible http or https URL." },
    },
    models: {
      type: "array",
      items: {
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
            },
            required: ["name"],
          },
        ],
      },
      description: {
        zh: "整份模型名单。每项是名字字符串，或 { name, price?, pricing?: { input, output, cached_input? }, thinking_levels?, strengths? }。price 是选路参考价；pricing 是 USD / 百万 token 计费单价。省略则为空名单。",
        en: "The full model list. Each item is a name string or { name, price?, pricing?: { input, output, cached_input? }, thinking_levels?, strengths? }. price is a routing reference; pricing is USD per million tokens. Omit for an empty list.",
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
    zh: "改一个已有端点。id 来自 list_endpoints。提供 models 就是整份新名单。改 URL 会停下来等批准；改名、名单、该端点默认模型直接执行。默认端点不能改 URL。不能换密钥。",
    en: "Change an existing endpoint. id comes from list_endpoints. Providing models replaces the whole list. Changing the URL pauses for approval; renaming, replacing the list, or changing that endpoint's default model runs immediately. You cannot change the default endpoint's URL. You cannot rotate keys.",
  },
  properties: {
    id: { type: "string", description: { zh: "端点 id。", en: "Endpoint id." } },
    name: { type: "string", description: { zh: "新名称。", en: "New name." } },
    base_url: {
      type: "string",
      description: { zh: "新的 http 或 https URL。默认端点不能改。", en: "New http or https URL. Forbidden on the default endpoint." },
    },
    models: {
      type: "array",
      items: {
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
            },
            required: ["name"],
          },
        ],
      },
      description: {
        zh: "整份新名单。pricing 的 input / output / cached_input 是 USD / 百万 token 计费单价；省略 pricing 清空单价。省略 models 则不改名单。",
        en: "The full new list. pricing input / output / cached_input rates are USD per million tokens; omit pricing to clear rates. Omit models to leave the list unchanged.",
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
