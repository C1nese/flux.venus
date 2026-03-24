const { ethers } = require("ethers");

const SUPPORTED_EVENT_TYPES = new Set(["TRANSFER", "DEPOSIT", "WITHDRAW"]);

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return undefined;
}

function toObjectFromNamedArray(value) {
  if (!Array.isArray(value)) {
    return value && typeof value === "object" ? value : {};
  }

  return value.reduce((result, item, index) => {
    if (item && typeof item === "object" && item.name) {
      result[item.name] = item.value;
    } else {
      result[index] = item;
    }

    return result;
  }, {});
}

function normalizeAddress(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function normalizeTokenType(rawValue, addressMap, contractAddress) {
  const directValue = typeof rawValue === "string" ? rawValue.trim().toUpperCase() : "";
  if (directValue === "USDC" || directValue === "FUSDT") {
    return directValue;
  }

  const mapped = addressMap[normalizeAddress(contractAddress)];
  return mapped || "";
}

function normalizeEventType(rawValue) {
  const normalized = typeof rawValue === "string" ? rawValue.trim().toUpperCase() : "";
  if (!normalized) {
    return "";
  }

  if (normalized === "WITHDRAWAL") {
    return "WITHDRAW";
  }

  return SUPPORTED_EVENT_TYPES.has(normalized) ? normalized : "";
}

function parseAmount(value, decimals) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return 0;
    }

    if (trimmed.includes(".")) {
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    try {
      return Number(ethers.formatUnits(BigInt(trimmed), decimals));
    } catch (error) {
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : 0;
    }
  }

  if (typeof value === "bigint") {
    return Number(ethers.formatUnits(value, decimals));
  }

  return 0;
}

function toIsoTimestamp(value, fallback) {
  if (!value) {
    return fallback;
  }

  if (typeof value === "number") {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(millis).toISOString();
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== "") {
      return toIsoTimestamp(numeric, fallback);
    }

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return fallback;
}

function normalizeOneEvent(rawEvent, context) {
  const args = toObjectFromNamedArray(
    pick(
      rawEvent.args,
      rawEvent.returnValues,
      rawEvent.decoded?.params,
      rawEvent.decodedData,
      rawEvent.data
    )
  );

  const receivedAt = new Date().toISOString();
  const contractAddress = pick(
    rawEvent.contractAddress,
    rawEvent.contract?.address,
    rawEvent.log?.address
  );
  const tokenType = normalizeTokenType(
    pick(rawEvent.tokenType, rawEvent.symbol, rawEvent.asset, rawEvent.token),
    context.tokenAddressMap,
    contractAddress
  );
  const eventType = normalizeEventType(
    pick(rawEvent.eventType, rawEvent.event, rawEvent.name, rawEvent.eventName, rawEvent.activity, rawEvent.method)
  );

  if (!tokenType || !eventType) {
    return null;
  }

  const txHash = pick(
    rawEvent.txHash,
    rawEvent.transactionHash,
    rawEvent.hash,
    rawEvent.log?.transactionHash
  );
  const logIndex = pick(rawEvent.logIndex, rawEvent.index, rawEvent.log?.logIndex, 0);
  const blockNumber = Number(
    pick(rawEvent.blockNumber, rawEvent.block?.number, rawEvent.log?.blockNumber, 0)
  ) || 0;
  const timestamp = toIsoTimestamp(
    pick(rawEvent.timestamp, rawEvent.blockTimestamp, rawEvent.block?.timestamp, rawEvent.time),
    receivedAt
  );

  const amountCandidate = pick(
    rawEvent.amount,
    rawEvent.amountFormatted,
    rawEvent.valueFormatted,
    rawEvent.assetsFormatted,
    args.amount,
    args.value,
    args.assets,
    args[2]
  );

  const sharesCandidate = pick(
    rawEvent.shares,
    rawEvent.sharesFormatted,
    args.shares,
    args[3],
    args[4]
  );

  const normalized = {
    id: `${txHash || "nohash"}:${logIndex}:${eventType}:${tokenType}`,
    tokenType,
    eventType,
    address: pick(rawEvent.account, rawEvent.user, rawEvent.owner, rawEvent.receiver, rawEvent.to, rawEvent.address, ""),
    from: pick(rawEvent.from, args.from, args.sender, args[0]),
    to: pick(rawEvent.to, args.to, args.receiver, args.owner, args[1]),
    amount: parseAmount(amountCandidate, context.tokenDecimals),
    shares: parseAmount(sharesCandidate, context.tokenDecimals),
    timestamp,
    receivedAt,
    txHash: txHash || "",
    blockNumber,
    source: pick(rawEvent.source, context.sourceLabel, "webhook"),
    contractAddress: contractAddress || "",
  };

  if (eventType === "TRANSFER") {
    normalized.address = pick(rawEvent.address, normalized.to, normalized.from, "");
  } else if (eventType === "DEPOSIT") {
    normalized.address = pick(rawEvent.address, rawEvent.owner, args.owner, args[1], normalized.to, normalized.from, "");
  } else {
    normalized.address = pick(rawEvent.address, rawEvent.receiver, args.receiver, args.owner, args[1], normalized.to, "");
  }

  return normalized;
}

function normalizeWebhookPayload(payload, context) {
  const sourceLabel = pick(payload.source, payload.provider, payload.webhookType, "webhook");
  const rawEvents = Array.isArray(payload.events)
    ? payload.events
    : Array.isArray(payload.data?.events)
      ? payload.data.events
      : Array.isArray(payload.logs)
        ? payload.logs
        : payload.event
          ? [payload.event]
          : [payload];

  const normalizedEvents = rawEvents
    .map((rawEvent) => normalizeOneEvent(rawEvent, { ...context, sourceLabel }))
    .filter(Boolean);

  return {
    source: sourceLabel,
    events: normalizedEvents,
  };
}

module.exports = {
  normalizeWebhookPayload,
};
