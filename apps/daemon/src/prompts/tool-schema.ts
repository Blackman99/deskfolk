import type { Locale } from "@real-bot/protocol";

export type Localized = { zh: string; en: string };

export type ToolProp = {
  type: string | string[];
  description: Localized;
  items?: unknown;
  enum?: string[];
  properties?: Record<string, ToolProp>;
  required?: string[];
};

export type ToolDef = {
  name: string;
  description: Localized;
  properties: Record<string, ToolProp>;
  required?: string[];
};

export type ChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

/** An array's items: their properties' descriptions in the locale, when they come in both. */
function localizeItems(items: unknown, locale: Locale): unknown {
  if (!items || typeof items !== "object" || !("properties" in items)) return items;
  const { properties, ...rest } = items as { properties: Record<string, Record<string, unknown>> };
  return {
    ...rest,
    properties: Object.fromEntries(Object.entries(properties).map(([key, child]) => {
      const description = child.description as Localized | string | undefined;
      return [key, description && typeof description === "object" ? { ...child, description: description[locale] } : child];
    })),
  };
}

function localizeProp(prop: ToolProp, locale: Locale): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: prop.type,
    description: prop.description[locale],
  };
  if (prop.items) schema.items = localizeItems(prop.items, locale);
  if (prop.enum) schema.enum = prop.enum;
  if (prop.properties) {
    const nested: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(prop.properties)) {
      nested[key] = localizeProp(child, locale);
    }
    schema.properties = nested;
    if (prop.required?.length) schema.required = prop.required;
  }
  return schema;
}

export function toChatTools(defs: readonly ToolDef[], locale: Locale): ChatTool[] {
  return defs.map((tool) => {
    const properties: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(tool.properties)) {
      properties[key] = localizeProp(prop, locale);
    }
    const parameters: ChatTool["function"]["parameters"] = { type: "object", properties };
    if (tool.required?.length) parameters.required = tool.required;
    return {
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description[locale],
        parameters,
      },
    };
  });
}
