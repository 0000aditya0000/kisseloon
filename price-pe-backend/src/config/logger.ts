import path from 'path';
import winston from 'winston';

const logLevel = process.env.LOG_LEVEL || 'debug';
const logsDir = path.join(process.cwd(), 'logs');

const { combine, timestamp, errors, printf, colorize, json } = winston.format;

const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    const metaKeys = Object.keys(meta).filter((key) => key !== 'service');
    const metaStr = metaKeys.length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const base = `${ts} [${level}]: ${stack || message}`;
    return `${base}${metaStr}`;
  })
);

const fileFormat = combine(
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  json()
);

const logger = winston.createLogger({
  level: logLevel,
  defaultMeta: { service: 'price-pe-backend' },
  transports: [
    new winston.transports.Console({
      format: consoleFormat,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: fileFormat,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: fileFormat,
    }),
  ],
  exitOnError: false,
});

export const morganStream = {
  write: (message: string): void => {
    logger.info(message.trim());
  },
};

export default logger;
