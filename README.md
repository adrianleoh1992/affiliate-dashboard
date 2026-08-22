# Affiliate Decision Dashboard

Alat pengambilan keputusan iklan untuk affiliate Shopee yang beriklan di Meta Ads.
Menggabungkan tiga laporan CSV menjadi satu vonis per tag: **Scale, Pantau, Stop, atau Organik.**

Berjalan sepenuhnya di browser. Tidak ada server, tidak ada data yang dikirim ke mana pun.

## Cara pakai

1. Buka `v2.html` di browser.
2. Tarik ketiga file CSV ke area unggah:
   - **Affiliate Commission Report** (Shopee) — wajib
   - **Meta Ads Report** — untuk menghitung ROAS dan CPC
   - **Website Click Report** (Shopee) — untuk mendeteksi kebocoran klik
3. Dashboard otomatis mengenali jenis tiap file dan menghitung keputusannya.

## Yang membedakan dari sekadar laporan ROAS

### CPC Ideal

Kolom paling berguna di tabel. Dari target ROI yang Anda tetapkan, dihitung mundur:
berapa CPC maksimal yang masih menguntungkan.

Bedanya besar. "ROAS 0,86x" itu laporan. "Anda bayar Rp167, batas Anda Rp80" itu perintah.

### Kebocoran klik

Membandingkan klik yang Anda bayar di Meta dengan klik yang benar-benar tercatat di Shopee.

Kalau sebuah tag cuma meneruskan 34% kliknya, masalahnya kemungkinan besar ada di
**link atau redirect**, bukan di creative. Tanpa kolom ini Anda akan mematikan iklan
yang sebenarnya sehat.

Persentase di atas 100% itu wajar — satu orang bisa klik berkali-kali dan trafik
organik ikut terhitung di tag yang sama.

### Lag atribusi

Pesanan tidak berhenti masuk di hari yang sama dengan kliknya. Pada data uji,
hanya 77% pesanan terjadi di H+0 sampai H+1; sisanya menyebar sampai H+6.

Artinya ROAS beberapa hari terakhir **selalu** terlihat lebih buruk dari kenyataan.
Vonis STOP karena itu hanya dihitung sampai hari yang datanya sudah matang.
Tanpa perlindungan ini, hampir semua iklan akan kena vonis STOP palsu.

### ROAS berbayar vs gabungan

Dibedakan secara sengaja. Komisi organik bisa membuat ROAS gabungan terlihat sehat
padahal iklan berbayarnya sendiri merugi. Dashboard menampilkan keduanya berdampingan
supaya tidak ada kejutan.

### Matching dengan tingkat keyakinan

Nama iklan di Meta jarang sama persis dengan tag affiliate. Tiap hasil pencocokan
diberi metode dan skor keyakinan; yang lemah ditandai supaya bisa diperiksa,
bukan diam-diam dipakai.

Mapping manual bisa diedit lewat UI dan disimpan di browser.

## Vonis

| Status | Syarat |
|---|---|
| **Scale** | ROAS efektif ≥ ambang scale |
| **Pantau** | ROAS efektif antara ambang pantau dan scale |
| **Stop** | ROAS di bawah impas, atau ROAS < 1 selama N hari produksi berturut |
| **Organik** | ada komisi, tanpa biaya iklan |
| **Belum cukup data** | spend atau durasi belum memenuhi minimum |

Sebuah tag baru divonis setelah memenuhi **spend minimum dan durasi minimum** —
keduanya, bukan salah satu. Spend besar dalam satu hari bukan dasar yang cukup
untuk mematikan iklan.

Komisi berstatus Tertunda dihitung dengan bobot 0,95, karena sebagian akan batal.

## Pengaturan

Semua ambang bisa diubah dan tersimpan otomatis di browser:
PPN iklan, target ROI, ambang ROAS scale/pantau, spend minimum, hari minimum,
lag atribusi, panjang streak stop, dan bobot komisi tertunda.

## Fitur lain

- **Snapshot** — simpan hasil analisis per tanggal, buka lagi tanpa unggah ulang CSV
- **Export CSV** — seluruh tabel keputusan beserta alasannya
- **Filter** — klik kartu keputusan untuk menyaring tabel
- **Mode gelap**
- Semua nilai dari CSV di-escape sebelum masuk ke DOM

## Struktur

```
engine.js         mesin hitung murni, tanpa DOM — jalan di browser dan Node
engine.test.js    uji unit mesin hitung
v2.html           antarmuka
browser.test.js   uji end-to-end dengan CSV asli
verify.js         verifikasi mesin terhadap CSV asli
index.html        versi 1 (lama)
```

Mesin hitung sengaja dipisah dari UI supaya angkanya bisa diuji, bukan sekadar
terlihat benar di layar.

## Menjalankan uji

```bash
node engine.test.js                     # uji mesin hitung
python3 -m http.server 8899             # lalu di terminal lain:
node browser.test.js                    # uji end-to-end
```

Uji browser memerlukan Playwright dan mengambil CSV dari `~/Downloads`.

## Privasi

Data transaksi tidak pernah meninggalkan browser. Tidak ada backend, tidak ada
analytics, tidak ada pengiriman ke pihak ketiga. Snapshot disimpan di
localStorage perangkat Anda sendiri.

File CSV di-ignore oleh git supaya data klien tidak ikut ter-commit.

---

Adrian Leo Hadipradata · Berlima Digital
