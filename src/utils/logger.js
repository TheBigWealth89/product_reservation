import winston from "winston";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Recreate __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const logDir = join(__dirname, "..", "..", "logs")

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

winston.addColors(colors);

const SENSITIVE_KEYS = ["password", "token", "secret", "stripe_secret_key", "session_secret", "authorization", "cookie"];
const STRIPE_REGEX = /(sk_test|sk_live)_[0-9a-zA-Z]+/g;
const BEARER_REGEX = /Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/g;

const redactSecrets = winston.format((info) => {
  if (typeof info.message === 'string') {
    info.message = info.message.replace(STRIPE_REGEX, '[STRIPE_KEY_REDACTED]');
    info.message = info.message.replace(BEARER_REGEX, 'Bearer [TOKEN_REDACTED]');
  }

  const scrubObject = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (let key in obj) {
      if (SENSITIVE_KEYS.some(k => key.toLowerCase().includes(k))) {
        obj[key] = '[REDACTED]';
      } else if (typeof obj[key] === 'object') {
        scrubObject(obj[key]);
      }
    }
  };

  scrubObject(info);
  return info;
});

// This format is much better for the console in development
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.colorize({ all: true }),
  winston.format.printf(
    (info) => {
      const { timestamp, level, message, ...meta } = info;
      const metaString = Object.keys(meta).length ? JSON.stringify(meta) : '';
      return `${timestamp} [${level}]: ${message} ${metaString}`;
    }
  )
);

// This format is better for files and production console (JSON is standard)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

const transports = [
  new winston.transports.File({
    filename: `${logDir}/error.log`,
    level: "error",
    format: fileFormat,
  }),
  new winston.transports.File({
    filename: `${logDir}/combined.log`,
    format: fileFormat,
  }),
];

// Always add the Console transport for Docker logs
transports.push(
  new winston.transports.Console({
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
    format: process.env.NODE_ENV === "production" ? fileFormat : consoleFormat,
  })
);

const logger = winston.createLogger({
  level: "info",
  levels,
  format: winston.format.combine(
    redactSecrets()
  ),
  transports,
});

export default logger;