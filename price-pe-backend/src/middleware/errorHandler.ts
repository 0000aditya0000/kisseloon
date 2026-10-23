import type { Request, Response, NextFunction } from 'express';
import logger from '../config/logger';
import env from '../config/env';
import type { ApiError } from '../types/errors';

export const errorHandler = (
  err: ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  const message = err.message || 'Internal Server Error';

  logger.error('Request failed', {
    statusCode,
    message,
    stack: err.stack,
    details: err.details,
  });

  res.status(statusCode).json({
    success: false,
    error: {
      message,
      statusCode,
      ...(env.isProduction ? {} : { stack: err.stack, details: err.details }),
    },
  });
};

export default errorHandler;
