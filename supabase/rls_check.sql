-- ============================================================
-- COOCAMM — Verificação de RLS (Row Level Security)
-- Execute no Supabase → SQL Editor → New Query
-- ============================================================
--
-- O backend (src/index.js) usa a SUPABASE_SERVICE_KEY (service_role), que
-- sempre ignora (bypassa) as políticas de RLS. Isso é esperado e seguro,
-- pois essa chave nunca é exposta ao navegador — fica só no servidor/.env.
--
-- O risco real é: alguém obter a URL do projeto + a chave "anon" (pública,
-- usada em apps client-side) e acessar o Supabase DIRETAMENTE, sem passar
-- pelo backend/login. Com RLS ativo e SEM nenhuma policy criada, a chave
-- anon não retorna nem grava nenhuma linha em nenhuma tabela — é o
-- comportamento "seguro por padrão" que queremos aqui, já que este sistema
-- não usa a chave anon em nenhum lugar do frontend.

-- ─── Garante RLS ativo em todas as tabelas ───────────────────────────────
ALTER TABLE produtos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE fornecedores  ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE carregamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE notas_sf      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos       ENABLE ROW LEVEL SECURITY;
-- Sem policies = nenhum acesso via anon key (service_role sempre bypassa)

-- ─── Consulta de diagnóstico: lista o status de RLS de cada tabela ───────
-- rowsecurity = true e policy_count = 0 é o estado esperado/desejado aqui.
SELECT
  t.tablename,
  t.rowsecurity AS rls_ativo,
  COUNT(p.policyname) AS policy_count
FROM pg_tables t
LEFT JOIN pg_policies p ON p.tablename = t.tablename AND p.schemaname = t.schemaname
WHERE t.schemaname = 'public'
  AND t.tablename IN ('produtos','fornecedores','clientes','carregamentos','notas_sf','pedidos')
GROUP BY t.tablename, t.rowsecurity
ORDER BY t.tablename;
