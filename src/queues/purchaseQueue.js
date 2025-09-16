import { Queue } from "bullmq";
import { redisClient } from "../db/connections.js";

const purchaseQueue = new Queue("fulfill-order", {
  connection: redisClient,
});

export default purchaseQueue;
