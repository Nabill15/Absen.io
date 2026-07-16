from __future__ import annotations

from getpass import getpass
from pathlib import Path
import re

from werkzeug.security import generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
ENV_FILE = BASE_DIR / ".env"
MIN_PASSWORD_LENGTH = 12


def update_env_value(text: str, key: str, value: str) -> str:
    pattern = re.compile(rf"(?m)^{re.escape(key)}=.*$")
    replacement = f"{key}={value}"
    if pattern.search(text):
        return pattern.sub(replacement, text)
    if text and not text.endswith("\n"):
        text += "\n"
    return text + replacement + "\n"


def main() -> None:
    print("Reset Password Admin Face Absensi")
    print(f"Password minimal {MIN_PASSWORD_LENGTH} karakter.")

    password = getpass("Password admin baru: ")
    confirmation = getpass("Ulangi password admin baru: ")

    if password != confirmation:
        raise SystemExit("Gagal: kedua password tidak sama.")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise SystemExit(
            f"Gagal: password minimal {MIN_PASSWORD_LENGTH} karakter."
        )

    if ENV_FILE.exists():
        content = ENV_FILE.read_text(encoding="utf-8")
    else:
        example = BASE_DIR / ".env.example"
        content = example.read_text(encoding="utf-8") if example.exists() else ""

    password_hash = generate_password_hash(password)
    content = update_env_value(content, "ADMIN_PASSWORD_HASH", password_hash)
    content = update_env_value(content, "ADMIN_PASSWORD", "")
    ENV_FILE.write_text(content, encoding="utf-8")

    print("Password admin berhasil diperbarui di file .env.")
    print("Hentikan lalu jalankan ulang aplikasi agar perubahan berlaku.")


if __name__ == "__main__":
    main()
