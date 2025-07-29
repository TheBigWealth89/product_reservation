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

// This format is much better for the console
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.colorize({ all: true }), // Colorize the entire log message
  winston.format.printf(
    (info) => `${info.timestamp} [${info.level}]: ${info.message}`
  )
);

// This format is better for files (JSON is standard)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json() // Log as JSON in files
);

const transports = [
  // Always log errors to a dedicated error file
  new winston.transports.File({
    filename: `${logDir}/error.log`,
    level: "error",
    format: fileFormat,
  }),
  // Log everything to a combined file
  new winston.transports.File({
    filename: `${logDir}/combined.log`,
    format: fileFormat,
  }),
];

// Only add the Console transport if we are NOT in production
if (process.env.NODE_ENV !== "production") {
  transports.push(
    new winston.transports.Console({
      level: 'debug', // Log everything to the console in dev
      format: consoleFormat,
    })
  );
}

const logger = winston.createLogger({
  level: "info", // Default level if not specified in transport
  levels,
  transports,
});

export default logger;