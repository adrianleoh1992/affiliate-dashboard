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

Pustaka PapaParse, Chart.js, jsPDF, dan AutoTable tersedia di `vendor/`; halaman aplikasi tidak
meminta skrip, font, atau data dari pihak ketiga. `index-daily.html` mengarah ke
halaman utama yang sudah memuat fitur harian. `legacy-v1.html` disimpan sebagai
arsip pembanding dan tidak disertakan dalam build produksi. Pustaka dan font PDF
baru dimuat saat membuat PDF agar pembukaan dashboard tetap ringan.

## Alur penggunaan

1. Pilih atau buat akun di bagian atas. CSV tidak menjamin identitas akun,
   sehingga konteks akun harus dipilih dengan benar.
2. Unggah CSV laporan komisi affiliate, laporan Meta Ads **per hari**, dan
   laporan klik. Baca hasil pemeriksaan per file. Jika hanya sebagian baris valid,
   perbaiki CSV atau pilih **Muat baris valid saja** secara eksplisit. Laporan
   affiliate diperlukan untuk analisis keputusan.
3. Periksa rentang tanggal, kelengkapan laporan, PPN sesuai tagihan, dan mapping.
   PPN awal di antarmuka adalah 0%; pilihan dan ambang disimpan per akun.
4. Tinjau rencana simpan, lalu tekan **Simpan** untuk memasukkan agregat ke
   riwayat harian. Unggahan saja belum menyimpan transaksi ke IndexedDB.
5. Gunakan **Simpan Snapshot** untuk menyimpan hasil analisis periode terpilih.
6. Setelah reload, buka **Data Tersimpan** untuk riwayat harian atau **Snapshot**
   untuk snapshot. Tidak perlu mengunggah CSV kembali untuk membuka keduanya.

File identik yang berganti nama dan baris identik dari beberapa file disaring.
File berbeda dengan nama dan ukuran sama tetap dapat dibaca. File CSV rusak
atau tidak dikenali ditolak. Menghapus file dari layar menghitung ulang dari
file yang tersisa; data harian yang telah disimpan dikelola terpisah.

CSV UTF-8 dan UTF-16 dengan BOM, pemisah koma/titik koma/tab, angka lokal, serta
teks berkutip lintas baris didukung. Ukuran maksimum 75 MiB per CSV; file Excel
harus diekspor sebagai CSV terlebih dahulu. Laporan Meta yang merangkum beberapa
hari dalam satu baris ditolak karena tidak dapat menghasilkan riwayat harian
yang benar. Kesalahan angka, tanggal, atau kolom ditampilkan dengan rincian
yang dapat diunduh. Tombol batal menghentikan batch yang sedang dibaca.

Kolom pengembalian dana kosong dan penanda `--` pada waktu selesai opsional
dikenali sebagai nilai yang belum tersedia pada ekspor Shopee; keduanya tidak
menolak pesanan yang valid. Komisi wajib, biaya iklan, dan tanggal utama tetap
harus valid. Catatan berulang diringkas per jenis/kolom dengan jumlah kejadian
dan contoh baris, sementara kesalahan selalu ditampilkan lebih dahulu.

Rentang tanggal pilihan sendiri dipertahankan saat menambah file; pilihan
semua tanggal mengikuti cakupan data terbaru. Pencarian tag dan filter keputusan
membantu mempersempit tabel. Tombol metrik menampilkan kolom tambahan.

## Ekspor analisis dan PDF

Klik **Ekspor data**, lalu pilih format dan isi laporan:

- **CSV:** keputusan tag, rincian iklan, kinerja harian, atau pencocokan nama.
  Untuk tag, pilih semua tag atau hasil pencarian/filter yang sedang terlihat.
  Setiap baris menyertakan akun dan periode; angka mempertahankan presisinya,
  dan teks sumber yang dapat menjadi formula spreadsheet dinetralkan.
- **JSON:** seluruh hasil analisis, parameter, dan catatan kualitas data dalam
  format `affiliate-analysis` versi 1. JSON analisis bukan backup yang dapat
  dipulihkan ke penyimpanan harian.
- **PDF:** klik **PDF**, isi judul, lalu unduh Ringkas, Standar, atau Lengkap.
  Semua mode dimulai dengan angka utama, grafik tren biaya/komisi, peta keputusan,
  diagram pembentukan laba, dan perbandingan enam tag dengan biaya terbesar.
  Tabel keputusan tetap menyertakan seluruh tag pada periode analisis; filter
  dashboard tidak mengurangi PDF. Standar menambahkan metrik tag, iklan, dan
  harian. Lengkap menambahkan alasan keputusan, pencocokan, status, produk,
  dan rincian lain yang tersedia pada hasil.

Grafik dan tabel harian memakai komisi efektif yang sama dengan ringkasan.
Tanggal tanpa baris sumber menjadi celah grafik dan tanda `-` pada tabel;
nilainya tidak diasumsikan nol. Catatan cakupan menjelaskan bahwa laba total
memakai seluruh data yang tersedia saat rentang sumber berbeda.

PDF dibuat lokal dengan grafik vektor yang tetap tajam saat diperbesar dan teks
yang dapat dipilih. Format A4 memakai header tabel berulang dan nomor halaman.
Tabel menampilkan nilai Rupiah hingga dua desimal; grafik memakai skala ribu/juta
sesuai nilai dan mencantumkan satuannya. Banyak halaman mengikuti
jumlah data. Produk/toko yang sudah dibatasi mesin analisis diberi keterangan
cakupan ringkasan. Font Noto Sans Latin disertakan lokal; karakter di luar
cakupannya, misalnya emoji atau sebagian aksara Asia, ditulis sebagai `[U+XXXX]`
dengan catatan agar identitas label tidak hilang. Data Unicode asli tetap ada
pada CSV/JSON. **Cetak lewat browser** tersedia sebagai alternatif.

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

Snapshot dapat diekspor dan diimpor dalam JSON. Di **Data Tersimpan**, gunakan
**Unduh backup** untuk mencadangkan agregat, fingerprint, identitas order yang
di-hash, dan log unggahan. **Pulihkan backup** memvalidasi isi dan menampilkan
akun asal, tujuan, serta cakupan sebelum tombol penggantian dapat dijalankan.
Pemulihan mengganti seluruh riwayat harian akun aktif dalam satu transaksi;
akun lain tidak berubah. Parameter backup hanya referensi, bukan pengganti
pengaturan analisis saat ini. Snapshot dan mapping mempunyai penyimpanan terpisah.

Backup baru memakai `affiliate-daily-backup` versi 1, maksimum 50 MiB. Backup
lama yang tidak lengkap ditolak dengan penjelasan, bukan dipulihkan sebagian.
Rincian tersedia di [DAILY-STORE.md](DAILY-STORE.md). Menghapus penyimpanan browser
tetap menghapus data lokal, sehingga simpan CSV sumber dan backup Anda.

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
fake-indexeddb, validasi impor/ekspor, pengujian alur browser Chromium dengan
server sementara, serta PDF dengan fixture hingga 100 tag.
Semua fixture sintetis; tidak membaca folder Downloads atau data klien.
Playwright memakai browser terpasangnya, atau Chrome lokal yang ditemukan.
Gunakan `CHROME_PATH` untuk menentukan executable khusus.

File uji lama (`browser.test.js`, `daily-agg.test.js`, `daily-store.test.js`,
`daily-ui.test.js`, `daily-parity.test.js`) mengarah ke suite regresi portabel.
Untuk memeriksa laporan Anda sendiri secara eksplisit:

```bash
node verify.js /path/affiliate.csv /path/ads.csv /path/clicks.csv
```

Verifikasi tersebut memakai pembaca CSV yang sama dengan dashboard dan berhenti
jika ada baris ditolak, sehingga pemeriksaan mesin tidak melewati validasi impor.

Pengujian sintetis membuktikan kasus yang dicakup; tidak menjamin semua variasi
format ekspor dan kondisi browser telah tercakup.

## Struktur dan deployment

| File | Fungsi |
|---|---|
| `engine.js` | Mesin hitung murni untuk browser dan Node |
| `import-pipeline.js` | Deteksi format, normalisasi, dan diagnostik CSV |
| `export-data.js` | CSV/JSON analisis dan sanitasi nama file |
| `pdf-export.js` | Susunan laporan visual PDF dan tabel multi halaman |
| `pdf-charts.js` | Grafik tren, perbandingan tag, dan peta keputusan vektor |
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
Font PDF terkemas pada `vendor/pdf-font.js` (Noto Sans Regular/Bold), dengan
lisensi OFL pada `vendor/NotoSans-LICENSE.txt`; script vendor tidak mengganti font.

Laporan audit awal ada di [AUDIT.md](AUDIT.md), dan perbaikan alur/ekspor terbaru
beserta batasannya ada di [EXPERIENCE.md](EXPERIENCE.md).

CSV dan spreadsheet diabaikan Git. Tidak ada backend, analytics, pengiriman
laporan, atau sinkronisasi cloud.
