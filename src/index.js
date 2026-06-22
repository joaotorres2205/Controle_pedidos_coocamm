require('dotenv').config();
const express = require('express');
const cors = require('cors');
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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── MIDDLEWARE DE AUTENTICAÇÃO ───────────────────────────────────────────────
const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Sessão inválida. Faça login novamente.' });
  req.user = user;
  next();
};

// ─── LOG DE HISTÓRICO ─────────────────────────────────────────────────────────
async function logAction(userEmail, acao, entidade, entidadeId, descricao) {
  try {
    await supabase.from('historico').insert([{
      usuario_email: userEmail || 'sistema',
      acao, entidade,
      entidade_id: entidadeId ? String(entidadeId) : null,
      descricao
    }]);
  } catch (e) {
    // Histórico não bloqueia operação principal
    console.error('[LOG]', e.message);
  }
}

// ─── BAIXA AUTOMÁTICA DE PEDIDOS ─────────────────────────────────────────────
// delta > 0 = incrementa entregue | delta < 0 = estorna entregue
async function atualizarPedidoBaixa(clienteId, produto, delta) {
  try {
    const { data: pedido } = await supabase
      .from('pedidos')
      .select('id, quantidade_entregue')
      .eq('cliente_id', clienteId)
      .eq('produto', produto.toUpperCase())
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
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Email ou senha incorretos' });
  res.json({ token: data.session.access_token, user: { email: data.user.email, id: data.user.id } });
});

// ─── HISTÓRICO ────────────────────────────────────────────────────────────────
app.get('/api/historico', requireAuth, async (req, res) => {
  try {
    const { entidade, acao, data_ini, data_fim, page = 1, limit = 50 } = req.query;
    let q = supabase.from('historico').select('*', { count: 'exact' }).order('created_at', { ascending: false });
    if (entidade) q = q.eq('entidade', entidade);
    if (acao) q = q.eq('acao', acao);
    if (data_ini) q = q.gte('created_at', data_ini + 'T00:00:00');
    if (data_fim) q = q.lte('created_at', data_fim + 'T23:59:59');
    const from = (parseInt(page) - 1) * parseInt(limit);
    q = q.range(from, from + parseInt(limit) - 1);
    const { data, error, count } = await q;
    if (error) throw error;
    res.json({ data: data || [], total: count || 0, page: parseInt(page), limit: parseInt(limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    const pedidos_abertos = (pedidos||[]).filter(p=>parseFloat(p.quantidade_entregue||0)<parseFloat(p.quantidade_pedida));
    res.json({ total_carregado, total_faturado, saldo_faturar:total_carregado-total_faturado, pedidos_abertos:pedidos_abertos.length, ultimas_notas:notas||[], por_produto:porProduto, pedidos_em_aberto:pedidos_abertos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CADASTROS: PRODUTOS ──────────────────────────────────────────────────────
app.get('/api/produtos', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('produtos').select('*').order('nome');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});
app.post('/api/produtos', requireAuth, async (req, res) => {
  const { nome, unidade, descricao } = req.body;
  if (!nome || !unidade) return res.status(400).json({ error: 'Nome e unidade são obrigatórios' });
  const { data, error } = await supabase.from('produtos').insert([{ nome: nome.toUpperCase(), unidade, descricao }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  logAction(req.user.email, 'CRIOU', 'produto', data.id, `Produto: ${data.nome}`);
  res.json(data);
});
app.put('/api/produtos/:id', requireAuth, async (req, res) => {
  const { nome, unidade, descricao } = req.body;
  const { data, error } = await supabase.from('produtos').update({ nome: nome.toUpperCase(), unidade, descricao }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  logAction(req.user.email, 'EDITOU', 'produto', data.id, `Produto: ${data.nome}`);
  res.json(data);
});
app.delete('/api/produtos/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('produtos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  logAction(req.user.email, 'EXCLUIU', 'produto', req.params.id, `ID: ${req.params.id}`);
  res.json({ ok: true });
});

// ─── CADASTROS: FORNECEDORES ──────────────────────────────────────────────────
app.get('/api/fornecedores', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('fornecedores').select('*').order('nome');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});
app.post('/api/fornecedores', requireAuth, async (req, res) => {
  const { nome, cnpj, telefone, email, cidade, estado } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  const { data, error } = await supabase.from('fornecedores').insert([{ nome, cnpj, telefone, email, cidade, estado }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  logAction(req.user.email, 'CRIOU', 'fornecedor', data.id, `Fornecedor: ${data.nome}`);
  res.json(data);
});
app.put('/api/fornecedores/:id', requireAuth, async (req, res) => {
  const { nome, cnpj, telefone, email, cidade, estado } = req.body;
  const { data, error } = await supabase.from('fornecedores').update({ nome, cnpj, telefone, email, cidade, estado }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  logAction(req.user.email, 'EDITOU', 'fornecedor', data.id, `Fornecedor: ${data.nome}`);
  res.json(data);
});
app.delete('/api/fornecedores/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('fornecedores').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  logAction(req.user.email, 'EXCLUIU', 'fornecedor', req.params.id, `ID: ${req.params.id}`);
  res.json({ ok: true });
});

// ─── CADASTROS: CLIENTES ──────────────────────────────────────────────────────
app.get('/api/clientes', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('clientes').select('*').order('nome');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});
app.post('/api/clientes', requireAuth, async (req, res) => {
  const { nome, cpf_cnpj, telefone, email, cidade, estado } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  const { data, error } = await supabase.from('clientes').insert([{ nome, cpf_cnpj, telefone, email, cidade, estado }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  logAction(req.user.email, 'CRIOU', 'cliente', data.id, `Cliente: ${data.nome}`);
  res.json(data);
});
app.put('/api/clientes/:id', requireAuth, async (req, res) => {
  const { nome, cpf_cnpj, telefone, email, cidade, estado } = req.body;
  const { data, error } = await supabase.from('clientes').update({ nome, cpf_cnpj, telefone, email, cidade, estado }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  logAction(req.user.email, 'EDITOU', 'cliente', data.id, `Cliente: ${data.nome}`);
  res.json(data);
});
app.delete('/api/clientes/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('clientes').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  logAction(req.user.email, 'EXCLUIU', 'cliente', req.params.id, `ID: ${req.params.id}`);
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/carregamentos', requireAuth, async (req, res) => {
  try {
    const { nota_nf, data, produto, modal, quantidade, custo_ton, serie_filial, fornecedor_id } = req.body;
    if (!nota_nf||!data||!produto||!modal||!quantidade||!custo_ton)
      return res.status(400).json({ error: 'Campos obrigatórios: Nota NF, Data, Produto, Modal, Quantidade, Custo' });
    const { data: result, error } = await supabase.from('carregamentos').insert([{ nota_nf, data, produto, modal, quantidade:parseFloat(quantidade), custo_ton:parseFloat(custo_ton), serie_filial, fornecedor_id:fornecedor_id||null }]).select().single();
    if (error) throw error;
    logAction(req.user.email, 'CRIOU', 'carregamento', result.id, `NF ${nota_nf} — ${produto} — ${quantidade}t`);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/carregamentos/:id', requireAuth, async (req, res) => {
  try {
    const { nota_nf, data, produto, modal, quantidade, custo_ton, serie_filial, fornecedor_id } = req.body;
    const { data: result, error } = await supabase.from('carregamentos').update({ nota_nf, data, produto, modal, quantidade:parseFloat(quantidade), custo_ton:parseFloat(custo_ton), serie_filial, fornecedor_id:fornecedor_id||null }).eq('id', req.params.id).select().single();
    if (error) throw error;
    logAction(req.user.email, 'EDITOU', 'carregamento', result.id, `NF ${nota_nf} — ${produto}`);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/carregamentos/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('carregamentos').delete().eq('id', req.params.id);
    if (error) throw error;
    logAction(req.user.email, 'EXCLUIU', 'carregamento', req.params.id, `ID: ${req.params.id}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notas-sf', requireAuth, async (req, res) => {
  try {
    const { nota_sf, data, produto, carregamento_id, cliente_id, quantidade, valor_total, codigo_fiscal } = req.body;
    if (!nota_sf||!data||!produto||!carregamento_id||!cliente_id||!quantidade||!valor_total)
      return res.status(400).json({ error: 'Todos os campos obrigatórios devem ser preenchidos' });

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

    logAction(req.user.email, 'CRIOU', 'nota_sf', result.id, `SF ${nota_sf} — ${result.clientes?.nome||cliente_id} — ${quantidade}t`);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notas-sf/:id', requireAuth, async (req, res) => {
  try {
    const { nota_sf, data, produto, carregamento_id, cliente_id, quantidade, valor_total, codigo_fiscal } = req.body;
    if (!nota_sf||!data||!produto||!carregamento_id||!cliente_id||!quantidade||!valor_total)
      return res.status(400).json({ error: 'Todos os campos obrigatórios devem ser preenchidos' });

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

    logAction(req.user.email, 'EDITOU', 'nota_sf', result.id, `SF ${nota_sf} — ${result.clientes?.nome||cliente_id} — ${quantidade}t`);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/notas-sf/:id', requireAuth, async (req, res) => {
  try {
    const { data: nota } = await supabase.from('notas_sf').select('*').eq('id', req.params.id).single();
    const { error } = await supabase.from('notas_sf').delete().eq('id', req.params.id);
    if (error) throw error;

    // Estorna a baixa do pedido
    if (nota) await atualizarPedidoBaixa(nota.cliente_id, nota.produto, -parseFloat(nota.quantidade||0));

    logAction(req.user.email, 'EXCLUIU', 'nota_sf', req.params.id, `SF ${nota?.nota_sf||req.params.id} — ${nota?.quantidade||'?'}t`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PEDIDOS ──────────────────────────────────────────────────────────────────
app.get('/api/pedidos', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('pedidos').select('*, clientes(nome)').order('created_at', { ascending: false });
    if (error) throw error;
    res.json((data||[]).map(p=>({...p, cliente_nome:p.clientes?.nome||'—'})));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pedidos', requireAuth, async (req, res) => {
  try {
    const { cliente_id, produto, quantidade_pedida, quantidade_entregue, observacao } = req.body;
    if (!cliente_id||!quantidade_pedida) return res.status(400).json({ error: 'Cliente e quantidade pedida são obrigatórios' });
    const { data, error } = await supabase.from('pedidos').insert([{ cliente_id, produto: produto?.toUpperCase(), quantidade_pedida:parseFloat(quantidade_pedida), quantidade_entregue:parseFloat(quantidade_entregue||0), observacao }]).select('*, clientes(nome)').single();
    if (error) throw error;
    logAction(req.user.email, 'CRIOU', 'pedido', data.id, `Pedido ${data.clientes?.nome||cliente_id} — ${quantidade_pedida}t`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/pedidos/:id', requireAuth, async (req, res) => {
  try {
    const { cliente_id, produto, quantidade_pedida, quantidade_entregue, observacao } = req.body;
    const { data, error } = await supabase.from('pedidos').update({ cliente_id, produto: produto?.toUpperCase(), quantidade_pedida:parseFloat(quantidade_pedida), quantidade_entregue:parseFloat(quantidade_entregue||0), observacao }).eq('id', req.params.id).select('*, clientes(nome)').single();
    if (error) throw error;
    logAction(req.user.email, 'EDITOU', 'pedido', data.id, `Pedido ${data.clientes?.nome||cliente_id} — Entregue: ${quantidade_entregue}t`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/pedidos/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('pedidos').delete().eq('id', req.params.id);
    if (error) throw error;
    logAction(req.user.email, 'EXCLUIU', 'pedido', req.params.id, `ID: ${req.params.id}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
