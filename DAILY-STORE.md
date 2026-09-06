# Penyimpanan harian

Fitur harian sudah terintegrasi di `index.html`. Bookmark `index-daily.html`
akan mengarah ke sana. **Data Tersimpan** di header tetap dapat dibuka setelah
reload tanpa mengunggah ulang laporan affiliate.

## Yang disimpan

- Akun yang dipilih pengguna.
- Agregat per `(akun, tanggal, tag)` untuk affiliate dan klik.
- Agregat per `(akun, tanggal, ad unit)` untuk Meta Ads.
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
dihapus. Untuk koreksi, hapus tanggal terdampak per jenis laporan, lalu simpan
ulang laporan lengkap yang benar. Hapus juga file lama dari analisis sebelum
mengunggah file koreksi.

Migrasi mempertahankan agregat lama. Penggabungan bertumpang tindih yang
membutuhkan identitas order tetapi tidak memilikinya ditolak dengan pesan
pemulihan. Total yang salah sebelum perbaikan tidak dapat dipulihkan otomatis.

Ekspor akun tersedia sebagai JSON untuk pemeriksaan dan cadangan; fitur impor
backup harian belum tersedia. Snapshot analisis mempunyai ekspor/impor terpisah.

## Verifikasi

```bash
npm ci
node daily.regression.test.js
npx playwright install chromium
npm run test:browser
```

Pengujian memakai data sintetis dan database terisolasi. Mencakup overlap,
file berulang, simpan bersamaan, isolasi akun, migrasi, penghapusan hari,
serta pemulihan melalui unggah ulang.
