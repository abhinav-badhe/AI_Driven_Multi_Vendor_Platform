import { apiClient } from '../../../api/client';

export interface AiChatMessageRequest {
  message: string;
  conversationId?: string | undefined;
  channel?: 'WEB' | 'WHATSAPP' | undefined;
}

export interface AiChatMessageResponse {
  conversationId: string;
  replyText: string;
  channel: string;
  toolCallsExecuted: string[];
  sourcesRetrieved: string[];
  status?: 'COMPLETED' | 'FAILED';
}

export interface AiConversationHistoryResponse {
  conversation: {
    id: string;
    tenantId: string;
    channel: string;
    title?: string;
    status: string;
    createdAt: string;
  };
  messages: Array<{
    id: string;
    conversationId: string;
    role: 'USER' | 'ASSISTANT' | 'SYSTEM' | 'TOOL';
    content: string;
    createdAt: string;
  }>;
}

export const aiApi = {
  sendMessage: async (req: AiChatMessageRequest): Promise<AiChatMessageResponse> => {
    return apiClient<AiChatMessageResponse>('/ai/chat', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  },

  getConversationHistory: async (conversationId: string): Promise<AiConversationHistoryResponse> => {
    return apiClient<AiConversationHistoryResponse>(`/ai/conversations/${conversationId}`);
  },
};
