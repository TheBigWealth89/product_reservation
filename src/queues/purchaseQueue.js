import { Queue } from "bullmq";
import { redisClient } from "../db/connections.js";

const purchaseQueue = new Queue("purchase-processing", {
  connection: { redisClient },
});

export default purchaseQueue;
