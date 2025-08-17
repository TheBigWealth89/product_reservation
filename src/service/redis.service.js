import { createClient } from "redis";
export const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

class RedisService {
  constructor() {
    this.client = createClient({ url: redisUrl });

    // This is a separate client dedicated to monitoring
    this.monitorClient = createClient("redis://localhost:6379");

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
    // if (!this.monitorClient.isOpen) {
    //   await this.monitorClient.connect();
    //   this.monitorClient.monitor((err, monitor) => {
    //     if (err) {
    //       console.error("Redis Monitor Error:", err);
    //       return;
    //     }
    //     monitor.on("monitor", (time, args, raw_reply) => {
    //       console.log(`[REDIS COMMAND] ${time} :${args.join(" ")}`);
    //     });
    //     console.log("🕵️  Redis monitor started.");
    //   });
    // }
  }
}

export default new RedisService();
