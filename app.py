from __future__ import annotations

import json
import os
import uuid
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, parse, request


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
LOCAL_OVERRIDES = ROOT / "overrides.local.json"
LOCAL_NOTICES = ROOT / "notices.local.json"

ALLOWED_STATUS = {"Disponível", "Parado", "Indisponível", "Em manutenção"}

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
USE_SUPABASE = bool(SUPABASE_URL and SUPABASE_KEY)


def json_response(handler: SimpleHTTPRequestHandler, payload: dict, status: int = 200) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def read_body(handler: SimpleHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length <= 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def load_local(path: Path, fallback):
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def save_local(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def supabase_request(method: str, table_or_path: str, *, query: dict | None = None, body=None, prefer: str | None = None):
    if not USE_SUPABASE:
        raise RuntimeError("Supabase nao configurado")

    query_string = ""
    if query:
        query_string = "?" + parse.urlencode(query, doseq=True, safe=",.*()")

    url = f"{SUPABASE_URL}/rest/v1/{table_or_path}{query_string}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer

    encoded = None
    if body is not None:
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")

    req = request.Request(url, data=encoded, headers=headers, method=method)
    try:
        with request.urlopen(req, timeout=20) as response:
            raw = response.read()
            if not raw:
                return None
            return json.loads(raw.decode("utf-8"))
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase HTTP {exc.code}: {detail}") from exc


def get_overrides(date: str) -> dict:
    if USE_SUPABASE:
        rows = supabase_request(
            "GET",
            "fleet_status_overrides",
            query={
                "base_date": f"eq.{date}",
                "select": "placa,status,updated_at",
            },
        ) or []
        return {
            row["placa"]: {
                "status": row["status"],
                "updatedAt": row.get("updated_at"),
            }
            for row in rows
        }

    store = load_local(LOCAL_OVERRIDES, {})
    return store.get(date, {})


def set_override(date: str, placa: str, status: str) -> dict:
    if USE_SUPABASE:
        supabase_request(
            "POST",
            "fleet_status_overrides",
            query={"on_conflict": "base_date,placa"},
            body=[{"base_date": date, "placa": placa, "status": status}],
            prefer="resolution=merge-duplicates,return=representation",
        )
        return get_overrides(date)

    store = load_local(LOCAL_OVERRIDES, {})
    store.setdefault(date, {})[placa] = {
        "status": status,
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
    }
    save_local(LOCAL_OVERRIDES, store)
    return store.get(date, {})


def get_notices(date: str) -> list[dict]:
    if USE_SUPABASE:
        rows = supabase_request(
            "GET",
            "fleet_maintenance_notices",
            query={
                "base_date": f"eq.{date}",
                "select": "id,placa,text,created_at",
                "order": "created_at.desc",
            },
        ) or []
        return [
            {
                "id": str(row["id"]),
                "placa": row["placa"],
                "text": row["text"],
                "updatedAt": row.get("created_at"),
            }
            for row in rows
        ]

    store = load_local(LOCAL_NOTICES, {})
    return store.get(date, [])


def add_notice(date: str, placa: str, text: str) -> list[dict]:
    if USE_SUPABASE:
        supabase_request(
            "POST",
            "fleet_maintenance_notices",
            body=[{"base_date": date, "placa": placa, "text": text}],
            prefer="return=representation",
        )
        return get_notices(date)

    store = load_local(LOCAL_NOTICES, {})
    store.setdefault(date, []).insert(
        0,
        {
            "id": uuid.uuid4().hex,
            "placa": placa,
            "text": text,
            "updatedAt": datetime.now().isoformat(timespec="seconds"),
        },
    )
    save_local(LOCAL_NOTICES, store)
    return store.get(date, [])


def delete_notice(date: str, notice_id: str) -> list[dict]:
    if USE_SUPABASE:
        supabase_request(
            "DELETE",
            "fleet_maintenance_notices",
            query={"base_date": f"eq.{date}", "id": f"eq.{notice_id}"},
            prefer="return=minimal",
        )
        return get_notices(date)

    store = load_local(LOCAL_NOTICES, {})
    store[date] = [item for item in store.get(date, []) if item.get("id") != notice_id]
    save_local(LOCAL_NOTICES, store)
    return store.get(date, [])


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def do_GET(self) -> None:
        parsed = parse.urlparse(self.path)
        query = parse.parse_qs(parsed.query)

        try:
            if parsed.path == "/health":
                json_response(self, {"ok": True, "storage": "supabase" if USE_SUPABASE else "local"})
                return

            if parsed.path == "/api/overrides":
                date = query.get("date", [""])[0]
                json_response(self, {"date": date, "overrides": get_overrides(date) if date else {}})
                return

            if parsed.path == "/api/notices":
                date = query.get("date", [""])[0]
                json_response(self, {"date": date, "notices": get_notices(date) if date else []})
                return
        except Exception as exc:
            json_response(self, {"error": str(exc)}, 500)
            return

        if parsed.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        parsed = parse.urlparse(self.path)
        try:
            payload = read_body(self)

            if parsed.path == "/api/overrides":
                date = str(payload.get("date", "")).strip()
                placa = str(payload.get("placa", "")).strip().upper()
                status = str(payload.get("status", "")).strip()
                if not date or not placa or status not in ALLOWED_STATUS:
                    json_response(self, {"error": "dados invalidos"}, 400)
                    return
                json_response(self, {"date": date, "overrides": set_override(date, placa, status)})
                return

            if parsed.path == "/api/notices":
                date = str(payload.get("date", "")).strip()
                placa = str(payload.get("placa", "")).strip().upper()
                text = str(payload.get("text", "")).strip()
                if not date or not placa or not text:
                    json_response(self, {"error": "dados invalidos"}, 400)
                    return
                json_response(self, {"date": date, "notices": add_notice(date, placa, text)})
                return
        except Exception as exc:
            json_response(self, {"error": str(exc)}, 500)
            return

        json_response(self, {"error": "rota nao encontrada"}, 404)

    def do_DELETE(self) -> None:
        parsed = parse.urlparse(self.path)
        query = parse.parse_qs(parsed.query)
        try:
            if parsed.path == "/api/notices":
                date = query.get("date", [""])[0]
                notice_id = query.get("id", [""])[0]
                if not date or not notice_id:
                    json_response(self, {"error": "dados invalidos"}, 400)
                    return
                json_response(self, {"date": date, "notices": delete_notice(date, notice_id)})
                return
        except Exception as exc:
            json_response(self, {"error": str(exc)}, 500)
            return

        json_response(self, {"error": "rota nao encontrada"}, 404)

    def log_message(self, format: str, *args) -> None:
        print(f"{self.address_string()} - {format % args}")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8787"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Disponibilidade da frota rodando na porta {port} usando {'Supabase' if USE_SUPABASE else 'armazenamento local'}")
    server.serve_forever()
