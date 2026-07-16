# Deployment FaceID Absensi

## 1. Siapkan environment

Salin konfigurasi contoh:

```bash
cp .env.example .env
```

Buat secret acak:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Buat hash password admin:

```bash
python -c "from werkzeug.security import generate_password_hash; print(generate_password_hash('GANTI_DENGAN_PASSWORD_KUAT'))"
```

Masukkan hasilnya ke `SECRET_KEY` dan `ADMIN_PASSWORD_HASH` pada `.env`.
Jangan unggah `.env` ke GitHub.

## 2. Jalankan tanpa Docker

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
set -a && source .env && set +a
gunicorn --bind 0.0.0.0:${PORT:-8080} --workers 1 --threads 4 --timeout 120 app:app
```

Di Windows PowerShell, isi environment melalui panel hosting atau jalankan dalam mode development menggunakan `.env` dan `python app.py`.

## 3. Jalankan dengan Docker

```bash
docker build -t face-absensi .
docker run --rm -p 8080:8080 --env-file .env \
  -v face_absensi_data:/app/instance \
  face-absensi
```

Gunakan HTTPS pada domain deployment karena akses kamera browser memerlukan secure context.

## 4. Persistent storage

Aplikasi masih menggunakan SQLite. Gunakan satu worker Gunicorn dan pasang volume persistent untuk:

- file database melalui `DATABASE_PATH`;
- foto privat melalui `UPLOAD_ROOT`.

Contoh:

```env
DATABASE_PATH=/data/database.db
UPLOAD_ROOT=/data/uploads
WEB_CONCURRENCY=1
```

Untuk banyak instance atau beban tinggi, migrasikan database ke PostgreSQL dan gambar ke object storage private.

## 5. Health check

Gunakan endpoint:

```text
GET /health
```

Respons normal:

```json
{"status":"ok","database":"connected"}
```

## 6. Pemeriksaan sebelum go-live

- `APP_ENV=production`
- `SIMULATION_ENABLED=false`
- HTTPS aktif
- `SECRET_KEY` dan password admin tidak memakai nilai contoh
- database dan upload memakai persistent volume
- backup database terjadwal
- hanya satu worker selama masih menggunakan SQLite

## Perbaikan Login Admin

Paket ini membawa `.env` khusus pengujian lokal dengan password awal `AdminFace2026!`. File tersebut membuat login dapat langsung diuji tanpa menyalin `.env.example` secara manual.

Sebelum deployment publik:

1. Jalankan `python reset_admin_password.py` untuk membuat hash password baru.
2. Salin nilai konfigurasi yang dibutuhkan ke Environment Variables platform hosting.
3. Gunakan `.env.production.example` sebagai acuan.
4. Jangan commit atau mengunggah `.env` ke repository publik.
5. Restart atau redeploy aplikasi setelah environment diubah.
