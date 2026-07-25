-- ============================================================
-- COOCAMM — Schema Update v6: índices de performance
-- Execute no Supabase → SQL Editor → New Query
-- ============================================================

-- Índices nas FKs (Supabase não cria automaticamente)
CREATE INDEX IF NOT EXISTS idx_notas_sf_carregamento ON notas_sf(carregamento_id);
CREATE INDEX IF NOT EXISTS idx_notas_sf_cliente      ON notas_sf(cliente_id);
CREATE INDEX IF NOT EXISTS idx_notas_sf_produto       ON notas_sf(produto);
CREATE INDEX IF NOT EXISTS idx_notas_sf_data          ON notas_sf(data DESC);

CREATE INDEX IF NOT EXISTS idx_carregamentos_produto  ON carregamentos(produto);
CREATE INDEX IF NOT EXISTS idx_carregamentos_data     ON carregamentos(data DESC);
CREATE INDEX IF NOT EXISTS idx_carregamentos_forn     ON carregamentos(fornecedor_id);

CREATE INDEX IF NOT EXISTS idx_pedidos_cliente        ON pedidos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_status         ON pedidos(status);
CREATE INDEX IF NOT EXISTS idx_pedidos_numero         ON pedidos(numero_pedido);
CREATE INDEX IF NOT EXISTS idx_pedidos_produto        ON pedidos(produto);
