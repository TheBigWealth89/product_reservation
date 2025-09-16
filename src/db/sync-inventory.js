import { redisClient, pool } from "./connections.js";
import logger from "../utils/logger.js";
import purchaseQueue from "../queues/purchaseQueue.js";

export const syncInventoryToRedis = async () => {
  try {
    //Fetch all products from postgreSQL
    const result = await pool.query("SELECT id, inventory FROM products");
    const products = result.rows;

    //Get all jobs currently in the queue (waiting or active)
    const waitingJobs = await purchaseQueue.getWaiting();
    const activeJobs = await purchaseQueue.getActive();
    const completed = await purchaseQueue.getCompleted();
    const failedJobs = await purchaseQueue.getFailed();
    logger.info(
      `Jobs - Waiting: ${waitingJobs.length}, Active: ${activeJobs.length}, Completed: ${completed.length}, Failed: ${failedJobs.length}`
    );
   
    //Sync each product's inventory to redis
    const multi = redisClient.multi();
    for (const product of products) {
      const totalInventory = product.inventory;

      // Count only reserved + unexpired reservations
      const reservationResult = await pool.query(
        `SELECT COUNT(*) 
         FROM orders 
         WHERE product_id = $1 
           AND expires_at > NOW() 
           AND status = 'reserved'`,
        [product.id]
      );

      const pendingPayment = await pool.query(
        `SELECT COUNT(*) 
         FROM orders 
         WHERE product_id = $1 AND
        status = 'payment_pending'`,
        [product.id]
      );

      const activePendingPayment = parseInt(pendingPayment.rows[0].count, 10);
      const activeReservations = parseInt(reservationResult.rows[0].count, 10);
    

      // Calculate the true available inventory
      const availableInventory = Math.max(
        0,
        totalInventory - activeReservations - activePendingPayment
      );
      //  Set this correct value in Redis
      const key = `inventory:product-${product.id}`;
      multi.set(key, availableInventory);

      logger.info(
        `Synced ${key} with available inventory ${availableInventory}`
      );
    }
    await multi.exec();
  } catch (err) {
    logger.error("Failed to sync inventory to Redis:", err);
    throw err;
  }
};
