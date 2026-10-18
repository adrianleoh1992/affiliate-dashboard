# Database bersama (Supabase)

Opsional. Tanpa konfigurasi, dashboard tetap menyimpan riwayat harian hanya di
browser (IndexedDB) seperti sebelumnya. Dengan Supabase, seluruh akun
(Beautyismust, Beautyisus, Rizqie, dan akun lain) memakai satu database yang
sama untuk semua anggota tim.

## Yang disimpan

Isi database sama dengan riwayat harian di browser, satu baris per
`(akun, tanggal, tag)` untuk komisi dan klik, dan per `(akun, tanggal, nama iklan)`
untuk Meta Ads, ditambah fingerprint baris (dedup) dan log unggahan. Semua akun
ada di tabel yang sama dengan kolom `account_id`, di schema privat `dashboard`.

| Tabel | Isi |
|---|---|
| `accounts` | Nama akun dashboard, `revision` (naik setiap kali ada penulisan) dan `reset_revision` (revisi penggantian seluruh akun terakhir) |
| `daily_affiliate` | Komisi, komisi selesai/tertunda, GMV, qty, refund, jumlah order, hash order |
| `daily_ads` | Spend, impresi, reach, klik, LPV, hasil, CPM/CPC/CTR |
| `daily_clicks` | Klik Shopee per tag dengan rincian wilayah dan perujuk |
| `row_hashes` | Satu fingerprint per baris sumber agar unggahan ulang tidak menggandakan angka |
| `uploads` | Log file: nama, jumlah baris, baru/diperbarui/duplikat, periode, pengunggah |
| `day_deletions` | Penanda tanggal yang dihapus, agar browser lain ikut menghapusnya |
| `team_members` | Pengguna Supabase Auth yang boleh membaca dan menulis |

Setiap baris membawa `rev`, yaitu revisi saat baris itu terakhir ditulis.

CSV mentah, nama/alamat pembeli, nama produk, toko, dan ID order asli **tidak**
dikirim. ID order hanya disimpan sebagai hash 16 karakter, sama seperti di browser.
Token Meta Ads tidak pernah disimpan di database.

## Cara kerja sinkronisasi

- Browser menyimpan revisi akun yang sedang ia cerminkan. **Simpan** melakukan
  dedup terhadap salinan itu, menghitung agregat dengan `DailyAgg` (jalur hitung
  yang sama dengan mode lokal), lalu mengirim agregat dan fingerprint ke fungsi
  `daily_ingest`. Bila anggota lain menyimpan lebih dulu, database menolak
  (revisi berubah), browser menarik data terbaru dan mengulang sekali.
- Penggabungan di database sama dengan `DailyAgg.mergeDaily`: angka dijumlahkan,
  order digabung sebagai himpunan hash, CPM/CPC/CTR dihitung ulang dari total.
- Setelah setiap penulisan, browser menarik **hanya baris yang berubah** sejak
  revisinya (`daily_changes`), termasuk tanggal yang dihapus, lalu mencocokkan
  jumlah record dengan database. Bila tidak cocok, atau akun baru saja diganti
  seluruhnya, browser mengunduh ulang seluruh akun (`daily_export_account`).
  Semua data yang ditarik divalidasi seperti backup. Tab dashboard tetap membaca
  IndexedDB.
- Bila penyimpanan sudah tercatat di database tetapi penarikan sesudahnya gagal,
  dashboard melaporkan penyimpanan berhasil dan panel menampilkan status
  **Tidak terhubung** sampai salinan browser diperbarui; penyimpanan berikutnya
  ditolak sampai itu terjadi.
- Hapus tanggal dan **Pulihkan backup** saat masuk berlaku untuk seluruh tim.
- Data yang disimpan saat **belum masuk** tidak pernah menimpa database secara
  diam-diam. Saat masuk, panel **Database bersama** meminta Anda memilih: pakai
  data database (disarankan; lalu unggah ulang CSV yang disimpan saat offline,
  baris yang sudah ada otomatis dilewati) atau ganti database dengan data browser.
- Akun yang belum ada di database (atau belum pernah ditulis) dibuat saat pertama
  kali menyimpan, dan riwayat lokal akun itu ikut dikirim. Akun yang pernah
  berisi lalu dikosongkan **tidak** diisi ulang otomatis dari salinan lama: itu
  diperlakukan sebagai pilihan yang harus dibuat pengguna.
- **Kirim riwayat lokal** dan **Ganti database bersama** selalu meminta
  konfirmasi dan membawa revisi yang terlihat saat itu. Bila anggota lain
  menyimpan setelahnya, database menolak penggantian dan tidak ada yang hilang.
- Riwayat lama di browser yang disimpan sebelum format penggabungan (tanpa hash
  order atau fingerprint bertanggal) tidak dikirim. Dashboard menyebut
  tanggalnya; hapus tanggal itu lalu unggah ulang CSV-nya.
- Database menolak isi yang tidak bisa dimuat kembali oleh browser (label kosong
  atau berkarakter kontrol, angka di luar batas aman JavaScript, peta klik bukan
  bilangan bulat, fingerprint tanpa tanggal atau tidak sesuai jumlah baris), agar
  satu penulisan buruk tidak mengunci seluruh tim.

## Keamanan

- Kunci anon/publishable bersifat publik di browser. Karena itu tabel berada di
  schema `dashboard` yang tidak dibuka lewat Data API, dengan RLS aktif dan tanpa
  hak akses langsung. Browser hanya dapat memanggil tujuh fungsi `public.daily_*`
  (`SECURITY DEFINER`) yang memeriksa keanggotaan `team_members`, mengunci akun,
  dan memvalidasi isi. Pengguna yang login tetapi bukan anggota ditolak.
- Jangan pernah memakai kunci `service_role`/secret di Vercel atau di repo.
  `npm run build` hanya menerima publishable key (`sb_publishable_…`) atau JWT
  dengan role `anon`.
- Sesi login disimpan di `localStorage` browser dan dipakai bersama oleh semua
  tab. Gangguan sementara layanan login (jaringan, 429, 5xx) tidak mengeluarkan
  Anda; hanya refresh token yang ditolak. **Keluar** tidak menghapus salinan data
  di browser itu; pada komputer bersama, hapus data situs browser.
- Saat ini semua anggota melihat semua akun. Pembatasan per akun memerlukan
  tabel izin tambahan; belum dibuat.

## Penyiapan

1. Di Supabase, buka project lalu **SQL Editor**, jalankan isi
   `supabase/migrations/20261018000000_shared_daily_store.sql` (atau
   `supabase db push` dengan Supabase CLI).
2. **Authentication → Sign In / Providers**: matikan *Allow new users to sign up*.
   **Authentication → Users → Add user**: buat pengguna untuk setiap anggota
   dengan email dan kata sandi (centang *Auto confirm*).
3. Daftarkan anggota tim di SQL Editor:
   ```sql
   insert into dashboard.team_members (user_id)
   select id from auth.users where email in ('anda@contoh.com', 'tim@contoh.com');
   ```
4. Di Vercel, **Settings → Environment Variables**, isi `SUPABASE_URL`
   (`https://<ref>.supabase.co`) dan `SUPABASE_ANON_KEY` (publishable key
   `sb_publishable_…` atau legacy anon key), lalu deploy ulang.
5. Buka **Data Tersimpan → Database bersama**, masuk, dan simpan laporan seperti biasa.

Menghapus anggota: `delete from dashboard.team_members where user_id = ...;`

## Pengujian

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres REQUIRE_DB=1 npm run test:db
```

Uji ini membuat database sementara di Postgres lokal, menerapkan migrasi dengan
pengganti minimal untuk `auth` Supabase, lalu menjalankan dua "browser" (IndexedDB
terpisah) terhadap database yang sama: penggabungan, dedup lintas browser,
paritas angka dengan mode lokal, revisi basi, konflik data offline, hapus
tanggal, pemulihan backup, sinkron bertahap, akun yang dikosongkan, penolakan
riwayat lama dan isi yang tidak valid, kegagalan penarikan setelah simpan, sesi
login, RLS, dan alur login sampai simpan di Chromium. Tanpa Postgres, uji
dilewati kecuali `REQUIRE_DB=1`.

## Batasan yang diketahui

- Unduhan penuh pertama (dan setelah pemulihan backup) memuat seluruh akun,
  termasuk satu fingerprint per baris sumber. Untuk satu bulan data ini beberapa
  MB; riwayat bertahun-tahun akan memperlambat unduhan pertama di browser baru.
- Iklan dikelompokkan per **nama iklan**, sama seperti penyimpanan browser.
  Nama iklan yang sama dipakai di beberapa kampanye akan tergabung. Kunci
  `ad_id` memerlukan perubahan di pembaca CSV dan penyimpanan browser juga.
