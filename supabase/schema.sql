-- ============================================================
-- IBIATÃ 2026 — Schema do Banco de Dados (Supabase / PostgreSQL)
-- Execute este script no Supabase → SQL Editor → New Query
-- ============================================================

-- ─── TABELAS DE CADASTRO (dinâmicas, sem valores fixos no código) ─────────────

CREATE TABLE IF NOT EXISTS produtos (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nome       VARCHAR(100) NOT NULL UNIQUE,
  unidade    VARCHAR(20)  NOT NULL DEFAULT 't',   -- t, kg, sc, L, etc.
  descricao  TEXT,
  ativo      BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fornecedores (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nome       VARCHAR(150) NOT NULL,
  cnpj       VARCHAR(18),
  telefone   VARCHAR(20),
  email      VARCHAR(100),
  cidade     VARCHAR(100),
  estado     VARCHAR(2),
  ativo      BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clientes (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nome       VARCHAR(150) NOT NULL,
  cpf_cnpj   VARCHAR(18),
  telefone   VARCHAR(20),
  email      VARCHAR(100),
  cidade     VARCHAR(100),
  estado     VARCHAR(2),
  ativo      BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── CARREGAMENTOS (NF de Remessa) ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS carregamentos (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nota_nf       VARCHAR(20)    NOT NULL,
  data          DATE           NOT NULL,
  produto       VARCHAR(100)   NOT NULL,         -- referencia nome do produto
  modal         VARCHAR(10)    NOT NULL CHECK (modal IN ('FOB', 'CIF')),
  quantidade    NUMERIC(12,2)  NOT NULL CHECK (quantidade > 0),
  custo_ton     NUMERIC(10,2)  NOT NULL CHECK (custo_ton >= 0),
  serie_filial  VARCHAR(20),
  fornecedor_id UUID           REFERENCES fornecedores(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ    DEFAULT NOW(),
  updated_at    TIMESTAMPTZ    DEFAULT NOW()
);

-- ─── NOTAS DE SIMPLES FATURAMENTO (SF) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS notas_sf (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nota_sf         VARCHAR(20)    NOT NULL,
  data            DATE           NOT NULL,
  produto         VARCHAR(100)   NOT NULL,
  carregamento_id UUID           NOT NULL REFERENCES carregamentos(id) ON DELETE RESTRICT,
  cliente_id      UUID           NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
  quantidade      NUMERIC(12,2)  NOT NULL CHECK (quantidade > 0),
  valor_total     NUMERIC(12,2)  NOT NULL CHECK (valor_total >= 0),
  codigo_fiscal   VARCHAR(20),
  created_at      TIMESTAMPTZ    DEFAULT NOW()
);

-- ─── PEDIDOS ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pedidos (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_id         UUID           NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
  produto            VARCHAR(100),
  quantidade_pedida  NUMERIC(12,2)  NOT NULL CHECK (quantidade_pedida > 0),
  quantidade_entregue NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (quantidade_entregue >= 0),
  observacao         TEXT,
  created_at         TIMESTAMPTZ    DEFAULT NOW(),
  updated_at         TIMESTAMPTZ    DEFAULT NOW()
);

-- ─── ÍNDICES ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_carregamentos_produto    ON carregamentos(produto);
CREATE INDEX IF NOT EXISTS idx_carregamentos_data       ON carregamentos(data DESC);
CREATE INDEX IF NOT EXISTS idx_carregamentos_fornecedor ON carregamentos(fornecedor_id);
CREATE INDEX IF NOT EXISTS idx_notas_sf_carregamento    ON notas_sf(carregamento_id);
CREATE INDEX IF NOT EXISTS idx_notas_sf_cliente         ON notas_sf(cliente_id);
CREATE INDEX IF NOT EXISTS idx_notas_sf_data            ON notas_sf(data DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente          ON pedidos(cliente_id);

-- ─── DADOS INICIAIS: PRODUTOS ─────────────────────────────────────────────────
-- (Você pode adicionar mais pelo sistema — estes são os dados de exemplo)

INSERT INTO produtos (nome, unidade, descricao) VALUES
  ('CALCÁRIO',         't',  'Calcário agrícola para correção de solo'),
  ('GESSO',            't',  'Gesso agrícola para condicionamento de solo'),
  ('COMPOSTO ORGÂNICO','t',  'Composto orgânico para fertilização')
ON CONFLICT (nome) DO NOTHING;

-- ─── DADOS INICIAIS: FORNECEDORES ─────────────────────────────────────────────

INSERT INTO fornecedores (id, nome) VALUES
  ('f0000000-0000-0000-0000-000000000001', 'Fornecedor Padrão Ibiatã')
ON CONFLICT DO NOTHING;

-- ─── DADOS INICIAIS: CLIENTES ─────────────────────────────────────────────────

INSERT INTO clientes (id, nome) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'Luiz Carlos de Paula'),
  ('c0000000-0000-0000-0000-000000000002', 'Leandro Volpe'),
  ('c0000000-0000-0000-0000-000000000003', 'José Brás'),
  ('c0000000-0000-0000-0000-000000000004', 'Wilson Guimarães'),
  ('c0000000-0000-0000-0000-000000000005', 'Mariangela Montans'),
  ('c0000000-0000-0000-0000-000000000006', 'José Varo'),
  ('c0000000-0000-0000-0000-000000000007', 'Saulo Dutra Varo'),
  ('c0000000-0000-0000-0000-000000000008', 'Fernando de Padua Pessoni'),
  ('c0000000-0000-0000-0000-000000000009', 'Marcio Antonio de Souza'),
  ('c0000000-0000-0000-0000-000000000010', 'Marcos Vinicius Nascimento'),
  ('c0000000-0000-0000-0000-000000000011', 'Dalton Furtado'),
  ('c0000000-0000-0000-0000-000000000012', 'Oswaldo Moura'),
  ('c0000000-0000-0000-0000-000000000013', 'Marcio Couto Rosa'),
  ('c0000000-0000-0000-0000-000000000014', 'Aguinaldo')
ON CONFLICT DO NOTHING;

-- ─── DADOS INICIAIS: CARREGAMENTOS ───────────────────────────────────────────

INSERT INTO carregamentos (id, nota_nf, data, produto, modal, quantidade, custo_ton, fornecedor_id) VALUES
  ('a0000000-0000-0000-0000-000000000001', '0000013048', '2026-03-18', 'CALCÁRIO', 'FOB', 200.00,  240.00, 'f0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000002', '0000013048', '2026-03-18', 'GESSO',    'FOB', 100.00,  240.00, 'f0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000003', '0000013049', '2026-03-18', 'CALCÁRIO', 'FOB', 600.00,  240.00, 'f0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000004', '0000013049', '2026-03-18', 'GESSO',    'FOB', 200.00,  240.00, 'f0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000005', '0000013052', '2026-03-18', 'COMPOSTO ORGÂNICO', 'FOB', 1000.00, 135.00, 'f0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000006', '0000013229', '2026-04-14', 'COMPOSTO ORGÂNICO', 'FOB', 1000.00, 135.00, 'f0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000007', '0000013050', '2026-03-18', 'CALCÁRIO', 'CIF', 466.67, 270.00, 'f0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000008', '0000013050', '2026-03-18', 'GESSO',    'CIF', 233.33, 270.00, 'f0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000009', '0000013051', '2026-03-18', 'CALCÁRIO', 'CIF', 975.00, 270.00, 'f0000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- ─── DADOS INICIAIS: NOTAS SF ────────────────────────────────────────────────

INSERT INTO notas_sf (nota_sf, data, produto, carregamento_id, cliente_id, quantidade, valor_total) VALUES
  ('0000013145', '2026-04-18', 'CALCÁRIO', 'a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000013', 13.76, 3302.40),
  ('0000013154', '2026-04-18', 'CALCÁRIO', 'a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000013', 13.24, 3177.60),
  ('0000013145', '2026-04-18', 'GESSO',    'a0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000013', 6.88,  1651.20),
  ('0000013132', '2026-04-18', 'CALCÁRIO', 'a0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000014', 15.36, 3686.40),
  ('0000013133', '2026-04-18', 'CALCÁRIO', 'a0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000014', 15.12, 3628.80),
  ('0000013136', '2026-04-19', 'COMPOSTO ORGÂNICO', 'a0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000001', 20.66, 2789.10),
  ('0000013342', '2026-05-08', 'COMPOSTO ORGÂNICO', 'a0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000012', 1.10,  148.50)
ON CONFLICT DO NOTHING;

-- ─── DADOS INICIAIS: PEDIDOS ─────────────────────────────────────────────────

INSERT INTO pedidos (cliente_id, produto, quantidade_pedida, quantidade_entregue) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'COMPOSTO ORGÂNICO', 40.00,   40.46),
  ('c0000000-0000-0000-0000-000000000002', 'CALCÁRIO',          20.00,   20.54),
  ('c0000000-0000-0000-0000-000000000003', 'CALCÁRIO',         160.00,  120.44),
  ('c0000000-0000-0000-0000-000000000004', 'CALCÁRIO',          40.00,   40.54),
  ('c0000000-0000-0000-0000-000000000005', 'CALCÁRIO',         350.00,  347.70),
  ('c0000000-0000-0000-0000-000000000006', 'CALCÁRIO',         140.00,    0.00),
  ('c0000000-0000-0000-0000-000000000007', 'CALCÁRIO',         140.00,    0.00),
  ('c0000000-0000-0000-0000-000000000008', 'CALCÁRIO',         800.00,   80.76),
  ('c0000000-0000-0000-0000-000000000009', 'CALCÁRIO',         120.00,    0.00),
  ('c0000000-0000-0000-0000-000000000010', 'CALCÁRIO',          80.00,    0.00),
  ('c0000000-0000-0000-0000-000000000011', 'CALCÁRIO',         225.00,  164.41),
  ('c0000000-0000-0000-0000-000000000012', 'COMPOSTO ORGÂNICO', 250.00, 246.76)
ON CONFLICT DO NOTHING;

-- ─── ROW LEVEL SECURITY (RLS) ────────────────────────────────────────────────
-- Ativa RLS em todas as tabelas: apenas usuários autenticados acessam

ALTER TABLE produtos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE fornecedores  ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE carregamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE notas_sf      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos       ENABLE ROW LEVEL SECURITY;

-- Service role bypassa RLS (usado pelo backend Node.js com SUPABASE_SERVICE_KEY)
-- Nenhuma policy adicional é necessária para o backend.
-- Se quiser expor leitura para usuários auth pela UI direta, adicione:
-- CREATE POLICY "autenticados leem" ON produtos FOR SELECT USING (auth.role() = 'authenticated');

-- ─── FIM DO SCRIPT ────────────────────────────────────────────────────────────
