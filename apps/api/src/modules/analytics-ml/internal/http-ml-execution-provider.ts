import { AppError, ValidationError } from '../../../errors/app-error.js';
import type { IMlInferenceProvider } from './ml-execution-provider.js';
import type { PythonPredictResult } from './python-runner.js';

/**
 * Custom error thrown when HTTP communication or response handling with
 * the standalone ML Inference Service fails.
 */
export class HttpMlProviderError extends AppError {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(
    message: string,
    statusCode = 502,
    code = 'ML_SERVICE_HTTP_ERROR',
    details?: unknown,
  ) {
    super(message, details);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface HttpMlExecutionProviderOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface HttpMlExecutionProviderConfig {
  baseUrl: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * HTTP implementation of IMlInferenceProvider.
 *
 * Dispatches model prediction requests over HTTP to the standalone ML inference service
 * (POST /v1/predict). Strictly an inference provider; does not support model training.
 */
export class HttpMlExecutionProvider implements IMlInferenceProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    configOrBaseUrl: string | HttpMlExecutionProviderConfig,
    options?: HttpMlExecutionProviderOptions,
  ) {
    if (typeof configOrBaseUrl === 'string') {
      this.baseUrl = configOrBaseUrl.trim().replace(/\/+$/, '');
      this.timeoutMs = options?.timeoutMs ?? 30000;
      this.fetchFn = options?.fetchFn ?? globalThis.fetch;
    } else {
      this.baseUrl = (configOrBaseUrl.baseUrl || '').trim().replace(/\/+$/, '');
      this.timeoutMs = configOrBaseUrl.timeoutMs ?? options?.timeoutMs ?? 30000;
      this.fetchFn = configOrBaseUrl.fetchFn ?? options?.fetchFn ?? globalThis.fetch;
    }

    if (!this.baseUrl) {
      throw new ValidationError('ML service baseUrl is required for HttpMlExecutionProvider');
    }
  }

  /**
   * Dispatches entity feature vectors to the standalone ML inference service (POST /v1/predict).
   * Preserves payload contract exactly, enforces request timeout, and maps responses/errors.
   */
  async runPrediction(payload: Record<string, unknown>): Promise<PythonPredictResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`ML prediction request timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/v1/predict`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const isAbortOrTimeout =
        controller.signal.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'));

      if (isAbortOrTimeout) {
        throw new HttpMlProviderError(
          `ML prediction request timed out after ${this.timeoutMs}ms`,
          504,
          'ML_SERVICE_TIMEOUT',
          { originalError: err instanceof Error ? err.message : String(err) },
        );
      }
      throw new HttpMlProviderError(
        `ML prediction network request failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
        'ML_SERVICE_NETWORK_ERROR',
        { originalError: err instanceof Error ? err.message : String(err) },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let errorBody: Record<string, unknown> | null = null;
      let textBody = '';
      try {
        const text = await response.text();
        textBody = text;
        errorBody = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Non-JSON error response body
      }

      const errorMessage =
        (typeof errorBody?.error === 'string' && errorBody.error) ||
        (typeof errorBody?.message === 'string' && errorBody.message) ||
        (textBody ? textBody.slice(0, 500) : `HTTP ${response.status} ${response.statusText}`);

      throw new HttpMlProviderError(
        `ML prediction service responded with HTTP ${response.status}: ${errorMessage}`,
        response.status,
        'ML_SERVICE_HTTP_ERROR',
        { statusCode: response.status, body: errorBody ?? textBody },
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = await response.json();
    } catch (err: unknown) {
      throw new HttpMlProviderError(
        `ML prediction service returned malformed JSON response: ${err instanceof Error ? err.message : String(err)}`,
        502,
        'ML_SERVICE_MALFORMED_RESPONSE',
      );
    }

    if (!parsedJson || typeof parsedJson !== 'object') {
      throw new HttpMlProviderError(
        'ML prediction service returned unexpected response: body must be a JSON object',
        502,
        'ML_SERVICE_MALFORMED_RESPONSE',
        { received: parsedJson },
      );
    }

    const resObj = parsedJson as Record<string, unknown>;

    if (resObj.success === false) {
      const errorMsg = typeof resObj.error === 'string' ? resObj.error : 'ML inference failed';
      throw new HttpMlProviderError(
        `ML prediction service reported inference failure: ${errorMsg}`,
        500,
        'ML_SERVICE_INFERENCE_FAILED',
        resObj,
      );
    }

    if (resObj.success !== true || !Array.isArray(resObj.predictions)) {
      throw new HttpMlProviderError(
        'ML prediction service returned unexpected response format: missing predictions array or success flag',
        502,
        'ML_SERVICE_MALFORMED_RESPONSE',
        resObj,
      );
    }

    const predictions = (resObj.predictions as Array<Record<string, unknown>>).map((item) => ({
      entityId: String(item.entityId ?? ''),
      predictionValue: Number(item.predictionValue ?? 0),
      probability: item.probability != null ? Number(item.probability) : null,
      confidence: item.confidence != null ? Number(item.confidence) : null,
    }));

    return {
      success: true,
      predictions,
    };
  }
}
