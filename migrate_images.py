"""Migrasi foto base64 lama ke penyimpanan privat.

Aplikasi utama sudah memigrasikan file lama dari static/uploads secara otomatis.
Script ini hanya diperlukan jika database versi sangat lama masih menyimpan gambar
langsung sebagai data URI base64.
"""

from app import PROFILE_DIR, SNAPSHOT_DIR, get_db_connection, save_data_image


def migrate() -> None:
    conn = get_db_connection()
    migrated_profiles = 0
    migrated_snapshots = 0

    try:
        employees = conn.execute("SELECT id, photo FROM employees").fetchall()
        for employee in employees:
            photo = employee["photo"] or ""
            if photo.startswith("data:image"):
                filename = save_data_image(photo, PROFILE_DIR, "profile")
                conn.execute(
                    "UPDATE employees SET photo = ? WHERE id = ?",
                    (f"/api/media/profiles/{filename}", employee["id"]),
                )
                migrated_profiles += 1

        logs = conn.execute(
            "SELECT id, snapshot_photo FROM attendance_logs WHERE snapshot_photo IS NOT NULL"
        ).fetchall()
        for log in logs:
            photo = log["snapshot_photo"] or ""
            if photo.startswith("data:image"):
                filename = save_data_image(photo, SNAPSHOT_DIR, "attendance")
                conn.execute(
                    "UPDATE attendance_logs SET snapshot_photo = ? WHERE id = ?",
                    (f"/api/media/snapshots/{filename}", log["id"]),
                )
                migrated_snapshots += 1

        conn.commit()
    finally:
        conn.close()

    print(
        f"Migrasi selesai: {migrated_profiles} foto profil dan "
        f"{migrated_snapshots} snapshot dipindahkan."
    )


if __name__ == "__main__":
    migrate()
