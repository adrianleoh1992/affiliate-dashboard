# Affiliate Ads Dashboard

> **Performance dashboard untuk Shopee Affiliate × Meta Ads** — built by [Berlima Digital](https://berlimadigital.com) untuk tim *Bapak-Bapak Affiliate*.
> Bridging AI, Ads & Business Growth.

Single-page web app yang merge data **Shopee Affiliate Commission Report** dengan **Meta Ads Manager export**, lalu auto-generate decision intelligence (Scale / Pantau / Stop) per affiliate tag.

🔗 **Live:** https://affiliate-dashboard-phi.vercel.app/

---

## Untuk Apa Tool Ini

Affiliate marketer yang jalankan campaign Meta Ads → Shopee Affiliate Link punya 2 sumber data terpisah:
- **Spend & klik** ada di Meta Ads Manager
- **Komisi & order** ada di Shopee Affiliate Dashboard

Tool ini meng-cross-reference keduanya berbasis mapping `Ad Name → Affiliate Tag`, lalu kasih:
- ROAS per tag (komisi / spend)
- Status decision: 🔥 Scale / ⚠️ Pantau / 🛑 Stop berbasis rule yang konfigurable
- Tracking komisi: Selesai / Tertunda / Dibatalkan
- Cross-platform attribution: klik dari Facebook → konversi dari Instagram?
- Decision per periode (1d / 3d / 7d / 14d / 30d)

## Cara Pakai

1. Buka https://affiliate-dashboard-phi.vercel.app/
2. **Tambah akun affiliate** (dropdown di header) — kasih nama sesuai akun Shopee Affiliate-mu
3. Upload 2 file CSV:
   - **Shopee:** export `AffiliateCommissionReport_*.csv` dari [affiliate.shopee.co.id](https://affiliate.shopee.co.id)
   - **Meta Ads:** export Ads Manager → Reports → CSV (level: Ad, kolom: lihat *Format CSV* di bawah)
4. Tool otomatis cross-reference & render dashboard
5. Untuk akun lain: switch via dropdown atau tambah akun baru

Data tersimpan **lokal di browser** (IndexedDB) — tidak ke-upload ke server. Refresh / tutup browser = data tetap. Beda perangkat = state terpisah.

## Format CSV yang Diharapkan

### Shopee Affiliate Commission Report
Export dari [affiliate.shopee.co.id](https://affiliate.shopee.co.id) → Performance → Order. Tool detect via header `ID Pemesanan` atau `Tag_link1`. Kolom kunci yang dipakai:

| Kolom | Untuk |
|---|---|
| `Status Pesanan` | Filter Selesai / Tertunda / Dibatalkan |
| `Waktu Pemesanan` | Tanggal acuan ROAS harian |
| `Waktu Klik` | Sumber attribution |
| `Tag_link1` ... `Tag_link5` | Affiliate tag → mapping ke ad |
| `Total Komisi per Pesanan(Rp)` | Komisi calculated |
| `Komisi Bersih Affiliate (Rp)` | Komisi setelah MCN fee |
| `Platform` | FB / IG / Web sumber klik |
| `L1/L2/L3 Kategori Global` | Breakdown kategori |

### Meta Ads Manager Export
Reports → Customize → Level: **Ad**. Tool detect via header `Ad name` atau `Reporting starts`. Kolom kunci:

| Kolom | Untuk |
|---|---|
| `Reporting starts/ends` | Period |
| `Ad name` | Match ke Tag affiliate (auto-mapping) |
| `Amount spent (IDR)` | Spend untuk ROAS |
| `Link clicks` / `Clicks (all)` | Click metrics |
| `Impressions`, `Reach`, `CTR`, `CPC`, `CPM` | Funnel metrics |
| `Quality / Engagement / Conversion ranking` | Health checks |

## Algoritma Decision-Making

ROAS dihitung dari **Komisi efektif** = Komisi Selesai + (Komisi Tertunda × `0.95`) — faktor probabilitas konfirmasi pending.

| Status | Threshold | Aksi |
|---|---|---|
| 🔥 **SCALE** | ROAS ≥ 2.0 | Naikkan budget |
| ⚠️ **PANTAU** | 1.0 ≤ ROAS < 2.0 | Tahan, monitor |
| 🛑 **STOP** | ROAS < 1.0 selama **3 hari produksi** | Matikan |
| 🌱 **ORGANIK** | Tag tanpa ad spend | Klik & order organik dari konten |

Rule "3 hari produksi" = 3 hari berturut-turut dimana ada **spend > 0** (hari tanpa spend di-skip, bukan dihitung sebagai hari buruk).

Decision dapat dilihat di scope: per Tag (default) / per Ad / per Campaign.

## Auto-Mapping Ad Name → Tag

Tool fuzzy-match nama ad ke affiliate tag (lowercase, hilangkan spasi/karakter spesial, cek substring overlap).

Untuk ad yang tidak ke-detect otomatis, tim bisa **override manual** lewat tab **Pengaturan** — mapping disimpan per-akun, otomatis dipakai upload berikutnya.

## Tech Stack

- Vanilla HTML/JS/CSS — **tidak ada build step**, deploy langsung ke Vercel
- [Chart.js](https://www.chartjs.org/) — visualization
- [PapaParse](https://www.papaparse.com/) — CSV parsing
- [Dexie.js](https://dexie.org/) — IndexedDB wrapper untuk multi-akun persistence
- [Vercel](https://vercel.com/) — hosting

## Struktur Repo

```
affiliate-dashboard/
├── index.html       # Single-file dashboard (UI + algoritma + state)
├── vercel.json      # Vercel deploy config
├── README.md        # Dokumen ini
└── LICENSE          # MIT
```

## Privacy & Data

- **Semua data tetap di browser kamu.** Tool tidak mengirim CSV / data transaksi ke server eksternal.
- Hanya request keluar: load Chart.js, PapaParse, Dexie dari CDN (jsdelivr/cloudflare).
- Kamu bisa hapus semua data via tombol **Reset semua data** di header.

## Roadmap

- [x] Multi-akun dropdown switcher
- [x] IndexedDB persistence
- [x] 3-tier decision engine dengan threshold konfigurable
- [x] Pending commission tracking
- [x] Auto-mapping dengan manual override
- [ ] Shared backend (Supabase) untuk sinkronisasi tim 8 user
- [ ] Direct Meta Ads API + Shopee Affiliate API integration

## Kontribusi

Repo internal Berlima Digital. Issue/saran lewat GitHub welcome.

## Lisensi

MIT — bebas pakai, modify, distribute. Lihat [LICENSE](LICENSE).

---

**Built by [Adrian Leo Hadipradata](https://github.com/adrianleoh1992)** · [Berlima Digital](https://berlimadigital.com) · *Bridging AI, Ads & Business Growth*
