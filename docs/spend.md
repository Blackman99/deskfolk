# Spend

[简体中文](spend.zh.md)

Open **Spend** from the sidebar or the desktop **View** menu. Desktop windows use a single pane tab; phones use a full-screen overlay. Choose today, the last 7 or 30 days, all time, or a custom range. Totals, call categories and daily trends follow the same filters. Switch the dimension table between models, sessions and Bots, sort its columns, and click rows to combine filters. Session links and paginated call details return to the original conversation or trigger message. New calls update the open view automatically.

Tokens come from endpoint usage. **Reported** amounts use the provider's `cost_in_usd_ticks`; **Estimated** amounts use optional model billing rates in USD per million tokens. In **Settings → Models → Models → Attributes**, set both input and output rates and optionally a cached-input rate. Leaving cached input blank uses the input rate. Rates save automatically and can be cleared together. The separate routing reference price continues to guide model choice. Estimates are stored with each new call, so later price changes preserve history. Missing usage or unconfigured rates remain visible as missing values.

The ledger includes turn completions, judgements, route picks, route reviews, learning hops and composer suggestions. Deleting a conversation or Bot, or clearing history, retains its recorded spend and name snapshots. Conversation headers, rows and settings keep their existing presentation. Spend adds no budget limits or automatic stops, and cannot measure fees charged separately by MCP tools.
