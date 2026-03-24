const crypto = require("crypto");

const { getConfig } = require("../lib/config");
const { normalizeWebhookPayload } = require("../lib/normalize");
const { appendEvents } = require("../lib/storage");

function isSecretValid(req, secret) {
  if (!secret) {
    return true;
  }

  const provided =
    req.headers["x-webhook-secret"] ||
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
    "";

  if (!provided) {
    return false;
  }

  const expectedBuffer = Buffer.from(secret);
  const providedBuffer = Buffer.from(String(provided));

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  const config = getConfig();

  if (!isSecretValid(req, config.webhookSecret)) {
    return res.status(401).json({
      ok: false,
      error: "Invalid webhook secret",
    });
  }

  try {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const normalized = normalizeWebhookPayload(payload, config);

    if (normalized.events.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "No supported events found in webhook payload",
      });
    }

    const state = await appendEvents(normalized.events, normalized.source);

    return res.status(202).json({
      ok: true,
      acceptedEvents: normalized.events.length,
      totalStoredEvents: state.meta.totalStoredEvents,
      storageMode: state.meta.storageMode,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
};
