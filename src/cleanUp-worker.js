import { createClient } from "redis";
import logger from "./utils/logger.js";

const subscriber = createClient();
const mainClient = createClient();

(async () => {
  await subscriber.connect();
  await mainClient.connect();
  logger.info(
    "Cleanup worker connected to Redis and listening for expired keys."
  );

  // Subscribe to the keyspace channel for expired events
  await subscriber.subscribe("__keyevent@0__:expired", async (key) => {
    logger.info(`Expired key detected: ${key}`);

    // Check if it's a reservation key we care about
    if (key.startsWith("reservation:product-")) {
      // Example key: "reservation:product-1:user-123"
      const parts = key.split(":");
      const productId = parts[2];
      const inventoryKey = `inventory:product-${productId}`;

      // Atomically increment the main inventory count to return the stock
      const newInventory = await mainClient.incr(inventoryKey);

      logger.info(
        `Stock returned for product ${productId}. New inventory: ${newInventory}`
      );
    }
  });
})();
