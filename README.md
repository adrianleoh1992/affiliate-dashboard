# Affiliate Decision Dashboard

Dashboard lokal untuk menggabungkan laporan komisi Shopee Affiliate, Meta Ads,
dan klik Shopee. Menghitung laba, ROAS, keputusan per tag, kebocoran klik,
dan riwayat harian per akun. Semua pemrosesan dan penyimpanan berada di browser.

## Menjalankan

Buka `index.html` langsung, atau gunakan server lokal agar origin penyimpanan konsisten:

```bash
npm ci
npm start
# http://127.0.0.1:8899
```

Pustaka PapaParse dan Chart.js tersedia di `vendor/`; halaman aplikasi tidak
meminta skrip, font, atau data dari pihak ketiga. `index-daily.html` mengarah ke
halaman utama yang sudah memuat fitur harian. `legacy-v1.html` disimpan sebagai
arsip pembanding dan tidak disertakan dalam build produksi.

## Alur penggunaan

1. Pilih atau buat akun di bagian atas. CSV tidak menjamin identitas akun,
   sehingga konteks akun harus dipilih dengan benar.
2. Unggah CSV laporan komisi affiliate, laporan Meta Ads **per hari**, dan
   laporan klik. Laporan affiliate diperlukan untuk analisis keputusan.
3. Periksa rentang tanggal, kelengkapan laporan, PPN sesuai tagihan, dan mapping.
   PPN awal di antarmuka adalah 0%; pilihan dan ambang disimpan per akun.
4. Tinjau rencana simpan, lalu tekan **Simpan** untuk memasukkan agregat ke
   riwayat harian. Unggahan saja belum menyimpan transaksi ke IndexedDB.
5. Gunakan **Simpan Snapshot** untuk menyimpan hasil analisis periode terpilih.
6. Setelah reload, buka **Data Tersimpan** untuk riwayat harian atau **Riwayat**
   untuk snapshot. Tidak perlu mengunggah CSV kembali untuk membuka keduanya.

File identik yang berganti nama dan baris identik dari beberapa file disaring.
File berbeda dengan nama dan ukuran sama tetap dapat dibaca. File CSV rusak
atau tidak dikenali ditolak. Menghapus file dari layar menghitung ulang dari
file yang tersisa; data harian yang telah disimpan dikelola terpisah.

## Arti angka dan keputusan

- **Komisi efektif:** komisi selesai ditambah komisi tertunda dikalikan bobot
  tertunda. Status dibatalkan dan belum dibayar dikecualikan. Kolom komisi per
  produk didahulukan bila ada; kolom alternatif digunakan bila diperlukan.
- **Biaya:** biaya Meta ditambah PPN satu kali. ROAS adalah komisi efektif
  dibagi biaya; ROAS berbayar memisahkan komisi tag organik.
- **Keputusan:** Scale, Pantau, Stop, Organik, atau Belum cukup data. Untuk tag
  berbayar, keputusan menggunakan biaya, komisi, dan hari produksi yang sudah
  matang menurut lag atribusi. Kolom utama tetap menunjukkan total periode;
  alasan keputusan menyebut dasar yang matang.
- **Lag dan order:** distribusi lag dan penyelesaian menghitung order unik,
  bukan jumlah baris produk. Rekomendasi H+0 tetap dapat bernilai nol.
- **Mapping:** mapping manual nama iklan yang dinormalisasi didahulukan.
  Kecocokan lemah ditampilkan sebagai saran dan memerlukan mapping manual;
  komisinya tidak otomatis digabung ke kandidat tersebut.
- **Klik:** perbandingan Meta dan Shopee menggunakan cakupan tanggal laporan
  klik. Data klik yang belum lengkap membatasi diagnosis kebocoran.
- **Kandidat organik:** Maks Biaya/Order merupakan batas biaya per pesanan
  berdasarkan komisi efektif dan target ROI. Angka ini bukan batas CPC;
  CPC memerlukan estimasi konversi klik menjadi pesanan.
- **Perkembangan:** periode dengan tanggal awal berbeda tetap terpisah,
  meskipun tanggal akhirnya sama. Perubahan tag membandingkan dua snapshot
  periode terbaru.

## Data revisi dan pemulihan

Deduplikasi memakai seluruh isi baris. Baris yang status, komisi, atau metriknya
berubah bukan baris identik. Ekspor tidak selalu menyediakan ID unik per item,
sehingga aplikasi tidak dapat memastikan apakah perubahan itu koreksi atau
transaksi lain yang sah.

Untuk laporan **koreksi**, hapus file lama dari analisis. Pada **Data Tersimpan**,
hapus tanggal terdampak untuk jenis laporan yang bersangkutan, lalu unggah dan
simpan kembali laporan lengkap yang benar untuk tanggal tersebut. Jangan
menambahkan laporan koreksi ke total lama. Penghapusan per hari membersihkan
penanda deduplikasi yang diperlukan agar unggah ulang dapat memulihkan hari itu.

Database versi lama tetap dipertahankan. Agregat lama yang tidak memiliki
identitas order untuk penggabungan aman akan menolak tambahan yang bertumpang
tindih dan memberikan petunjuk hapus tanggal lalu impor ulang. Aplikasi tidak
mencoba merekonstruksi angka lama yang mungkin sudah salah.

Snapshot dapat diekspor dan diimpor dalam JSON. Impor divalidasi sebelum
mengubah riwayat. Ekspor akun harian berisi agregat dan metadata deduplikasi;
impor backup akun harian belum tersedia. Menghapus penyimpanan browser tetap
menghapus data lokal, sehingga simpan CSV sumber dan ekspor cadangan Anda.

## Pengujian

Node.js 22 atau lebih baru disarankan untuk pengembangan.

```bash
npm ci
npx playwright install chromium
npm test
npm run build
npm audit
```

`npm test` menjalankan mesin hitung, regresi penyimpanan menggunakan
fake-indexeddb, dan pengujian browser Chromium dengan server sementara.
Semua fixture sintetis; tidak membaca folder Downloads atau data klien.
Playwright memakai browser terpasangnya, atau Chrome lokal yang ditemukan.
Gunakan `CHROME_PATH` untuk menentukan executable khusus.

File uji lama (`browser.test.js`, `daily-agg.test.js`, `daily-store.test.js`,
`daily-ui.test.js`, `daily-parity.test.js`) mengarah ke suite regresi portabel.
Untuk memeriksa laporan Anda sendiri secara eksplisit:

```bash
node verify.js /path/affiliate.csv /path/ads.csv /path/clicks.csv
```

Pengujian sintetis membuktikan kasus yang dicakup; tidak menjamin semua variasi
format ekspor dan kondisi browser telah tercakup.

## Struktur dan deployment

| File | Fungsi |
|---|---|
| `engine.js` | Mesin hitung murni untuk browser dan Node |
| `app.js`, `index.html`, `styles.css` | Antarmuka, impor, snapshot, grafik, ekspor |
| `daily-agg.js` | Deduplikasi dan agregasi harian |
| `daily-store.js` | Transaksi IndexedDB dan migrasi |
| `daily-layer.js` | Rencana simpan dan tampilan data harian |
| `*.regression.test.js`, `engine.test.js` | Pengujian sintetis otomatis |
| `scripts/build.js` | Menyalin aset aplikasi yang diizinkan ke `dist/` |
| `scripts/vendor.js` | Memperbarui aset lokal dari dependensi terkunci |

Build produksi hanya berisi aset aplikasi. Vercel menggunakan `npm run build`
dan direktori `dist/`; pengujian dan berkas pengembangan tidak ikut dipublikasikan.
Untuk memperbarui pustaka, ubah dependensi, jalankan `npm run vendor`, kemudian
jalankan seluruh pengujian dan commit `package-lock.json` beserta aset vendor.

CSV dan spreadsheet diabaikan Git. Tidak ada backend, analytics, pengiriman
laporan, atau sinkronisasi cloud.
