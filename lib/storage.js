const { Redis } = require("@upstash/redis");

const { getConfig } = require("./config");

const STATE_KEY = "flux:venus:state";

let memoryState = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDefaultState(config) {
  return {
    stats: {
      usdc: {
        totalDeposit: 0,
        totalWithdraw: 0,
      },
      fusdt: {
        totalDeposit: 0,
        totalWithdraw: 0,
      },
    },
    events: [],
    meta: {
      updatedAt: null,
      lastWebhookAt: null,
      lastSource: null,
      totalStoredEvents: 0,
      storageMode: config.storageConfigured ? "redis" : config.allowMemoryFallback ? "memory" : "unconfigured",
      storageConfigured: config.storageConfigured,
    },
  };
}

function getRedis(config) {
  if (!config.storageConfigured) {
    return null;
  }

  return new Redis({
    url: config.redisUrl,
    token: config.redisToken,
  });
}

async function readState() {
  const config = getConfig();
  const fallback = createDefaultState(config);
  const redis = getRedis(config);

  if (redis) {
    const state = await redis.get(STATE_KEY);
    return state ? { ...fallback, ...state, meta: { ...fallback.meta, ...state.meta } } : fallback;
  }

  if (!memoryState) {
    memoryState = fallback;
  }

  return clone(memoryState);
}

async function writeState(state) {
  const config = getConfig();
  const nextState = {
    ...state,
    meta: {
      ...state.meta,
      storageMode: config.storageConfigured ? "redis" : config.allowMemoryFallback ? "memory" : "unconfigured",
      storageConfigured: config.storageConfigured,
    },
  };
  const redis = getRedis(config);

  if (redis) {
    await redis.set(STATE_KEY, nextState);
    return nextState;
  }

  if (!config.allowMemoryFallback) {
    throw new Error("External storage is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN.");
  }

  memoryState = clone(nextState);
  return clone(nextState);
}

function updateStats(stats, event) {
  const key = event.tokenType.toLowerCase();
  if (!stats[key]) {
    return;
  }

  if (event.eventType === "DEPOSIT") {
    stats[key].totalDeposit += event.amount;
  }

  if (event.eventType === "WITHDRAW") {
    stats[key].totalWithdraw += event.amount;
  }
}

async function appendEvents(events, source) {
  const config = getConfig();
  const state = await readState();
  const existingIds = new Set(state.events.map((event) => event.id));
  const inserted = [];

  for (const event of events) {
    if (existingIds.has(event.id)) {
      continue;
    }

    existingIds.add(event.id);
    inserted.push(event);
    updateStats(state.stats, event);
  }

  if (inserted.length === 0) {
    state.meta.updatedAt = new Date().toISOString();
    state.meta.lastWebhookAt = state.meta.updatedAt;
    state.meta.lastSource = source;
    return writeState(state);
  }

  state.events = [...inserted, ...state.events]
    .sort((left, right) => {
      if (left.blockNumber !== right.blockNumber) {
        return right.blockNumber - left.blockNumber;
      }

      return new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime();
    })
    .slice(0, config.maxHistory);

  state.meta.updatedAt = new Date().toISOString();
  state.meta.lastWebhookAt = state.meta.updatedAt;
  state.meta.lastSource = source;
  state.meta.totalStoredEvents = state.events.length;

  return writeState(state);
}

module.exports = {
  appendEvents,
  createDefaultState,
  readState,
};
