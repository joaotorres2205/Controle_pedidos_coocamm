-- ============================================================
-- COOCAMM — Schema Update v2
-- Execute no Supabase → SQL Editor → New Query
-- ============================================================

-- Já incluído no schema.sql principal (v2 mantido para referência)
-- Tabela de histórico / auditoria
CREATE TABLE IF NOT EXISTS historico (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  usuario_email VARCHAR(200),
  acao          VARCHAR(20) NOT NULL,   -- CRIOU | EDITOU | EXCLUIU
  entidade      VARCHAR(50) NOT NULL,   -- carregamento | nota_sf | pedido | etc.
  entidade_id   TEXT,
  descricao     TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE historico ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_historico_created  ON historico(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_historico_entidade ON historico(entidade);
CREATE INDEX IF NOT EXISTS idx_historico_acao     ON historico(acao);
CREATE INDEX IF NOT EXISTS idx_historico_usuario  ON historico(usuario_email);
