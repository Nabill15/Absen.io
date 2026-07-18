from __future__ import annotations

import base64
import binascii
import csv
import hmac
import io
import json
import logging
import math
import os
import re
import secrets
import shutil
import sqlite3
import threading
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dotenv import load_dotenv
from flask import (
    Flask,
    abort,
    jsonify,
    make_response,
    render_template,
    request,
    send_from_directory,
    session,
)
from PIL import Image, UnidentifiedImageError
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
IS_PRODUCTION = APP_ENV == "production"

app = Flask(__name__, static_folder="static", template_folder="templates")

secret_key = os.getenv("SECRET_KEY", "").strip()
if IS_PRODUCTION and (len(secret_key) < 32 or secret_key.startswith('replace-with')):
    raise RuntimeError("SECRET_KEY production wajib unik dan minimal 32 karakter.")
if not secret_key:
    secret_key = secrets.token_hex(32)
    app.logger.warning("SECRET_KEY belum diatur. Session akan berubah setiap aplikasi restart.")

app.config.update(
    SECRET_KEY=secret_key,
    MAX_CONTENT_LENGTH=int(os.getenv("MAX_CONTENT_LENGTH", str(3 * 1024 * 1024))),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=IS_PRODUCTION,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(minutes=int(os.getenv("SESSION_MINUTES", "30"))),
    JSON_SORT_KEYS=False,
)

if os.getenv("TRUST_PROXY", "1" if IS_PRODUCTION else "0") == "1":
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
) 

DB_PATH = Path(os.getenv("DATABASE_PATH", str(BASE_DIR / "database.db"))).expanduser().resolve()
PRIVATE_UPLOAD_ROOT = Path(
    os.getenv("UPLOAD_ROOT", str(BASE_DIR / "instance" / "uploads"))
).expanduser().resolve()
PROFILE_DIR = PRIVATE_UPLOAD_ROOT / "profiles"
SNAPSHOT_DIR = PRIVATE_UPLOAD_ROOT / "snapshots"
PROFILE_DIR.mkdir(parents=True, exist_ok=True)
SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

try:
    APP_TIMEZONE = ZoneInfo(os.getenv("APP_TIMEZONE", "Asia/Makassar"))
except ZoneInfoNotFoundError as exc:
    raise RuntimeError("APP_TIMEZONE tidak valid.") from exc

TIMEZONE_LABEL = os.getenv("TIMEZONE_LABEL", "WITA")
FACE_MATCH_THRESHOLD = float(os.getenv("FACE_MATCH_THRESHOLD", "0.58"))
SIMULATION_ENABLED = (
    os.getenv("SIMULATION_ENABLED", "false").strip().lower() == "true"
    and not IS_PRODUCTION
)

# Active liveness: server memberikan urutan gerakan acak yang wajib
# diselesaikan sebelum presensi diterima.
LIVENESS_TIMEOUT_SECONDS = max(
    20,
    min(90, int(os.getenv("LIVENESS_TIMEOUT_SECONDS", "45")))
)

LIVENESS_ACTIONS = (
    "blink",
    "turn_left",
    "turn_right",
)

LIVENESS_MIN_SCORE = {
    "blink": 0.15,
    "turn_left": 0.10,
    "turn_right": 0.10,
}

ADMIN_PASSWORD_HASH = os.getenv("ADMIN_PASSWORD_HASH", "").strip()
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "").strip()
if IS_PRODUCTION and not (ADMIN_PASSWORD_HASH or ADMIN_PASSWORD):
    raise RuntimeError(
        "ADMIN_PASSWORD_HASH atau ADMIN_PASSWORD wajib diatur pada environment production."
    )
if IS_PRODUCTION and ADMIN_PASSWORD and len(ADMIN_PASSWORD) < 12:
    raise RuntimeError("ADMIN_PASSWORD production minimal 12 karakter.")
if not IS_PRODUCTION and not (ADMIN_PASSWORD_HASH or ADMIN_PASSWORD):
    ADMIN_PASSWORD = "change-me-now"
    app.logger.warning(
        "Password admin development memakai nilai sementara 'change-me-now'. Segera ubah melalui .env."
    )

EMPLOYEE_ID_RE = re.compile(r"^[A-Z0-9][A-Z0-9_-]{2,29}$")
ALLOWED_SETTING_KEYS = {
    "checkin_start",
    "checkin_end",
    "checkout_start",
    "checkout_end",
    "office_lat",
    "office_lng",
    "office_radius",
}

_rate_limit_store: dict[str, deque[float]] = defaultdict(deque)
_rate_limit_lock = threading.Lock()


def client_ip() -> str:
    # ProxyFix will replace remote_addr only when TRUST_PROXY is explicitly enabled.
    return request.remote_addr or "unknown"


def enforce_rate_limit(scope: str, limit: int, window_seconds: int) -> None:
    key = f"{scope}:{client_ip()}"
    now = time.monotonic()
    with _rate_limit_lock:
        bucket = _rate_limit_store[key]
        while bucket and now - bucket[0] >= window_seconds:
            bucket.popleft()
        if len(bucket) >= limit:
            abort(429, description="Terlalu banyak permintaan. Silakan coba kembali beberapa saat lagi.")
        bucket.append(now)


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def migrate_legacy_media(conn: sqlite3.Connection) -> None:
    mappings = [
        (
            "employees",
            "id",
            "photo",
            "/static/uploads/profiles/",
            BASE_DIR / "static" / "uploads" / "profiles",
            PROFILE_DIR,
            "profiles",
        ),
        (
            "attendance_logs",
            "id",
            "snapshot_photo",
            "/static/uploads/snapshots/",
            BASE_DIR / "static" / "uploads" / "snapshots",
            SNAPSHOT_DIR,
            "snapshots",
        ),
    ]

    for table, key_column, path_column, prefix, legacy_dir, destination, media_kind in mappings:
        rows = conn.execute(
            f"SELECT {key_column}, {path_column} FROM {table} WHERE {path_column} LIKE ?",
            (f"{prefix}%",),
        ).fetchall()
        for row in rows:
            old_value = row[path_column]
            filename = Path(old_value).name
            if not filename:
                continue
            source = legacy_dir / filename
            target = destination / filename
            try:
                if source.exists() and not target.exists():
                    shutil.copy2(source, target)
                if target.exists():
                    conn.execute(
                        f"UPDATE {table} SET {path_column} = ? WHERE {key_column} = ?",
                        (f"/api/media/{media_kind}/{filename}", row[key_column]),
                    )
                    if source.exists():
                        source.unlink()
            except OSError:
                app.logger.exception("Gagal memigrasikan media lama: %s", source)


def init_db() -> None:
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS employees (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            role TEXT NOT NULL,
            photo TEXT NOT NULL,
            descriptor TEXT NOT NULL,
            registered_at TEXT NOT NULL,
            is_deleted INTEGER DEFAULT 0 CHECK (is_deleted IN (0, 1))
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS attendance_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            log_id TEXT NOT NULL,
            employee_id TEXT NOT NULL,
            name TEXT NOT NULL,
            role TEXT NOT NULL,
            snapshot_photo TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            time_formatted TEXT NOT NULL,
            date_formatted TEXT NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('check-in', 'check-out')),
            status TEXT NOT NULL,
            is_late INTEGER NOT NULL CHECK (is_late IN (0, 1)),
            method TEXT NOT NULL,
            FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE RESTRICT
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )

    defaults = {
        "checkin_start": "07:00",
        "checkin_end": "09:00",
        "checkout_start": "17:00",
        "checkout_end": "19:00",
        "office_lat": "-6.200000",
        "office_lng": "106.816666",
        "office_radius": "100",
    }
    cursor.executemany(
        "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", defaults.items()
    )

    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_log_id ON attendance_logs(log_id)"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_attendance_timestamp ON attendance_logs(timestamp)"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_attendance_employee_timestamp ON attendance_logs(employee_id, timestamp)"
    )

    migrate_legacy_media(conn)
    conn.commit()
    conn.close()
    app.logger.info("Database SQLite siap: %s", DB_PATH)


init_db()


def now_local() -> datetime:
    return datetime.now(APP_TIMEZONE)


def formatted_datetime(value: datetime) -> tuple[str, str]:
    days = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"]
    months = [
        "Januari",
        "Februari",
        "Maret",
        "April",
        "Mei",
        "Juni",
        "Juli",
        "Agustus",
        "September",
        "Oktober",
        "November",
        "Desember",
    ]
    date_formatted = f"{days[value.weekday()]}, {value.day} {months[value.month - 1]} {value.year}"
    return value.strftime("%H:%M"), date_formatted


def calculate_euclidean_distance(vector_a: list[float], vector_b: list[float]) -> float:
    if len(vector_a) != len(vector_b):
        return float("inf")
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(vector_a, vector_b)))


def validate_descriptor_vector(value: object) -> list[float] | None:
    if not isinstance(value, list) or len(value) != 128:
        return None
    validated: list[float] = []
    for item in value:
        if not isinstance(item, (int, float)) or isinstance(item, bool):
            return None
        number = float(item)
        if not math.isfinite(number) or abs(number) > 10:
            return None
        validated.append(number)
    return validated


def validate_descriptor_payload(value: object) -> list[list[float]] | None:
    single = validate_descriptor_vector(value)
    if single is not None:
        return [single]
    if not isinstance(value, list) or not 1 <= len(value) <= 10:
        return None
    vectors: list[list[float]] = []
    for item in value:
        validated = validate_descriptor_vector(item)
        if validated is None:
            return None
        vectors.append(validated)
    return vectors


def decode_stored_descriptors(raw_value: str) -> list[list[float]]:
    try:
        value = json.loads(raw_value)
    except (TypeError, json.JSONDecodeError):
        return []
    return validate_descriptor_payload(value) or []


def save_data_image(data_uri: str, destination: Path, filename_prefix: str) -> str:
    if not isinstance(data_uri, str) or "," not in data_uri:
        raise ValueError("Format gambar tidak valid")

    header, encoded = data_uri.split(",", 1)
    if header not in {
        "data:image/jpeg;base64",
        "data:image/jpg;base64",
        "data:image/png;base64",
        "data:image/webp;base64",
    }:
        raise ValueError("Format gambar harus JPEG, PNG, atau WebP")

    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Data gambar tidak valid") from exc

    if not raw or len(raw) > 2 * 1024 * 1024:
        raise ValueError("Ukuran gambar maksimal 2 MB")

    try:
        with Image.open(io.BytesIO(raw)) as source:
            source.verify()
        with Image.open(io.BytesIO(raw)) as source:
            image = source.convert("RGB")
            if image.width < 100 or image.height < 100:
                raise ValueError("Resolusi gambar terlalu kecil")
            if image.width * image.height > 12_000_000:
                raise ValueError("Resolusi gambar terlalu besar")
            image.thumbnail((1024, 1024))
            filename = f"{filename_prefix}-{uuid.uuid4().hex}.jpg"
            filepath = destination / filename
            image.save(filepath, format="JPEG", quality=85, optimize=True)
            return filename
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("File gambar tidak dapat diproses") from exc


def delete_private_media(url: str) -> None:
    if not isinstance(url, str) or not url.startswith("/api/media/"):
        return
    parts = url.strip("/").split("/")
    if len(parts) != 4:
        return
    _, _, kind, filename = parts
    base = PROFILE_DIR if kind == "profiles" else SNAPSHOT_DIR if kind == "snapshots" else None
    if base is None:
        return
    safe_name = Path(filename).name
    try:
        (base / safe_name).unlink(missing_ok=True)
    except OSError:
        app.logger.exception("Gagal menghapus media: %s", safe_name)


def is_admin() -> bool:
    return session.get("admin_logged_in") is True


def ensure_csrf_token() -> str:
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def validate_csrf() -> bool:
    expected = session.get("csrf_token", "")
    supplied = request.headers.get("X-CSRF-Token", "")
    return bool(expected and supplied and hmac.compare_digest(expected, supplied))


def csrf_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not validate_csrf():
            return jsonify({"message": "Token keamanan tidak valid. Muat ulang halaman."}), 403
        return view(*args, **kwargs)

    return wrapped


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not is_admin():
            return jsonify({"message": "Sesi admin diperlukan"}), 401
        return view(*args, **kwargs)

    return wrapped


def password_is_valid(candidate: str) -> bool:
    if not isinstance(candidate, str) or not candidate:
        return False
    if ADMIN_PASSWORD_HASH:
        try:
            return check_password_hash(ADMIN_PASSWORD_HASH, candidate)
        except ValueError:
            app.logger.error("ADMIN_PASSWORD_HASH tidak valid")
            return False
    return hmac.compare_digest(ADMIN_PASSWORD, candidate)


def json_body() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}

def validate_liveness_proof(data: dict) -> tuple[bool, str]:
    """
    Memvalidasi dan menghapus tantangan liveness sekali pakai
    yang tersimpan dalam session.
    """

    # pop() membuat challenge hanya bisa digunakan satu kali.
    challenge = session.pop("liveness_challenge", None)
    session.modified = True

    if not isinstance(challenge, dict):
        return False, (
            "Tantangan keaslian tidak ditemukan. "
            "Mulai ulang pemindaian."
        )

    challenge_id = str(data.get("liveness_challenge_id", ""))
    expected_id = str(challenge.get("id", ""))

    if (
        not challenge_id
        or not expected_id
        or not hmac.compare_digest(challenge_id, expected_id)
    ):
        return False, (
            "Tantangan keaslian tidak valid atau sudah digunakan."
        )

    try:
        expires_at = int(challenge.get("expires_at", 0))
    except (TypeError, ValueError):
        expires_at = 0

    if int(time.time()) > expires_at:
        return False, (
            "Waktu pemeriksaan keaslian telah habis. "
            "Silakan ulangi."
        )

    expected_actions = challenge.get("actions")
    steps = data.get("liveness_steps")

    if not isinstance(expected_actions, list) or not isinstance(steps, list):
        return False, "Bukti pemeriksaan keaslian tidak lengkap."

    if len(steps) != len(expected_actions):
        return False, (
            "Semua gerakan pemeriksaan keaslian wajib diselesaikan."
        )

    supplied_actions: list[str] = []
    previous_at = -1

    for step in steps:
        if not isinstance(step, dict):
            return False, (
                "Format bukti pemeriksaan keaslian tidak valid."
            )

        action = str(step.get("action", ""))
        supplied_actions.append(action)

        try:
            score = float(step.get("score", 0))
            at_ms = int(step.get("at_ms", -1))
        except (TypeError, ValueError):
            return False, (
                "Nilai pemeriksaan keaslian tidak valid."
            )

        minimum_score = LIVENESS_MIN_SCORE.get(action, 1.0)

        if not math.isfinite(score) or score < minimum_score:
            return False, (
                "Gerakan pemeriksaan keaslian tidak cukup jelas."
            )

        if (
            at_ms <= previous_at
            or at_ms < 0
            or at_ms > LIVENESS_TIMEOUT_SECONDS * 1000
        ):
            return False, (
                "Urutan waktu pemeriksaan keaslian tidak valid."
            )

        previous_at = at_ms

    if supplied_actions != expected_actions:
        return False, (
            "Urutan gerakan pemeriksaan keaslian "
            "tidak sesuai tantangan."
        )

    try:
        duration_ms = int(data.get("liveness_duration_ms", 0))
    except (TypeError, ValueError):
        duration_ms = 0

    if (
        duration_ms < 500
        or duration_ms > LIVENESS_TIMEOUT_SECONDS * 1000
    ):
        return False, (
            "Durasi pemeriksaan keaslian tidak valid."
        )

    return True, ""

@app.after_request
def apply_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=(self)"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' "
        "https://cdn.jsdelivr.net "
        "https://unpkg.com "
        "'unsafe-eval'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: blob:; "
        "media-src 'self' blob:; "
        "connect-src 'self'; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    if request.is_secure and IS_PRODUCTION:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


@app.errorhandler(413)
def payload_too_large(_error):
    return jsonify({"message": "Payload terlalu besar. Maksimal 3 MB."}), 413


@app.errorhandler(429)
def too_many_requests(error):
    return jsonify({"message": getattr(error, "description", "Terlalu banyak permintaan")}), 429


@app.errorhandler(500)
def internal_error(_error):
    app.logger.exception("Kesalahan server tidak terduga")
    return jsonify({"message": "Terjadi kesalahan internal pada server"}), 500


@app.get("/")
def index():
    ensure_csrf_token()
    return render_template("index.html")


@app.get("/health")
def health():
    try:
        conn = get_db_connection()
        conn.execute("SELECT 1").fetchone()
        conn.close()
        return jsonify({"status": "ok", "database": "connected"})
    except sqlite3.Error:
        app.logger.exception("Health check database gagal")
        return jsonify({"status": "error", "database": "disconnected"}), 503


@app.get("/api/session")
def session_status():
    return jsonify(
        {
            "authenticated": is_admin(),
            "csrf_token": ensure_csrf_token(),
            "simulation_enabled": SIMULATION_ENABLED,
            "timezone": str(APP_TIMEZONE),
            "timezone_label": TIMEZONE_LABEL,
        }
    )


@app.post("/api/login")
@csrf_required
def login():
    enforce_rate_limit("login", 5, 60)
    data = json_body()
    if not password_is_valid(data.get("password", "")):
        app.logger.warning("Login admin gagal dari IP %s", client_ip())
        return jsonify({"message": "Password salah"}), 401

    session.clear()
    session["admin_logged_in"] = True
    session.permanent = True
    token = ensure_csrf_token()
    app.logger.info("Login admin berhasil dari IP %s", client_ip())
    return jsonify({"message": "Login berhasil", "csrf_token": token})


@app.post("/api/logout")
@admin_required
@csrf_required
def logout():
    session.clear()
    return jsonify({"message": "Logout berhasil"})


@app.get("/api/media/<kind>/<path:filename>")
@admin_required
def private_media(kind: str, filename: str):
    if Path(filename).name != filename:
        abort(404)
    if kind == "profiles":
        directory = PROFILE_DIR
    elif kind == "snapshots":
        directory = SNAPSHOT_DIR
    else:
        abort(404)
    return send_from_directory(directory, filename, conditional=True, max_age=0)


@app.get("/api/employees")
@admin_required
def get_employees():
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT id, name, role, photo, registered_at FROM employees WHERE is_deleted = 0 ORDER BY name COLLATE NOCASE"
    ).fetchall()
    conn.close()
    return jsonify([dict(row) for row in rows])


@app.post("/api/register")
@admin_required
@csrf_required
def register_employee():
    enforce_rate_limit("register", 10, 3600)
    data = json_body()
    emp_id = str(data.get("id", "")).strip().upper()
    name = str(data.get("name", "")).strip()
    role = str(data.get("role", "")).strip()
    photo_data = data.get("photo")
    descriptors = validate_descriptor_payload(data.get("descriptor"))

    if not EMPLOYEE_ID_RE.fullmatch(emp_id):
        return jsonify({"message": "ID harus 3–30 karakter: huruf, angka, underscore, atau tanda hubung"}), 400
    if not 2 <= len(name) <= 100:
        return jsonify({"message": "Nama harus 2–100 karakter"}), 400
    if not 2 <= len(role) <= 100:
        return jsonify({"message": "Jabatan/divisi harus 2–100 karakter"}), 400
    if descriptors is None:
        return jsonify({"message": "Descriptor wajah harus berisi vektor biometrik 128 dimensi"}), 400
    if not isinstance(photo_data, str):
        return jsonify({"message": "Foto registrasi tidak valid"}), 400

    try:
        filename = save_data_image(photo_data, PROFILE_DIR, "profile")
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400

    photo_path = f"/api/media/profiles/{filename}"
    conn = get_db_connection()
    try:
        conn.execute(
            """
            INSERT INTO employees (id, name, role, photo, descriptor, registered_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (emp_id, name, role, photo_path, json.dumps(descriptors), now_local().isoformat()),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        delete_private_media(photo_path)
        return jsonify({"message": f"Karyawan dengan ID {emp_id} sudah terdaftar"}), 409
    except sqlite3.Error:
        delete_private_media(photo_path)
        app.logger.exception("Gagal menyimpan karyawan")
        return jsonify({"message": "Gagal menyimpan data karyawan"}), 500
    finally:
        conn.close()

    app.logger.info("Karyawan terdaftar: %s", emp_id)
    return jsonify({"message": "Registrasi karyawan berhasil"}), 201

@app.route("/api/liveness/challenge", methods=["GET", "POST"])
def create_liveness_challenge():
    # Endpoint ini hanya membuat tantangan acak sekali pakai.
    # Validasi utama tetap dilakukan saat presensi dikirim.

    enforce_rate_limit(
        "liveness-challenge",
        20,
        60
    )

    actions = list(LIVENESS_ACTIONS)
    secrets.SystemRandom().shuffle(actions)

    challenge_id = secrets.token_urlsafe(24)

    session["liveness_challenge"] = {
        "id": challenge_id,
        "actions": actions,
        "expires_at": (
            int(time.time()) +
            LIVENESS_TIMEOUT_SECONDS
        ),
    }

    session.modified = True

    response = jsonify({
        "challenge_id": challenge_id,
        "actions": actions,
        "expires_in": LIVENESS_TIMEOUT_SECONDS,
    })

    response.headers["Cache-Control"] = "no-store"

    return response

@app.post("/api/attendance")
@csrf_required
def record_attendance():
    enforce_rate_limit("attendance", 15, 60)
    data = json_body()
    emp_id_value = data.get("employee_id")
    emp_id = str(emp_id_value).strip().upper() if emp_id_value else None
    attendance_type = str(data.get("type", "")).strip()
    simulate = data.get("simulate") is True

    if emp_id and not EMPLOYEE_ID_RE.fullmatch(emp_id):
        return jsonify({"message": "Format ID karyawan tidak valid"}), 400
    if attendance_type not in {"check-in", "check-out"}:
        return jsonify({"message": "Tipe presensi harus check-in atau check-out"}), 400
    if simulate and not SIMULATION_ENABLED:
        return jsonify({"message": "Mode simulasi dinonaktifkan pada server ini"}), 403

    live_descriptor = None if simulate else validate_descriptor_vector(data.get("descriptor"))
    if not simulate and live_descriptor is None:
        return jsonify({"message": "Descriptor wajah tidak valid atau tidak terbaca"}), 400
    
    if not simulate:
        liveness_ok, liveness_message = validate_liveness_proof(data)

    if not liveness_ok:
        app.logger.warning(
            "Presensi ditolak oleh liveness dari IP %s: %s",
            client_ip(),
            liveness_message,
        )

        return jsonify({
            "message": liveness_message
        }), 403

    snapshot_photo = data.get("snapshot_photo")
    if not isinstance(snapshot_photo, str):
        return jsonify({"message": "Snapshot wajah wajib disertakan"}), 400

    conn = get_db_connection()
    try:
        if emp_id:
            employees = conn.execute(
                "SELECT id, name, role, photo, descriptor FROM employees WHERE id = ? AND is_deleted = 0",
                (emp_id,),
            ).fetchall()
        else:
            employees = conn.execute(
                "SELECT id, name, role, photo, descriptor FROM employees WHERE is_deleted = 0"
            ).fetchall()

        if not employees:
            return jsonify({"message": "Karyawan tidak ditemukan atau belum ada wajah terdaftar"}), 404

        matched_employee = None
        best_distance = float("inf")

        if simulate:
            matched_employee = dict(employees[0])
            best_distance = 0.0
            method_label = "Face ID Simulation (Development Only)"
        else:
            for employee in employees:
                registered_vectors = decode_stored_descriptors(employee["descriptor"])
                for registered_vector in registered_vectors:
                    distance = calculate_euclidean_distance(live_descriptor, registered_vector)
                    if distance < best_distance:
                        best_distance = distance
                        matched_employee = dict(employee)

            if matched_employee is None or best_distance > FACE_MATCH_THRESHOLD:
                app.logger.warning("Presensi ditolak: wajah tidak cocok dari IP %s", client_ip())
                return jsonify({"message": "Wajah tidak dikenali atau tingkat kecocokan terlalu rendah"}), 400
            method_label = "Face ID + Active Liveness"

        current = now_local()
        current_date_prefix = current.strftime("%Y-%m-%d") + "%"
        existing_types = {
            row["type"]
            for row in conn.execute(
                """
                SELECT type FROM attendance_logs
                WHERE employee_id = ? AND timestamp LIKE ?
                """,
                (matched_employee["id"], current_date_prefix),
            ).fetchall()
        }

        if attendance_type in existing_types:
            label = "check-in" if attendance_type == "check-in" else "check-out"
            return jsonify({"message": f"{label.capitalize()} hari ini sudah tercatat"}), 409
        if attendance_type == "check-out" and "check-in" not in existing_types:
            return jsonify({"message": "Check-out ditolak karena belum ada check-in hari ini"}), 409

        settings_rows = conn.execute("SELECT key, value FROM settings").fetchall()
        settings = {row["key"]: row["value"] for row in settings_rows}
        current_time = current.strftime("%H:%M")
        status_label = "Tepat Waktu"
        is_late = 0

        if attendance_type == "check-in" and current_time > settings.get("checkin_end", "09:00"):
            is_late = 1
            status_label = "Terlambat"
        elif attendance_type == "check-out":
            status_label = (
                "Pulang Cepat"
                if current_time < settings.get("checkout_start", "17:00")
                else "Selesai Tugas"
            )

        try:
            snapshot_filename = save_data_image(snapshot_photo, SNAPSHOT_DIR, "attendance")
        except ValueError as exc:
            return jsonify({"message": str(exc)}), 400

        snapshot_path = f"/api/media/snapshots/{snapshot_filename}"
        log_id = "LOG-" + secrets.token_hex(6).upper()
        time_str, date_str = formatted_datetime(current)

        try:
            conn.execute(
                """
                INSERT INTO attendance_logs (
                    log_id, employee_id, name, role, snapshot_photo, timestamp,
                    time_formatted, date_formatted, type, status, is_late, method
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    log_id,
                    matched_employee["id"],
                    matched_employee["name"],
                    matched_employee["role"],
                    snapshot_path,
                    current.isoformat(),
                    time_str,
                    date_str,
                    attendance_type,
                    status_label,
                    is_late,
                    method_label,
                ),
            )
            conn.commit()
        except sqlite3.Error:
            delete_private_media(snapshot_path)
            app.logger.exception("Gagal merekam presensi")
            return jsonify({"message": "Gagal merekam log kehadiran"}), 500

        similarity = 100.0 if simulate else max(0.0, min(100.0, (1.0 - best_distance) * 100.0))
        app.logger.info(
            "Presensi tercatat employee=%s type=%s distance=%.4f",
            matched_employee["id"],
            attendance_type,
            best_distance,
        )
        return jsonify(
            {
                "status": "success",
                "similarity": round(similarity, 1),
                "distance": round(best_distance, 4),
                "timezone_label": TIMEZONE_LABEL,
                "employee": {
                    "id": matched_employee["id"],
                    "name": matched_employee["name"],
                    "role": matched_employee["role"],
                },
                "log": {
                    "log_id": log_id,
                    "type": attendance_type,
                    "time": time_str,
                    "date": date_str,
                    "status": status_label,
                    "is_late": is_late,
                },
            }
        )
    finally:
        conn.close()


@app.get("/api/logs")
@admin_required
def get_logs():
    conn = get_db_connection()
    rows = conn.execute(
        """
        SELECT log_id, employee_id, name, role, snapshot_photo,
               timestamp, time_formatted AS time, date_formatted AS date,
               type, status, is_late, method
        FROM attendance_logs
        ORDER BY timestamp DESC
        LIMIT 2000
        """
    ).fetchall()
    conn.close()
    return jsonify([dict(row) for row in rows])


@app.post("/api/clear-logs")
@admin_required
@csrf_required
def clear_logs():
    conn = get_db_connection()
    rows = conn.execute("SELECT snapshot_photo FROM attendance_logs").fetchall()
    conn.execute("DELETE FROM attendance_logs")
    conn.commit()
    conn.close()
    for row in rows:
        delete_private_media(row["snapshot_photo"])
    app.logger.warning("Seluruh riwayat presensi dihapus oleh admin")
    return jsonify({"message": "Semua riwayat presensi berhasil dihapus"})


@app.get("/api/stats")
def get_stats():
    current_date_prefix = now_local().strftime("%Y-%m-%d") + "%"
    conn = get_db_connection()
    total_emp = conn.execute(
        "SELECT COUNT(*) FROM employees WHERE is_deleted = 0"
    ).fetchone()[0]
    today_checkins = conn.execute(
        "SELECT COUNT(*) FROM attendance_logs WHERE type = 'check-in' AND timestamp LIKE ?",
        (current_date_prefix,),
    ).fetchone()[0]
    today_checkouts = conn.execute(
        "SELECT COUNT(*) FROM attendance_logs WHERE type = 'check-out' AND timestamp LIKE ?",
        (current_date_prefix,),
    ).fetchone()[0]
    conn.close()
    return jsonify(
        {
            "total_employees": total_emp,
            "today_checkins": today_checkins,
            "today_checkouts": today_checkouts,
        }
    )


@app.get("/api/employees/recycle_bin")
@admin_required
def get_deleted_employees():
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT id, name, role, photo, registered_at FROM employees WHERE is_deleted = 1 ORDER BY name COLLATE NOCASE"
    ).fetchall()
    conn.close()
    return jsonify([dict(row) for row in rows])


@app.delete("/api/employees/<emp_id>")
@admin_required
@csrf_required
def soft_delete_employee(emp_id: str):
    normalized = emp_id.strip().upper()
    conn = get_db_connection()
    result = conn.execute(
        "UPDATE employees SET is_deleted = 1 WHERE id = ? AND is_deleted = 0", (normalized,)
    )
    conn.commit()
    conn.close()
    if result.rowcount == 0:
        return jsonify({"message": "Karyawan tidak ditemukan"}), 404
    return jsonify({"message": f"Karyawan {normalized} dipindahkan ke Recycle Bin"})


@app.post("/api/employees/<emp_id>/restore")
@admin_required
@csrf_required
def restore_employee(emp_id: str):
    normalized = emp_id.strip().upper()
    conn = get_db_connection()
    result = conn.execute(
        "UPDATE employees SET is_deleted = 0 WHERE id = ? AND is_deleted = 1", (normalized,)
    )
    conn.commit()
    conn.close()
    if result.rowcount == 0:
        return jsonify({"message": "Karyawan tidak ditemukan di Recycle Bin"}), 404
    return jsonify({"message": f"Karyawan {normalized} berhasil dipulihkan"})


@app.delete("/api/employees/<emp_id>/permanent")
@admin_required
@csrf_required
def permanent_delete_employee(emp_id: str):
    normalized = emp_id.strip().upper()
    conn = get_db_connection()
    employee = conn.execute(
        "SELECT photo FROM employees WHERE id = ? AND is_deleted = 1", (normalized,)
    ).fetchone()
    if not employee:
        conn.close()
        return jsonify({"message": "Karyawan tidak ditemukan di Recycle Bin"}), 404

    log_count = conn.execute(
        "SELECT COUNT(*) FROM attendance_logs WHERE employee_id = ?", (normalized,)
    ).fetchone()[0]
    if log_count:
        conn.close()
        return jsonify(
            {
                "message": "Karyawan masih memiliki riwayat presensi. Hapus riwayat terkait sebelum penghapusan permanen."
            }
        ), 409

    conn.execute("DELETE FROM employees WHERE id = ?", (normalized,))
    conn.commit()
    conn.close()
    delete_private_media(employee["photo"])
    return jsonify({"message": f"Karyawan {normalized} dihapus permanen"})


@app.get("/api/settings")
@admin_required
def get_settings():
    conn = get_db_connection()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    return jsonify({row["key"]: row["value"] for row in rows})



def csv_safe_cell(value: object) -> str:
    text = str(value if value is not None else "")
    if text.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + text
    return text

def valid_hhmm(value: str) -> bool:
    try:
        datetime.strptime(value, "%H:%M")
        return True
    except (TypeError, ValueError):
        return False


@app.post("/api/settings")
@admin_required
@csrf_required
def save_settings():
    data = json_body()
    updates: dict[str, str] = {}
    for key, value in data.items():
        if key not in ALLOWED_SETTING_KEYS:
            continue
        text_value = str(value).strip()
        if key in {"checkin_start", "checkin_end", "checkout_start", "checkout_end"}:
            if not valid_hhmm(text_value):
                return jsonify({"message": f"Format waktu {key} tidak valid"}), 400
        elif key in {"office_lat", "office_lng"}:
            try:
                number = float(text_value)
            except ValueError:
                return jsonify({"message": f"Nilai {key} tidak valid"}), 400
            if key == "office_lat" and not -90 <= number <= 90:
                return jsonify({"message": "Latitude harus -90 sampai 90"}), 400
            if key == "office_lng" and not -180 <= number <= 180:
                return jsonify({"message": "Longitude harus -180 sampai 180"}), 400
        elif key == "office_radius":
            try:
                radius = float(text_value)
            except ValueError:
                return jsonify({"message": "Radius kantor tidak valid"}), 400
            if not 10 <= radius <= 10_000:
                return jsonify({"message": "Radius kantor harus 10–10.000 meter"}), 400
        updates[key] = text_value

    if not updates:
        return jsonify({"message": "Tidak ada pengaturan valid yang dikirim"}), 400

    conn = get_db_connection()
    conn.executemany(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        updates.items(),
    )
    conn.commit()
    conn.close()
    return jsonify({"message": "Pengaturan berhasil disimpan"})


@app.get("/api/export-csv")
@admin_required
def export_csv():
    conn = get_db_connection()
    rows = conn.execute(
        """
        SELECT log_id, employee_id, name, role, date_formatted, time_formatted,
               type, status, method
        FROM attendance_logs
        ORDER BY timestamp DESC
        """
    ).fetchall()
    conn.close()

    output_stream = io.StringIO()
    writer = csv.writer(output_stream)
    writer.writerow(
        [
            "ID Transaksi",
            "ID Karyawan",
            "Nama Karyawan",
            "Jabatan/Divisi",
            "Tanggal",
            "Waktu",
            "Tipe Absensi",
            "Status",
            "Metode Verifikasi",
        ]
    )
    for row in rows:
        writer.writerow([csv_safe_cell(value) for value in row])

    response = make_response("\ufeff" + output_stream.getvalue())
    response.headers["Content-Disposition"] = (
        f"attachment; filename=riwayat_absensi_faceid_{now_local().strftime('%Y-%m-%d')}.csv"
    )
    response.headers["Content-Type"] = "text/csv; charset=utf-8"
    return response


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8085"))
    debug = os.getenv("FLASK_DEBUG", "false").lower() == "true" and not IS_PRODUCTION
    app.run(host="0.0.0.0", port=port, debug=debug)
