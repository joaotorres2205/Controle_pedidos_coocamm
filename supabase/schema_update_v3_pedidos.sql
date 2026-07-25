-- ============================================================
-- COOCAMM — Schema Update v3: número de pedido + status + multi-produto
-- Execute no Supabase → SQL Editor → New Query
-- ============================================================

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS numero_pedido VARCHAR(20);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','encerrado'));

CREATE INDEX IF NOT EXISTS idx_pedidos_numero ON pedidos(numero_pedido);
CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);

-- Preenche numero_pedido para pedidos já existentes (1 item = 1 número, na ordem de criação)
WITH numerados AS (
  SELECT id, 'PED-' || EXTRACT(YEAR FROM created_at) || '-' ||
    LPAD(ROW_NUMBER() OVER (PARTITION BY EXTRACT(YEAR FROM created_at) ORDER BY created_at)::TEXT, 4, '0') AS gerado
  FROM pedidos
  WHERE numero_pedido IS NULL
)
UPDATE pedidos p SET numero_pedido = n.gerado
FROM numerados n
WHERE p.id = n.id;
