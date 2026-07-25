-- ============================================================
-- COOCAMM — Schema Update v4: campos comerciais em Pedidos
-- Execute no Supabase → SQL Editor → New Query
-- ============================================================

-- Tabela de tipos de embalagem
CREATE TABLE IF NOT EXISTS embalagens (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nome        VARCHAR(100) NOT NULL,
  descricao   TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE embalagens ENABLE ROW LEVEL SECURITY;

-- Tabela de prazos de pagamento
CREATE TABLE IF NOT EXISTS prazos_pagamento (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nome        VARCHAR(100) NOT NULL,  -- ex: "À vista", "30 dias", "30/60/90"
  descricao   TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE prazos_pagamento ENABLE ROW LEVEL SECURITY;

-- Novos campos na tabela pedidos
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS embalagem_id        UUID REFERENCES embalagens(id);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS preco_unitario      NUMERIC(12,2) DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS prazo_pagamento_id  UUID REFERENCES prazos_pagamento(id);
-- total_venda é calculado: quantidade_pedida * preco_unitario (não armazenado)

-- Seed com exemplos comuns (usuário pode editar depois)
INSERT INTO embalagens (nome, descricao) VALUES
  ('Granel', 'Produto a granel, sem embalagem'),
  ('Big Bag 1t', 'Embalagem Big Bag de 1 tonelada'),
  ('Big Bag 500kg', 'Embalagem Big Bag de 500kg'),
  ('Saco 50kg', 'Saco de 50 quilos')
ON CONFLICT DO NOTHING;

INSERT INTO prazos_pagamento (nome, descricao) VALUES
  ('À vista', 'Pagamento no ato'),
  ('30 dias', 'Pagamento em 30 dias'),
  ('30/60 dias', 'Pagamento em 2x: 30 e 60 dias'),
  ('30/60/90 dias', 'Pagamento em 3x: 30, 60 e 90 dias'),
  ('60/90/120 dias', 'Pagamento em 3x: 60, 90 e 120 dias')
ON CONFLICT DO NOTHING;
