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

  return null;
}
