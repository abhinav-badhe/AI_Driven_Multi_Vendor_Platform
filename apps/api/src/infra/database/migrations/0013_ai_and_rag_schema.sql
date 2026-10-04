-- Migration: 0013_ai_and_rag_schema.sql
-- Description: AI interaction layer, RAG knowledge documents, versions, chunks, WhatsApp channel mapping, webhook deduplication, and audit logs.
-- Phase: 14 (WhatsApp AI + RAG)
-- Invariant: AI is a derived capability layer. It NEVER becomes the transactional source of truth for Orders, Inventory, Payment, Settlement, Catalog, or Customer truth.

-- 1. AI Conversations
CREATE TABLE IF NOT EXISTS ai_conversations (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  channel VARCHAR(32) NOT NULL DEFAULT 'WEB',
  external_user_id VARCHAR(128) NOT NULL,
  customer_id VARCHAR(64),
  title VARCHAR(255),
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_conv_channel CHECK (
    channel IN ('WEB', 'WHATSAPP', 'API')
  ),
  CONSTRAINT chk_ai_conv_status CHECK (
    status IN ('ACTIVE', 'CLOSED', 'ARCHIVED')
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_conv_tenant_user ON ai_conversations (tenant_id, channel, external_user_id);
CREATE INDEX IF NOT EXISTS idx_ai_conv_customer ON ai_conversations (tenant_id, customer_id);

-- 2. AI Messages
CREATE TABLE IF NOT EXISTS ai_messages (
  id VARCHAR(64) PRIMARY KEY,
  conversation_id VARCHAR(64) NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  tenant_id VARCHAR(64) NOT NULL,
  role VARCHAR(32) NOT NULL,
  content TEXT NOT NULL,
  tool_calls JSONB DEFAULT '[]'::jsonb,
  tool_call_id VARCHAR(64),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_msg_role CHECK (
    role IN ('SYSTEM', 'USER', 'ASSISTANT', 'TOOL')
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_msg_conv_created ON ai_messages (conversation_id, created_at ASC);

-- 3. RAG Knowledge Documents
CREATE TABLE IF NOT EXISTS ai_knowledge_documents (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  category VARCHAR(64) NOT NULL,
  source_type VARCHAR(64) NOT NULL DEFAULT 'MANUAL',
  source_id VARCHAR(128),
  current_version INT NOT NULL DEFAULT 1,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_doc_category CHECK (
    category IN ('PRODUCT_INFO', 'SPECIFICATION', 'POLICY', 'FAQ', 'SHIPPING', 'RETURNS', 'WARRANTY', 'MERCHANT_DOC', 'GENERAL')
  ),
  CONSTRAINT chk_ai_doc_status CHECK (
    status IN ('PENDING', 'PROCESSING', 'INDEXED', 'ARCHIVED', 'FAILED')
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_doc_tenant_category ON ai_knowledge_documents (tenant_id, category, status);
CREATE INDEX IF NOT EXISTS idx_ai_doc_source ON ai_knowledge_documents (tenant_id, source_id);

-- 4. RAG Knowledge Document Versions
CREATE TABLE IF NOT EXISTS ai_knowledge_document_versions (
  id VARCHAR(64) PRIMARY KEY,
  document_id VARCHAR(64) NOT NULL REFERENCES ai_knowledge_documents(id) ON DELETE CASCADE,
  tenant_id VARCHAR(64) NOT NULL,
  version INT NOT NULL,
  raw_content TEXT NOT NULL,
  cleaned_content TEXT NOT NULL,
  chunk_count INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_doc_ver_status CHECK (
    status IN ('PENDING', 'PROCESSING', 'INDEXED', 'SUPERSEDED', 'FAILED')
  ),
  CONSTRAINT uq_ai_doc_version UNIQUE (document_id, version)
);

-- 5. RAG Knowledge Chunks
CREATE TABLE IF NOT EXISTS ai_knowledge_chunks (
  id VARCHAR(64) PRIMARY KEY,
  document_id VARCHAR(64) NOT NULL REFERENCES ai_knowledge_documents(id) ON DELETE CASCADE,
  version_id VARCHAR(64) NOT NULL REFERENCES ai_knowledge_document_versions(id) ON DELETE CASCADE,
  tenant_id VARCHAR(64) NOT NULL,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  embedding JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_chunks_tenant_active ON ai_knowledge_chunks (tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_ai_chunks_doc_active ON ai_knowledge_chunks (document_id, is_active);

-- 6. WhatsApp Identity Mappings
CREATE TABLE IF NOT EXISTS ai_whatsapp_mappings (
  id VARCHAR(64) PRIMARY KEY,
  phone_number VARCHAR(32) NOT NULL UNIQUE,
  tenant_id VARCHAR(64) NOT NULL,
  customer_id VARCHAR(64) NOT NULL,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  verification_code VARCHAR(32),
  verified_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_wa_tenant_customer ON ai_whatsapp_mappings (tenant_id, customer_id);

-- 7. WhatsApp Webhook Idempotency Log
CREATE TABLE IF NOT EXISTS ai_whatsapp_webhooks (
  id VARCHAR(64) PRIMARY KEY,
  provider_message_id VARCHAR(128) NOT NULL UNIQUE,
  tenant_id VARCHAR(64) NOT NULL,
  phone_number VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PROCESSED',
  payload_hash VARCHAR(64) NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_wa_webhook_status CHECK (
    status IN ('RECEIVED', 'PROCESSED', 'FAILED', 'DUPLICATE')
  )
);

-- 8. AI Audit & Observability Logs
CREATE TABLE IF NOT EXISTS ai_audit_logs (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  conversation_id VARCHAR(64),
  channel VARCHAR(32) NOT NULL,
  actor_role VARCHAR(32) NOT NULL,
  actor_id VARCHAR(64) NOT NULL,
  action_type VARCHAR(64) NOT NULL,
  tool_name VARCHAR(64),
  auth_status VARCHAR(32),
  document_ids JSONB DEFAULT '[]'::jsonb,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_audit_tenant_time ON ai_audit_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_audit_action ON ai_audit_logs (action_type, auth_status);
