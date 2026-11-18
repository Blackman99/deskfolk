declare const __REAL_BOT_HOSTED__: boolean | undefined;

/** Hosted production is compiled with REAL_BOT_HOSTED=1. Desktop/dev stay local. */
export const HOSTED_MESSENGER = typeof __REAL_BOT_HOSTED__ !== "undefined" && __REAL_BOT_HOSTED__ === true;
