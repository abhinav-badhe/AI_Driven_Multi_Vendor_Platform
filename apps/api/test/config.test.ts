import { describe, it, expect } from 'vitest';
import { parseConfig, ConfigurationError } from '../src/config/index.js';

describe('Configuration Validation', () => {
  const validEnv: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '4000',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'info',
    DATABASE_HOST: 'localhost',
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'test_db',
    DATABASE_USER: 'test_user',
    DATABASE_PASSWORD: 'test_password',
    DATABASE_POOL_MIN: '1',
    DATABASE_POOL_MAX: '5',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    REDIS_PASSWORD: '',
    REDIS_TLS: 'false',
    ACCESS_TOKEN_SECRET: 'super-secret-key-at-least-16-chars',
    SERVICE_NAME: 'test-commerce-api',
    LOG_PRETTY: 'false',
    REDACT_KEYS: 'password,token,secret',
  };

  it('successfully parses valid environment variables into typed categories', () => {
    const config = parseConfig(validEnv);

    expect(config.app.nodeEnv).toBe('test');
    expect(config.app.port).toBe(4000);
    expect(config.app.host).toBe('127.0.0.1');

    expect(config.postgres.host).toBe('localhost');
    expect(config.postgres.port).toBe(5432);
    expect(config.postgres.database).toBe('test_db');

    expect(config.redis.host).toBe('localhost');
    expect(config.redis.port).toBe(6379);
    expect(config.redis.tls).toBe(false);

    expect(config.observability.serviceName).toBe('test-commerce-api');
    expect(config.observability.redactKeys).toContain('password');
  });

  it('fails fast when required configuration is missing', () => {
    const incompleteEnv = { ...validEnv };
    delete (incompleteEnv as Record<string, unknown>).DATABASE_NAME;
    delete (incompleteEnv as Record<string, unknown>).PORT;

    expect(() => parseConfig(incompleteEnv)).toThrowError(ConfigurationError);
  });

  it('fails when enum values are invalid', () => {
    const invalidEnv = { ...validEnv, NODE_ENV: 'invalid_env' };
    expect(() => parseConfig(invalidEnv)).toThrowError(ConfigurationError);
  });

  it('defaults ML execution mode to local with 30000ms timeout', () => {
    const config = parseConfig(validEnv);
    expect(config.ml.executionMode).toBe('local');
    expect(config.ml.serviceUrl).toBeUndefined();
    expect(config.ml.timeoutMs).toBe(30000);
  });

  it('validates ML execution mode http requires ML_SERVICE_URL', () => {
    const httpEnvWithoutUrl = { ...validEnv, ML_EXECUTION_MODE: 'http' };
    expect(() => parseConfig(httpEnvWithoutUrl)).toThrowError(ConfigurationError);

    const httpEnvWithUrl = {
      ...validEnv,
      ML_EXECUTION_MODE: 'http',
      ML_SERVICE_URL: 'http://ml-service.internal:8000',
      ML_SERVICE_TIMEOUT_MS: '15000',
    };
    const config = parseConfig(httpEnvWithUrl);
    expect(config.ml.executionMode).toBe('http');
    expect(config.ml.serviceUrl).toBe('http://ml-service.internal:8000');
    expect(config.ml.timeoutMs).toBe(15000);
  });

  it('defaults AUTH_VERIFICATION_MODE to dynamic and supports stateless and gateway', () => {
    const config = parseConfig(validEnv);
    expect(config.identity.verificationMode).toBe('dynamic');

    const statelessConfig = parseConfig({ ...validEnv, AUTH_VERIFICATION_MODE: 'stateless' });
    expect(statelessConfig.identity.verificationMode).toBe('stateless');

    const gatewayConfig = parseConfig({ ...validEnv, AUTH_VERIFICATION_MODE: 'gateway' });
    expect(gatewayConfig.identity.verificationMode).toBe('gateway');

    const invalidAuthEnv = { ...validEnv, AUTH_VERIFICATION_MODE: 'invalid_mode' };
    expect(() => parseConfig(invalidAuthEnv)).toThrowError(ConfigurationError);
  });

  it('validates SEARCH_STORE_ADAPTER http requires SEARCH_SERVICE_URL', () => {
    const defaultSearchConfig = parseConfig(validEnv);
    expect(defaultSearchConfig.search.storeAdapter).toBe('postgres');

    const httpSearchWithoutUrl = { ...validEnv, SEARCH_STORE_ADAPTER: 'http' };
    expect(() => parseConfig(httpSearchWithoutUrl)).toThrowError(ConfigurationError);

    const httpSearchWithUrl = {
      ...validEnv,
      SEARCH_STORE_ADAPTER: 'http',
      SEARCH_SERVICE_URL: 'http://search-service.internal:4050',
      SEARCH_SERVICE_TIMEOUT_MS: '8000',
    };
    const config = parseConfig(httpSearchWithUrl);
    expect(config.search.storeAdapter).toBe('http');
    expect(config.search.serviceUrl).toBe('http://search-service.internal:4050');
    expect(config.search.timeoutMs).toBe(8000);
  });

  it('validates RECOMMENDATION_STORE_ADAPTER http requires RECOMMENDATION_SERVICE_URL', () => {
    const defaultRecConfig = parseConfig(validEnv);
    expect(defaultRecConfig.recommendations.storeAdapter).toBe('postgres');

    const httpRecWithoutUrl = { ...validEnv, RECOMMENDATION_STORE_ADAPTER: 'http' };
    expect(() => parseConfig(httpRecWithoutUrl)).toThrowError(ConfigurationError);

    const httpRecWithUrl = {
      ...validEnv,
      RECOMMENDATION_STORE_ADAPTER: 'http',
      RECOMMENDATION_SERVICE_URL: 'http://recommendations-service.internal:4060',
      RECOMMENDATION_SERVICE_TIMEOUT_MS: '7500',
    };
    const config = parseConfig(httpRecWithUrl);
    expect(config.recommendations.storeAdapter).toBe('http');
    expect(config.recommendations.serviceUrl).toBe('http://recommendations-service.internal:4060');
    expect(config.recommendations.timeoutMs).toBe(7500);
  });

  it('validates ANALYTICS_SERVICE_MODE http requires ANALYTICS_SERVICE_URL', () => {
    const defaultAnalyticsConfig = parseConfig(validEnv);
    expect(defaultAnalyticsConfig.analytics.mode).toBe('local');

    const httpAnalyticsWithoutUrl = { ...validEnv, ANALYTICS_SERVICE_MODE: 'http' };
    expect(() => parseConfig(httpAnalyticsWithoutUrl)).toThrowError(ConfigurationError);

    const httpAnalyticsWithUrl = {
      ...validEnv,
      ANALYTICS_SERVICE_MODE: 'http',
      ANALYTICS_SERVICE_URL: 'http://analytics-service.internal:4070',
      ANALYTICS_SERVICE_TIMEOUT_MS: '6000',
    };
    const config = parseConfig(httpAnalyticsWithUrl);
    expect(config.analytics.mode).toBe('http');
    expect(config.analytics.serviceUrl).toBe('http://analytics-service.internal:4070');
    expect(config.analytics.timeoutMs).toBe(6000);
  });

  it('validates MERCHANT_SERVICE_MODE http requires MERCHANT_SERVICE_URL', () => {
    const defaultMerchantConfig = parseConfig(validEnv);
    expect(defaultMerchantConfig.merchant.mode).toBe('local');

    const httpMerchantWithoutUrl = { ...validEnv, MERCHANT_SERVICE_MODE: 'http' };
    expect(() => parseConfig(httpMerchantWithoutUrl)).toThrowError(ConfigurationError);

    const httpMerchantWithUrl = {
      ...validEnv,
      MERCHANT_SERVICE_MODE: 'http',
      MERCHANT_SERVICE_URL: 'http://merchant-service.internal:4080',
      MERCHANT_SERVICE_TIMEOUT_MS: '8000',
    };
    const config = parseConfig(httpMerchantWithUrl);
    expect(config.merchant.mode).toBe('http');
    expect(config.merchant.serviceUrl).toBe('http://merchant-service.internal:4080');
    expect(config.merchant.timeoutMs).toBe(8000);
  });

  it('validates CATALOG_SERVICE_MODE http requires CATALOG_SERVICE_URL', () => {
    const defaultCatalogConfig = parseConfig(validEnv);
    expect(defaultCatalogConfig.catalog.mode).toBe('local');

    const httpCatalogWithoutUrl = { ...validEnv, CATALOG_SERVICE_MODE: 'http' };
    expect(() => parseConfig(httpCatalogWithoutUrl)).toThrowError(ConfigurationError);

    const httpCatalogWithUrl = {
      ...validEnv,
      CATALOG_SERVICE_MODE: 'http',
      CATALOG_SERVICE_URL: 'http://catalog-service.internal:4090',
      CATALOG_SERVICE_TIMEOUT_MS: '7000',
    };
    const config = parseConfig(httpCatalogWithUrl);
    expect(config.catalog.mode).toBe('http');
    expect(config.catalog.serviceUrl).toBe('http://catalog-service.internal:4090');
    expect(config.catalog.timeoutMs).toBe(7000);
  });

  it('validates MARKETPLACE_SERVICE_MODE http requires MARKETPLACE_SERVICE_URL', () => {
    const defaultMarketplaceConfig = parseConfig(validEnv);
    expect(defaultMarketplaceConfig.marketplace.mode).toBe('local');

    const httpMarketplaceWithoutUrl = { ...validEnv, MARKETPLACE_SERVICE_MODE: 'http' };
    expect(() => parseConfig(httpMarketplaceWithoutUrl)).toThrowError(ConfigurationError);

    const httpMarketplaceWithUrl = {
      ...validEnv,
      MARKETPLACE_SERVICE_MODE: 'http',
      MARKETPLACE_SERVICE_URL: 'http://marketplace-service.internal:4095',
      MARKETPLACE_SERVICE_TIMEOUT_MS: '6500',
    };
    const config = parseConfig(httpMarketplaceWithUrl);
    expect(config.marketplace.mode).toBe('http');
    expect(config.marketplace.serviceUrl).toBe('http://marketplace-service.internal:4095');
    expect(config.marketplace.timeoutMs).toBe(6500);
  });

  it('validates INVENTORY_SERVICE_MODE http requires INVENTORY_SERVICE_URL', () => {
    const defaultInventoryConfig = parseConfig(validEnv);
    expect(defaultInventoryConfig.inventory.mode).toBe('local');

    const httpInventoryWithoutUrl = { ...validEnv, INVENTORY_SERVICE_MODE: 'http' };
    expect(() => parseConfig(httpInventoryWithoutUrl)).toThrowError(ConfigurationError);

    const httpInventoryWithUrl = {
      ...validEnv,
      INVENTORY_SERVICE_MODE: 'http',
      INVENTORY_SERVICE_URL: 'http://inventory-service.internal:4080',
      INVENTORY_SERVICE_TIMEOUT_MS: '6000',
    };
    const config = parseConfig(httpInventoryWithUrl);
    expect(config.inventory.mode).toBe('http');
    expect(config.inventory.serviceUrl).toBe('http://inventory-service.internal:4080');
    expect(config.inventory.timeoutMs).toBe(6000);
  });

  it('validates CART_SERVICE_MODE http requires CART_SERVICE_URL', () => {
    const defaultCartConfig = parseConfig(validEnv);
    expect(defaultCartConfig.cart.mode).toBe('local');

    const httpCartWithoutUrl = { ...validEnv, CART_SERVICE_MODE: 'http' };
    expect(() => parseConfig(httpCartWithoutUrl)).toThrowError(ConfigurationError);

    const httpCartWithUrl = {
      ...validEnv,
      CART_SERVICE_MODE: 'http',
      CART_SERVICE_URL: 'http://cart-service.internal:4100',
      CART_SERVICE_TIMEOUT_MS: '4500',
    };
    const config = parseConfig(httpCartWithUrl);
    expect(config.cart.mode).toBe('http');
    expect(config.cart.serviceUrl).toBe('http://cart-service.internal:4100');
    expect(config.cart.timeoutMs).toBe(4500);
  });

  it('validates CHECKOUT_SERVICE_MODE http requires CHECKOUT_SERVICE_URL', () => {
    const defaultCheckoutConfig = parseConfig(validEnv);
    expect(defaultCheckoutConfig.checkout.mode).toBe('local');

    const httpCheckoutWithoutUrl = { ...validEnv, CHECKOUT_SERVICE_MODE: 'http' };
    expect(() => parseConfig(httpCheckoutWithoutUrl)).toThrowError(ConfigurationError);

    const httpCheckoutWithUrl = {
      ...validEnv,
      CHECKOUT_SERVICE_MODE: 'http',
      CHECKOUT_SERVICE_URL: 'http://checkout-service.internal:4110',
      CHECKOUT_SERVICE_TIMEOUT_MS: '7000',
    };
    const config = parseConfig(httpCheckoutWithUrl);
    expect(config.checkout.mode).toBe('http');
    expect(config.checkout.serviceUrl).toBe('http://checkout-service.internal:4110');
    expect(config.checkout.timeoutMs).toBe(7000);
  });

  it('validates ORDER_SERVICE_MODE http requires ORDER_SERVICE_URL', () => {
    const defaultOrderConfig = parseConfig(validEnv);
    expect(defaultOrderConfig.orders.mode).toBe('local');

    const httpOrderWithoutUrl = { ...validEnv, ORDER_SERVICE_MODE: 'http' };
    expect(() => parseConfig(httpOrderWithoutUrl)).toThrowError(ConfigurationError);

    const httpOrderWithUrl = {
      ...validEnv,
      ORDER_SERVICE_MODE: 'http',
      ORDER_SERVICE_URL: 'http://order-service.internal:4120',
      ORDER_SERVICE_TIMEOUT_MS: '8000',
    };
    const config = parseConfig(httpOrderWithUrl);
    expect(config.orders.mode).toBe('http');
    expect(config.orders.serviceUrl).toBe('http://order-service.internal:4120');
    expect(config.orders.timeoutMs).toBe(8000);
  });

  it('validates PAYMENT_SERVICE_MODE http requires PAYMENT_SERVICE_URL', () => {
    const defaultPaymentConfig = parseConfig(validEnv);
    expect(defaultPaymentConfig.payment.mode).toBe('local');

    const httpPaymentWithoutUrl = { ...validEnv, PAYMENT_SERVICE_MODE: 'http' };
    expect(() => parseConfig(httpPaymentWithoutUrl)).toThrowError(ConfigurationError);

    const httpPaymentWithUrl = {
      ...validEnv,
      PAYMENT_SERVICE_MODE: 'http',
      PAYMENT_SERVICE_URL: 'http://payment-service.internal:4130',
      PAYMENT_SERVICE_TIMEOUT_MS: '5500',
    };
    const config = parseConfig(httpPaymentWithUrl);
    expect(config.payment.mode).toBe('http');
    expect(config.payment.serviceUrl).toBe('http://payment-service.internal:4130');
    expect(config.payment.timeoutMs).toBe(5500);
  });

  it('validates FULFILLMENT_SERVICE_MODE http requires FULFILLMENT_SERVICE_URL', () => {
    const defaultFulfillmentConfig = parseConfig(validEnv);
    expect(defaultFulfillmentConfig.fulfillment.mode).toBe('local');

    const httpFulfillmentWithoutUrl = { ...validEnv, FULFILLMENT_SERVICE_MODE: 'http' };
    expect(() => parseConfig(httpFulfillmentWithoutUrl)).toThrowError(ConfigurationError);

    const httpFulfillmentWithUrl = {
      ...validEnv,
      FULFILLMENT_SERVICE_MODE: 'http',
      FULFILLMENT_SERVICE_URL: 'http://fulfillment-service.internal:4140',
      FULFILLMENT_SERVICE_TIMEOUT_MS: '6500',
    };
    const config = parseConfig(httpFulfillmentWithUrl);
    expect(config.fulfillment.mode).toBe('http');
    expect(config.fulfillment.serviceUrl).toBe('http://fulfillment-service.internal:4140');
    expect(config.fulfillment.timeoutMs).toBe(6500);
  });

  it('validates SETTLEMENT_SERVICE_MODE http requires SETTLEMENT_SERVICE_URL', () => {
    const defaultSettlementConfig = parseConfig(validEnv);
    expect(defaultSettlementConfig.settlement.mode).toBe('local');

    const httpSettlementWithoutUrl = { ...validEnv, SETTLEMENT_SERVICE_MODE: 'http' };
    expect(() => parseConfig(httpSettlementWithoutUrl)).toThrowError(ConfigurationError);

    const httpSettlementWithUrl = {
      ...validEnv,
      SETTLEMENT_SERVICE_MODE: 'http',
      SETTLEMENT_SERVICE_URL: 'http://settlement-service.internal:4150',
      SETTLEMENT_SERVICE_TIMEOUT_MS: '7000',
    };
    const config = parseConfig(httpSettlementWithUrl);
    expect(config.settlement.mode).toBe('http');
    expect(config.settlement.serviceUrl).toBe('http://settlement-service.internal:4150');
    expect(config.settlement.timeoutMs).toBe(7000);
  });

  it('validates EVENT_BROKER_MODE http requires EVENT_BROKER_URL', () => {
    const defaultEventBrokerConfig = parseConfig(validEnv);
    expect(defaultEventBrokerConfig.eventBroker.mode).toBe('local');

    const httpEventBrokerWithoutUrl = { ...validEnv, EVENT_BROKER_MODE: 'http' };
    expect(() => parseConfig(httpEventBrokerWithoutUrl)).toThrowError(ConfigurationError);

    const httpEventBrokerWithUrl = {
      ...validEnv,
      EVENT_BROKER_MODE: 'http',
      EVENT_BROKER_URL: 'http://event-broker-service.internal:4160',
      EVENT_BROKER_TIMEOUT_MS: '7500',
    };
    const config = parseConfig(httpEventBrokerWithUrl);
    expect(config.eventBroker.mode).toBe('http');
    expect(config.eventBroker.serviceUrl).toBe('http://event-broker-service.internal:4160');
    expect(config.eventBroker.timeoutMs).toBe(7500);
  });

  it('validates AI_SERVICE_MODE http requires AI_SERVICE_URL', () => {
    const defaultAiConfig = parseConfig(validEnv);
    expect(defaultAiConfig.ai.mode).toBe('local');

    const httpAiWithoutUrl = { ...validEnv, AI_SERVICE_MODE: 'http' };
    expect(() => parseConfig(httpAiWithoutUrl)).toThrowError(ConfigurationError);

    const httpAiWithUrl = {
      ...validEnv,
      AI_SERVICE_MODE: 'http',
      AI_SERVICE_URL: 'http://ai-service.internal:4170',
      AI_SERVICE_TIMEOUT_MS: '20000',
    };
    const config = parseConfig(httpAiWithUrl);
    expect(config.ai.mode).toBe('http');
    expect(config.ai.serviceUrl).toBe('http://ai-service.internal:4170');
    expect(config.ai.timeoutMs).toBe(20000);
  });
});
