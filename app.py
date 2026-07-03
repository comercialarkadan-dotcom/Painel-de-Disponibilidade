from __future__ import annotations

import csv
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import uuid
from datetime import datetime
from http import cookies
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, parse, request


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_JS = STATIC_DIR / "data.js"
HISTORY_CSV = ROOT / "fato_disponibilidade.csv"

LOCAL_OVERRIDES = ROOT / "overrides.local.json"
LOCAL_NOTICES = ROOT / "notices.local.json"
LOCAL_DAILY_HISTORY = ROOT / "daily_history.local.json"

STATUS_AVAILABLE = "Disponível"
STATUS_STOPPED = "Parado"
STATUS_UNAVAILABLE = "Indisponível"
STATUS_MAINTENANCE = "Em manutenção"
STATUS_DEMOBILIZED = "Desmobilizada"
STATUS_MAINTENANCE_REASON = "Manutenção"

ALLOWED_STATUS = {
    STATUS_AVAILABLE,
    STATUS_STOPPED,
    STATUS_UNAVAILABLE,
    STATUS_MAINTENANCE,
    STATUS_DEMOBILIZED,
}

EDIT_ROLES = {"supervisor_frota"}
SESSION_TTL = 12 * 60 * 60
SESSIONS: dict[str, dict] = {}

USERS = {
    "supervisor.frota": {
        "name": "Supervisor de Frota",
        "role": "supervisor_frota",
        "password_hash": hashlib.sha256("Frota@2026".encode("utf-8")).hexdigest(),
    },
    "supervisor.rota": {
        "name": "Supervisor de Rota",
        "role": "supervisor_rota",
        "password_hash": hashlib.sha256("Rota@2026".encode("utf-8")).hexdigest(),
    },
}


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file(ROOT / ".env")
load_env_file(ROOT.parent / ".env")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = (
    os.environ.get("SUPABASE_SECRET_KEY")
    or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_PUBLISHABLE_KEY")
    or os.environ.get("SUPABASE_ANON_KEY")
    or ""
)
USE_SUPABASE = bool(SUPABASE_URL and SUPABASE_KEY) and os.environ.get("DISABLE_SUPABASE") != "1"


def load_json(path: Path, fallback):
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def save_json(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def read_request_json(handler: SimpleHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length <= 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def normalize_status(value: str) -> str:
    clean = str(value or "").strip()
    fixes = {
        "DisponÃ­vel": STATUS_AVAILABLE,
        "DisponÃƒÂ­vel": STATUS_AVAILABLE,
        "IndisponÃ­vel": STATUS_UNAVAILABLE,
        "IndisponÃƒÂ­vel": STATUS_UNAVAILABLE,
        "Em manutenÃ§Ã£o": STATUS_MAINTENANCE,
        "Em manutenÃƒÂ§ÃƒÂ£o": STATUS_MAINTENANCE,
        "ManutenÃ§Ã£o": STATUS_MAINTENANCE_REASON,
        "ManutenÃƒÂ§ÃƒÂ£o": STATUS_MAINTENANCE_REASON,
    }
    return fixes.get(clean, clean)


def parse_date_br(value: str) -> str:
    clean = str(value or "").strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(clean, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return clean


def date_label(value: str) -> str:
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%d/%m/%Y")
    except ValueError:
        return value


def month_info(iso_date: str) -> tuple[str, str, int, str]:
    month_names = {
        1: "Jan",
        2: "Fev",
        3: "Mar",
        4: "Abr",
        5: "Mai",
        6: "Jun",
        7: "Jul",
        8: "Ago",
        9: "Set",
        10: "Out",
        11: "Nov",
        12: "Dez",
    }
    try:
        dt = datetime.strptime(iso_date, "%Y-%m-%d")
    except ValueError:
        now = datetime.now()
        return now.strftime("%Y-%m"), f"{month_names[now.month]}/{now.year}", 1, "S1"
    week = min(((dt.day - 1) // 7) + 1, 5)
    return dt.strftime("%Y-%m"), f"{month_names[dt.month]}/{dt.year}", week, f"S{week}"


def read_data_payload() -> dict:
    if not DATA_JS.exists():
        return {}
    text = DATA_JS.read_text(encoding="utf-8")
    match = re.search(r"window\.DISPONIBILIDADE_DATA\s*=\s*(\{.*\});?\s*$", text, re.S)
    if not match:
        return {}
    return json.loads(match.group(1))


def supabase_request(
    method: str,
    table_or_path: str,
    *,
    query: dict | None = None,
    body=None,
    prefer: str | None = None,
):
    if not USE_SUPABASE:
        raise RuntimeError("Supabase nao configurado")

    query_string = ""
    if query:
        query_string = "?" + parse.urlencode(query, doseq=True, safe=",.*():")

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
                "select": "placa,status,os_number,no_os_observation,updated_by,updated_at",
            },
        ) or []
        return {
            str(row.get("placa", "")).upper(): {
                "status": normalize_status(row.get("status", "")),
                "osNumber": row.get("os_number") or "",
                "noOsObservation": row.get("no_os_observation") or "",
                "updatedBy": row.get("updated_by") or "",
                "updatedAt": row.get("updated_at") or "",
            }
            for row in rows
            if row.get("placa")
        }

    store = load_json(LOCAL_OVERRIDES, {})
    return store.get(date, {}) if date else store


def set_override(
    date: str,
    placa: str,
    status: str,
    os_number: str,
    no_os_observation: str,
    username: str,
) -> dict:
    item = {
        "status": status,
        "osNumber": os_number,
        "noOsObservation": no_os_observation,
        "updatedBy": username,
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
    }

    if USE_SUPABASE:
        supabase_request(
            "POST",
            "fleet_status_overrides",
            query={"on_conflict": "base_date,placa"},
            body=[
                {
                    "base_date": date,
                    "placa": placa,
                    "status": status,
                    "os_number": os_number,
                    "no_os_observation": no_os_observation,
                    "updated_by": username,
                    "updated_at": item["updatedAt"],
                }
            ],
            prefer="resolution=merge-duplicates,return=representation",
        )
        return get_overrides(date)

    store = load_json(LOCAL_OVERRIDES, {})
    store.setdefault(date, {})[placa] = item
    save_json(LOCAL_OVERRIDES, store)
    return store.get(date, {})


def get_notices(date: str) -> list[dict]:
    if USE_SUPABASE:
        rows = supabase_request(
            "GET",
            "fleet_maintenance_notices",
            query={
                "base_date": f"eq.{date}",
                "select": "id,placa,text,updated_by,created_at",
                "order": "created_at.desc",
            },
        ) or []
        return [
            {
                "id": str(row.get("id", "")),
                "placa": str(row.get("placa", "")).upper(),
                "text": row.get("text") or "",
                "updatedBy": row.get("updated_by") or "",
                "updatedAt": row.get("created_at") or "",
            }
            for row in rows
        ]

    store = load_json(LOCAL_NOTICES, {})
    return store.get(date, []) if date else store


def add_notice(date: str, placa: str, text: str, username: str) -> list[dict]:
    if USE_SUPABASE:
        supabase_request(
            "POST",
            "fleet_maintenance_notices",
            body=[
                {
                    "base_date": date,
                    "placa": placa,
                    "text": text,
                    "updated_by": username,
                }
            ],
            prefer="return=representation",
        )
        return get_notices(date)

    store = load_json(LOCAL_NOTICES, {})
    store.setdefault(date, []).insert(
        0,
        {
            "id": uuid.uuid4().hex,
            "placa": placa,
            "text": text,
            "updatedBy": username,
            "updatedAt": datetime.now().isoformat(timespec="seconds"),
        },
    )
    save_json(LOCAL_NOTICES, store)
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

    store = load_json(LOCAL_NOTICES, {})
    store[date] = [item for item in store.get(date, []) if item.get("id") != notice_id]
    save_json(LOCAL_NOTICES, store)
    return store.get(date, [])


def get_daily_history_store() -> dict:
    if USE_SUPABASE:
        rows = supabase_request(
            "GET",
            "fleet_daily_history",
            query={
                "select": "base_date,rows,updated_by,updated_at",
                "order": "base_date.asc",
            },
        ) or []
        store = {}
        for row in rows:
            iso = str(row.get("base_date") or "")
            if not iso:
                continue
            store[iso] = {
                "rows": row.get("rows") or [],
                "updatedBy": row.get("updated_by") or "",
                "updatedAt": row.get("updated_at") or "",
            }
        return store

    return load_json(LOCAL_DAILY_HISTORY, {})


def save_daily_snapshot(date: str, rows: list[dict], username: str) -> None:
    payload = {
        "updatedBy": username,
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
        "rows": rows,
    }

    if USE_SUPABASE:
        supabase_request(
            "POST",
            "fleet_daily_history",
            query={"on_conflict": "base_date"},
            body=[
                {
                    "base_date": date,
                    "rows": rows,
                    "updated_by": username,
                    "updated_at": payload["updatedAt"],
                }
            ],
            prefer="resolution=merge-duplicates,return=representation",
        )
        return

    store = load_json(LOCAL_DAILY_HISTORY, {})
    store[date] = payload
    save_json(LOCAL_DAILY_HISTORY, store)


def base_history_rows() -> list[dict]:
    rows = []
    if not HISTORY_CSV.exists():
        return rows

    with HISTORY_CSV.open("r", encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file, delimiter=";")
        for item in reader:
            iso = parse_date_br(item.get("DATA", ""))
            status = normalize_status(item.get("STATUS", ""))
            mes, mes_label, week, week_label = month_info(iso)
            active = int(float(item.get("ATIVO") or 1))
            available = int(
                float(
                    item.get("DISPONIVEL")
                    or (1 if status in {STATUS_AVAILABLE, STATUS_STOPPED} else 0)
                )
            )
            unavailable = int(
                float(
                    item.get("INDISPONIVEL")
                    or (
                        1
                        if status not in {STATUS_AVAILABLE, STATUS_STOPPED, STATUS_DEMOBILIZED}
                        else 0
                    )
                )
            )
            rows.append(
                {
                    "date": iso,
                    "dateLabel": date_label(iso),
                    "month": item.get("MES") or mes,
                    "monthLabel": item.get("MES_LABEL") or mes_label,
                    "week": int(float(item.get("SEMANA_MES") or week or 0)),
                    "weekLabel": item.get("SEMANA_LABEL") or week_label,
                    "perfil": item.get("PERFIL", ""),
                    "placa": item.get("PLACA", "").upper(),
                    "status": status,
                    "motorista": item.get("MOTORISTA", ""),
                    "observacao": item.get("OBSERVACAO", ""),
                    "motivo": normalize_status(item.get("MOTIVO", status)),
                    "ativo": active,
                    "disponivel": available,
                    "indisponivel": unavailable,
                    "horasIndisp": float(item.get("HORAS_INDISP") or 0),
                    "source": "Planilha",
                    "osNumber": "",
                    "statusObservation": "",
                }
            )
    return rows


def daily_snapshot_rows() -> list[dict]:
    store = get_daily_history_store()
    rows = []
    for iso, payload in store.items():
        for item in payload.get("rows", []):
            status = normalize_status(item.get("status", ""))
            mes, mes_label, week, week_label = month_info(iso)
            active = 0 if status == STATUS_DEMOBILIZED else 1
            available = 1 if status in {STATUS_AVAILABLE, STATUS_STOPPED} and active else 0
            unavailable = (
                1
                if status not in {STATUS_AVAILABLE, STATUS_STOPPED, STATUS_DEMOBILIZED} and active
                else 0
            )
            rows.append(
                {
                    "date": iso,
                    "dateLabel": date_label(iso),
                    "month": mes,
                    "monthLabel": mes_label,
                    "week": week,
                    "weekLabel": week_label,
                    "perfil": item.get("perfil", ""),
                    "placa": item.get("placa", "").upper(),
                    "status": status,
                    "motorista": item.get("motorista", ""),
                    "observacao": item.get("observacao", ""),
                    "motivo": STATUS_MAINTENANCE_REASON if status == STATUS_MAINTENANCE else status,
                    "ativo": active,
                    "disponivel": available,
                    "indisponivel": unavailable,
                    "horasIndisp": 24.0 if unavailable else 0.0,
                    "source": "Painel",
                    "osNumber": item.get("osNumber", ""),
                    "statusObservation": item.get("statusObservation", ""),
                    "updatedBy": payload.get("updatedBy", ""),
                    "updatedAt": payload.get("updatedAt", ""),
                }
            )
    return rows


def history_payload() -> dict:
    merged = {}
    for row in base_history_rows():
        merged[(row["date"], row["placa"])] = row
    for row in daily_snapshot_rows():
        merged[(row["date"], row["placa"])] = row

    details = sorted(merged.values(), key=lambda item: (item["date"], item["placa"]))
    grouped: dict[str, list[dict]] = {}
    for row in details:
        grouped.setdefault(row["date"], []).append(row)

    summary = []
    for iso, rows in sorted(grouped.items()):
        active = [row for row in rows if row.get("ativo")]
        available = sum(row.get("disponivel", 0) for row in active)
        stopped = sum(1 for row in active if row.get("status") == STATUS_STOPPED)
        maintenance = sum(1 for row in active if row.get("status") == STATUS_MAINTENANCE)
        unavailable = sum(row.get("indisponivel", 0) for row in active)
        summary.append(
            {
                "date": iso,
                "dateLabel": date_label(iso),
                "total": len(active),
                "available": available,
                "stopped": stopped,
                "maintenance": maintenance,
                "unavailable": unavailable,
                "availability": round(available / len(active), 4) if active else 0,
                "source": "Painel"
                if any(row.get("source") == "Painel" for row in rows)
                else "Planilha",
            }
        )
    return {"summary": summary, "details": details}


def current_public_user(handler: SimpleHTTPRequestHandler):
    cookie_header = handler.headers.get("Cookie", "")
    jar = cookies.SimpleCookie()
    try:
        jar.load(cookie_header)
    except cookies.CookieError:
        return None
    token = jar.get("disp_session")
    if not token:
        return None
    session = SESSIONS.get(token.value)
    if not session or session.get("expires", 0) < time.time():
        SESSIONS.pop(token.value, None)
        return None
    user = USERS.get(session.get("username"))
    if not user:
        return None
    return {
        "username": session["username"],
        "name": user["name"],
        "role": user["role"],
        "canEdit": user["role"] in EDIT_ROLES,
    }


def verify_login(username: str, password: str):
    clean_username = str(username or "").strip().lower()
    user = USERS.get(clean_username)
    if not user:
        return None
    password_hash = hashlib.sha256(str(password or "").encode("utf-8")).hexdigest()
    if not hmac.compare_digest(password_hash, user["password_hash"]):
        return None
    return clean_username


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def send_json(self, payload: dict, status: int = 200, extra_headers: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def require_user(self):
        user = current_public_user(self)
        if not user:
            self.send_json({"error": "nao autenticado"}, 401)
            return None
        return user

    def require_editor(self):
        user = self.require_user()
        if not user:
            return None
        if not user.get("canEdit"):
            self.send_json({"error": "usuario somente leitura"}, 403)
            return None
        return user

    def do_GET(self) -> None:
        parsed = parse.urlparse(self.path)
        query = parse.parse_qs(parsed.query)

        try:
            if parsed.path == "/health":
                self.send_json({"ok": True, "storage": "supabase" if USE_SUPABASE else "local"})
                return

            if parsed.path == "/api/session":
                self.send_json({"user": current_public_user(self)})
                return

            if parsed.path == "/api/data":
                user = self.require_user()
                if not user:
                    return
                self.send_json({"data": read_data_payload()})
                return

            if parsed.path == "/api/history":
                user = self.require_user()
                if not user:
                    return
                self.send_json(history_payload())
                return

            if parsed.path == "/api/overrides":
                user = self.require_user()
                if not user:
                    return
                date = query.get("date", [""])[0]
                self.send_json({"date": date, "overrides": get_overrides(date) if date else {}})
                return

            if parsed.path == "/api/notices":
                user = self.require_user()
                if not user:
                    return
                date = query.get("date", [""])[0]
                self.send_json({"date": date, "notices": get_notices(date) if date else []})
                return
        except Exception as exc:
            self.send_json({"error": str(exc)}, 500)
            return

        if parsed.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        parsed = parse.urlparse(self.path)

        if parsed.path == "/api/login":
            try:
                payload = read_request_json(self)
            except Exception:
                self.send_json({"error": "json invalido"}, 400)
                return
            username = verify_login(payload.get("username", ""), payload.get("password", ""))
            if not username:
                self.send_json({"error": "usuario ou senha invalidos"}, 401)
                return
            token = secrets.token_urlsafe(32)
            SESSIONS[token] = {"username": username, "expires": time.time() + SESSION_TTL}
            current = {
                "username": username,
                "name": USERS[username]["name"],
                "role": USERS[username]["role"],
                "canEdit": USERS[username]["role"] in EDIT_ROLES,
            }
            headers = {
                "Set-Cookie": (
                    f"disp_session={token}; Path=/; HttpOnly; SameSite=Lax; "
                    f"Max-Age={SESSION_TTL}"
                )
            }
            self.send_json({"user": current}, extra_headers=headers)
            return

        if parsed.path == "/api/logout":
            jar = cookies.SimpleCookie()
            try:
                jar.load(self.headers.get("Cookie", ""))
            except cookies.CookieError:
                pass
            token = jar.get("disp_session")
            if token:
                SESSIONS.pop(token.value, None)
            self.send_json(
                {"ok": True},
                extra_headers={"Set-Cookie": "disp_session=; Path=/; Max-Age=0; SameSite=Lax"},
            )
            return

        try:
            if parsed.path == "/api/overrides":
                user = self.require_editor()
                if not user:
                    return
                payload = read_request_json(self)
                date = str(payload.get("date", "")).strip()
                placa = str(payload.get("placa", "")).strip().upper()
                status = normalize_status(payload.get("status", ""))
                os_number = str(payload.get("osNumber", "")).strip().upper()
                no_os_observation = str(payload.get("noOsObservation", "")).strip()

                if not date or not placa or status not in ALLOWED_STATUS:
                    self.send_json({"error": "dados invalidos"}, 400)
                    return
                if not os_number and not no_os_observation:
                    self.send_json(
                        {"error": "informe a OS ou uma observacao quando nao houver OS"},
                        400,
                    )
                    return

                self.send_json(
                    {
                        "date": date,
                        "overrides": set_override(
                            date,
                            placa,
                            status,
                            os_number,
                            no_os_observation,
                            user["username"],
                        ),
                    }
                )
                return

            if parsed.path == "/api/notices":
                user = self.require_editor()
                if not user:
                    return
                payload = read_request_json(self)
                date = str(payload.get("date", "")).strip()
                placa = str(payload.get("placa", "")).strip().upper()
                text = str(payload.get("text", "")).strip()
                if not date or not placa or not text:
                    self.send_json({"error": "dados invalidos"}, 400)
                    return
                self.send_json(
                    {"date": date, "notices": add_notice(date, placa, text, user["username"])}
                )
                return

            if parsed.path == "/api/daily-update":
                user = self.require_editor()
                if not user:
                    return
                payload = read_request_json(self)
                date = parse_date_br(payload.get("date", ""))
                rows = payload.get("rows") or []
                if not date or not isinstance(rows, list):
                    self.send_json({"error": "dados invalidos"}, 400)
                    return

                clean_rows = []
                for row in rows:
                    status = normalize_status(row.get("status", ""))
                    if status not in ALLOWED_STATUS:
                        continue
                    clean_rows.append(
                        {
                            "placa": str(row.get("placa", "")).strip().upper(),
                            "perfil": str(row.get("perfil", "")).strip(),
                            "status": status,
                            "motorista": str(row.get("motorista", "")).strip(),
                            "observacao": str(row.get("observacao", "")).strip(),
                            "osNumber": str(row.get("osNumber", "")).strip().upper(),
                            "statusObservation": str(row.get("statusObservation", "")).strip(),
                        }
                    )
                if not clean_rows:
                    self.send_json({"error": "nenhuma linha valida"}, 400)
                    return

                save_daily_snapshot(date, clean_rows, user["username"])
                self.send_json({"ok": True, "date": date, **history_payload()})
                return
        except Exception as exc:
            self.send_json({"error": str(exc)}, 500)
            return

        self.send_json({"error": "rota nao encontrada"}, 404)

    def do_DELETE(self) -> None:
        parsed = parse.urlparse(self.path)
        query = parse.parse_qs(parsed.query)

        try:
            if parsed.path == "/api/notices":
                user = self.require_editor()
                if not user:
                    return
                date = query.get("date", [""])[0]
                notice_id = query.get("id", [""])[0]
                if not date or not notice_id:
                    self.send_json({"error": "dados invalidos"}, 400)
                    return
                self.send_json({"date": date, "notices": delete_notice(date, notice_id)})
                return
        except Exception as exc:
            self.send_json({"error": str(exc)}, 500)
            return

        self.send_json({"error": "rota nao encontrada"}, 404)

    def log_message(self, format: str, *args) -> None:
        print(f"{self.address_string()} - {format % args}")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8787"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    storage = "Supabase" if USE_SUPABASE else "armazenamento local"
    print(f"Disponibilidade da frota rodando na porta {port} usando {storage}")
    server.serve_forever()
