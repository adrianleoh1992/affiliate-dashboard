# Penyimpanan harian

Fitur harian sudah terintegrasi di `index.html`. Bookmark `index-daily.html`
akan mengarah ke sana. **Data Tersimpan** di header tetap dapat dibuka setelah
reload tanpa mengunggah ulang laporan affiliate.

## Yang disimpan

- Akun yang dipilih pengguna.
- Agregat per `(akun, tanggal, tag)` untuk affiliate dan klik.
- Agregat per `(akun, tanggal, ad_key)` untuk Meta Ads. Nama tampil tetap di `ad_unit`; identitas memakai Ad ID, lalu nama + tanggal pembuatan, lalu nama persis jika identitas lain tidak tersedia.
- Fingerprint baris dengan tanggal dan jenis laporan, fingerprint file,
  identitas order yang di-hash, serta log unggahan.

CSV mentah, nama produk, toko, dan ID order mentah tidak dipersistenkan oleh
alur simpan harian. Data berada di IndexedDB pada origin browser yang sama.

## Jaminan penggabungan

Rencana simpan hanya merupakan pratinjau. Transaksi penulisan memeriksa ulang
file dan fingerprint baris agar dua tab atau dua proses simpan dengan rencana
lama tidak menambahkan baris yang sama. Kontribusi baru digabung ke agregat
lama, bukan menimpa seluruh total dengan sebagian baris. Order menggunakan
union identitas agar tambahan produk dari pesanan yang sama tidak menambah
jumlah order.

Menghapus satu tanggal membersihkan penanda baris tanggal itu dan membatalkan
penanda file yang relevan. Unggah ulang laporan yang mencakup beberapa hari
mengembalikan hari terhapus, sementara hari lainnya tetap terdeduplikasi.
Penghapusan akun membersihkan data, penanda deduplikasi, dan log terkait.

## Laporan koreksi

Hash seluruh baris mengenali duplikat identik, bukan revisi status atau nilai.
Tanpa ID unik per item, sistem tidak boleh menebak baris mana yang harus
dihapus. Untuk koreksi, muat hanya versi laporan yang benar, pilih **Ganti periode lengkap**, pilih jenis laporan, dan isi sendiri tanggal awal/akhir. Rentang tidak diisi otomatis dari tanggal baris: tanggal yang tidak muncul bisa berarti aktivitas nol atau sumber belum lengkap. Periksa akun, rentang, jumlah agregat, dan total lama → baru, lalu centang pernyataan kelengkapan dan konfirmasi penggantian.

Seluruh agregat jenis/rentang itu dihapus dan dibangun dari baris sumber lengkap yang masih dimuat, termasuk baris identik yang sebelumnya sudah pernah diimpor. Tag dan tanggal yang tidak muncul pada versi baru ikut dihapus. Baris di luar rentang dan akun lain tetap utuh. Sumber yang sebagian barisnya ditolak tidak boleh dipakai untuk mengganti periode lengkap. Penggantian tidak menebak identitas transaksi dari order/produk.

Simpan biasa dan penggantian memakai satu transaksi untuk semua file terpilih, fingerprint, dan log. Jika satu penulisan gagal, semuanya dibatalkan. Tindakan penggantian UI hanya menyimpan jenis yang dipilih; file jenis lain dapat disimpan terpisah memakai simpan biasa.

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
`affiliate-daily-backup`, `version: 1`, `database_version: 3`. Cadangan database versi 2 tetap dapat dibaca; versi 3 menambah identitas iklan tanpa menyimpulkan tanggal pembuatan dari timestamp penyimpanan lama. Backup berisi
metadata akun, semua agregat affiliate/iklan/klik, fingerprint, identitas order
yang di-hash, log unggahan (termasuk status sumber parsial bila diketahui), dan parameter analisis/akhir pengamatan sebagai referensi. JSON
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
node daily-batch.test.js
node daily-replacement-ui.test.js
npx playwright install chromium
npm run test:browser
```

Pengujian memakai data sintetis dan database terisolasi. Mencakup overlap,
file berulang, simpan bersamaan, isolasi akun, migrasi, penghapusan hari,
serta pemulihan melalui unggah ulang. Pengujian backup mencakup roundtrip,
penolakan data rusak dan konflik key, penggantian akun, kegagalan penyimpanan
setelah penghapusan, kesinambungan deduplikasi, dan label Unicode/lintas baris.

## Kontrak integrasi

`store.saveBatch(accountId, items, { replacementRanges })` menerima daftar item datar:

```js
{ kind, records, rawRows, fileHash, fileName, sourceRows, duplicates, period, rowHashes, sourceState }
```

`kind` adalah `affiliate`, `ads`, atau `clicks`. `sourceState` opsional bernilai `loaded` atau `partial`. `rawRows` merupakan semua baris sumber yang diterima untuk file, bukan hanya baris yang lolos deduplikasi pratinjau. Store memeriksa ulang fingerprint di transaksi. `records`/`rowHashes` tetap tersedia bagi pemanggil agregat lama; penggantian periode wajib menggunakan `rawRows` (daftar kosong diizinkan). `replacementRanges` adalah daftar `{kind,start,end}` tanggal ISO valid dan eksplisit. Item untuk jenis yang diganti dipotong ke rentang tersebut sebelum penulisan; metadata fingerprint file memakai subset yang benar-benar disimpan. Hasil `{added,updated,duplicates,skipped,removed,items}` menghitung perubahan agregat dan hasil per file. `saveDaily(accountId, kind, records, opts)` tetap kompatibel, membungkus satu item dan mengembalikan hasil per file seperti sebelumnya.

`ad_key` memakai `id:<id>`, `created:<JSON pasangan nama/tanggal>`, atau `name:<nama persis>`. `ad_id` dan `created_at` menyimpan identitas sumber bila tersedia; `stored_at` mencatat waktu penyimpanan iklan baru. Record lama selalu dimigrasikan ke identitas berbasis nama. Baris dimensi dengan isi berbeda tetap memberi kontribusi; hanya fingerprint seluruh isi baris yang sama dideduplikasi.

## Batas ringkasan tersimpan

Data Tersimpan adalah ringkasan agregat, bukan rekonstruksi analisis transaksi. Tidak ada baris pesanan buatan dari agregat. Rincian produk, pemetaan cohort tanggal klik, dan rekomendasi memerlukan CSV sumber.

`source_partial` pada agregat iklan mempertahankan bukti sumber parsial per tanggal, termasuk ketika log file yang bertumpang tindih dihapus oleh penggantian satu hari. Bukti ini ikut divalidasi dan dipulihkan di backup. Biaya/laba/ROAS total tetap tidak tersedia jika ada tanggal Meta yang belum tercakup atau sumber Meta parsial. Baris harian yang mempunyai Meta tetap menampilkan biaya teramati. Konfirmasi lengkap untuk akun/rentang dengan data Meta dapat menjelaskan tanggal kosong; konfirmasi tidak memperbaiki sumber parsial. Pernyataan tanpa Meta hanya menetapkan biaya nol jika rentang itu tidak mempunyai data Meta tersimpan. Lapisan harian membaca `window.dashboardSourceCoverage(accountName,start,end)` dari aplikasi; deklarasi ini terpisah dari backup agregat dan tidak ikut dipulihkan. Mapping manual juga menggunakan cadangan terpisah.
