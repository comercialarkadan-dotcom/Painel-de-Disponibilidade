# Disponibilidade da Frota - Render + Supabase

## 1. Criar as tabelas no Supabase

1. Abra o projeto no Supabase.
2. Entre em **SQL Editor**.
3. Cole e execute o arquivo `supabase_schema.sql`.

As tabelas gravam:

- `fleet_status_overrides`: mudancas de status do dia, OS e observacao quando nao houver OS.
- `fleet_maintenance_notices`: avisos do Supervisor de Manutencao.
- `fleet_daily_history`: fotografia diaria para historico de disponibilidade.

## 2. Configurar o Render

Configuracao do servico:

- Runtime: `Python`
- Build Command: `pip install -r requirements.txt`
- Start Command: `python app.py`
- Plano: pode ser `Free`

Variaveis de ambiente:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `SUPABASE_PUBLISHABLE_KEY` opcional
- `SUPABASE_JWKS_URL` opcional

Use a chave secreta somente no Render. Nao coloque a `SUPABASE_SECRET_KEY` dentro do HTML ou JavaScript do navegador.

## 3. Usuarios do painel

- `supervisor.frota` / senha definida no backend: consegue alterar status, salvar atualizacao diaria e cadastrar avisos.
- `supervisor.rota` / senha definida no backend: acesso somente leitura.

## 4. Teste local

```powershell
cd "C:\Users\ArT\Documents\AUTOMATIZAR GINFO\render-supabase"
$env:PORT="8788"
$env:DISABLE_SUPABASE="1"
python app.py
```

Abra:

```text
http://127.0.0.1:8788/
```

Se as variaveis do Supabase nao estiverem configuradas, o app usa arquivos `*.local.json` apenas para teste local.
