import purchaseQueue from "../queues/purchaseQueue.js";
async function clearFailedJobs() {
  try {
    await purchaseQueue.clean(0, 1000, "failed");
    console.log("✅ Successfully cleared the failed jobs queue.");
  } catch (err) {
    console.error("Error clearing failed jobs:", err);
  }
  // We need to close the connection for the script to exit
  await purchaseQueue.close();
}

clearFailedJobs();
