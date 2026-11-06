/**
 * The endpoint presets of the wizard's second step. No model names written in for OpenAI and
 * OpenRouter: their lists move too fast, and the key fetches what the account has. Model servers on
 * this computer (ADR 0067) have no key, and their list is read from what is installed.
 */
import { connectorById, type ApiFormat } from "@real-bot/protocol";

export type Preset = {
  id: string;
  name: string;
  url: string;
  format: ApiFormat | null;
  models: readonly string[];
  defaultModel: string;
};

const first = (id: string) => connectorById(id as never)!.plans[0]!.baseUrl;

export const PRESETS: readonly Preset[] = [
  { id: "openai", name: "OpenAI", url: "https://api.openai.com/v1", format: "openai", models: [], defaultModel: "" },
  {
    id: "anthropic",
    name: "Anthropic",
    url: "https://api.anthropic.com",
    format: "anthropic",
    models: ["claude-opus-5-5", "claude-sonnet-5-5"],
    defaultModel: "claude-opus-5-5",
  },
  // Built-in connectors with several plans (ADR 0072): the first plan is filled in, and the key
  // finds the right one when the list is fetched.
  { id: "xiaomi", name: "Xiaomi MiMo", url: first("xiaomi"), format: "openai", models: [], defaultModel: "" },
  { id: "qwen", name: "Qwen", url: first("qwen"), format: "openai", models: [], defaultModel: "" },
  { id: "deepseek", name: "DeepSeek", url: first("deepseek"), format: "openai", models: ["deepseek-chat", "deepseek-reasoner"], defaultModel: "deepseek-chat" },
  { id: "openrouter", name: "OpenRouter", url: "https://openrouter.ai/api/v1", format: "openai", models: [], defaultModel: "" },
  { id: "ollama", name: "Ollama", url: "http://localhost:11434/v1", format: "openai", models: [], defaultModel: "" },
  { id: "lmstudio", name: "LM Studio", url: "http://localhost:1234/v1", format: "openai", models: [], defaultModel: "" },
  { id: "llamacpp", name: "llama.cpp", url: "http://localhost:8080/v1", format: "openai", models: [], defaultModel: "" },
  { id: "custom", name: "自定义", url: "", format: null, models: [], defaultModel: "" },
];

export const LOCAL_PRESETS = new Set(["ollama", "lmstudio", "llamacpp"]);
