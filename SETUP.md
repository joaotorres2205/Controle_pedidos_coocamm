# Ibiatã 2026 — Guia de Setup Completo

## Pré-requisitos

- Node.js v18+ → https://nodejs.org (baixe a versão LTS)
- VS Code → https://code.visualstudio.com
- Conta Supabase → supabase.com (login: danielapborges@hotmail.com)

---

## PASSO 1 — Abrir o projeto no VS Code

1. Abra o VS Code
2. **File → Open Folder** → selecione a pasta `ibiata-saas`
3. Abra o terminal integrado: **Ctrl + `** (crase) ou **View → Terminal**

---

## PASSO 2 — Instalar dependências Node.js

No terminal do VS Code, execute:

```bash
npm install
```

Isso instala: Express, Supabase SDK, dotenv, cors e nodemon.

---

## PASSO 3 — Pegar a Service Role Key do Supabase

1. Acesse https://supabase.com e faça login
2. Abra o projeto (ref: `vtotcsudrkqmvcnphhjx`)
3. No menu esquerdo: **Settings → API**
4. Copie a chave **`service_role`** (em "Project API keys")
5. Abra o arquivo `.env` e substitua `COLE_AQUI_A_SERVICE_ROLE_KEY` pela chave copiada

Exemplo de como ficará o `.env`:
```
SUPABASE_URL=https://vtotcsudrkqmvcnphhjx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGci...sua_chave_aqui...
PORT=3000
```

> ⚠️ NUNCA compartilhe ou commite o arquivo `.env` — ele já está no `.gitignore`

---

## PASSO 4 — Criar as tabelas no Supabase

1. No painel do Supabase: **SQL Editor → New Query**
2. Abra o arquivo `supabase/schema.sql` do projeto
3. Copie todo o conteúdo e cole no SQL Editor
4. Clique em **Run** (▶)

Isso cria todas as tabelas e insere os dados iniciais (carregamentos, clientes, pedidos de exemplo).

---

## PASSO 5 — Criar usuário de login no Supabase

1. No painel do Supabase: **Authentication → Users → Add user**
2. Adicione o email e senha que usará para entrar no sistema
3. Clique em **Create user**

Sugestão de acesso inicial:
- Email: `admin@ibiata.com.br`
- Senha: uma senha forte de sua escolha

---

## PASSO 6 — Rodar o sistema

No terminal do VS Code:

```bash
# Modo desenvolvimento (reinicia ao salvar arquivos)
npm run dev

# OU modo produção
npm start
```

Você verá:
```
🌱 Ibiatã SaaS rodando em → http://localhost:3000
```

Abra no navegador: **http://localhost:3000**

---

## Estrutura do Projeto

```
ibiata-saas/
├── src/
│   └── index.js          ← Servidor Express + todas as rotas da API
├── public/
│   └── index.html        ← Frontend SPA completo (login + sistema)
├── supabase/
│   └── schema.sql        ← Tabelas + dados iniciais
├── .env                  ← Suas credenciais (não commitar!)
├── .env.example          ← Template das variáveis
├── .gitignore
└── package.json
```

---

## Extensões VS Code Recomendadas

Cole no terminal para instalar:

```bash
code --install-extension dbaeumer.vscode-eslint
code --install-extension esbenp.prettier-vscode
code --install-extension Prisma.prisma
code --install-extension bradlc.vscode-tailwindcss
```

---

## Comandos úteis no terminal

```bash
# Instalar dependências
npm install

# Rodar em desenvolvimento (auto-reload)
npm run dev

# Rodar em produção
npm start

# Ver versão do Node
node -v

# Ver versão do npm
npm -v
```

---

## Módulos do sistema

| Módulo | Descrição |
|---|---|
| **Dashboard** | Totais, gráfico por produto, pedidos em aberto, últimas SF |
| **Carregamentos** | NFs de remessa (FOB/CIF), controle de saldo |
| **Notas SF** | Simples faturamentos vinculados aos carregamentos |
| **Pedidos** | Acompanhamento de entregas por cliente |
| **Cadastros → Produtos** | Tipos de material (adicione quantos quiser) |
| **Cadastros → Fornecedores** | Empresas fornecedoras |
| **Cadastros → Clientes** | Produtores rurais e clientes |

---

## Dúvidas comuns

**"Erro: SUPABASE_SERVICE_KEY inválida"**
→ Verifique se copiou a chave `service_role` (não a `anon`/pública)

**"Cannot find module 'express'"**
→ Execute `npm install` no terminal

**Porta 3000 em uso**
→ Mude `PORT=3001` no arquivo `.env`

---

*Ibiatã 2026 — COOCAMM | Desenvolvido com Node.js + Supabase*
