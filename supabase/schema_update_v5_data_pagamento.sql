-- ============================================================
-- COOCAMM — Schema Update v5: data de pagamento no pedido
-- Execute no Supabase → SQL Editor → New Query
-- ============================================================

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS data_pagamento DATE;
-- prazo_pagamento_id mantido na tabela (histórico), mas deixa de ser usado no app
