# Daily Store — versi percobaan

Penyimpanan data harian per akun untuk Affiliate Decision Dashboard.
**Berdiri terpisah**; dashboard di `index.html` tidak tersentuh.

Tujuan: menyimpan data affiliate dan iklan harian secara permanen, per akun,
tanpa pernah menggandakan angka meski file diunggah berkali-kali.

## Kenapa ini dibuat terpisah dulu

Dashboard saat ini menghitung ulang dari nol setiap kali CSV diunggah. Kalau
file yang sama masuk dua kali, komisi menggandakan diam-diam — ROAS 1,95x
terbaca 3,89x. Memindahkan logika seperti itu ke cloud berarti menyimpan angka
keliru secara permanen, dan itu jauh lebih sulit diperbaiki daripada sekarang.

Jadi urutannya: **buktikan deduplikasi benar di lokal dulu**, baru cloud.

## Cara mencoba

```bash
python3 -m http.server 8899
# buka http://127.0.0.1:8899/test-daily.html
```

1. Isi nama akun Shopee, klik **Buat/Pilih**
2. Unggah ketiga CSV
3. Coba unggah file yang sama lagi — akan ditolak
4. Lihat **Cakupan Data** dan **Riwayat Upload**

## Empat lapis anti-duplikasi

| Lapis | Menangkap |
|---|---|
| Hash file | File identik, meski namanya diubah |
| Hash baris | Periode tumpang tindih antar file berbeda |
| Kunci `(akun, tanggal, tag)` | Simpan ulang jadi perbarui, bukan baris baru |
| Log upload | Jejak apa yang pernah masuk, kapan, berapa |

### Kunci dedup harus hash seluruh baris

Kunci komposit yang tampak masuk akal justru berbahaya. Diuji pada CSV asli:

```
kunci order+produk+waktu+komisi → 1.408 baris dianggap duplikat
                                → 0 benar-benar identik
                                → 1.408 baris SAH akan terhapus
```

Penyebabnya satu pesanan bisa berisi beberapa produk berbeda harga:

```
baris 29: qty=1  nilai=17.999  Tertunda
baris 30: qty=1  nilai=35.999  Tertunda
baris 31: qty=1  nilai=17.287  Tertunda
```

Hash seluruh isi baris: 11.470 dari 11.470 unik, nol false positive.

## Grain penyimpanan

Yang disimpan adalah **agregat harian**, bukan transaksi mentah.

| | Transaksi mentah | Agregat harian |
|---|---|---|
| Baris per bulan | 11.470 | 340 |
| Ukuran 30 hari | 23,1 MB | 123 KB |
| Proyeksi 1 tahun | ~280 MB | **1,4 MB** |
| Data sensitif | ID order, nama produk, toko | tidak ada |

Kompresi 192×. Cukup untuk tren, ROAS harian, dan deteksi kebocoran.
CSV mentah tetap diproses di browser lalu tidak dikirim ke mana pun.

## Akun tidak bisa dideteksi otomatis

CSV Shopee dan Meta **tidak memuat identitas akun sama sekali**:

- Meta Ads export tidak punya kolom `Account name`
- `Nama Toko` di laporan affiliate adalah toko penjual, bukan akun Anda

Jadi akun adalah **konteks yang dipilih pengguna**, lalu setiap baris dicap
dengan akun aktif saat diunggah. Salah pilih akun akan mencampur data dua akun
dan sulit dipisahkan setelah tersimpan — karena itu pemilihan akun dibuat
sebagai langkah eksplisit.

## Angka harus cocok dengan dashboard

`daily-agg.test.js` mengunci kecocokan dengan `engine.js`. Keduanya
mengecualikan status `Dibatalkan` dan `Belum Dibayar`.

Uji ini pernah menangkap penyimpangan nyata: store menghitung 8.007 order
sementara engine 8.004, karena store belum mengecualikan `Belum Dibayar`.

## File

```
daily-agg.js         agregasi + dedup, murni, tanpa DOM — bisa diuji di Node
daily-agg.test.js    uji terhadap CSV asli + kecocokan dengan engine
daily-store.js       IndexedDB: akun, data harian, log upload
daily-store.test.js  uji end-to-end di Chrome
test-daily.html      halaman uji manual
```

Catatan teknis: transaksi IndexedDB tertutup otomatis di akhir microtask, jadi
transaksi tidak boleh ditahan melewati `await`. Setiap method di `daily-store.js`
membuka transaksi, bekerja di dalam callback, dan resolve saat transaksi commit.

## Menjalankan uji

```bash
node daily-agg.test.js      # agregasi + dedup
node daily-store.test.js    # IndexedDB (perlu server jalan)
```

## Hasil uji

```
file diunggah 2x        22.940 baris → 11.470 diterima, 11.470 ditolak
tumpang tindih 30%      14.912 baris → 11.470 diterima, 3.442 ditolak
komisi setelah dedup    Rp31.028.615 (tidak berubah)
cocok dengan engine     komisi sama, order sama
isolasi akun            dua akun, data terpisah penuh
hapus akun              0 baris yatim
console error           0
```

## Belum dikerjakan

- Peringatan tumpang tindih periode **sebelum** menyimpan (rencana sudah ada di `planIngest`)
- Integrasi ke dashboard utama
- Sinkronisasi cloud (Supabase) — sengaja ditunda sampai lapisan ini terbukti
