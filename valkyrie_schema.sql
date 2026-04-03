-- Valkyrie Database Initialization Script
-- Execute isto na página do Supabase > SQL Editor > New Query

-- 1. Ativar a extensão de IA Vetorial
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Criar a Tabela de Memórias (O Hipocampo)
CREATE TABLE IF NOT EXISTS memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    embedding vector(768), -- Assumindo Text Embedding do Google GenAI, o tamanho do vector "text-embedding-004" do gcp é 768
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Criar índice para busca por similaridade hiper-rápida (HNSW)
CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops);

-- Nota: Caso a gente use um modelo local do OpenAI, o length pode ser 1536 (text-embedding-3-small).
-- Mas para o text-embedding-004 do Google Gemini, são 768 dimensões.

-- 4. Função RPC para busca semântica pelo Python
CREATE OR REPLACE FUNCTION match_memories (
  query_embedding vector(768),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    id,
    content,
    metadata,
    1 - (embedding <=> query_embedding) AS similarity
  FROM memories
  WHERE 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
