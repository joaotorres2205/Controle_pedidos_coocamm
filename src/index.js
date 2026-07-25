require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL e SUPABASE_SERVICE_KEY não configuradas');
  // Não usar process.exit() em serverless — apenas loga o erro
}

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

// Cliente isolado exclusivo para operações de auth (login). NUNCA usar para .from():
// signInWithPassword() atualiza a sessão interna do client, e o supabase-js troca
// automaticamente o header Authorization do REST (.from()) pelo token da sessão ativa
// em vez da service_role key — isso quebraria o bypass de RLS em todas as rotas
// caso essa chamada fosse feita no client `supabase` acima.
const supabaseAuth = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || '',
  { auth: { persistSession: false, autoRefreshToken: false } }
);

app.use(helmet({ contentSecurityPolicy: false })); // CSP false pois usa CDN
app.use(cors({
  origin: ['https://coocamm-pedidos.vercel.app', 'http://localhost:3000'],
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Rate limit geral
app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 200, message: { error: 'Muitas requisições. Tente novamente em 15 minutos.' } }));
// Rate limit severo no login (anti-brute-force)
app.use('/api/auth/login', rateLimit({ windowMs: 15*60*1000, max: 10, message: { error: 'Muitas tentativas de login.' } }));

// Sanitização básica de strings recebidas no body (remove tags HTML e espaços nas bordas)
const clean = (s) => typeof s === 'string' ? s.trim().replace(/<[^>]*>/g, '') : s;
function cleanBody(req, res, next) {
  if (req.originalUrl.startsWith('/api/auth/')) return next(); // nunca sanitizar credenciais
  if (req.body && typeof req.body === 'object') {
    for (const k of Object.keys(req.body)) {
      if (k === 'password') continue; // nunca sanitizar senha
      const v = req.body[k];
      if (typeof v === 'string') req.body[k] = clean(v);
      else if (Array.isArray(v)) {
        req.body[k] = v.map(item => {
          if (item && typeof item === 'object') {
            const cleaned = {};
            for (const ik of Object.keys(item)) cleaned[ik] = clean(item[ik]);
            return cleaned;
          }
          return clean(item);
        });
      }
    }
  }
  next();
}
app.use('/api/', cleanBody);

// Mapeia códigos de erro do Postgres para mensagens seguras
function safeError(e, res) {
  const code = e?.code;
  console.error('[API ERROR]', code, e?.message); // log interno, nunca ao cliente
  if (code === '23505') return res.status(400).json({ error: 'Registro duplicado. Verifique os dados e tente novamente.' });
  if (code === '23503') return res.status(400).json({ error: 'Este registro está vinculado a outros dados e não pode ser excluído.' });
  if (code === '23502') return res.status(400).json({ error: 'Campo obrigatório não informado.' });
  if (code === '22P02') return res.status(400).json({ error: 'Valor inválido informado.' });
  if (code === '42P01') return res.status(500).json({ error: 'Erro de configuração do servidor. Contate o suporte.' });
  return res.status(500).json({ error: 'Erro interno do servidor. Tente novamente.' });
}

function validateNum(val, field, { min = 0, max = 9999999 } = {}) {
  const n = parseFloat(val);
  if (isNaN(n)) return `${field}: valor numérico inválido`;
  if (n < min) return `${field}: deve ser maior ou igual a ${min}`;
  if (n > max) return `${field}: valor muito alto`;
  return null;
}
function validateLen(val, field, max = 200) {
  if (val && String(val).length > max) return `${field}: máximo ${max} caracteres`;
  return null;
}

// ─── MIDDLEWARE DE AUTENTICAÇÃO ───────────────────────────────────────────────
const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Sessão inválida. Faça login novamente.' });
  req.user = user;
  next();
};

// ─── BAIXA AUTOMÁTICA DE PEDIDOS ─────────────────────────────────────────────
// delta > 0 = incrementa entregue | delta < 0 = estorna entregue
async function atualizarPedidoBaixa(clienteId, produto, delta) {
  try {
    const { data: pedido } = await supabase
      .from('pedidos')
      .select('id, quantidade_entregue')
      .eq('cliente_id', clienteId)
      .eq('produto', produto.toUpperCase())
      .eq('status', 'aberto')
      .maybeSingle();

    if (!pedido) return; // nenhum pedido para este cliente+produto

    const novaEntregue = Math.max(0, parseFloat(pedido.quantidade_entregue || 0) + delta);
    await supabase.from('pedidos')
      .update({ quantidade_entregue: novaEntregue, updated_at: new Date().toISOString() })
      .eq('id', pedido.id);
  } catch (e) {
    console.error('[BAIXA PEDIDO]', e.message);
  }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Email ou senha incorretos' });
  res.json({ token: data.session.access_token, user: { email: data.user.email, id: data.user.id } });
});

// ─── RELATÓRIOS ──────────────────────────────────────────────────────────────

// Resumo geral com filtros
app.get('/api/relatorios/resumo', requireAuth, async (req, res) => {
  try {
    const { data_ini, data_fim, produto, fornecedor_id, modal, cliente_id } = req.query;

    // Carregamentos filtrados
    let qCarr = supabase.from('carregamentos').select('*, notas_sf(quantidade, valor_total), fornecedores(nome)');
    if (data_ini) qCarr = qCarr.gte('data', data_ini);
    if (data_fim) qCarr = qCarr.lte('data', data_fim);
    if (produto) qCarr = qCarr.eq('produto', produto);
    if (fornecedor_id) qCarr = qCarr.eq('fornecedor_id', fornecedor_id);
    if (modal) qCarr = qCarr.eq('modal', modal);

    // Notas SF filtradas
    let qNotas = supabase.from('notas_sf').select('*, clientes(nome), carregamentos(nota_nf, modal, fornecedor_id)');
    if (data_ini) qNotas = qNotas.gte('data', data_ini);
    if (data_fim) qNotas = qNotas.lte('data', data_fim);
    if (produto) qNotas = qNotas.eq('produto', produto);
    if (cliente_id) qNotas = qNotas.eq('cliente_id', cliente_id);
    if (modal) qNotas = qNotas.eq('carregamentos.modal', modal);

    const [{ data: carrs, error: e1 }, { data: notas, error: e2 }] = await Promise.all([qCarr, qNotas]);
    if (e1) throw e1; if (e2) throw e2;

    const filteredNotas = (notas || []).filter(n => {
      if (fornecedor_id && n.carregamentos?.fornecedor_id !== fornecedor_id) return false;
      if (modal && n.carregamentos?.modal !== modal) return false;
      return true;
    });

    const total_carregado = (carrs || []).reduce((s, c) => s + parseFloat(c.quantidade), 0);
    const total_faturado = filteredNotas.reduce((s, n) => s + parseFloat(n.quantidade), 0);
    const valor_total_faturado = filteredNotas.reduce((s, n) => s + parseFloat(n.valor_total), 0);
    const ticket_medio = filteredNotas.length > 0 ? valor_total_faturado / total_faturado : 0;

    // Agrupamento por produto
    const por_produto = {};
    for (const c of (carrs || [])) {
      if (!por_produto[c.produto]) por_produto[c.produto] = { carregado: 0, faturado: 0, valor: 0, saldo: 0 };
      por_produto[c.produto].carregado += parseFloat(c.quantidade);
    }
    for (const n of filteredNotas) {
      if (!por_produto[n.produto]) por_produto[n.produto] = { carregado: 0, faturado: 0, valor: 0, saldo: 0 };
      por_produto[n.produto].faturado += parseFloat(n.quantidade);
      por_produto[n.produto].valor += parseFloat(n.valor_total);
    }
    Object.keys(por_produto).forEach(p => {
      por_produto[p].saldo = por_produto[p].carregado - por_produto[p].faturado;
    });

    // Agrupamento por cliente
    const por_cliente = {};
    for (const n of filteredNotas) {
      const nome = n.clientes?.nome || n.cliente_id;
      if (!por_cliente[nome]) por_cliente[nome] = { faturado: 0, valor: 0, notas: 0 };
      por_cliente[nome].faturado += parseFloat(n.quantidade);
      por_cliente[nome].valor += parseFloat(n.valor_total);
      por_cliente[nome].notas++;
    }

    // Agrupamento por fornecedor
    const por_fornecedor = {};
    for (const c of (carrs || [])) {
      const nome = c.fornecedores?.nome || c.fornecedor_id || 'Sem fornecedor';
      if (!por_fornecedor[nome]) por_fornecedor[nome] = { carregado: 0 };
      por_fornecedor[nome].carregado += parseFloat(c.quantidade);
    }

    // Evolução mensal das notas SF
    const por_mes = {};
    for (const n of filteredNotas) {
      const mes = n.data?.substring(0, 7);
      if (!por_mes[mes]) por_mes[mes] = { faturado: 0, valor: 0 };
      por_mes[mes].faturado += parseFloat(n.quantidade);
      por_mes[mes].valor += parseFloat(n.valor_total);
    }

    res.json({
      total_carregado, total_faturado,
      saldo_faturar: total_carregado - total_faturado,
      valor_total_faturado, ticket_medio,
      qtd_notas: filteredNotas.length,
      qtd_carregamentos: (carrs || []).length,
      por_produto, por_cliente, por_fornecedor, por_mes
    });
  } catch (e) {
    return safeError(e, res);
  }
});

// Relatório detalhado de carregamentos
app.get('/api/relatorios/carregamentos', requireAuth, async (req, res) => {
  try {
    const { data_ini, data_fim, produto, fornecedor_id, modal } = req.query;
    let q = supabase.from('carregamentos').select('*, notas_sf(quantidade), fornecedores(nome)').order('data', { ascending: false });
    if (data_ini) q = q.gte('data', data_ini);
    if (data_fim) q = q.lte('data', data_fim);
    if (produto) q = q.eq('produto', produto);
    if (fornecedor_id) q = q.eq('fornecedor_id', fornecedor_id);
    if (modal) q = q.eq('modal', modal);
    const { data, error } = await q;
    if (error) throw error;
    const result = (data || []).map(c => {
      const faturado = (c.notas_sf || []).reduce((s, sf) => s + parseFloat(sf.quantidade || 0), 0);
      const saldo = parseFloat(c.quantidade) - faturado;
      const pct = c.quantidade > 0 ? (faturado / c.quantidade) * 100 : 0;
      return { ...c, faturado: +faturado.toFixed(2), saldo: +saldo.toFixed(2), pct_faturado: +pct.toFixed(1), valor_carregamento: parseFloat(c.quantidade) * parseFloat(c.custo_ton), fornecedor_nome: c.fornecedores?.nome || '—' };
    });
    res.json(result);
  } catch (e) {
    return safeError(e, res);
  }
});

// Relatório detalhado de notas SF
app.get('/api/relatorios/notas-sf', requireAuth, async (req, res) => {
  try {
    const { data_ini, data_fim, produto, cliente_id, fornecedor_id, modal } = req.query;
    let q = supabase.from('notas_sf').select('*, clientes(nome), carregamentos(nota_nf, modal, fornecedor_id, fornecedores(nome))').order('data', { ascending: false });
    if (data_ini) q = q.gte('data', data_ini);
    if (data_fim) q = q.lte('data', data_fim);
    if (produto) q = q.eq('produto', produto);
    if (cliente_id) q = q.eq('cliente_id', cliente_id);
    const { data, error } = await q;
    if (error) throw error;
    const result = (data || [])
      .filter(n => {
        if (fornecedor_id && n.carregamentos?.fornecedor_id !== fornecedor_id) return false;
        if (modal && n.carregamentos?.modal !== modal) return false;
        return true;
      })
      .map(n => ({
        ...n,
        cliente_nome: n.clientes?.nome || '—',
        carr_nota: n.carregamentos?.nota_nf || '—',
        carr_modal: n.carregamentos?.modal || '—',
        carr_fornecedor: n.carregamentos?.fornecedores?.nome || '—',
        preco_ton: n.quantidade > 0 ? (n.valor_total / n.quantidade).toFixed(2) : 0
      }));
    res.json(result);
  } catch (e) {
    return safeError(e, res);
  }
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const [{ data: carrs }, { data: notas }, { data: pedidos }] = await Promise.all([
      supabase.from('carregamentos').select('*, notas_sf(quantidade), fornecedores(nome)'),
      supabase.from('notas_sf').select('*, carregamentos(nota_nf), clientes(nome)').order('data', { ascending: false }).limit(10),
      supabase.from('pedidos').select('*, clientes(nome)')
    ]);
    const calcSaldo = c => { const f = (c.notas_sf||[]).reduce((s,sf)=>s+parseFloat(sf.quantidade||0),0); return { faturado:f, saldo:parseFloat(c.quantidade)-f }; };
    const total_carregado = (carrs||[]).reduce((s,c)=>s+parseFloat(c.quantidade),0);
    const total_faturado = (carrs||[]).reduce((s,c)=>s+calcSaldo(c).faturado,0);
    const porProduto = {};
    for (const c of (carrs||[])) {
      if (!porProduto[c.produto]) porProduto[c.produto] = { carregado:0, faturado:0 };
      porProduto[c.produto].carregado += parseFloat(c.quantidade);
      porProduto[c.produto].faturado += calcSaldo(c).faturado;
    }
    const pedidos_abertos = (pedidos||[]).filter(p=>p.status!=='encerrado' && parseFloat(p.quantidade_entregue||0)<parseFloat(p.quantidade_pedida));
    res.json({ total_carregado, total_faturado, saldo_faturar:total_carregado-total_faturado, pedidos_abertos:pedidos_abertos.length, ultimas_notas:notas||[], por_produto:porProduto, pedidos_em_aberto:pedidos_abertos });
  } catch (e) { return safeError(e, res); }
});

// ─── CADASTROS: PRODUTOS ──────────────────────────────────────────────────────
app.get('/api/produtos', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('produtos').select('*').order('nome');
  if (error) return safeError(error, res);
  res.json(data || []);
});
app.post('/api/produtos', requireAuth, async (req, res) => {
  const { nome, unidade, descricao } = req.body;
  if (!nome || !unidade) return res.status(400).json({ error: 'Nome e unidade são obrigatórios' });
  const erroNome = validateLen(nome, 'Nome', 150);
  if (erroNome) return res.status(400).json({ error: erroNome });
  const { data, error } = await supabase.from('produtos').insert([{ nome: nome.toUpperCase(), unidade, descricao }]).select().single();
  if (error) return safeError(error, res);
  res.json(data);
});
app.put('/api/produtos/:id', requireAuth, async (req, res) => {
  const { nome, unidade, descricao } = req.body;
  const erroNome = validateLen(nome, 'Nome', 150);
  if (erroNome) return res.status(400).json({ error: erroNome });
  const { data, error } = await supabase.from('produtos').update({ nome: nome.toUpperCase(), unidade, descricao }).eq('id', req.params.id).select().single();
  if (error) return safeError(error, res);
  res.json(data);
});
app.delete('/api/produtos/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('produtos').delete().eq('id', req.params.id);
  if (error) return safeError(error, res);
  res.json({ ok: true });
});

// ─── CADASTROS: FORNECEDORES ──────────────────────────────────────────────────
app.get('/api/fornecedores', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('fornecedores').select('*').order('nome');
  if (error) return safeError(error, res);
  res.json(data || []);
});
app.post('/api/fornecedores', requireAuth, async (req, res) => {
  const { nome, cnpj, telefone, email, cidade, estado } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  const erroNome = validateLen(nome, 'Nome', 150);
  if (erroNome) return res.status(400).json({ error: erroNome });
  const { data, error } = await supabase.from('fornecedores').insert([{ nome, cnpj, telefone, email, cidade, estado }]).select().single();
  if (error) return safeError(error, res);
  res.json(data);
});
app.put('/api/fornecedores/:id', requireAuth, async (req, res) => {
  const { nome, cnpj, telefone, email, cidade, estado } = req.body;
  const erroNome = validateLen(nome, 'Nome', 150);
  if (erroNome) return res.status(400).json({ error: erroNome });
  const { data, error } = await supabase.from('fornecedores').update({ nome, cnpj, telefone, email, cidade, estado }).eq('id', req.params.id).select().single();
  if (error) return safeError(error, res);
  res.json(data);
});
app.delete('/api/fornecedores/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('fornecedores').delete().eq('id', req.params.id);
  if (error) return safeError(error, res);
  res.json({ ok: true });
});

// ─── CADASTROS: CLIENTES ──────────────────────────────────────────────────────
app.get('/api/clientes', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('clientes').select('*').order('nome');
  if (error) return safeError(error, res);
  res.json(data || []);
});
function validaCpfCnpj(cpf_cnpj) {
  if (!cpf_cnpj || !cpf_cnpj.trim()) return 'CPF/CNPJ é obrigatório';
  const digits = cpf_cnpj.replace(/\D/g, '');
  if (digits.length !== 11 && digits.length !== 14) return 'CPF/CNPJ inválido — informe 11 dígitos (CPF) ou 14 dígitos (CNPJ)';
  return null;
}

app.post('/api/clientes', requireAuth, async (req, res) => {
  const { nome, cpf_cnpj, telefone, email, cidade, estado } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  const erroNome = validateLen(nome, 'Nome', 150);
  if (erroNome) return res.status(400).json({ error: erroNome });
  const erroCpf = validaCpfCnpj(cpf_cnpj);
  if (erroCpf) return res.status(400).json({ error: erroCpf });

  const { data: existe } = await supabase.from('clientes').select('id,nome').eq('cpf_cnpj', cpf_cnpj).maybeSingle();
  if (existe) return res.status(400).json({ error: `CPF/CNPJ já cadastrado para: ${existe.nome}` });

  const { data, error } = await supabase.from('clientes').insert([{ nome, cpf_cnpj, telefone, email, cidade, estado }]).select().single();
  if (error) return safeError(error, res);
  res.json(data);
});
app.put('/api/clientes/:id', requireAuth, async (req, res) => {
  const { nome, cpf_cnpj, telefone, email, cidade, estado } = req.body;
  const erroNome = validateLen(nome, 'Nome', 150);
  if (erroNome) return res.status(400).json({ error: erroNome });
  const erroCpf = validaCpfCnpj(cpf_cnpj);
  if (erroCpf) return res.status(400).json({ error: erroCpf });

  const { data: existe } = await supabase.from('clientes').select('id,nome').eq('cpf_cnpj', cpf_cnpj).neq('id', req.params.id).maybeSingle();
  if (existe) return res.status(400).json({ error: `CPF/CNPJ já cadastrado para: ${existe.nome}` });

  const { data, error } = await supabase.from('clientes').update({ nome, cpf_cnpj, telefone, email, cidade, estado }).eq('id', req.params.id).select().single();
  if (error) return safeError(error, res);
  res.json(data);
});
app.delete('/api/clientes/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('clientes').delete().eq('id', req.params.id);
  if (error) return safeError(error, res);
  res.json({ ok: true });
});

// ─── EMBALAGENS ───────────────────────────────────────────────────────────────
app.get('/api/embalagens', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('embalagens').select('*').order('nome');
  if (error) return safeError(error, res);
  res.json(data || []);
});
app.post('/api/embalagens', requireAuth, async (req, res) => {
  const nome = clean(req.body.nome);
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  const { data, error } = await supabase.from('embalagens').insert([{ nome, descricao: clean(req.body.descricao) }]).select().single();
  if (error) return safeError(error, res);
  res.json(data);
});
app.put('/api/embalagens/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('embalagens').update({ nome: clean(req.body.nome), descricao: clean(req.body.descricao) }).eq('id', req.params.id).select().single();
  if (error) return safeError(error, res);
  res.json(data);
});
app.delete('/api/embalagens/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('embalagens').delete().eq('id', req.params.id);
  if (error) {
    if (error.code === '23503') return res.status(400).json({ error: 'Esta embalagem está em uso em um ou mais pedidos e não pode ser excluída.' });
    return safeError(error, res);
  }
  res.json({ ok: true });
});

// ─── PRAZOS DE PAGAMENTO ──────────────────────────────────────────────────────
app.get('/api/prazos-pagamento', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('prazos_pagamento').select('*').order('nome');
  if (error) return safeError(error, res);
  res.json(data || []);
});
app.post('/api/prazos-pagamento', requireAuth, async (req, res) => {
  const nome = clean(req.body.nome);
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  const { data, error } = await supabase.from('prazos_pagamento').insert([{ nome, descricao: clean(req.body.descricao) }]).select().single();
  if (error) return safeError(error, res);
  res.json(data);
});
app.put('/api/prazos-pagamento/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('prazos_pagamento').update({ nome: clean(req.body.nome), descricao: clean(req.body.descricao) }).eq('id', req.params.id).select().single();
  if (error) return safeError(error, res);
  res.json(data);
});
app.delete('/api/prazos-pagamento/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('prazos_pagamento').delete().eq('id', req.params.id);
  if (error) {
    if (error.code === '23503') return res.status(400).json({ error: 'Este prazo de pagamento está em uso em um ou mais pedidos e não pode ser excluído.' });
    return safeError(error, res);
  }
  res.json({ ok: true });
});

// ─── CARREGAMENTOS ────────────────────────────────────────────────────────────
app.get('/api/carregamentos', requireAuth, async (req, res) => {
  try {
    let q = supabase.from('carregamentos').select('*, notas_sf(id, nota_sf, data, quantidade, valor_total, codigo_fiscal, cliente_id, clientes(nome)), fornecedores(nome)').order('data', { ascending: false });
    if (req.query.produto) q = q.eq('produto', req.query.produto);
    if (req.query.modal) q = q.eq('modal', req.query.modal);
    if (req.query.fornecedor_id) q = q.eq('fornecedor_id', req.query.fornecedor_id);
    const { data, error } = await q;
    if (error) throw error;
    const result = (data||[]).map(c => {
      const faturado = (c.notas_sf||[]).reduce((s,sf)=>s+parseFloat(sf.quantidade||0),0);
      const saldo = parseFloat(c.quantidade) - faturado;
      const pct = c.quantidade > 0 ? (faturado/c.quantidade)*100 : 0;
      let status = pct>=100?'Encerrado':pct>=80?'Quase enc.':'Em aberto';
      return { ...c, fornecedor_nome:c.fornecedores?.nome||'—', faturado:+faturado.toFixed(2), saldo:+saldo.toFixed(2), status };
    });
    res.json(result);
  } catch (e) { return safeError(e, res); }
});

app.post('/api/carregamentos', requireAuth, async (req, res) => {
  try {
    const { nota_nf, data, produto, modal, quantidade, custo_ton, serie_filial, fornecedor_id } = req.body;
    if (!nota_nf||!data||!produto||!modal||!quantidade||!custo_ton)
      return res.status(400).json({ error: 'Campos obrigatórios: Nota NF, Data, Produto, Modal, Quantidade, Custo' });
    const erros = [
      validateLen(nota_nf, 'Nota NF', 50),
      validateNum(quantidade, 'Quantidade', { min: 0.001, max: 99999 }),
      validateNum(custo_ton, 'Custo R$/t', { min: 0, max: 99999 }),
    ].filter(Boolean);
    if (erros.length) return res.status(400).json({ error: erros[0] });
    const { data: result, error } = await supabase.from('carregamentos').insert([{ nota_nf, data, produto, modal, quantidade:parseFloat(quantidade), custo_ton:parseFloat(custo_ton), serie_filial, fornecedor_id:fornecedor_id||null }]).select().single();
    if (error) throw error;
    res.json(result);
  } catch (e) { return safeError(e, res); }
});

app.put('/api/carregamentos/:id', requireAuth, async (req, res) => {
  try {
    const { nota_nf, data, produto, modal, quantidade, custo_ton, serie_filial, fornecedor_id } = req.body;
    const erros = [
      validateLen(nota_nf, 'Nota NF', 50),
      validateNum(quantidade, 'Quantidade', { min: 0.001, max: 99999 }),
      validateNum(custo_ton, 'Custo R$/t', { min: 0, max: 99999 }),
    ].filter(Boolean);
    if (erros.length) return res.status(400).json({ error: erros[0] });
    const { data: result, error } = await supabase.from('carregamentos').update({ nota_nf, data, produto, modal, quantidade:parseFloat(quantidade), custo_ton:parseFloat(custo_ton), serie_filial, fornecedor_id:fornecedor_id||null }).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(result);
  } catch (e) { return safeError(e, res); }
});

app.delete('/api/carregamentos/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('carregamentos').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { return safeError(e, res); }
});

// ─── NOTAS SF ─────────────────────────────────────────────────────────────────
app.get('/api/notas-sf', requireAuth, async (req, res) => {
  try {
    let q = supabase.from('notas_sf').select('*, carregamentos(nota_nf, produto, modal), clientes(nome)').order('data', { ascending: false });
    if (req.query.produto) q = q.eq('produto', req.query.produto);
    if (req.query.cliente_id) q = q.eq('cliente_id', req.query.cliente_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json((data||[]).map(n=>({...n, cliente_nome:n.clientes?.nome||'—'})));
  } catch (e) { return safeError(e, res); }
});

app.post('/api/notas-sf', requireAuth, async (req, res) => {
  try {
    const { nota_sf, data, produto, carregamento_id, cliente_id, quantidade, valor_total, codigo_fiscal } = req.body;
    if (!nota_sf||!data||!produto||!carregamento_id||!cliente_id||!quantidade||!valor_total)
      return res.status(400).json({ error: 'Todos os campos obrigatórios devem ser preenchidos' });
    const errosNota = [
      validateLen(nota_sf, 'Nota SF', 50),
      validateNum(quantidade, 'Quantidade', { min: 0.001, max: 99999 }),
      validateNum(valor_total, 'Valor total', { min: 0, max: 99999999 }),
    ].filter(Boolean);
    if (errosNota.length) return res.status(400).json({ error: errosNota[0] });

    // Valida saldo do carregamento
    const { data: carr, error: carrErr } = await supabase.from('carregamentos').select('quantidade, notas_sf(quantidade)').eq('id', carregamento_id).single();
    if (carrErr) throw carrErr;
    const faturado = (carr.notas_sf||[]).reduce((s,sf)=>s+parseFloat(sf.quantidade||0),0);
    const saldo = parseFloat(carr.quantidade) - faturado;
    if (parseFloat(quantidade) > saldo + 0.001)
      return res.status(400).json({ error: `Quantidade (${quantidade}t) excede o saldo do carregamento (${saldo.toFixed(2)}t)` });

    const { data: result, error } = await supabase.from('notas_sf')
      .insert([{ nota_sf, data, produto: produto?.toUpperCase(), carregamento_id, cliente_id, quantidade:parseFloat(quantidade), valor_total:parseFloat(valor_total), codigo_fiscal }])
      .select('*, clientes(nome)').single();
    if (error) throw error;

    // Baixa automática no pedido
    await atualizarPedidoBaixa(cliente_id, produto, parseFloat(quantidade));

    res.json(result);
  } catch (e) { return safeError(e, res); }
});

app.put('/api/notas-sf/:id', requireAuth, async (req, res) => {
  try {
    const { nota_sf, data, produto, carregamento_id, cliente_id, quantidade, valor_total, codigo_fiscal } = req.body;
    if (!nota_sf||!data||!produto||!carregamento_id||!cliente_id||!quantidade||!valor_total)
      return res.status(400).json({ error: 'Todos os campos obrigatórios devem ser preenchidos' });
    const errosNota = [
      validateLen(nota_sf, 'Nota SF', 50),
      validateNum(quantidade, 'Quantidade', { min: 0.001, max: 99999 }),
      validateNum(valor_total, 'Valor total', { min: 0, max: 99999999 }),
    ].filter(Boolean);
    if (errosNota.length) return res.status(400).json({ error: errosNota[0] });

    // Busca nota original para estorno
    const { data: antiga, error: eAnt } = await supabase.from('notas_sf').select('*').eq('id', req.params.id).single();
    if (eAnt) throw eAnt;

    // Valida saldo (excluindo a própria nota do cálculo)
    const { data: carr } = await supabase.from('carregamentos').select('quantidade, notas_sf(id, quantidade)').eq('id', carregamento_id).single();
    const faturadoSemEsta = (carr.notas_sf||[]).filter(sf=>sf.id!==req.params.id).reduce((s,sf)=>s+parseFloat(sf.quantidade||0),0);
    const saldo = parseFloat(carr.quantidade) - faturadoSemEsta;
    if (parseFloat(quantidade) > saldo + 0.001)
      return res.status(400).json({ error: `Quantidade (${quantidade}t) excede o saldo do carregamento (${saldo.toFixed(2)}t)` });

    const { data: result, error } = await supabase.from('notas_sf')
      .update({ nota_sf, data, produto: produto?.toUpperCase(), carregamento_id, cliente_id, quantidade:parseFloat(quantidade), valor_total:parseFloat(valor_total), codigo_fiscal })
      .eq('id', req.params.id).select('*, clientes(nome)').single();
    if (error) throw error;

    // Estorna a baixa antiga e aplica a nova
    await atualizarPedidoBaixa(antiga.cliente_id, antiga.produto, -parseFloat(antiga.quantidade));
    await atualizarPedidoBaixa(cliente_id, produto, parseFloat(quantidade));

    res.json(result);
  } catch (e) { return safeError(e, res); }
});

app.delete('/api/notas-sf/:id', requireAuth, async (req, res) => {
  try {
    const { data: nota } = await supabase.from('notas_sf').select('*').eq('id', req.params.id).single();
    const { error } = await supabase.from('notas_sf').delete().eq('id', req.params.id);
    if (error) throw error;

    // Estorna a baixa do pedido
    if (nota) await atualizarPedidoBaixa(nota.cliente_id, nota.produto, -parseFloat(nota.quantidade||0));

    res.json({ ok: true });
  } catch (e) { return safeError(e, res); }
});

// ─── PEDIDOS ──────────────────────────────────────────────────────────────────
// Cada linha da tabela = 1 produto. N linhas com o mesmo numero_pedido formam 1 pedido.
app.get('/api/pedidos', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('pedidos').select('*, clientes(nome), embalagens(nome), prazos_pagamento(nome)').order('created_at', { ascending: false });
    if (error) throw error;

    const grupos = {};
    const ordem = [];
    for (const p of (data || [])) {
      const chave = p.numero_pedido || p.id;
      if (!grupos[chave]) {
        grupos[chave] = {
          numero_pedido: p.numero_pedido, cliente_id: p.cliente_id,
          cliente_nome: p.clientes?.nome || '—', observacao: p.observacao,
          created_at: p.created_at, itens: [], _statuses: []
        };
        ordem.push(chave);
      }
      const preco = parseFloat(p.preco_unitario || 0);
      const qtdePedida = parseFloat(p.quantidade_pedida);
      grupos[chave].itens.push({
        id: p.id, produto: p.produto,
        quantidade_pedida: qtdePedida,
        quantidade_entregue: parseFloat(p.quantidade_entregue || 0),
        status: p.status,
        embalagem_id: p.embalagem_id, embalagem_nome: p.embalagens?.nome || '—',
        preco_unitario: preco,
        prazo_pagamento_id: p.prazo_pagamento_id, prazo_pagamento_nome: p.prazos_pagamento?.nome || '—',
        data_pagamento: p.data_pagamento,
        total_venda: qtdePedida * preco
      });
      grupos[chave]._statuses.push(p.status || 'aberto');
    }
    const result = ordem.map(k => {
      const g = grupos[k];
      g.status = g._statuses.every(s => s === 'encerrado') ? 'encerrado' : 'aberto';
      delete g._statuses;
      return g;
    });
    res.json(result);
  } catch (e) { return safeError(e, res); }
});

app.post('/api/pedidos', requireAuth, async (req, res) => {
  try {
    const { cliente_id, observacao } = req.body;
    const itens = Array.isArray(req.body.itens) ? req.body.itens : [];
    if (!cliente_id) return res.status(400).json({ error: 'Cliente é obrigatório' });
    if (!itens.length || itens.some(it => !it.produto || !it.quantidade_pedida))
      return res.status(400).json({ error: 'Informe ao menos um produto com quantidade pedida' });

    for (const it of itens) {
      const erros = [
        validateNum(it.quantidade_pedida, 'Quantidade pedida', { min: 0.001, max: 99999 }),
        it.preco_unitario !== undefined ? validateNum(it.preco_unitario, 'Preço unitário', { min: 0, max: 99999 }) : null,
      ].filter(Boolean);
      if (erros.length) return res.status(400).json({ error: erros[0] });
    }

    const { count } = await supabase.from('pedidos').select('*', { count: 'exact', head: true });
    const numero_pedido = `PED-${new Date().getFullYear()}-${String((count || 0) + 1).padStart(4, '0')}`;

    const rows = itens.map(it => ({
      cliente_id, numero_pedido, status: 'aberto',
      produto: String(it.produto).toUpperCase(),
      quantidade_pedida: parseFloat(it.quantidade_pedida),
      quantidade_entregue: 0,
      observacao: observacao || null,
      embalagem_id: it.embalagem_id || null,
      preco_unitario: parseFloat(it.preco_unitario || 0),
      prazo_pagamento_id: it.prazo_pagamento_id || null,
      data_pagamento: it.data_pagamento || null
    }));

    const { data, error } = await supabase.from('pedidos').insert(rows).select('*, clientes(nome), embalagens(nome), prazos_pagamento(nome)');
    if (error) throw error;
    res.json({
      numero_pedido, cliente_id, cliente_nome: data[0]?.clientes?.nome || '—',
      observacao, status: 'aberto',
      itens: data.map(p => ({
        id: p.id, produto: p.produto,
        quantidade_pedida: parseFloat(p.quantidade_pedida),
        quantidade_entregue: parseFloat(p.quantidade_entregue || 0),
        status: p.status,
        embalagem_id: p.embalagem_id, embalagem_nome: p.embalagens?.nome || '—',
        preco_unitario: parseFloat(p.preco_unitario || 0),
        prazo_pagamento_id: p.prazo_pagamento_id, prazo_pagamento_nome: p.prazos_pagamento?.nome || '—',
        data_pagamento: p.data_pagamento,
        total_venda: parseFloat(p.quantidade_pedida) * parseFloat(p.preco_unitario || 0)
      }))
    });
  } catch (e) { return safeError(e, res); }
});

app.put('/api/pedidos/:id', requireAuth, async (req, res) => {
  try {
    const { cliente_id, produto, quantidade_pedida, quantidade_entregue, observacao, status, embalagem_id, preco_unitario, prazo_pagamento_id, data_pagamento } = req.body;
    const update = {
      cliente_id, produto: produto?.toUpperCase(),
      quantidade_pedida: parseFloat(quantidade_pedida),
      quantidade_entregue: parseFloat(quantidade_entregue || 0),
      observacao, updated_at: new Date().toISOString(),
      embalagem_id: embalagem_id || null,
      preco_unitario: parseFloat(preco_unitario || 0),
      prazo_pagamento_id: prazo_pagamento_id || null,
      data_pagamento: data_pagamento || null
    };
    if (status === 'aberto' || status === 'encerrado') update.status = status;
    const { data, error } = await supabase.from('pedidos').update(update).eq('id', req.params.id).select('*, clientes(nome), embalagens(nome), prazos_pagamento(nome)').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { return safeError(e, res); }
});

// Encerra todos os itens de um pedido (mesmo numero_pedido) — saldo restante fica finalizado
app.post('/api/pedidos/:numero_pedido/encerrar', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('pedidos')
      .update({ status: 'encerrado', updated_at: new Date().toISOString() })
      .eq('numero_pedido', req.params.numero_pedido)
      .select();
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Pedido não encontrado' });
    res.json({ ok: true });
  } catch (e) { return safeError(e, res); }
});

app.delete('/api/pedidos/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('pedidos').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { return safeError(e, res); }
});

// ─── USUÁRIOS (Supabase Auth Admin API) ──────────────────────────────────────
app.get('/api/usuarios', requireAuth, async (req, res) => {
  try {
    const { data: { users }, error } = await supabase.auth.admin.listUsers();
    if (error) throw error;
    res.json(users.map(u => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      confirmed: !!u.confirmed_at
    })));
  } catch (e) { return safeError(e, res); }
});

app.post('/api/usuarios', requireAuth, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
    const { data, error } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true
    });
    if (error) throw error;
    res.json({ id: data.user.id, email: data.user.email });
  } catch (e) { return safeError(e, res); }
});

app.put('/api/usuarios/:id/senha', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
    const { error } = await supabase.auth.admin.updateUserById(req.params.id, { password });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { return safeError(e, res); }
});

// Não pode excluir a própria conta
app.delete('/api/usuarios/:id', requireAuth, async (req, res) => {
  try {
    if (req.params.id === req.user.id)
      return res.status(400).json({ error: 'Você não pode excluir sua própria conta' });
    const { error } = await supabase.auth.admin.deleteUser(req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { return safeError(e, res); }
});

// ─── SPA CATCH-ALL ────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Rodar localmente (npm run dev / npm start)
// No Vercel, este bloco é ignorado — o export abaixo é usado
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🌱 COOCAMM — Sistema rodando em → http://localhost:${PORT}`);
    console.log(`   Pressione Ctrl+C para parar\n`);
  });
}

module.exports = app;
