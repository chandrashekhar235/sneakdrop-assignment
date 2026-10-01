const express = require("express");
const cors = require("cors");
const path = require("path");

const { redisClient, connectRedis } = require("./redis");

const {
  buySneaker,
  payForSneaker,
  joinQueue,
  getUserStatus,
  processExpiredHolds,
} = require("./sale");

const app = express();

app.use(cors());
app.use(express.json());

// Serve the simple frontend
app.use(express.static(path.join(__dirname, "../../public")));

const PORT = 5050;
const STOCK_KEY = "sneaker:stock";

// Get current stock
app.get("/stock", async (req, res) => {
  try {
    const stock = await redisClient.get(STOCK_KEY);

    res.json({
      stock: Number(stock || 0),
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Could not fetch stock",
    });
  }
});

// Buy sneaker
app.post("/buy", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        message: "userId is required",
      });
    }

    const result = await buySneaker(userId);

    res.json(result);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Something went wrong",
    });
  }
});

// Direct payment
app.post("/pay", async (req, res) => {
  try {
    const { userId, holdId } = req.body;

    if (!userId || !holdId) {
      return res.status(400).json({
        message: "userId and holdId are required",
      });
    }

    const result = await payForSneaker(userId, holdId);

    res.json(result);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Something went wrong",
    });
  }
});

// Fake payment provider
app.post("/fake-payment", (req, res) => {
  const {
    userId,
    holdId,
    delayMs = 2000,
    duplicate = false,
  } = req.body;

  if (!userId || !holdId) {
    return res.status(400).json({
      message: "userId and holdId are required",
    });
  }

  const sendPayment = async () => {
    try {
      const result = await payForSneaker(userId, holdId);

      console.log(
        `Fake payment for ${userId}:`,
        result
      );
    } catch (error) {
      console.error(
        `Fake payment error for ${userId}:`,
        error
      );
    }
  };

  // First payment message
  setTimeout(sendPayment, Number(delayMs));

  // Optional duplicate payment message
  if (duplicate) {
    setTimeout(
      sendPayment,
      Number(delayMs) + 500
    );
  }

  res.json({
    success: true,
    message: "Fake payment scheduled",
    delayMs: Number(delayMs),
    duplicate,
  });
});

// Join waiting queue
app.post("/join-queue", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        message: "userId is required",
      });
    }

    const result = await joinQueue(userId);

    res.json(result);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Something went wrong",
    });
  }
});

// User status
app.get("/status/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await getUserStatus(userId);

    res.json(result);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Something went wrong",
    });
  }
});

async function startServer() {
  try {
    await connectRedis();

    // Initialize stock only once
    const exists = await redisClient.exists(STOCK_KEY);

    if (!exists) {
      await redisClient.set(STOCK_KEY, 20);
      console.log("Stock initialized to 20");
    }

    // Check expired holds every second
    setInterval(processExpiredHolds, 1000);

    app.listen(PORT, () => {
      console.log(
        `Server running on http://localhost:${PORT}`
      );
    });
  } catch (error) {
    console.error(
      "Failed to start server:",
      error
    );

    process.exit(1);
  }
}

startServer();