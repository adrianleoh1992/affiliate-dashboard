# Database bersama (Supabase)

Opsional. Tanpa konfigurasi, dashboard tetap menyimpan riwayat harian hanya di
browser (IndexedDB) seperti sebelumnya. Dengan Supabase, seluruh akun
(Beautyismust, Beautyisus, Rizqie, dan akun lain) memakai satu database yang
sama untuk semua anggota tim.

## Yang disimpan

Isi database sama dengan riwayat harian di browser, satu baris per
`(akun, tanggal, tag)` untuk komisi dan klik, dan per `(akun, tanggal, ad_key)`
untuk Meta Ads (`id:<Ad ID>`, atau `name:<nama iklan>` bila tanpa Ad ID),
ditambah fingerprint baris (dedup) dan log unggahan. Semua akun
ada di tabel yang sama dengan kolom `account_id`, di schema privat `dashboard`.

| Tabel | Isi |
|---|---|
| `accounts` | Nama akun dashboard, `revision` (naik setiap kali ada penulisan) dan `reset_revision` (revisi penggantian seluruh akun terakhir) |
| `daily_affiliate` | Komisi, komisi selesai/tertunda, GMV, qty, refund, jumlah order, rincian per pesanan (`order_parts`, kunci hash) |
| `daily_ads` | Ad ID, nama iklan, spend, impresi, reach, klik, LPV, hasil, CPM/CPC/CTR |
| `daily_clicks` | Klik Shopee per tag dengan rincian wilayah dan perujuk |
| `row_hashes` | Fingerprint per baris sumber untuk klik dan iklan tanpa Ad ID, agar unggahan ulang tidak menggandakan angka |
| `uploads` | Log file: nama, jumlah baris, baru/diperbarui/duplikat, periode, pengunggah |
| `day_deletions` | Penanda tanggal yang dihapus, agar browser lain ikut menghapusnya |
| `team_members` | Pengguna Supabase Auth yang boleh membaca dan menulis |

Setiap baris membawa `rev`, yaitu revisi saat baris itu terakhir ditulis.

CSV mentah, nama/alamat pembeli, nama produk, toko, dan ID order asli **tidak**
dikirim. ID order hanya disimpan sebagai hash 16 karakter, sama seperti di browser.
Token Meta Ads tidak pernah disimpan di database.

## Cara kerja sinkronisasi

- Browser menyimpan revisi akun yang sedang ia cerminkan. **Simpan** menjalankan
  langkah `DailyAgg` yang sama dengan mode lokal terhadap salinan itu (dedup,
  agregasi, pemeriksaan hari, pilih yang berubah), lalu mengirim hasilnya ke
  fungsi `daily_ingest`. Bila anggota lain menyimpan lebih dulu, database menolak
  (revisi berubah), browser menarik data terbaru dan mengulang sekali.
- Penggabungan di database sama dengan `DailyAgg.mergeDaily`. Komisi diganti per
  pesanan dan iklan dengan Ad ID diganti per `(tanggal, Ad ID)`
  (`merge_version` 2); klik dan iklan tanpa Ad ID dijumlahkan (`merge_version` 1).
  Total komisi dihitung ulang dari rincian pesanan dengan urutan kunci yang sama
  dengan browser, sehingga angkanya identik. CPM/CPC/CTR dihitung ulang dari
  total. Database sendiri juga menolak tanggal yang berisi iklan tanpa Ad ID dan
  dengan Ad ID sekaligus, rincian pesanan yang menyusut, serta konversi hari
  komisi format lama yang tidak memuat semua pesanannya. Kolom metrik yang tidak
  ada di file pengganti mempertahankan angka tersimpan (browser mengirim nilai
  yang sudah digabung dari salinan pada revisi yang sama).
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
  bilangan bulat, rincian pesanan yang tidak sama dengan totalnya, Ad ID tidak
  valid, waktu tak hingga atau bertahun lima digit, fingerprint tanpa tanggal
  atau tidak sesuai jumlah baris), agar
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
2. Pilih cara membuat akun:
   - **Anggota mendaftar sendiri** lewat tombol *Daftar* di kartu Database
     bersama. Biarkan *Allow new users to sign up* menyala. Akun baru tidak bisa
     membaca atau menulis apa pun (kartu menampilkan "Menunggu persetujuan")
     sampai admin menyetujuinya di langkah 3. Paket gratis Supabase hanya
     mengirim sedikit email konfirmasi per jam; mematikan *Confirm email* di
     **Authentication → Sign In / Providers → Email** menghindarinya dan tetap
     aman karena persetujuan admin yang membuka akses.
   - **Admin membuat akun**: matikan *Allow new users to sign up*, lalu
     **Authentication → Users → Add user** untuk setiap anggota (centang
     *Auto confirm*).
3. Setujui anggota tim di SQL Editor:
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
paritas angka dengan mode lokal, laporan komisi revisi, tarikan ulang iklan
dengan Ad ID, penolakan simpan ganda nama/Ad ID di database, revisi basi, konflik data offline, hapus
tanggal, pemulihan backup, sinkron bertahap, akun yang dikosongkan, penolakan
riwayat lama dan isi yang tidak valid, kegagalan penarikan setelah simpan, sesi
login, RLS, dan alur login sampai simpan di Chromium. Tanpa Postgres, uji
dilewati kecuali `REQUIRE_DB=1`.

## Batasan yang diketahui

- Unduhan penuh pertama (dan setelah pemulihan backup) memuat seluruh akun,
  termasuk rincian per pesanan dan fingerprint klik/iklan. Untuk satu bulan data
  ini beberapa MB; riwayat bertahun-tahun akan memperlambat unduhan pertama di
  browser baru.
- Ekspor CSV Meta **tanpa kolom Ad ID** tetap dikelompokkan per nama iklan dan
  dijumlahkan. Nama iklan yang sama di beberapa kampanye akan tergabung, dan
  file revisi tanpa Ad ID ditambahkan, bukan mengganti. Pakai tarikan API atau
  sertakan kolom Ad ID di ekspor Ads Manager.
- Pesanan yang hilang dari laporan komisi revisi tidak dihapus otomatis; hapus
  tanggalnya lalu unggah ulang bila pesanan memang dihapus Shopee. Begitu juga
  iklan yang tidak muncul lagi di tarikan ulang Meta (misalnya semua impresinya
  dibatalkan Meta): angka lamanya tetap. Penggantian per rentang tanggal tidak
  dipakai karena satu akun dashboard memuat beberapa akun iklan, dan tarikan
  tanpa filter status tidak memuat iklan yang diarsipkan atau dihapus.
- Ad ID yang dibulatkan Excel (lebih dari 15 digit dan berakhir nol) dianggap
  tidak ada, sehingga baris itu disimpan per nama iklan.
