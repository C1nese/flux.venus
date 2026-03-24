const DEFAULT_USDC_CONTRACT = "0xfE60462E93cee34319F48Cfc6AcFbc13c2882Df9";
const DEFAULT_FUSDT_CONTRACT = "0xA5b8FCa32E5252B0B58EAbf1A8c79d958F8EE6A2";

function getAddress(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function getNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getConfig() {
  const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

  return {
    maxHistory: getNumber(process.env.MAX_HISTORY, 200),
    tokenDecimals: getNumber(process.env.TOKEN_DECIMALS, 18),
    webhookSecret: process.env.WEBHOOK_SECRET || "",
    redisUrl,
    redisToken,
    storageConfigured: Boolean(redisUrl && redisToken),
    allowMemoryFallback:
      process.env.ALLOW_MEMORY_FALLBACK === "true" || process.env.NODE_ENV !== "production",
    tokenAddressMap: {
      [getAddress(process.env.USDC_CONTRACT_ADDRESS || DEFAULT_USDC_CONTRACT)]: "USDC",
      [getAddress(process.env.FUSDT_CONTRACT_ADDRESS || DEFAULT_FUSDT_CONTRACT)]: "FUSDT",
    },
  };
}

module.exports = {
  DEFAULT_USDC_CONTRACT,
  DEFAULT_FUSDT_CONTRACT,
  getConfig,
};
