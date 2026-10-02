# Affiliate Decision Dashboard

Dashboard lokal untuk menggabungkan laporan komisi Shopee Affiliate, Meta Ads,
dan klik Shopee. Menghitung laba, ROAS, keputusan per tag, perbandingan klik,
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
3. Periksa rentang tanggal, kesiapan sumber, dan PPN sesuai tagihan. PPN awal
   di antarmuka adalah 0%; pilihan dan ambang disimpan per akun. Tanggal kosong
   dapat dikonfirmasi lengkap jika laporan sumber memang sudah lengkap.
4. Buka **Hubungkan iklan ke tag**, pilih iklan yang belum terhubung, cari tag
   dari laporan komisi/klik, lalu **Simpan pasangan**. Daftar mendahulukan biaya
   terbesar. Pasangan dapat diubah, dihapus, serta diekspor/impor sebagai JSON;
   setiap perubahan disimpan untuk akun aktif.
5. Tinjau rencana simpan, lalu tekan **Simpan** untuk memasukkan agregat ke
   riwayat harian. Unggahan saja belum menyimpan transaksi ke IndexedDB.
6. Gunakan **Simpan Snapshot** untuk menyimpan hasil analisis periode terpilih.
7. Setelah reload, buka **Data Tersimpan** untuk riwayat harian atau **Snapshot**
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
  Semua mode dimulai dengan halaman **Dashboard utama**: Komisi Total, Spend
  Iklan, Laba Bersih, ROAS Total, metrik klik, prioritas anggaran, serta kartu
  Scale/Pantau/Stop/Tanpa biaya Meta. Klik memakai tag dan jendela pembanding yang sama
  dengan dashboard; sumber yang tidak tersedia ditandai `-`.
  Halaman berikutnya berisi grafik tren, peta keputusan, diagram laba, dan
  perbandingan enam tag dengan biaya terbesar. Kandidat uji iklan serta konsentrasi
  anggaran dari dashboard juga disertakan. Ini tata letak PDF dengan teks dan
  grafik vektor, bukan tangkapan layar yang memotong dashboard panjang.
  Tag dengan biaya dan komisi sama-sama nol tidak disertakan dalam grafik,
  tabel, rincian iklan, maupun jumlah tag. Tag organik, tag dengan biaya tanpa
  komisi, dan komisi negatif tetap disertakan. Komisi tertunda yang bobotnya nol
  tetap dianggap komisi. Filter pencarian dashboard tidak mengurangi PDF.
  Standar menambahkan metrik tag, iklan, dan
  harian. Lengkap menambahkan alasan keputusan, pencocokan, status, produk,
  dan rincian lain yang tersedia pada hasil.

Grafik dan tabel harian memakai komisi efektif yang sama dengan ringkasan.
Tanggal tanpa baris sumber menjadi celah grafik dan tanda `-` pada tabel;
nilainya tidak diasumsikan nol. Biaya yang belum lengkap membuat laba dan rasio biaya tidak tersedia;
`null` pada JSON atau tanda `-` pada PDF bukan biaya nol. Laporan menyertakan
alasan penghambat dan dasar keputusan.

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
- **Biaya:** biaya Meta ditambah PPN satu kali. Meta yang belum dimuat atau
  parsial menghasilkan biaya/laba/ROAS yang belum tersedia. Pernyataan eksplisit
  **Tidak menjalankan Meta di periode ini** menetapkan biaya nol hanya untuk
  akun dan periode tersebut. Unggahan biaya yang nyata tetap diperhitungkan.
- **Keputusan:** Scale, Pantau, Stop, Tanpa biaya Meta, atau Perlu diperiksa.
  Keuangan mengikuti tanggal pesanan. Keputusan iklan memakai komisi yang
  dikelompokkan menurut tanggal klik dan hari produksi yang sudah matang.
  **Pesanan diamati sampai** dapat memperpanjang pengamatan dengan laporan
  pesanan berikutnya; tanpa cakupan sumber yang cukup, keputusan tetap ditahan.
  Waktu klik pesanan yang hilang tidak diganti dengan waktu pesanannya.
- **Lag dan order:** distribusi lag dan penyelesaian menghitung order unik,
  bukan jumlah baris produk. Rekomendasi H+0 tetap dapat bernilai nol.
- **Mapping:** identitas memakai Ad ID, lalu nama + tanggal dibuat, lalu nama
  persis. Pasangan manual per identitas didahulukan dari aturan lama berdasarkan
  nama. Lingkupnya ditampilkan di antarmuka. Iklan yang belum jelas pasangannya
  tidak langsung menerima rekomendasi STOP/SCALE. Tag dari laporan klik tetap
  dapat dipilih walaupun belum menghasilkan komisi.
- **Klik:** selisih Meta dan Shopee memakai jendela pembanding yang sama.
  Perbedaan hitungan platform tidak membuktikan klik hilang atau biaya terbuang.
- **Tanpa biaya Meta:** ini bukan bukti organik; trafik juga bisa berasal dari
  promosi Shopee atau sumber lain. Kandidat uji iklan baru ditampilkan setelah
  kesiapan sumber dan pencocokan terpenuhi. Maks Biaya/Order bukan batas CPC.
- **Perkembangan:** periode dengan tanggal awal berbeda tetap terpisah,
  meskipun tanggal akhirnya sama. Perubahan tag membandingkan dua snapshot
  periode terbaru.

## Data revisi dan pemulihan

Deduplikasi memakai seluruh isi baris. Baris yang status, komisi, atau metriknya
berubah bukan baris identik. Ekspor tidak selalu menyediakan ID unik per item,
sehingga aplikasi tidak dapat memastikan apakah perubahan itu koreksi atau
transaksi lain yang sah.

Untuk laporan **koreksi**, hapus file lama dari analisis lalu unggah versi
lengkap yang benar. Pada rencana simpan, pilih **Ganti periode lengkap**, jenis
laporan, dan rentang tanggal. Periksa akun serta total lama → baru pada
pratinjau, lalu konfirmasikan penggantian. Data lama dalam rentang terpilih,
termasuk tag/tanggal yang tidak ada di laporan revisi, diganti secara atomik.
Tanggal di luar rentang dan akun lain tetap utuh. Kegagalan penulisan membatalkan
seluruh penggantian. Mode simpan biasa tetap menambah dan menyaring duplikat.

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
pengaturan analisis saat ini. Snapshot dan mapping mempunyai ekspor/impor terpisah. Konfirmasi cakupan
tersimpan di browser per akun/periode; backup harian tidak memindahkannya.

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
