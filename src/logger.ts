import winston from "winston";
import { CONFIG } from "./config.js";

export const logger = winston.createLogger({
  level: CONFIG.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level}] ${message}`;
    }),
  ),
  transports: [
    new winston.transports.File({ filename: "data/agent.log" }),
  ],
});
