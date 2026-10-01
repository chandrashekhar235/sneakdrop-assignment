const { createClient } = require("redis");

const redisClient = createClient({
  url: "redis://127.0.0.1:6379",
});

redisClient.on("error", (err) => {
  console.error("Redis error:", err);
});

async function connectRedis() {
  await redisClient.connect();
  console.log("Redis connected");
}

module.exports = {
  redisClient,
  connectRedis,
};