/**
 * BOUNDED CONTEXT: Analytics & ML
 * Ownership: Analytics pipelines, predictive feature extractors, model inference scoring.
 *
 * Invariant: Analytics/ML consume governed data.
 * They MUST NOT directly write transactional business truth.
 */
export interface AnalyticsMlModule {
  readonly contextName: 'analytics-ml';
}

export const analyticsMlModule: AnalyticsMlModule = {
  contextName: 'analytics-ml',
};
