export interface ImportViolation {
  rule: string;
  sourceFile: string;
  importedPath: string;
  message: string;
}

export function validateImportBoundary(
  sourceFile: string,
  importedPath: string,
): ImportViolation | null {
  // Normalize path separators to forward slashes
  const normalizedSource = sourceFile.replace(/\\/g, '/');
  const normalizedImport = importedPath.replace(/\\/g, '/');

  // Rule 1: Private Internal Encapsulation
  // Cross-module access into any other module's internal/ directory is forbidden.
  const sourceModuleMatch = normalizedSource.match(/modules\/([a-zA-Z0-9-]+)\//);
  const sourceModule = sourceModuleMatch ? sourceModuleMatch[1] : null;

  const internalMatch = normalizedImport.match(/(?:^|\/)([a-zA-Z0-9-]+)\/internal(?:\/|$)/);
  if (internalMatch) {
    const targetModule = internalMatch[1];
    // If the path is relative to self (like ./internal/...), targetModule won't match a sibling module
    if (
      targetModule &&
      targetModule !== '.' &&
      targetModule !== '..' &&
      targetModule !== sourceModule
    ) {
      return {
        rule: 'PRIVATE_INTERNAL_IMPORT_VIOLATION',
        sourceFile,
        importedPath,
        message: `Forbidden cross-module access: '${sourceFile}' cannot import internal path '${importedPath}'. Access must occur exclusively through the target module's public interface.`,
      };
    }
  }

  // Rule 2: AI Direct Database Access Restriction
  // AI code must never import database connections or repositories directly.
  if (normalizedSource.includes('modules/ai/')) {
    if (
      normalizedImport.includes('infra/database') ||
      normalizedImport.includes('/database') ||
      normalizedImport.includes('pg')
    ) {
      return {
        rule: 'AI_DIRECT_DB_IMPORT_VIOLATION',
        sourceFile,
        importedPath,
        message: `Architectural violation: AI module ('${sourceFile}') cannot directly import database infrastructure ('${importedPath}'). AI must interact with commerce strictly via authorized typed tools.`,
      };
    }
  }

  // Rule 3: Derived Systems Transactional Write Restriction
  // Derived systems (search, analytics-ml) are read models / governed consumers and cannot import database directly.
  if (
    normalizedSource.includes('modules/search/') ||
    normalizedSource.includes('modules/analytics-ml/')
  ) {
    if (normalizedImport.includes('infra/database')) {
      return {
        rule: 'DERIVED_SYSTEM_TRANSACTIONAL_WRITE_VIOLATION',
        sourceFile,
        importedPath,
        message: `Architectural violation: Derived module ('${sourceFile}') cannot directly import transactional database ('${importedPath}'). Derived systems consume governed projections/events only.`,
      };
    }
  }

  // Rule 4: Domain Core HTTP Decoupling
  // Domain business modules must not import Fastify or HTTP transport concerns.
  if (
    normalizedSource.includes('modules/') &&
    !normalizedSource.includes('apps/api/src/server') &&
    !normalizedSource.includes('apps/api/src/app')
  ) {
    if (normalizedImport === 'fastify' || normalizedImport.startsWith('fastify/')) {
      return {
        rule: 'DOMAIN_TO_HTTP_COUPLING_VIOLATION',
        sourceFile,
        importedPath,
        message: `Architectural violation: Domain module ('${sourceFile}') cannot directly import HTTP server framework '${importedPath}'. Core domain logic must remain transport-agnostic.`,
      };
    }
  }

  // Rule 5: Search Read-Model Downstream Independence
  // Search derived read model must not depend on or import Orders, Payment, or Settlement modules.
  if (normalizedSource.includes('modules/search/')) {
    if (
      normalizedImport.includes('modules/orders') ||
      normalizedImport.includes('../orders') ||
      normalizedImport.includes('modules/payment') ||
      normalizedImport.includes('../payment') ||
      normalizedImport.includes('modules/settlement-ledger') ||
      normalizedImport.includes('../settlement-ledger')
    ) {
      return {
        rule: 'SEARCH_DOWNSTREAM_DEPENDENCY_VIOLATION',
        sourceFile,
        importedPath,
        message: `Architectural violation: Search read model ('${sourceFile}') cannot import transactional downstream modules ('${importedPath}'). Discovery must remain decoupled from orders, payment, and settlement.`,
      };
    }
  }

  // Rule 6: Notifications Module Decoupling
  // Notifications module must not directly import Orders, Payment, or Settlement modules.
  if (normalizedSource.includes('modules/notifications/')) {
    if (
      normalizedImport.includes('modules/orders') ||
      normalizedImport.includes('../orders') ||
      normalizedImport.includes('modules/payment') ||
      normalizedImport.includes('../payment') ||
      normalizedImport.includes('modules/settlement-ledger') ||
      normalizedImport.includes('../settlement-ledger')
    ) {
      return {
        rule: 'NOTIFICATIONS_DOWNSTREAM_DEPENDENCY_VIOLATION',
        sourceFile,
        importedPath,
        message: `Architectural violation: Notifications module ('${sourceFile}') cannot directly import downstream transactional modules ('${importedPath}'). Notifications react strictly via event transport.`,
      };
    }
  }

  // Rule 7: Analytics Module Transactional Decoupling
  // Analytics module must not directly import transactional domain modules.
  // It reacts strictly to domain events from event transport.
  if (normalizedSource.includes('modules/analytics/')) {
    if (
      normalizedImport.includes('modules/orders') ||
      normalizedImport.includes('../orders') ||
      normalizedImport.includes('modules/payment') ||
      normalizedImport.includes('../payment') ||
      normalizedImport.includes('modules/settlement-ledger') ||
      normalizedImport.includes('../settlement-ledger') ||
      normalizedImport.includes('modules/inventory') ||
      normalizedImport.includes('../inventory') ||
      normalizedImport.includes('modules/catalog') ||
      normalizedImport.includes('../catalog') ||
      normalizedImport.includes('modules/marketplace') ||
      normalizedImport.includes('../marketplace') ||
      normalizedImport.includes('modules/cart-checkout') ||
      normalizedImport.includes('../cart-checkout')
    ) {
      return {
        rule: 'ANALYTICS_TRANSACTIONAL_DEPENDENCY_VIOLATION',
        sourceFile,
        importedPath,
        message: `Architectural violation: Analytics module ('${sourceFile}') cannot directly import transactional domain modules ('${importedPath}'). Analytics derives information exclusively from event transport and cannot mutate transactional truth.`,
      };
    }
  }

  // Rule 8: Recommendations Module Transactional and ML Decoupling
  // Recommendations module must not directly import transactional downstream modules (orders, payment, settlement-ledger, cart-checkout)
  // and must NOT import predictive ML or AI modules.
  if (normalizedSource.includes('modules/recommendations/')) {
    if (
      normalizedImport.includes('modules/orders') ||
      normalizedImport.includes('../orders') ||
      normalizedImport.includes('modules/payment') ||
      normalizedImport.includes('../payment') ||
      normalizedImport.includes('modules/settlement-ledger') ||
      normalizedImport.includes('../settlement-ledger') ||
      normalizedImport.includes('modules/cart-checkout') ||
      normalizedImport.includes('../cart-checkout') ||
      normalizedImport.includes('modules/ai') ||
      normalizedImport.includes('../ai') ||
      normalizedImport.includes('modules/analytics-ml') ||
      normalizedImport.includes('../analytics-ml')
    ) {
      return {
        rule: 'RECOMMENDATIONS_TRANSACTIONAL_DEPENDENCY_VIOLATION',
        sourceFile,
        importedPath,
        message: `Architectural violation: Recommendations module ('${sourceFile}') cannot directly import transactional downstream modules or ML modules ('${importedPath}'). Recommendations derives signals exclusively from events, analytics facts, and authorized read interfaces.`,
      };
    }
  }

  // Rule 9: Predictive ML Transactional Decoupling
  // ML module must not directly import transactional domain modules.
  // Transactional domains must not import ML modules.
  if (normalizedSource.includes('modules/analytics-ml/')) {
    if (
      normalizedImport.includes('modules/orders') ||
      normalizedImport.includes('../orders') ||
      normalizedImport.includes('modules/payment') ||
      normalizedImport.includes('../payment') ||
      normalizedImport.includes('modules/settlement-ledger') ||
      normalizedImport.includes('../settlement-ledger') ||
      normalizedImport.includes('modules/inventory') ||
      normalizedImport.includes('../inventory') ||
      normalizedImport.includes('modules/catalog') ||
      normalizedImport.includes('../catalog') ||
      normalizedImport.includes('modules/marketplace') ||
      normalizedImport.includes('../marketplace') ||
      normalizedImport.includes('modules/cart-checkout') ||
      normalizedImport.includes('../cart-checkout') ||
      normalizedImport.includes('modules/fulfillment') ||
      normalizedImport.includes('../fulfillment')
    ) {
      return {
        rule: 'ML_TRANSACTIONAL_DEPENDENCY_VIOLATION',
        sourceFile,
        importedPath,
        message: `Architectural violation: Predictive ML module ('${sourceFile}') cannot directly import transactional domain modules ('${importedPath}'). ML derives features exclusively from authorized Analytics interfaces.`,
      };
    }
  }

  // Transactional domains must not depend on ML
  const isTransactionalDomain =
    normalizedSource.includes('modules/orders/') ||
    normalizedSource.includes('modules/payment/') ||
    normalizedSource.includes('modules/settlement-ledger/') ||
    normalizedSource.includes('modules/inventory/') ||
    normalizedSource.includes('modules/cart-checkout/') ||
    normalizedSource.includes('modules/fulfillment/');

  if (isTransactionalDomain) {
    if (
      normalizedImport.includes('modules/analytics-ml') ||
      normalizedImport.includes('../analytics-ml') ||
      normalizedImport.includes('modules/ai') ||
      normalizedImport.includes('../ai')
    ) {
      return {
        rule: 'TRANSACTIONAL_TO_ML_DEPENDENCY_VIOLATION',
        sourceFile,
        importedPath,
        message: `Architectural violation: Transactional domain ('${sourceFile}') cannot depend on derived ML or AI modules ('${importedPath}'). Transactional operations must remain fully independent of ML.`,
      };
    }
  }

  return null;
}


