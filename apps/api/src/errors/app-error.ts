export abstract class AppError extends Error {
  public abstract readonly statusCode: number;
  public abstract readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  public readonly statusCode = 404;
  public readonly code = 'RESOURCE_NOT_FOUND';
}

export class ValidationError extends AppError {
  public readonly statusCode = 400;
  public readonly code = 'VALIDATION_FAILED';
}

export class UnauthorizedError extends AppError {
  public readonly statusCode = 401;
  public readonly code = 'UNAUTHORIZED';
}

export class ForbiddenError extends AppError {
  public readonly statusCode = 403;
  public readonly code = 'FORBIDDEN';
}

export class ConflictError extends AppError {
  public readonly statusCode = 409;
  public readonly code = 'RESOURCE_CONFLICT';
}

export class InvalidStateTransitionError extends AppError {
  public readonly statusCode = 409;
  public readonly code = 'INVALID_STATE_TRANSITION';
}

export class InsufficientInventoryError extends AppError {
  public readonly statusCode = 409;
  public readonly code = 'INSUFFICIENT_INVENTORY';
}

export class EmptyCartError extends AppError {
  public readonly statusCode = 400;
  public readonly code = 'EMPTY_CART';
}

export class CheckoutValidationError extends AppError {
  public readonly statusCode = 422;
  public readonly code = 'CHECKOUT_VALIDATION_FAILED';
}

export class CheckoutExpiredError extends AppError {
  public readonly statusCode = 409;
  public readonly code = 'CHECKOUT_EXPIRED';
}

export class InternalError extends AppError {
  public readonly statusCode = 500;
  public readonly code = 'INTERNAL_ERROR';
}
