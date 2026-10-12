import { describe, it, expect, vi } from 'vitest';
import {
  HttpMlExecutionProvider,
  HttpMlProviderError,
  analyticsMlModule,
  InMemoryMlStore,
  MlService,
  type IMlInferenceProvider,
} from '../src/modules/analytics-ml/index.js';
import { ValidationError } from '../src/errors/app-error.js';
import { JsonLogger } from '../src/observability/logger.js';
import type { IAnalyticsMlFeatureReader } from '../src/modules/analytics/index.js';

describe('HttpMlExecutionProvider', () => {
  const BASE_URL = 'http://ml-service.internal:8000';
  const logger = new JsonLogger({ serviceName: 'http-ml-test', level: 'error' });

  describe('1. Configuration & Instantiation', () => {
    it('initializes with a valid string base URL and strips trailing slashes', () => {
      const provider = new HttpMlExecutionProvider('http://ml-service.internal:8000///');
      expect(provider).toBeInstanceOf(HttpMlExecutionProvider);
    });

    it('initializes with an options object', () => {
      const provider = new HttpMlExecutionProvider({
        baseUrl: 'http://ml-service.internal:8000/',
        timeoutMs: 5000,
      });
      expect(provider).toBeInstanceOf(HttpMlExecutionProvider);
    });

    it('throws ValidationError when base URL is empty or whitespace', () => {
      expect(() => new HttpMlExecutionProvider('')).toThrow(ValidationError);
      expect(() => new HttpMlExecutionProvider('   ')).toThrow(ValidationError);
      expect(() => new HttpMlExecutionProvider({ baseUrl: '' })).toThrow(ValidationError);
    });

    it('is exported from analyticsMlModule factory helper without altering default provider', () => {
      const httpProvider = analyticsMlModule.createHttpExecutionProvider(BASE_URL);
      expect(httpProvider).toBeInstanceOf(HttpMlExecutionProvider);

      // Verify default createService STILL wires LocalPythonMlExecutionProvider
      const dummyStore = new InMemoryMlStore();
      const dummyReader = {} as IAnalyticsMlFeatureReader;
      const defaultService = analyticsMlModule.createService(dummyStore, dummyReader, logger);
      expect(defaultService).toBeInstanceOf(MlService);
    });
  });

  describe('2. Interface Conformance (IMlInferenceProvider)', () => {
    it('implements IMlInferenceProvider and does not expose training operations', () => {
      const provider = new HttpMlExecutionProvider(BASE_URL);
      expect(provider).toBeInstanceOf(HttpMlExecutionProvider);
      expect(typeof provider.runPrediction).toBe('function');
      // Confirms runTraining is not exposed on the inference-only HTTP provider
      expect('runTraining' in provider).toBe(false);
    });
  });

  describe('3. Prediction Dispatch & Contract Preservation (runPrediction)', () => {
    it('dispatches POST /v1/predict and sends the existing payload contract unchanged', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(
          JSON.stringify({
            success: true,
            predictions: [
              {
                entityId: 'prod-123',
                predictionValue: 42.5,
                probability: null,
                confidence: 0.95,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const provider = new HttpMlExecutionProvider(BASE_URL, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const testPayload = {
        modelType: 'DEMAND_FORECASTING',
        artifactPath: 'models/tenant-1/DEMAND_FORECASTING/model.joblib',
        features: [
          {
            entityId: 'prod-123',
            featureVector: [1.5, 3.0, 10.0, 3.33, 14.0, 0.0],
          },
        ],
      };

      const result = await provider.runPrediction(testPayload);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(capturedUrl).toBe(`${BASE_URL}/v1/predict`);
      expect(capturedInit?.method).toBe('POST');
      expect((capturedInit?.headers as Record<string, string>)?.['Content-Type']).toBe(
        'application/json',
      );
      expect((capturedInit?.headers as Record<string, string>)?.['Accept']).toBe(
        'application/json',
      );

      // Verify exact JSON body sent
      const parsedBody = JSON.parse(capturedInit?.body as string);
      expect(parsedBody).toEqual({
        modelType: 'DEMAND_FORECASTING',
        artifactPath: 'models/tenant-1/DEMAND_FORECASTING/model.joblib',
        features: [
          {
            entityId: 'prod-123',
            featureVector: [1.5, 3.0, 10.0, 3.33, 14.0, 0.0],
          },
        ],
      });

      // Verify parsed response
      expect(result).toEqual({
        success: true,
        predictions: [
          {
            entityId: 'prod-123',
            predictionValue: 42.5,
            probability: null,
            confidence: 0.95,
          },
        ],
      });
    });

    it('correctly handles multi-item batch predictions with optional probability and confidence', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            success: true,
            predictions: [
              { entityId: 'c-1', predictionValue: 1.0, probability: 0.88, confidence: 0.92 },
              { entityId: 'c-2', predictionValue: 0.0, probability: 0.12, confidence: 0.85 },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const provider = new HttpMlExecutionProvider(BASE_URL, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await provider.runPrediction({
        modelType: 'PURCHASE_PROPENSITY',
        artifactPath: 'models/tenant-1/PURCHASE_PROPENSITY/model.joblib',
        features: [
          { entityId: 'c-1', featureVector: [10, 20] },
          { entityId: 'c-2', featureVector: [1, 2] },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.predictions).toHaveLength(2);
      expect(result.predictions?.[0]).toEqual({
        entityId: 'c-1',
        predictionValue: 1.0,
        probability: 0.88,
        confidence: 0.92,
      });
      expect(result.predictions?.[1]).toEqual({
        entityId: 'c-2',
        predictionValue: 0.0,
        probability: 0.12,
        confidence: 0.85,
      });
    });
  });

  describe('4. Non-2xx Response Handling', () => {
    it('converts 400 Bad Request into typed HttpMlProviderError with message from body', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Unknown model type: INVALID_TYPE',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const provider = new HttpMlExecutionProvider(BASE_URL, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      try {
        await provider.runPrediction({
          modelType: 'INVALID_TYPE',
          artifactPath: 'x',
          features: [],
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpMlProviderError);
        const pErr = err as HttpMlProviderError;
        expect(pErr.statusCode).toBe(400);
        expect(pErr.message).toContain('Unknown model type: INVALID_TYPE');
      }
    });

    it('converts 404 Not Found into typed HttpMlProviderError', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Artifact not found: missing.joblib',
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const provider = new HttpMlExecutionProvider(BASE_URL, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      try {
        await provider.runPrediction({
          modelType: 'STOCKOUT_RISK',
          artifactPath: 'missing.joblib',
          features: [],
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpMlProviderError);
        const pErr = err as HttpMlProviderError;
        expect(pErr.statusCode).toBe(404);
        expect(pErr.message).toContain('Artifact not found');
      }
    });

    it('converts 500 Internal Server Error with HTML/text body into typed HttpMlProviderError', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response('<html><title>500 Internal Error</title></html>', {
          status: 500,
          statusText: 'Internal Server Error',
        });
      });

      const provider = new HttpMlExecutionProvider(BASE_URL, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      try {
        await provider.runPrediction({
          modelType: 'DEMAND_FORECASTING',
          artifactPath: 'model.joblib',
          features: [],
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpMlProviderError);
        const pErr = err as HttpMlProviderError;
        expect(pErr.statusCode).toBe(500);
        expect(pErr.message).toContain('500');
      }
    });
  });

  describe('5. Malformed and Unexpected Response Handling', () => {
    it('throws HttpMlProviderError when response body is invalid JSON', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response('not valid json at all {', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const provider = new HttpMlExecutionProvider(BASE_URL, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.runPrediction({
          modelType: 'DEMAND_FORECASTING',
          artifactPath: 'm.joblib',
          features: [],
        }),
      ).rejects.toThrow(HttpMlProviderError);
    });

    it('throws HttpMlProviderError when response JSON indicates success=false in a 200 response', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Inference runtime crashed',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const provider = new HttpMlExecutionProvider(BASE_URL, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      try {
        await provider.runPrediction({
          modelType: 'DEMAND_FORECASTING',
          artifactPath: 'm.joblib',
          features: [],
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpMlProviderError);
        const pErr = err as HttpMlProviderError;
        expect(pErr.code).toBe('ML_SERVICE_INFERENCE_FAILED');
        expect(pErr.message).toContain('Inference runtime crashed');
      }
    });

    it('throws HttpMlProviderError when response JSON is missing predictions array', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            success: true,
            // missing predictions
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const provider = new HttpMlExecutionProvider(BASE_URL, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.runPrediction({
          modelType: 'DEMAND_FORECASTING',
          artifactPath: 'm.joblib',
          features: [],
        }),
      ).rejects.toThrow(HttpMlProviderError);
    });
  });

  describe('6. Timeout and Network Failure', () => {
    it('throws HttpMlProviderError with ML_SERVICE_TIMEOUT on request abort/timeout', async () => {
      const mockFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const abortErr = new Error('The operation was aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            });
          }
        });
      });

      const provider = new HttpMlExecutionProvider(BASE_URL, {
        timeoutMs: 15,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      try {
        await provider.runPrediction({
          modelType: 'DEMAND_FORECASTING',
          artifactPath: 'm.joblib',
          features: [],
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpMlProviderError);
        const pErr = err as HttpMlProviderError;
        expect(pErr.statusCode).toBe(504);
        expect(pErr.code).toBe('ML_SERVICE_TIMEOUT');
        expect(pErr.message).toContain('timed out');
      }
    });

    it('throws HttpMlProviderError with ML_SERVICE_NETWORK_ERROR on fetch network failure', async () => {
      const mockFetch = vi.fn(async () => {
        throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:8000');
      });

      const provider = new HttpMlExecutionProvider(BASE_URL, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      try {
        await provider.runPrediction({
          modelType: 'DEMAND_FORECASTING',
          artifactPath: 'm.joblib',
          features: [],
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpMlProviderError);
        const pErr = err as HttpMlProviderError;
        expect(pErr.statusCode).toBe(502);
        expect(pErr.code).toBe('ML_SERVICE_NETWORK_ERROR');
        expect(pErr.message).toContain('ECONNREFUSED');
      }
    });
  });

  describe('7. IMlInferenceProvider contract', () => {
    it('satisfies IMlInferenceProvider interface for model inference dispatch', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            success: true,
            predictions: [
              { entityId: 'p-1', predictionValue: 99.0, probability: null, confidence: 0.9 },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const httpProvider: IMlInferenceProvider = new HttpMlExecutionProvider(BASE_URL, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await httpProvider.runPrediction({
        modelType: 'DEMAND_FORECASTING',
        artifactPath: 'model.joblib',
        features: [],
      });

      expect(result.success).toBe(true);
      expect(result.predictions).toHaveLength(1);
    });
  });

  describe('8. CompositeMlExecutionProvider (Inference + Training Decoupling)', () => {
    it('delegates runPrediction to inference provider and runTraining to training provider', async () => {
      const mockInference: IMlInferenceProvider = {
        runPrediction: vi.fn(async () => ({
          success: true,
          modelType: 'DEMAND_FORECASTING',
          predictions: [
            { entityId: 'prod-1', predictionValue: 42.0, probability: null, confidence: 0.95 },
          ],
        })),
      };

      const mockTraining = {
        runTraining: vi.fn(async () => ({
          success: true,
          status: 'APPROVED' as const,
          modelId: 'mdl-composite-1',
          version: 'v1.0.0',
          metrics: { train: { r2: 0.88 }, validation: { r2: 0.85 }, test: { rmse: 12.5 } },
          algorithm: 'RandomForestRegressor',
          featureVersion: 'v1',
          dataSourceType: 'REAL' as const,
          artifactPath: 'test.joblib',
          trainedAt: '2026-10-10T12:00:00Z',
        })),
      };

      const composite = analyticsMlModule.createCompositeExecutionProvider(
        mockInference,
        mockTraining,
      );

      const pred = await composite.runPrediction({ modelType: 'DEMAND_FORECASTING' });
      expect(pred.success).toBe(true);
      expect(pred.predictions?.[0]?.predictionValue).toBe(42.0);
      expect(mockInference.runPrediction).toHaveBeenCalledTimes(1);
      expect(mockTraining.runTraining).not.toHaveBeenCalled();

      const train = await composite.runTraining({
        modelType: 'DEMAND_FORECASTING',
        version: 'v1.0.0',
      });
      expect(train.success).toBe(true);
      expect(train.modelId).toBe('mdl-composite-1');
      expect(mockTraining.runTraining).toHaveBeenCalledTimes(1);
    });
  });
});
