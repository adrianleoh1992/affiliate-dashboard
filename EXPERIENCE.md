# Perbaikan alur baca data, UI, dan ekspor

Selesai 7 September 2026. Tahap ini melanjutkan audit lokal pada commit
`3dff0ca`, berdasarkan repository `adrianleoh1992/affiliate-dashboard` dengan
baseline `24e4cf3`. Perubahan tetap memakai HTML/CSS/JavaScript yang sudah ada.
Tidak ada push, pull request, merge, atau deployment yang dilakukan.

## Perubahan yang tersedia

| Area | Perilaku setelah perbaikan |
|---|---|
| Baca CSV | Mengenali kolom, pemisah koma/titik koma/tab, UTF-8 dan UTF-16 dengan BOM, angka lokal, serta teks berkutip lintas baris |
| Kualitas data | Memeriksa angka, tanggal, status, mata uang, kolom wajib, dan struktur file sebelum analisis |
| Kesalahan sebagian baris | Menampilkan jumlah valid/bermasalah dan rincian yang dapat diunduh; baris valid baru dimuat setelah pilihan eksplisit pengguna |
| Meta Ads | Menolak laporan agregat beberapa hari yang tidak dapat dipecah menjadi harian secara akurat |
| Pembatalan | Pembacaan batch dapat dibatalkan; callback lama tidak mengubah akun baru atau data setelah reset |
| Rentang tanggal | Pilihan tanggal pengguna dipertahankan saat menambah file; rentang semua tanggal mengikuti cakupan baru |
| Deduplikasi lama | Pembacaan baru tetap mengenali fingerprint baris asli dari pembaca sebelumnya, termasuk sesudah restore |
| Pencarian dan tabel | Pencarian tag/alasan, filter keputusan, kolom utama ringkas, pilihan metrik tambahan, dan penanda urutan tabel |
| Akses dan mobile | Fokus keyboard pada dialog, Escape, pengembalian fokus, target sentuh dan layout pada lebar 320/390 px |
| CSV | Empat dataset dengan akun/periode, pilihan tag mengikuti filter, presisi angka, dan perlindungan formula pada teks sumber |
| JSON analisis | Format berversi yang membawa seluruh hasil, parameter, dan catatan kualitas; tidak disamakan dengan backup |
| PDF | Unduhan PDF asli tiga mode dengan judul, semua tag, angka lengkap, teks yang dapat dipilih, header berulang, dan nomor halaman |
| Backup | Ekspor lengkap dan pemulihan ke akun tujuan dengan pratinjau penggantian, validasi ketat, serta transaksi yang membatalkan seluruh penulisan jika gagal |
| Backup besar | JSON ringkas dan batas UTF-8 50 MiB yang sama pada ekspor/pemulihan; tidak mengunduh backup yang melebihi batas restore |
| Kecepatan awal | Pustaka PDF dan font hanya dimuat saat fitur PDF digunakan; seluruh aset tetap tersedia lokal |

Catatan kualitas dari file yang diterima sebagian disertakan dalam ekspor JSON
dan PDF. Tombol ekspor tidak tersedia ketika hasil belum siap. Kegagalan memuat
pustaka PDF menampilkan pesan dan memungkinkan percobaan ulang.

## Cara memakai

1. Pilih akun dan masukkan CSV sumber. Periksa hasil pembacaan sebelum memakai
   keputusan atau menyimpan riwayat.
2. Pilih periode, PPN, dan parameter analisis. Cari tag atau gunakan filter
   keputusan untuk memusatkan pemeriksaan.
3. Buka **Ekspor data** untuk CSV/JSON. Pilih dataset dan cakupan sebelum unduh.
4. Buka **Unduh PDF**, isi judul, lalu pilih Ringkas, Standar, atau Lengkap.
   PDF menyertakan seluruh tag pada periode analisis, terlepas dari filter tabel.
5. Gunakan **Data Tersimpan → Unduh backup** untuk cadangan harian. Untuk
   pemulihan, pilih akun tujuan, pilih file backup, periksa cakupan, lalu tekan
   tombol penggantian. Simpan cadangan akun tujuan terlebih dahulu bila perlu.

Paket source dapat diekstrak lalu dibuka melalui `index.html`. Server lokal
`npm start` disarankan untuk menjaga origin penyimpanan tetap konsisten.

## Hasil verifikasi

- Mesin hitung asli dan regresi engine: lulus.
- Penyimpanan harian: 30/30 kasus lulus, termasuk deduplikasi, migrasi,
  roundtrip backup, batas byte Unicode, isolasi akun, serta rollback.
- Validasi impor: 31/31 kasus lulus.
- CSV/JSON analisis: 7/7 kasus lulus.
- Regresi browser: 25/25 kasus lulus.
- Alur penggunaan browser: 24/24 kasus lulus, termasuk rentang tanggal,
  pembatalan, file rusak, keyboard, mobile, backup, dan unduhan PDF offline.
- PDF fixture 100 tag: Ringkas 8 halaman, Standar 23 halaman, Lengkap 35 halaman;
  seluruh tag, batas halaman, header, Unicode, dan data sumber diperiksa.
- Contoh PDF Standar tiga halaman dengan data sintetis dirender dan ditinjau.
  Totalnya cocok dengan sumber: biaya Rp1.476.300,00, komisi efektif
  Rp2.326.800,00, laba Rp850.500,00, dan 182 pesanan.
- Build produksi, pemeriksaan aset, pembukaan melalui HTTP dan `file://`, serta
  unduhan PDF dan backup tanpa permintaan eksternal: lulus.
- `npm audit`: 0 kerentanan yang dilaporkan pada dependensi terpasang saat
  pemeriksaan. `git diff --check`: bersih.

Pengujian menggunakan Chromium dan data sintetis. Belum memverifikasi Safari,
Firefox, atau seluruh variasi CSV produksi pengguna.

## Batasan yang tetap berlaku

- Data tetap lokal pada origin browser. Backup harian tidak memuat CSV mentah,
  mapping, seluruh rincian produk, atau snapshot; simpan sumber dan ekspor
  snapshot secara terpisah. Parameter backup hanya referensi.
- Backup baru memakai `affiliate-daily-backup` versi 1. Backup lama yang tidak
  lengkap dan JSON analisis ditolak oleh pemulihan harian. Batas backup 50 MiB
  dan 500.000 record; batas CSV 75 MiB per file.
- Laporan koreksi bukan baris duplikat. Hapus tanggal terdampak untuk jenis
  laporan itu, lalu impor ulang laporan lengkap. CSV lama yang diformat ulang
  belum tentu cocok dengan fingerprint pembaca lama. Total lama yang salah
  tidak dapat direkonstruksi otomatis dari agregat saja.
- PDF mencantumkan `[U+XXXX]` untuk karakter di luar font Noto Sans yang
  disertakan, misalnya emoji atau sebagian aksara Asia. Identitas teks tetap
  dapat ditelusuri, dan CSV/JSON menyimpan Unicode aslinya.
- PDF mengikuti data yang tersedia pada hasil analisis. Ringkasan produk/toko
  yang telah dibatasi mesin tidak berubah menjadi seluruh transaksi mentah.
  Banyak halaman bergantung pada data dan panjang label.

Perbaikan ini mencakup bug yang ditemukan dan diuji, bukan jaminan bahwa setiap
kemungkinan bug atau format sumber sudah tercakup.

## Paket hasil

- `affiliate-dashboard-v2.zip`: source lengkap, aset vendor lokal, pengujian,
  dan dokumentasi; mencakup kedua tahap perbaikan.
- `affiliate-dashboard-v2.patch`: patch kumulatif dari baseline `24e4cf3`.
  Gunakan `git am` pada branch dari baseline tersebut; tinjau konflik jika
  repository Anda telah berubah.
- `contoh-laporan.pdf`: contoh laporan dengan data sintetis.
- `verification-v2.txt`: keluaran pengujian akhir.

Patch tidak perlu diterapkan lagi jika menggunakan source ZIP terbaru.
