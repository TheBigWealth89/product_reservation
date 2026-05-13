import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redisClient } from '../db/connections.js';

// It returns a new RedisStore instance with the given configuration. 
// Each limiter needs its own store instance because rate-limit-redis tracks state per-instance.
const makeStore = () => new RedisStore({
  // Proper ioredis v5 call signature
  sendCommand: (command, ...args) => redisClient.call(command, ...args),
});

const baseConfig = {
  standardHeaders: true, // sends RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset
  legacyHeaders: false,  // disables X-RateLimit-* (deprecated)

  // Using the verified user ID from the authentication middleware.
  keyGenerator: (req) => req.user?.id,

  // Custom JSON handler for API consistency
  handler: (req, res, next, options) => {
    res.status(429).json({
      error: options.message,
      retryAfter: Math.ceil(options.windowMs / 1000),
    });
  },

  // Skip health checks to avoid exhausting IP limits via load balancers
  skip: (req) => req.path === '/health',
};

export const reserveLimiter = rateLimit({
  ...baseConfig,
  store: makeStore(),
  windowMs: 15 * 60 * 1000, // 15 minutes (more forgiving for bursty networks)
  max: 10,
  message: 'Too many reservation attempts, please try again later.',
});

export const paymentLimiter = rateLimit({
  ...baseConfig,
  store: makeStore(),
  windowMs: 60 * 1000, // 1 minute
  max: 3,
  message: 'Too many payment attempts, please try again later.',
});
