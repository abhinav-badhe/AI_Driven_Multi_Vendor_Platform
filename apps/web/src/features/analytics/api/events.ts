import { apiClient } from '../../../api/client';

export interface OutboxEventDto {
  id: string;
  tenantId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  retryCount: number;
  lastError?: string | null;
  createdAt: string;
  publishedAt?: string | null;
}

export interface ListOutboxEventsResponse {
  items: OutboxEventDto[];
  total: number;
}

export interface PublishResultDto {
  processed: number;
  published: number;
  failed: number;
}

export const eventsApi = {
  getOutboxEvents: async (params?: {
    status?: string;
    eventType?: string;
    limit?: number;
    offset?: number;
  }): Promise<ListOutboxEventsResponse> => {
    const qs = new URLSearchParams();
    if (params?.status) qs.append('status', params.status);
    if (params?.eventType) qs.append('eventType', params.eventType);
    if (params?.limit) qs.append('limit', params.limit.toString());
    if (params?.offset) qs.append('offset', params.offset.toString());

    const queryString = qs.toString();
    return apiClient<ListOutboxEventsResponse>(
      `/events/outbox${queryString ? `?${queryString}` : ''}`,
    );
  },

  processOutboxEvents: async (batchSize = 50): Promise<PublishResultDto> => {
    return apiClient<PublishResultDto>('/events/outbox/process', {
      method: 'POST',
      body: JSON.stringify({ batchSize }),
    });
  },

  replayOutboxEvent: async (eventId: string): Promise<{ replayed: boolean }> => {
    return apiClient<{ replayed: boolean }>(`/events/outbox/${eventId}/replay`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
};
