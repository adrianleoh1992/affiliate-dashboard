# Penyimpanan harian

Fitur harian sudah terintegrasi di `index.html`. Bookmark `index-daily.html`
akan mengarah ke sana. **Data Tersimpan** di header tetap dapat dibuka setelah
reload tanpa mengunggah ulang laporan affiliate.

## Yang disimpan

- Akun yang dipilih pengguna.
- Agregat per `(akun, tanggal, tag)` untuk affiliate dan klik. Agregat komisi
  menyimpan rincian per pesanan (`order_parts`, kunci hash ID Pemesanan).
- Agregat per `(akun, tanggal, Ad ID)` untuk Meta Ads, atau per nama iklan bila
  baris tidak membawa Ad ID (`ad_key` = `id:<Ad ID>` atau `name:<nama iklan>`).
- Fingerprint baris dengan tanggal dan jenis laporan (hanya untuk klik dan iklan
  tanpa Ad ID), fingerprint file, serta log unggahan.

CSV mentah, nama produk, toko, dan ID order mentah tidak dipersistenkan oleh
alur simpan harian. Data berada di IndexedDB pada origin browser yang sama.

## Jaminan penggabungan

Rencana simpan hanya merupakan pratinjau. Transaksi penulisan memeriksa ulang
file dan fingerprint baris agar dua tab atau dua proses simpan dengan rencana
lama tidak menambahkan baris yang sama. Aturan gabung (`merge_version`):

- **2, mengganti:** komisi per pesanan dan iklan dengan Ad ID. Pesanan yang ada
  di file mengganti rincian pesanan yang sama; pesanan lain tetap. Total harian
  dihitung ulang dari rincian dengan urutan kunci yang tetap, sehingga browser
  dan database bersama menghasilkan angka yang identik.
- **1, menambah:** klik dan iklan tanpa Ad ID. Baris yang belum dikenal
  ditambahkan ke agregat lama; baris identik dilewati lewat fingerprint.

Iklan yang sama pada tanggal yang sama tidak boleh tersimpan dengan nama dan
dengan Ad ID sekaligus; penyimpanan itu ditolak agar tidak terhitung dua kali.
Riwayat komisi lama (format 1, union hash order) dikonversi ke format 2 hanya
bila file baru memuat semua pesanan hari itu untuk tag tersebut; file sebagian
ditolak dengan petunjuk hapus tanggal lalu unggah ulang.

Menghapus satu tanggal membersihkan penanda baris tanggal itu dan membatalkan
penanda file yang relevan. Unggah ulang laporan yang mencakup beberapa hari
mengembalikan hari terhapus, sementara hari lainnya tetap terdeduplikasi.
Penghapusan akun membersihkan data, penanda deduplikasi, dan log terkait.

## Laporan koreksi

Laporan komisi yang direvisi dan tarikan ulang iklan dengan Ad ID mengganti
angka lama secara otomatis. File revisi komisi harus memuat semua baris produk
dari setiap pesanan yang dimuatnya. Pesanan yang hilang dari laporan revisi
tidak dihapus otomatis.

Untuk klik dan ekspor iklan tanpa Ad ID, hash seluruh baris hanya mengenali
duplikat identik, bukan revisi nilai. Untuk koreksi jenis itu, hapus tanggal
terdampak per jenis laporan, lalu simpan ulang laporan lengkap yang benar. Hapus juga file lama dari analisis sebelum
mengunggah file koreksi.

Migrasi mempertahankan agregat lama. Penggabungan bertumpang tindih yang
membutuhkan identitas order tetapi tidak memilikinya ditolak dengan pesan
pemulihan. Total yang salah sebelum perbaikan tidak dapat dipulihkan otomatis.

Pembaca CSV baru menormalisasi nama kolom dan nilai. Saat file asli lama dibaca
ulang, deduplikasi juga memeriksa fingerprint baris persis seperti pembaca lama
agar pembaruan aplikasi tidak menggandakan riwayat. Jika CSV lama diubah lagi
formatnya, fingerprint lama belum tentu dapat dikenali: hapus tanggal terdampak
dan impor laporan lengkap yang benar. Aplikasi tidak menebak kemiripan baris.

## Backup dan pemulihan

Di **Data Tersimpan**, **Unduh backup** menghasilkan JSON berformat
`affiliate-daily-backup`, `version: 1`, `database_version: 3` (backup
`database_version: 2` tetap dapat dipulihkan). Backup berisi metadata akun,
semua agregat affiliate/iklan/klik termasuk rincian pesanan yang di-hash,
fingerprint, log unggahan, dan parameter analisis sebagai referensi. JSON
ditulis ringkas; batas ekspor dan impor sama, 50 MiB, dengan maksimum total
500.000 record. Ekspor yang melebihi batas tidak dinyatakan sebagai backup siap
dipulihkan.

Untuk memulihkan:

1. Pilih akun tujuan, lalu buka **Data Tersimpan → Pulihkan backup**.
2. Pilih JSON backup. Periksa akun asal, tujuan, tanggal, jumlah agregat, dan
   jumlah data saat ini yang akan diganti.
3. Unduh backup akun tujuan terlebih dahulu jika masih diperlukan. Tekan tombol
   penggantian hanya ketika cakupan yang ditampilkan sudah benar.

Pemulihan mengganti agregat, fingerprint, dan log akun tujuan dalam satu
transaksi. Kegagalan penulisan membatalkan seluruh penggantian, sehingga riwayat
sebelumnya tetap utuh. ID record dipetakan ulang ke akun tujuan; akun lain
tidak diubah. Fingerprint tetap ada agar unggahan sesudah restore tidak
menggandakan data. Pergantian akun, reset, pembatalan, atau pemilihan file baru
membatalkan pratinjau baca yang sudah kedaluwarsa.

Parameter di backup hanya referensi: pengaturan aktif, mapping, snapshot, dan
CSV yang sedang dimuat tidak diganti oleh pemulihan harian. JSON analisis dari
menu Ekspor data dan backup lama yang belum memiliki metadata deduplikasi
lengkap tidak dapat dipulihkan melalui fitur ini. Snapshot analisis mempunyai
ekspor/impor terpisah. Backup tidak menyimpan seluruh CSV mentah dan tidak dapat
membangun ulang rincian produk; tetap simpan laporan sumber.

## Verifikasi

```bash
npm ci
node daily.regression.test.js
npx playwright install chromium
npm run test:browser
```

Pengujian memakai data sintetis dan database terisolasi. Mencakup overlap,
file berulang, simpan bersamaan, isolasi akun, migrasi, penghapusan hari,
serta pemulihan melalui unggah ulang. Pengujian backup mencakup roundtrip,
penolakan data rusak dan konflik key, penggantian akun, kegagalan penyimpanan
setelah penghapusan, kesinambungan deduplikasi, dan label Unicode/lintas baris.
