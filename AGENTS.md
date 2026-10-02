# Panduan kontribusi

## Cakupan dan titik masuk

- Ini aplikasi statis lokal. Mulai dari `README.md`, `package.json`, dan
  `index.html`; detail transaksi harian ada di `DAILY-STORE.md`.
- Gunakan `main` sebagai dasar perilaku yang sudah tersedia. Periksa diff PR
  sebelum menyebut fitur usulan sebagai fitur aplikasi. Jangan mengubah branch
  atau PR lain sebagai bagian dari pekerjaan dokumentasi.
- `index-daily.html` mengarahkan ke halaman utama. `legacy-v1.html` adalah arsip
  pembanding dan tidak masuk build produksi.
- Pembagian tugas dengan repo publik `affiliate-harian` ada di README.
  Jangan menganggap format database atau backup kedua repo saling kompatibel.

## Perintah yang tersedia

Node.js 22 dipakai CI; Node.js 22 atau lebih baru disarankan. Jalankan dari root
repo. Dependensi dipasang lokal memakai lockfile, tanpa instalasi global.

```bash
npm ci
npm start
```

`npm start` membangun `dist/` lalu melayani `http://127.0.0.1:8899`.
`dist/` adalah hasil generasi dan dibangun ulang oleh script.

```bash
npm run test:unit
npm run test:browser
npm run test:pdf
npm test
npm run build
```

- `test:unit`: mesin hitung, regresi harian, impor, dan ekspor.
- `test:browser`: regresi Chromium dan alur pengalaman pengguna.
- `test:pdf`: grafik serta ekspor PDF. `npm test` menjalankan ketiga kelompok.
- Fixture suite utama sintetis. Browser test mencari Chromium Playwright atau
  Chrome lokal; `CHROME_PATH` dapat menunjuk executable yang sudah tersedia.
  Jika belum ada browser, gunakan `npx playwright install chromium`; CI Linux
  memakai `npx playwright install --with-deps chromium`.
- `npm run build` menyalin aset yang diizinkan ke `dist/`. Jangan mengedit
  hasil build; perbaiki berkas sumbernya.
- `npm run vendor` menyalin pustaka dari dependensi ke `vendor/`. Jalankan hanya
  ketika memperbarui dependensi, bukan untuk perubahan dokumentasi.

Untuk dokumentasi, periksa tautan relatif/anchor dan `git diff --check`, serta
pastikan perintah yang ditulis cocok dengan `package.json` dan sumbernya.
Jalankan suite terkait bila mengubah perilaku; CI menjalankan `npm test` dan
`npm run build` sesuai `.github/workflows/test.yml`.

## Data dan batas perubahan

- Repo ini publik. Jangan commit CSV asli, laporan iklan/komisi, backup JSON,
  snapshot pelanggan, kredensial, token, atau aset privat; jangan menulis nama
  repo privat maupun isinya ke dokumentasi publik.
- Jangan mencari laporan pada Downloads atau folder pribadi. `verify.js`
  hanya boleh membaca tiga path CSV yang secara eksplisit diberikan untuk
  tugas tersebut; hasilnya juga dapat memuat data sensitif. Script itu memakai
  mapping dan PPN contoh di dalam sumber, bukan pengaturan browser aktif.
- Pertahankan perubahan pengguna, media, lisensi, dan branch/PR yang sudah ada.
  Jangan menetapkan lisensi dari metadata paket atau usulan PR lama.
- Jangan menambah backend, telemetry, atau permintaan jaringan runtime sebagai
  efek samping perapihan dokumentasi. Riwayat harian, snapshot, dan mapping
  mempunyai tempat penyimpanan berbeda; hindari instruksi yang menghapus data
  tanpa menjelaskan cakupan dan backup.
