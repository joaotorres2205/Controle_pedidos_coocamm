-- ============================================================
-- BACKFILL: preenche numero_pedido para pedidos antigos com NULL
-- Execute no Supabase SQL Editor
-- ============================================================

-- Etapa 1: gera números sequenciais por ano para os registros com numero_pedido = NULL
WITH ranked AS (
  SELECT
    id,
    'PED-' || EXTRACT(YEAR FROM created_at)::TEXT || '-' ||
    LPAD(
      ROW_NUMBER() OVER (
        PARTITION BY EXTRACT(YEAR FROM created_at)
        ORDER BY created_at ASC
      )::TEXT,
      4, '0'
    ) AS novo_numero
  FROM pedidos
  WHERE numero_pedido IS NULL
)
UPDATE pedidos p
SET numero_pedido = r.novo_numero
FROM ranked r
WHERE p.id = r.id;

-- Etapa 2: verifica quantas linhas ainda têm NULL (deve retornar 0)
SELECT COUNT(*) AS ainda_null FROM pedidos WHERE numero_pedido IS NULL;
