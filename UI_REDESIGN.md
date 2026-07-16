# Absen.io Workforce — UI Redesign v2.0

Antarmuka project telah diperbarui menjadi desain enterprise SaaS tanpa mengubah struktur utama aplikasi atau endpoint backend.

## Perubahan utama

- Navigasi sidebar yang lebih terstruktur untuk operasional dan administrasi.
- Dashboard baru dengan hero section, metrik utama, aktivitas terbaru, dan akses cepat.
- Registrasi wajah menggunakan alur bertahap: identitas, pemindaian, dan verifikasi.
- Terminal presensi dengan pemilihan check-in/check-out yang lebih jelas.
- Halaman riwayat dan admin menggunakan toolbar serta tabel enterprise.
- Login admin dipindahkan dari prompt browser ke modal autentikasi.
- Menu sesi admin dengan status login dan tombol logout.
- Toast notification menggantikan sebagian besar alert browser.
- Dukungan tema terang dan gelap.
- Navigasi mobile dengan sidebar drawer.
- Peningkatan aksesibilitas: label, fokus keyboard, skip link, dan reduced motion.
- Design tokens terpusat untuk warna, radius, shadow, spacing, dan typography.

## File yang diperbarui

- `templates/index.html`
- `static/style.css`
- `static/app.js`

## Kompatibilitas

Seluruh ID elemen yang digunakan oleh proses kamera, face recognition, statistik, riwayat, registrasi, dan admin tetap dipertahankan. Struktur folder utama tidak diubah.
