const { getConfig } = require("../lib/config");

module.exports = async function handler(req, res) {
  const config = getConfig();

  res.status(200).json({
    ok: true,
    runtime: "serverless-compatible",
    storageConfigured: config.storageConfigured,
    storageMode: config.storageConfigured ? "redis" : config.allowMemoryFallback ? "memory" : "unconfigured",
    maxHistory: config.maxHistory,
  });
};
