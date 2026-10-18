/* ── Shared database panel ───────────────────────────────────────────────────
   Sign-in and sync status for cloud-store.js, shown at the top of Data
   Tersimpan. Renders nothing when SUPABASE_CONFIG is empty, so a deployment
   without Supabase looks exactly as before. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => window.Engine.escapeHtml(value);
  const nf = n => Math.round(n || 0).toLocaleString('id-ID');
  const shared = () => window.__cloudStore || null;
  const name = () => (window.DailyLayer && window.DailyLayer.account()) || '';
  const toast = message => window.toast && window.toast(message);
  let BUSY = false, EMAIL = '', SIGNUP = false;

  function mount() {
    let card = $('cloudCard');
    if (card) return card;
    const panel = document.querySelector('[data-panel="tersimpan"]');
    if (!panel) return null;
    card = document.createElement('div');
    card.className = 'card';
    card.id = 'cloudCard';
    panel.prepend(card);
    return card;
  }

  const TEXT = {
    checking: () => ['Memeriksa database bersama…', ''],
    synced: s => ['Tersinkron', `Data akun ini sama dengan database bersama (revisi ${nf(s.revision)}). Setiap Simpan dan hapus tanggal langsung tercatat untuk seluruh tim.`],
    unlinked: s => ['Belum ada di database bersama', s.localRows
      ? `Browser ini menyimpan ${nf(s.localRows)} agregat untuk akun ini. Kirim sekarang, atau otomatis terkirim saat Anda menekan Simpan berikutnya.`
      : 'Akun dibuat di database bersama saat Anda pertama kali menyimpan laporan.'],
    conflict: s => ['Perlu dipilih', `Browser ini punya ${nf(s.localRows)} agregat yang belum pernah tersinkron, sedangkan database bersama sudah berisi data akun ini. `
      + 'Penyimpanan dihentikan agar tidak ada yang tertimpa diam-diam. Disarankan: Unduh backup, pakai data database bersama, lalu unggah ulang CSV yang disimpan saat offline (baris yang sudah ada otomatis dilewati).'],
    error: s => ['Tidak terhubung', s.message + ' Data tidak disimpan ke mana pun sampai koneksi pulih.'],
    pending: () => ['Menunggu persetujuan', 'Akun ini sudah terdaftar tetapi belum disetujui admin, jadi belum bisa membaca atau menyimpan ke database bersama. '
      + 'Minta admin menambahkan Anda sebagai anggota tim, lalu tekan Periksa ulang. Sampai saat itu, data hanya tersimpan di browser ini.'],
  };

  function render() {
    const store = shared();
    if (!store) return;
    const card = mount();
    if (!card) return;
    const client = store.client;
    if (!client.signedIn) {
      card.innerHTML = `<div class="card-head"><h2>Database bersama</h2><span class="sub">belum masuk</span></div>
        <p class="hint">${SIGNUP
          ? 'Buat akun dengan email dan kata sandi. Setelah mendaftar, minta admin menyetujui akun Anda; sebelum itu database bersama belum bisa dipakai.'
          : 'Masuk untuk memakai riwayat harian yang sama dengan tim untuk semua akun. Belum punya akun? Daftar, lalu minta admin menyetujuinya.'}
          Tanpa masuk, data hanya tersimpan di browser ini.</p>
        <form id="cloudLogin" class="ctrls ctrls-inline">
          <div class="field"><label for="cloudEmail">Email</label><input id="cloudEmail" type="email" autocomplete="username" value="${esc(EMAIL)}" required></div>
          <div class="field"><label for="cloudPass">Kata sandi</label><input id="cloudPass" type="password" minlength="6" autocomplete="${SIGNUP ? 'new-password' : 'current-password'}" required></div>
          <div class="field"><label>&nbsp;</label><button class="btn primary" type="submit" ${BUSY ? 'disabled' : ''}>${SIGNUP ? 'Daftar' : 'Masuk'}</button></div>
          <div class="field"><label>&nbsp;</label><button class="btn ghost" type="button" id="cloudMode" ${BUSY ? 'disabled' : ''}>${SIGNUP ? 'Sudah punya akun? Masuk' : 'Belum punya akun? Daftar'}</button></div>
        </form>`;
      $('cloudMode').onclick = () => { EMAIL = $('cloudEmail').value.trim(); SIGNUP = !SIGNUP; render(); };
      $('cloudLogin').onsubmit = event => {
        event.preventDefault();
        // Read before act() re-renders the form.
        const email = $('cloudEmail').value.trim(), password = $('cloudPass').value;
        EMAIL = email;
        if (SIGNUP) return act(async () => {
          const { confirm } = await client.signUp(email, password);
          SIGNUP = false;
          if (confirm) return toast('Pendaftaran terkirim. Buka link konfirmasi di email ' + email + ', lalu Masuk.');
          await store.sync(name());
          toast('Akun ' + email + ' terdaftar. Minta admin menyetujuinya.');
        });
        act(async () => {
          await client.signIn(email, password);
          await store.sync(name());
          toast('Masuk sebagai ' + client.user.email);
        });
      };
      return;
    }
    const account = name();
    const status = store.status(account);
    // Signed in from another tab, or statuses were reset: check this account.
    if (account && status.state === 'checking' && !store.pending.has(account)) store.sync(account).catch(() => {});
    const [title, detail] = (TEXT[status.state] || TEXT.checking)(status);
    const buttons = [];
    if (status.state === 'unlinked' && status.localRows) buttons.push('<button class="btn sm primary" data-cloud="push">Kirim riwayat lokal</button>');
    if (status.state === 'conflict') {
      buttons.push('<button class="btn sm primary" data-cloud="pull">Pakai data database bersama</button>');
      buttons.push('<button class="btn sm danger" data-cloud="push">Ganti database bersama dengan data browser ini</button>');
    }
    buttons.push('<button class="btn sm" data-cloud="sync">Periksa ulang</button>');
    card.innerHTML = `<div class="card-head"><h2>Database bersama</h2>
        <span class="pill ${status.state === 'synced' ? 'ok-pill' : 'warn-pill'}">${esc(title)}</span>
        <span class="sub">${esc(client.user ? client.user.email : '')}</span>
        <button class="btn sm ghost" data-cloud="logout">Keluar</button></div>
      <p class="hint">${esc(detail)}</p>
      <div class="button-row">${buttons.join('')}</div>`;
    card.querySelectorAll('[data-cloud]').forEach(button => { button.disabled = BUSY; button.onclick = () => handle(button.dataset.cloud); });
  }

  function handle(action) {
    const store = shared(), account = name();
    if (action === 'logout') return act(async () => { await store.client.signOut(); toast('Keluar dari database bersama. Salinan data di browser ini tetap ada.'); });
    if (action === 'sync') return act(() => store.sync(account));
    if (action === 'pull') {
      if (!confirm(`Ganti riwayat harian "${account}" di browser ini dengan data database bersama?\n\nUnduh backup dulu jika data browser ini masih diperlukan.`)) return;
      return act(async () => { await store.usePulled(account); toast('Memakai data database bersama'); });
    }
    if (action === 'push') {
      // The revision on screen is the one the user decides on; the database
      // refuses the replacement if anyone saved after it.
      const status = store.status(account);
      if (!['unlinked', 'conflict'].includes(status.state)) return;
      const expected = status.remote ? status.remote.revision : 0;
      const question = status.state === 'conflict'
        ? `Ganti seluruh riwayat "${account}" di database bersama dengan data browser ini?\n\nData yang disimpan anggota tim lain untuk akun ini akan hilang.`
        : `Kirim ${nf(status.localRows)} agregat riwayat "${account}" dari browser ini ke database bersama?\n\nSetelah itu seluruh tim memakai riwayat ini.`;
      if (!confirm(question)) return;
      return act(async () => { await store.push(account, expected); window.DailyLayer && window.DailyLayer.refresh(); toast('Riwayat lokal terkirim ke database bersama'); });
    }
  }

  async function act(work) {
    if (BUSY) return;
    if (window.DailyLayer && window.DailyLayer.busy()) return toast('Tunggu penyimpanan selesai');
    BUSY = true; render();
    try { await work(); } catch (error) { toast('Database bersama: ' + error.message); }
    finally { BUSY = false; render(); }
  }

  window.CloudPanel = { render };
})();
