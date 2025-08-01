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
      // Key format is "reservation:product:{productId}:{userId}"
      const parts = key.split(":");

      // The product ID is the THIRD part (index 2) of the key array
      if (parts.length >= 3) {
        const productId = parts[2];
        const inventoryKey = `inventory:product-${productId}`;

        // Atomically increment the correct inventory count to return the stock
        const newInventory = await mainClient.incr(inventoryKey);

        logger.info(
          `Stock returned for product ${productId}. New inventory: ${newInventory}`
        );
      } else {
        logger.warn(
          `Could not parse a valid product ID from expired key: ${key}`
        );
      }
    }
  });
})();
