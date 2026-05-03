import winston from "winston";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG } from "./config.js";

const LOG_PATH = "data/agent.log";
// Winston's File transport will silently swallow ENOENT on open; ensure the
// directory exists before construction so a fresh clone (no `data/` yet) still
// captures startup logs that fire before the journal lazily creates the dir.
mkdirSync(dirname(LOG_PATH), { recursive: true });

export const logger = winston.createLogger({
  level: CONFIG.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level}] ${message}`;
    }),
  ),
  transports: [
    new winston.transports.File({ filename: LOG_PATH }),
  ],
});
