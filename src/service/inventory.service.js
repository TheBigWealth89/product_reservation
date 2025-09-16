import { redisClient } from "../db/connections.js";
import logger from "../utils/logger.js";


const returnStock = async (productId) => {
  const inventoryKey = `inventory:product-${productId}`;

  // Atomically increase the inventory in Redis
  const newInventory = await redisClient.incr(inventoryKey);

  //Prepare the update message
  const updateMessage = JSON.stringify({
    productId: productId,
    newInventory: newInventory,
  });



  // Publish the update to the central channel
  await redisClient.publish("inventory-updates", updateMessage);

  logger.info(
    `Returned stock for product ${productId}. New inventory: ${newInventory}. Update published.`
  );
  return newInventory;
};

export default returnStock;
