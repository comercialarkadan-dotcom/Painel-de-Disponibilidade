# Disponibilidade da Frota - Render + Supabase

## 1. Supabase

1. Abra o projeto no Supabase.
2. Vá em **SQL Editor**.
3. Cole e execute o conteúdo de `supabase_schema.sql`.
4. Em **Project Settings > API**, copie:
   - `Project URL`
   - `service_role key`

## 2. Render

Configuração do serviço:

- Runtime: `Python`
- Build Command: `pip install -r requirements.txt`
- Start Command: `python app.py`
- Root Directory: deixe em branco, porque este repositório já foi publicado com o app na raiz.

Variáveis de ambiente no Render:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## 3. Funcionamento

- O Render serve o painel web.
- O Supabase grava:
  - alterações de status do dia em `fleet_status_overrides`
  - avisos da manutenção em `fleet_maintenance_notices`
- Se as variáveis do Supabase não estiverem configuradas, o app roda localmente usando JSON.

## 4. Teste Local

```powershell
cd "C:\Users\ArT\Documents\AUTOMATIZAR GINFO\render-supabase"
$env:PORT="8788"
python app.py
```

Abra:

```text
http://127.0.0.1:8788/
```
