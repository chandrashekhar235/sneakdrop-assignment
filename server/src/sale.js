const crypto = require("crypto");
const { redisClient } = require("./redis");

const STOCK_KEY = "sneaker:stock";
const HOLDS_KEY = "sneaker:holds";
const QUEUE_KEY = "sneaker:queue";

const HOLD_TIME = 300; // 5 mins
const PAYMENT_RETENTION = 24 * 60 * 60; // 
function makeHoldId() {
  return crypto.randomUUID();
}

async function buySneaker(userId) {
  const holdId = makeHoldId();
  const holdKey = `hold:${userId}`;
  const purchasedKey = `purchased:${userId}`;

  const result = await redisClient.eval(
    `
    -- 1. Never allow more than one active hold.
    if redis.call("EXISTS", KEYS[2]) == 1 then
      return -1
    end

    -- 2. A queued user must wait for their queue turn.
    if redis.call("LPOS", KEYS[5], ARGV[1]) then
      return -2
    end

    -- 3. Enforce the lifetime purchase limit atomically.
    local purchased = tonumber(redis.call("GET", KEYS[3]) or "0")
    if purchased >= 2 then
      return -3
    end

    -- 4. If this user's previous hold expired in Redis but the expiration
    -- worker has not processed its sorted-set entry yet, return that old
    -- unit before attempting the new purchase.
    local previousExpiry = redis.call("ZSCORE", KEYS[4], ARGV[1])
    if previousExpiry and tonumber(previousExpiry) <= tonumber(ARGV[2]) then
      redis.call("ZREM", KEYS[4], ARGV[1])
      redis.call("INCR", KEYS[1])
    end

    -- 5. Reserve inventory atomically with the validation above.
    local stock = tonumber(redis.call("GET", KEYS[1]) or "0")
    if stock <= 0 then
      return 0
    end

    redis.call("DECR", KEYS[1])

    -- The worker owns expired reservations. We intentionally do not remove
    -- an old sorted-set entry here; the worker must return that old unit to
    -- inventory. A new hold uses the same member only after the old entry has
    -- been processed, so stale expiration cannot be silently lost.
    local now = tonumber(ARGV[2])
    local expiresAt = now + tonumber(ARGV[3]) * 1000
    local payload = ARGV[4]

    redis.call("SET", KEYS[2], payload, "EX", ARGV[3])
    redis.call("ZADD", KEYS[4], expiresAt, ARGV[1])

    return 1
    `,
    {
      keys: [
        STOCK_KEY,
        holdKey,
        purchasedKey,
        HOLDS_KEY,
        QUEUE_KEY,
      ],
      arguments: [
        userId,
        Date.now().toString(),
        HOLD_TIME.toString(),
        JSON.stringify({
          userId,
          holdId,
          createdAt: Date.now(),
          expiresAt: Date.now() + HOLD_TIME * 1000,
        }),
      ],
    }
  );

  if (result === -1) {
    return {
      success: false,
      message: "You already have a sneaker on hold",
    };
  }

  if (result === -2) {
    return {
      success: false,
      message: "You are already in the waiting queue",
    };
  }

  if (result === -3) {
    return {
      success: false,
      message: "You have already purchased the maximum of 2 pairs",
    };
  }

  if (result === 0) {
    return {
      success: false,
      message: "Sold out",
    };
  }

  return {
    success: true,
    message: "Sneaker held for 5 minutes",
    expiresIn: HOLD_TIME,
    holdId,
  };
}

async function payForSneaker(userId, holdId) {
  if (!holdId) {
    return {
      success: false,
      message: "holdId is required for payment",
    };
  }

  const holdKey = `hold:${userId}`;
  const purchasedKey = `purchased:${userId}`;
  const paymentKey = `payment:${holdId}`;

  const result = await redisClient.eval(
    `
    -- A duplicate notification for an already completed payment is harmless.
    if redis.call("EXISTS", KEYS[4]) == 1 then
      return 3
    end

    local hold = redis.call("GET", KEYS[1])
    if not hold then
      return 0
    end

    local ok, decoded = pcall(cjson.decode, hold)
    if not ok or decoded["holdId"] ~= ARGV[1] then
      return 0
    end

    local purchased = tonumber(redis.call("GET", KEYS[2]) or "0")
    if purchased >= 2 then
      return 2
    end

    redis.call("DEL", KEYS[1])
    redis.call("ZREM", KEYS[3], ARGV[2])
    redis.call("INCR", KEYS[2])
    redis.call("SET", KEYS[4], "1", "EX", ARGV[3])

    return 1
    `,
    {
      keys: [holdKey, purchasedKey, HOLDS_KEY, paymentKey],
      arguments: [
        holdId,
        userId,
        PAYMENT_RETENTION.toString(),
      ],
    }
  );

  if (result === 0) {
    return {
      success: false,
      message: "This hold is no longer active. The payment notification was ignored.",
    };
  }

  if (result === 2) {
    return {
      success: false,
      message: "Maximum of 2 purchased pairs reached",
    };
  }

  if (result === 3) {
    return {
      success: true,
      duplicate: true,
      message: "Duplicate payment notification ignored; purchase was already recorded",
    };
  }

  return {
    success: true,
    message: "Payment successful",
  };
}

async function joinQueue(userId) {
  const holdKey = `hold:${userId}`;
  const purchasedKey = `purchased:${userId}`;

  const result = await redisClient.eval(
    `
    if redis.call("EXISTS", KEYS[2]) == 1 then
      return -1
    end

    local purchased = tonumber(redis.call("GET", KEYS[3]) or "0")
    if purchased >= 2 then
      return -2
    end

    -- Queue is only for the sold-out state.
    local stock = tonumber(redis.call("GET", KEYS[1]) or "0")
    if stock > 0 then
      return -3
    end

    if redis.call("LPOS", KEYS[4], ARGV[1]) then
      return 0
    end

    redis.call("RPUSH", KEYS[4], ARGV[1])
    return redis.call("LPOS", KEYS[4], ARGV[1]) + 1
    `,
    {
      keys: [STOCK_KEY, holdKey, purchasedKey, QUEUE_KEY],
      arguments: [userId],
    }
  );

  if (result === -1) {
    return {
      success: false,
      message: "You already have a sneaker on hold",
    };
  }

  if (result === -2) {
    return {
      success: false,
      message: "You have already purchased the maximum of 2 pairs",
    };
  }

  if (result === -3) {
    return {
      success: false,
      message: "Sneakers are still available. Buy a pair instead of joining the queue.",
    };
  }

  if (result === 0) {
    const position = await redisClient.lPos(QUEUE_KEY, userId);
    return {
      success: true,
      message: "Already in waiting queue",
      position: position === null ? undefined : position + 1,
    };
  }

  return {
    success: true,
    message: "Added to waiting queue",
    position: result,
  };
}

async function getUserStatus(userId) {
  const holdKey = `hold:${userId}`;
  const purchasedKey = `purchased:${userId}`;

  const [hold, purchasedValue] = await Promise.all([
    redisClient.get(holdKey),
    redisClient.get(purchasedKey),
  ]);

  const purchased = Number(purchasedValue || 0);

  if (hold) {
    const ttl = await redisClient.ttl(holdKey);
    let holdId;

    try {
      holdId = JSON.parse(hold).holdId;
    } catch (_) {
      holdId = undefined;
    }

    return {
      status: "HELD",
      expiresIn: ttl,
      holdId,
      purchased,
    };
  }

  const queue = await redisClient.lRange(QUEUE_KEY, 0, -1);
  const position = queue.indexOf(userId);

  if (position !== -1) {
    return {
      status: "WAITING",
      position: position + 1,
      purchased,
    };
  }

  if (purchased > 0) {
    return {
      status: "PURCHASED",
      purchased,
    };
  }

  return {
    status: "NOT_STARTED",
    purchased: 0,
  };
}

async function processExpiredHolds() {
  const now = Date.now();

  const expiredUsers = await redisClient.zRangeByScore(
    HOLDS_KEY,
    0,
    now
  );

  for (const userId of expiredUsers) {
    const nextHoldId = makeHoldId();
    const newExpiresAt = now + HOLD_TIME * 1000;
    const nextHoldPayload = JSON.stringify({
      userId: null,
      holdId: nextHoldId,
      createdAt: now,
      expiresAt: newExpiresAt,
    });

    const result = await redisClient.eval(
      `
      local expiry = redis.call("ZSCORE", KEYS[1], ARGV[1])

      if not expiry then
        return 0
      end

      if tonumber(expiry) > tonumber(ARGV[2]) then
        return 0
      end

      -- Remove this expired reservation from the expiration index first.
      redis.call("ZREM", KEYS[1], ARGV[1])

      -- If the Redis TTL has already removed the hold, this is still the
      -- reservation represented by the sorted-set entry. We can safely
      -- allocate the returned unit exactly once here.
      redis.call("DEL", KEYS[2])

      -- Give the released unit to the first eligible queued user.
      while true do
        local nextUser = redis.call("LPOP", KEYS[3])
        if not nextUser then
          redis.call("INCR", KEYS[4])
          return 1
        end

        local purchased = tonumber(redis.call("GET", "purchased:" .. nextUser) or "0")
        local hasHold = redis.call("EXISTS", "hold:" .. nextUser)

        if purchased < 2 and hasHold == 0 then
          local payload = cjson.decode(ARGV[4])
          payload["userId"] = nextUser
          payload["expiresAt"] = tonumber(ARGV[2]) + tonumber(ARGV[3]) * 1000

          redis.call(
            "SET",
            "hold:" .. nextUser,
            cjson.encode(payload),
            "EX",
            ARGV[3]
          )

          redis.call(
            "ZADD",
            KEYS[1],
            payload["expiresAt"],
            nextUser
          )

          return nextUser
        end
      end
      `,
      {
        keys: [
          HOLDS_KEY,
          `hold:${userId}`,
          QUEUE_KEY,
          STOCK_KEY,
        ],
        arguments: [
          userId,
          now.toString(),
          HOLD_TIME.toString(),
          nextHoldPayload,
        ],
      }
    );

    if (result === 1) {
      console.log("Expired hold returned to stock");
    } else if (result !== 0) {
      console.log(`Expired hold assigned to ${result}`);
    }
  }
}

module.exports = {
  buySneaker,
  payForSneaker,
  joinQueue,
  getUserStatus,
  processExpiredHolds,
};
