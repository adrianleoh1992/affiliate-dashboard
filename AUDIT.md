# Audit dan perbaikan Affiliate Dashboard

Tanggal penyelesaian: 6 September 2026.
Sumber: https://github.com/adrianleoh1992/affiliate-dashboard
Baseline: `24e4cf3` pada branch `main` yang dikloning saat audit dimulai.
Branch perbaikan lokal: `fix/audit-correctness-reliability`.

Perbaikan sudah diterapkan pada source lokal dan diverifikasi. Tidak ada push,
pull request, merge, atau deployment ke GitHub/Vercel yang dilakukan.

## Perbaikan utama

| Area | Masalah yang ditemukan | Hasil perbaikan |
|---|---|---|
| PPN | Rincian tertentu mengenakan PPN dua kali | Biaya tag, per hari, dan CPC Shopee mengenakan PPN sekali |
| Keputusan | Biaya hari belum matang masih bisa memicu STOP agregat | Kualifikasi dan keputusan berbayar memakai biaya, komisi efektif, dan hari matang |
| Komisi | Kolom komisi per produk tidak diprioritaskan | Resolusi kolom komisi konsisten dengan agregasi harian |
| Lag atribusi | Rekomendasi H+0 bisa tertimpa; produk dihitung sebagai order | H+0 valid; distribusi lag dan penyelesaian memakai order unik |
| Matching | Fragmen lemah bisa menggabungkan biaya ke tag yang salah | Mapping manual didahulukan; kandidat lemah hanya saran sampai dipetakan |
| Metrik | Status inactive dianggap active; porsi organik tidak konsisten | Status iklan eksplisit dan proporsi berdasarkan komisi efektif |
| Penghematan | Bid saving tag STOP ikut ditambah ke seluruh biaya STOP | Estimasi menghindari penghitungan ulang komponen yang sama |
| Kandidat organik | Batas biaya per order dilabeli CPC | Diganti Maks Biaya/Order, berdasarkan komisi efektif dan target ROI |
| Tren | Periode berbeda dengan tanggal akhir sama hilang; perubahan memakai awal-ke-akhir | Periode lengkap dibedakan dan perubahan tag membandingkan dua periode terakhir |
| Input | Angka lokal, tanggal tidak valid, key objek khusus berpotensi salah/crash | Parsing dan validasi defensif, dictionary aman untuk nama sumber |
| Upload | Deduplikasi hanya nama/ukuran; overlap menggandakan angka | Baris identik disaring berdasarkan isi; nama/ukuran sama tidak menolak file berbeda |
| Upload asinkron | Callback lama dapat mengisi akun baru atau menghidupkan data yang di-reset | Antrean impor dan pemeriksaan akun/versi state sebelum menerapkan hasil |
| Snapshot | JSON tak tervalidasi disimpan dan dirender sebagai HTML | Validasi sebelum simpan, escaping, deduplikasi ID, dan pembatalan impor tertunda |
| Ekspor | Isi tag dapat menjadi formula spreadsheet | Ekspor CSV menetralisasi awalan formula pada teks |
| State UI | Pengaturan bocor antar akun; hasil lama tersisa setelah file dihapus | Default/pengaturan per akun dimuat ulang; hasil dan tanggal invalid dibersihkan |
| Urutan tabel | Urutan angka berlawanan dengan indikator | Default biaya tertinggi berada di atas; arah pengurutan konsisten |
| Riwayat harian | Total lama ditimpa agregat sebagian dari baris baru | Kontribusi unik digabung secara transaksional dengan union identitas order |
| Simpan paralel | Rencana lama/dua tab berisiko menggandakan data | Deduplikasi diperiksa kembali dalam transaksi yang sama dengan data dan log |
| Hapus tanggal | Fingerprint lama menghalangi pemulihan lewat unggah ulang | Penanda tanggal/file yang relevan dibersihkan, hari lainnya tetap terlindungi |
| Migrasi | Agregat lama tidak cukup untuk penggabungan order yang aman | Data lama dipertahankan; overlap yang tidak aman ditolak dengan petunjuk pemulihan |
| Akses riwayat | Data harian tidak bisa dibuka setelah reload tanpa CSV | Tombol Data Tersimpan tersedia di header tanpa memerlukan hasil analisis |
| Tampilan | Grid grafik meluber pada 320px | Lebar grid/canvas menyesuaikan viewport; 320px dan 390px diuji |
| Cetak | Timer dapat memulihkan layout sebelum preview selesai | Pemulihan memakai peristiwa print/focus dan bersifat idempoten |
| Dependensi | Runtime membutuhkan CDN/font eksternal | PapaParse dan Chart.js dikemas lokal dengan lisensi dan versi terkunci |
| Pengujian | npm test gagal dan skrip bergantung pada Downloads pribadi | Suite sintetis portabel, server uji otomatis, fixture database terisolasi, dan CI |
| Build | Root repository menjadi output publik | Build dist hanya memuat aset aplikasi yang diizinkan dan membersihkan output lama |

## Optimasi yang diukur

Benchmark membandingkan baseline dan perbaikan pada fixture sintetis berisi
10.000 baris. Lima putaran warmup, lalu median 21 pengukuran dengan urutan mesin
bergantian. Total biaya, komisi, klik, dan order diperiksa tetap sama untuk
fixture benchmark ini.

| Jumlah tag | Baseline | Perbaikan | Pengurangan waktu |
|---|---:|---:|---:|
| 100 | 22,86 ms | 17,65 ms | 22,8% |
| 500 | 56,15 ms | 24,49 ms | 56,4% |

Perbaikan meliputi cache matching, parsing angka cepat, cache validasi tanggal
terbatas, penggunaan ulang hasil stability saat render tanpa perubahan data,
dan penambahan file tanpa membangun ulang seluruh dataset setiap kali.
Angka benchmark bukan jaminan untuk setiap CSV atau seluruh waktu render UI.

Ulangi di checkout Git yang memiliki baseline:

```bash
node scripts/benchmark-engine.js 24e4cf3
```

## Hasil verifikasi

- `npm ci`: berhasil memakai lockfile.
- `npm test`: berhasil — suite engine asli, regresi engine, 20/20 regresi harian,
  dan 25/25 regresi browser.
- `npm run build`: berhasil.
- `npm audit`: 0 kerentanan yang dilaporkan pada dependensi terpasang.
- `git diff --check`: bersih.
- Peluncuran langsung `file://` dan pembukaan Data Tersimpan: berhasil di Chromium.
- Pemeriksaan output produksi: tidak menyertakan test, package metadata, README,
  atau halaman legacy.
- Uji browser menolak setiap permintaan eksternal, menguji kedua entry point,
  menguji viewport 320px/390px, dan memeriksa error JavaScript.
- Screenshot data sintetis ditinjau pada desktop dan mobile.
- Review akhir terpisah atas migrasi, transaksi, isolasi akun, dan batas impor
  tidak menemukan regresi blocking.

## Batasan dan tindakan untuk data lama

1. **Revisi laporan:** perubahan status/komisi/angka bukan duplikat identik.
   Ekspor tidak selalu memiliki ID unik per item; aplikasi tidak menebak baris
   mana yang merupakan koreksi. Hapus file lama dari analisis. Di Data Tersimpan,
   hapus tanggal terdampak untuk jenis laporan itu, lalu unggah dan simpan laporan
   lengkap yang benar. Peringatan overlap ditampilkan sebelum simpan.
2. **Agregat versi lama:** tidak dibuang otomatis. Overlap tanpa identitas order
   yang cukup akan ditolak; pemulihannya menggunakan hapus tanggal dan impor ulang.
   Total salah yang sudah tersimpan sebelum perbaikan tidak dapat direkonstruksi
   hanya dari agregat.
3. **Format sumber:** diuji dengan fixture sintetis yang mencakup bug di atas.
   Laporan Meta harus diekspor per hari. Belum menguji setiap variasi ekspor,
   browser Safari/Firefox, atau data produksi pengguna.
4. **Penyimpanan:** tetap lokal per origin browser. Ekspor/impor snapshot tersedia;
   ekspor backup akun harian tersedia, tetapi impor backup harian belum tersedia.
5. Audit ini memperbaiki bug yang ditemukan dan diuji, bukan jaminan bahwa seluruh
   kemungkinan bug di aplikasi telah hilang.

## Menggunakan hasil

`affiliate-dashboard-fixed.zip` berisi source lengkap dan aset vendor. Ekstrak,
buka `affiliate-dashboard/index.html`, atau jalankan `npm ci` lalu `npm start`
untuk origin server yang konsisten. Detail alur tersedia di README.

`audit-fixes.patch` adalah commit patch dari baseline. Terapkan di clone repository:

```bash
git switch -c fix/audit-correctness-reliability 24e4cf3
git am /path/audit-fixes.patch
npm ci
npx playwright install chromium
npm test
```

Pada branch yang telah berubah dari baseline, tinjau konflik sebelum menggabungkan.
