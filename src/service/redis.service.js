import { createClient } from "redis";

class RedisService {
  constructor() {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    this.client = createClient({ url: redisUrl });

    this.client.on("error", (err) => {
      console.error("Redis Error:", err);
    });

    this.client.on("connect", () => {
      console.log("✅ Connected to Redis successfully:", this.client.isOpen);
    });

    this.client.on("reconnecting", () => {
      console.warn("🔁 Reconnecting to Redis...");
    });
  }

  async connect() {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
  }
}

export default new RedisService();
