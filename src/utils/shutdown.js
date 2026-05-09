import logger from "./logger.js";

const SHUTDOWN_TIMEOUT_MS = 25_000; // Force-exit before Docker's 30s SIGKILL

/**
 * Runs the full shutdown sequence, racing against a hard timeout.
 *
 * @param {object} opts
 * @param {string}                          opts.name
 * @param {import("http").Server}           [opts.httpServer]
 * @param {import("socket.io").Server}      [opts.io]          - Must be closed BEFORE httpServer
 * @param {import("bullmq").Worker}         [opts.worker]      - Drained with a 20s timeout
 * @param {import("bullmq").Queue}          [opts.queue]
 * @param {import("pg").Pool}               [opts.dbPool]
 * @param {import("ioredis").Redis}         [opts.redisClient]
 * @param {() => void | Promise<void>}      [opts.stopTimer]   - Cancel interval/cron; may be async
 */
export async function gracefulShutdown(opts) {
  const { name, httpServer, io, worker, queue, dbPool, redisClient, stopTimer } =
    opts;

  logger.info(`[${name}] Shutdown signal received — starting graceful shutdown`);

  const doShutdown = async () => {
    // 1. Cancel new scheduling (clearInterval / cron.stop) — awaited in case it's async
    if (stopTimer) await stopTimer();

    // 2. Close Socket.IO FIRST — disconnects WS clients so httpServer.close() can resolve
    if (io) {
      await new Promise((res) => io.close(() => res()));
      logger.info(`[${name}] Socket.IO closed`);
    }

    // 3. Stop accepting new HTTP connections
    if (httpServer) {
      await new Promise((res, rej) =>
        httpServer.close((err) => {
          if (err && err.code !== "ERR_SERVER_NOT_RUNNING" && err.message !== "Server is not running.") {
            return rej(err);
          }
          res();
        })
      );
      logger.info(`[${name}] HTTP server closed`);
    }

    // 4. Drain BullMQ Worker — waits for current job processor to settle.
    //    If the processor throws, the existing catch/ROLLBACK in the worker runs
    //    before we close the pool.
    if (worker) {
      await Promise.race([
        worker.close(),
        new Promise((_, rej) =>
          setTimeout(
            () => rej(new Error(`[${name}] worker.close() timed out after 20s`)),
            20_000
          )
        ),
      ]);
      logger.info(`[${name}] BullMQ worker drained`);
    }

    // 5. Close BullMQ Queue connection
    if (queue) {
      await queue.close();
      logger.info(`[${name}] BullMQ queue closed`);
    }

    // 6. Close the Postgres pool
    if (dbPool) {
      await dbPool.end();
      logger.info(`[${name}] DB pool closed`);
    }

    // 7. Disconnect Redis last (workers may still publish up to this point)
    if (redisClient) {
      await redisClient.quit();
      logger.info(`[${name}] Redis disconnected`);
    }
  };

  try {
    await Promise.race([
      doShutdown(),
      new Promise((_, rej) =>
        setTimeout(
          () =>
            rej(
              new Error(
                `[${name}] Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms`
              )
            ),
          SHUTDOWN_TIMEOUT_MS
        )
      ),
    ]);

    logger.info(`[${name}] Graceful shutdown complete ✅`);
    process.exit(0);
  } catch (err) {
    logger.error(`[${name}] Shutdown error — forcing exit`, {
      error: err.message,
    });
    process.exit(1);
  }
}

/**
 * Register SIGTERM + SIGINT + unhandledRejection with a double-invocation guard.
 * Call this ONCE per process after all handles are initialised.
 *
 * @param {Parameters<typeof gracefulShutdown>[0]} opts
 */
export function registerShutdownHandlers(opts) {
  let isShuttingDown = false;

  const handler = (signal) => {
    if (isShuttingDown) {
      logger.warn(
        `[${opts.name}] ${signal} received again — already shutting down, ignoring`
      );
      return;
    }
    isShuttingDown = true;
    gracefulShutdown(opts);
  };

  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGINT", () => handler("SIGINT"));

  process.on("unhandledRejection", (err) => {
    logger.error(`[${opts.name}] Unhandled rejection — triggering shutdown`, {
      error: err?.message,
    });
    handler("unhandledRejection");
  });
}
