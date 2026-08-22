# Affiliate Decision Dashboard

Alat pengambilan keputusan iklan untuk affiliate Shopee yang beriklan di Meta Ads.
Menggabungkan tiga laporan CSV menjadi satu vonis per tag: **Scale, Pantau, Stop, atau Organik** —
lalu menyimpan riwayatnya per akun supaya perkembangan tiap akun kelihatan dari waktu ke waktu.

Berjalan sepenuhnya di browser. Tidak ada server, tidak ada data yang dikirim ke mana pun.

## Cara pakai

1. Buka `index.html` di browser.
2. Pilih akun di pojok kanan atas, atau tekan **+** untuk membuat akun baru.
3. Tarik ketiga file CSV ke area unggah:
   - **Affiliate Commission Report** (Shopee) — wajib
   - **Meta Ads Report** — untuk ROAS, CPM, CPC, CTR
   - **Website Click Report** (Shopee) — untuk mendeteksi kebocoran klik
4. Tekan **Simpan Snapshot** setiap selesai menganalisis. Setelah dua snapshot,
   tab **Perkembangan** akan menampilkan tren akun tersebut.

## Multi-akun

Setiap akun punya penyimpanan sendiri:

- mapping nama iklan ke tag
- riwayat snapshot
- tren perkembangan

Berganti akun tidak mencampur data. Snapshot satu akun tidak pernah muncul di akun lain.

## Yang membedakan dari sekadar laporan ROAS

### ROAS berbayar dipisah dari ROAS gabungan

Komisi organik bisa membuat ROAS gabungan terlihat sehat padahal iklan berbayarnya merugi.
Pada data uji, ROAS gabungan 1,95x terlihat bagus — ROAS berbayarnya ternyata 0,92x,
di bawah titik impas. Keduanya ditampilkan berdampingan.

### CPC Ideal

Dari target ROI yang Anda tetapkan, dihitung mundur: berapa CPC maksimal yang masih
menguntungkan. "ROAS 0,86x" itu laporan; "Anda bayar Rp167, batas Anda Rp80" itu perintah.

### Kebocoran klik

Membandingkan klik yang dibayar di Meta dengan klik yang benar-benar tercatat di Shopee.
Kalau sebuah tag hanya meneruskan 34% kliknya, masalahnya kemungkinan besar di **link atau
redirect**, bukan di creative. Tanpa kolom ini Anda akan mematikan iklan dengan diagnosis salah.

Persentase di atas 100% wajar — satu orang bisa klik berkali-kali dan trafik organik ikut terhitung.

### Lag atribusi

Pesanan tidak berhenti masuk di hari yang sama dengan kliknya. Pada data uji hanya 77%
pesanan terjadi di H+0 sampai H+1; sisanya menyebar sampai H+6. Vonis STOP karena itu
hanya dihitung sampai hari yang datanya sudah matang — tanpa perlindungan ini hampir
semua iklan akan kena vonis STOP palsu.

### Matching dengan tingkat keyakinan

Tiap hasil pencocokan nama iklan ke tag diberi metode dan skor keyakinan. Yang lemah
ditandai untuk diperiksa, bukan diam-diam dipakai.

## Tab

| Tab | Isi |
|---|---|
| **Keputusan** | Vonis per tag, alasan, saran bid, ROAS, ROI, CPM, CPC ideal, CR |
| **Per Ad Unit** | Satu baris per iklan Meta: status, CPM, impresi, reach, CTR, CPC ideal |
| **Kebocoran Klik** | Klik Meta vs Shopee, % masuk, biaya terbuang, sumber & wilayah klik |
| **Harian** | Komisi vs biaya, ROAS harian, klik & konversi, tabel rincian per tanggal |
| **Perkembangan** | Tren antar snapshot: laba, ROAS, komposisi keputusan, pergerakan tag |
| **Rincian** | Platform, kategori, jam terbaik, jeda klik, produk, toko, kurva penyelesaian |
| **Matching** | Nama iklan ke tag beserta metode dan keyakinan |

## Vonis

| Status | Syarat |
|---|---|
| **Scale** | ROAS efektif ≥ ambang scale |
| **Pantau** | ROAS efektif antara ambang pantau dan scale |
| **Stop** | ROAS di bawah impas, atau ROAS < 1 selama N hari produksi berturut |
| **Organik** | ada komisi, tanpa biaya iklan |
| **Belum cukup data** | spend atau durasi belum memenuhi minimum |

Sebuah tag baru divonis setelah memenuhi **spend minimum dan durasi minimum** — keduanya,
bukan salah satu. Spend besar dalam satu hari bukan dasar yang cukup untuk mematikan iklan.

Komisi berstatus Tertunda dihitung dengan bobot 0,95, karena sebagian akan batal.

## Pengaturan

Semua ambang bisa diubah dan tersimpan otomatis: PPN iklan, target ROI, ambang ROAS
scale/pantau, spend minimum, hari minimum, lag atribusi, panjang streak stop, dan bobot
komisi tertunda.

## Struktur

```
engine.js         mesin hitung murni, tanpa DOM — jalan di browser dan Node
engine.test.js    uji unit mesin hitung
index.html        struktur halaman
styles.css        tema terang dan gelap
app.js            render dan interaksi
browser.test.js   uji end-to-end dengan CSV asli
verify.js         verifikasi mesin terhadap CSV asli
legacy-v1.html    versi lama, disimpan sebagai pembanding
```

Mesin hitung sengaja dipisah dari UI supaya angkanya bisa diuji, bukan sekadar
terlihat benar di layar.

## Menjalankan uji

```bash
node engine.test.js                     # uji mesin hitung
python3 -m http.server 8899             # lalu di terminal lain:
node browser.test.js                    # uji end-to-end
node verify.js                          # cetak seluruh metrik dari CSV asli
```

Uji browser memerlukan Playwright dan mengambil CSV dari `~/Downloads`.

## Privasi

Data transaksi tidak pernah meninggalkan browser. Tidak ada backend, tidak ada analytics,
tidak ada pengiriman ke pihak ketiga. Snapshot disimpan di localStorage perangkat Anda.

File CSV di-ignore oleh git supaya data klien tidak ikut ter-commit.

---

Adrian Leo Hadipradata · Berlima Digital
