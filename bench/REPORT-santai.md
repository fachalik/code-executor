# Laporan Tes Code-Executor — Versi Santai

_Ngobrolin hasil tes beban & keamanan pakai bahasa sehari-hari. Nggak perlu ngerti istilah
teknis dulu — semua dijelasin sambil jalan._

---

## Ini project apa sih?

Aplikasi ini bikin user bisa nulis kode di halaman web terus **dijalanin di server**. Keren buat
playground coding, tapi ngeri juga: kamu ngejalanin **kode yang nggak kamu percaya** di
**mesin kamu sendiri**. Pengamannya namanya **sandbox** — kotak terkunci: kodenya boleh jalan,
tapi nggak boleh nyentuh file kamu, nggak boleh nembak internet, nggak boleh nge-crash server.

Project ini nyediain **empat sandbox**, masing-masing ngunci kotaknya dengan cara beda:

| Engine | Versi satu baris |
|---|---|
| **Piston** | Jalanin kode di Node.js / Python beneran, di dalam container yang dikunci. |
| **Judge0** | Mirip, tapi sekalian ngukur berapa CPU sama memori tiap run. |
| **QuickJS** | Jalanin JavaScript di interpreter mungil — lambat, tapi target serangannya kecil banget. |
| **isolated-vm** | Jalanin JavaScript di engine cepat (V8, mesinnya Chrome), tapi di gelembung sendiri. |

Tugas saya jawab dua hal: **secepat apa dia?** dan **bisa nggak kode jahat kabur dari kotaknya?**

---

## Bagian 1 — Secepat apa tiap engine?

10 user bareng, 20 detik, program yang sama.

### Program remeh (cuma ngetes biaya "nyalain" run)

| Engine | Waktu / run | Run / detik | Bacaan gampangnya |
|---|--:|--:|---|
| **isolated-vm** | **7 ms** | **1.487** | Ngebut. Nyaris instan. |
| **QuickJS** | 87 ms | 115 | Oke buat sesekali, lambat kalau volume banyak. |
| **Piston** | 686 ms | 14 | Lambat — tiap run dia nyalain program beneran dari nol. |
| **Judge0** | 1.025 ms | 5 | Paling lambat (dan sebenernya nggak bisa jalan — lihat bawah). |

**Kenapa bedanya jauh?** isolated-vm engine-nya udah anget, tinggal kasih gelembung baru —
murah. Piston tiap kali **nyalain proses OS baru dari nol** (kayak buka aplikasi baru terus-terusan),
itu emang mahal. Makanya ada "lantai dasar" ~0,6 detik.

### Program berat (3 juta akar kuadrat)

| Engine | Waktu / run | Bacaan gampangnya |
|---|--:|---|
| **isolated-vm** | **20 ms** | Nyaris nggak kerasa. |
| **Piston** | 771 ms | Matematikanya cepet; biaya nyalainnya yang berat. |
| **QuickJS** | **2.673 ms** | Anjlok total. |

**Kenapa QuickJS anjlok?** Dua alasan, dua-duanya emang sengaja:
1. **Nggak ada JIT.** JIT itu trik yang bikin JavaScript modern kenceng (nerjemahin kode ke bahasa
   mesin sambil jalan). QuickJS sengaja nggak pakai — soalnya penerjemah itu justru bagian yang
   sering diserang. Nggak ada JIT = target lebih kecil, lebih aman. Bayarannya: kecepatan.
2. **Cuma satu jalur.** Pas ada satu program berat jalan, yang lain harus antre di belakangnya.
   Jadi kode berat nggak cuma lambat, tapi **nge-block semua orang juga**.

**Intinya:** isolated-vm juaranya soal ngebut, jauh. QuickJS oke buat script ringan-cepat, tapi
salah alamat buat komputasi berat.

---

## Bagian 2 — Pas ada yang error, gimana?

Sandbox yang bagus bukan cuma jalanin kode baik — dia harus **selamat** dari kode nakal.

- **Loop nggak berhenti (`while(true)`)** → isolated-vm sama QuickJS dua-duanya stop rapi di
  batas 5 detik; Piston dibunuh ~3 detik. Semua lolos. Catatan: QuickJS, gara-gara cuma satu
  jalur, bikin loop tak-hingga ngelambatin user lain selama lagi dihentiin.
- **Bom memori (makan memori sampe abis)** → isolated-vm nangkepnya rapi (error "out of memory"
  yang bersih). QuickJS **nggak** — container-nya kehabisan memori terus **restart sendiri**.
  Masih ketahan sih (nggak ngerobohin mesin), tapi kasar: request-nya mati putus koneksi, dan
  request lain yang lagi numpang di container itu ikut mati. Ini perlu diperbaiki.
- **Banjir output** → dua sandbox motong di ~256 KB, nggak dibiarin membengkak.
- **Kebanjiran 50 user sekaligus** → dua-duanya **nolak kelebihan** daripada crash. QuickJS
  bikin antre (ada yang nunggu ~14 detik), isolated-vm nolak seketika. Nggak ada yang tumbang.

---

## Bagian 3 — Bisa nggak kodenya kabur dari kotak? (Keamanan)

**Skornya: 21 dari 27 serangan contained (ketahan).** Yang jebol ngumpul di dua masalah nyata.

### 🟢 Dua sandbox JavaScript bersih total
QuickJS sama isolated-vm nahan semuanya: nggak bisa nyentuh network, nggak nemu host object yang
tersembunyi, nggak ninggalin state buat run berikutnya. Kalau kamu butuh ngejalanin JavaScript
yang nggak dipercaya, **dua ini beres tugasnya.**

### 🔴 Kebocorannya numpuk di jalur Piston
Semua yang leak berpangkal di dua hal: **network yang masih kebuka**, dan **sanitizer yang
dipercaya kelewat jauh.**

**Serangan yang beneran tembus cuma 2, dua-duanya di Piston:**

| # | Serangan | Bukti |
|---|---|---|
| 1 | Network lewat JS: `globalThis['fet'+'ch'](...)` | Nyampe ke `backend:3001`, dapet balasan `NET-OK` |
| 2 | Network lewat Python: `import socket` | Nyampe ke `backend:3001`, dapet `NET-OK` |

Gara-gara `PISTON_DISABLE_NETWORKING: "false"`, blokir network-nya **mati**. Jadi kode sandbox
bisa nembak service internal lain di mesin kamu (database, backend, secret cloud). **Ini temuan
paling gawat.** Benerinnya satu kata: ubah `"false"` jadi `"true"`.

**Kenapa sanitizer nggak bisa dipercaya:** dia cuma scan teks kode sebelum dijalanin. Buat Python
dia **nggak punya aturan sama sekali**, dan buat JavaScript gampang dikadalin — tinggal tulis
`fetch` jadi `'fet'+'ch'`, teks `fetch(` nggak muncul, lolos. Scanner teks nggak akan pernah bisa
jadi tembok asli. Tembok aslinya harus container — yang balik lagi ke masalah network kebuka tadi.

### 🟠 Dua masalah lain
- **Nggak ada rate limit / login** — 30 request beruntun nggak ada yang ditolak. Satu orang bisa
  bikin semua engine sibuk dan ngunci user beneran.
- **Judge0 nggak bisa jalan di sini** — butuh fitur Linux lama ("cgroup v1") yang nggak ada di Mac.
  Tiap run gagal "Internal Error". Bukan bug project — README-nya udah ngingetin. Jalan kok di
  server Linux beneran.

### Soal "6 kegagalan" di output
6 dari 27 kelihatan gagal, tapi akarnya cuma 2:
- **Egress Piston** (2 kasus: JS + Python) — bocor beneran.
- **QuickJS** (4 sisanya) — ini cuma efek tes beruntun: tes loop tak-hingga sempet nge-jam satu
  jalur QuickJS, jadi tes berikutnya timeout. Pas dites sendiri-sendiri, lolos bersih (udah saya
  cek: timeout rapi, state fresh). Jadi bukan jebol — itu cuma "satu jalur"-nya QuickJS nongol.

---

## Yang perlu diperbaiki, per engine

### 🔴 Piston (paling mendesak)
1. Matiin egress: `PISTON_DISABLE_NETWORKING: "true"`. Nutup serangan #1 dan #2 sekaligus.
2. Jangan andelin sanitizer sebagai tembok. Kalau tetep dipakai, tambahin aturan Python; tapi
   anggep nsjail yang jadi batas asli.
3. Benerin kontrak `ok:true` — Piston selalu bilang sukses walau timeout/dibunuh. Harusnya baca
   status detailnya kayak engine lain.

### 🔴 Judge0
1. Nggak jalan di Mac (cgroup v2) — pindah ke host Linux, atau nyalain cgroup v1.
2. Nyalain auth — sekarang kebuka tanpa login di `0.0.0.0:2358`.
3. Runtime-nya jadul (Node 12, Python 3.8) — ada celah lama, update.

### ⚠️ QuickJS
1. Bom memori bikin container restart. Bikin biar balas `out_of_memory` yang rapi, jangan putus
   koneksi. Atau turunin batas memori container biar mendekati batas guest.
2. Satu jalur → kode berat/loop nge-block yang lain. Pindahin eksekusinya ke **worker thread**
   (kayak isolated-vm) biar satu job berat nggak nahan yang lain.

### ✅ isolated-vm (paling kuat, tinggal poles)
1. Batasnya V8-dengan-JIT — kalau V8-nya jebol, jebol ke proses. Rajin update `isolated-vm` +
   Node/V8. Container-nya udah `read_only` + buang semua hak akses (bagus, pertahanin).

### 🟠 Semua engine (lapis backend)
1. Tambah **rate limit** — sekarang tanpa batas.
2. Tambah **auth** kalau bukan internal doang.
3. Tambah **helmet** — sekarang bocorin `X-Powered-By: Express`.

---

## Kesimpulan

- **JavaScript nggak dipercaya, mau cepet?** → **isolated-vm.** Paling ngebut, paling rapi nangani
  input nakal, paling kuat nahan. (Catatan: cepetnya dari JIT V8, permukaan serangannya lebih gede
  dari QuickJS.)
- **JavaScript nggak dipercaya, aman lebih penting dari cepet?** → **QuickJS.** Simpel dan aman.
  Jaga jobnya ringan, benerin urusan bom memori.
- **Butuh Python beneran / banyak bahasa?** → **Piston** — tapi **matiin network dulu**, terus
  kasih rate limit.
- **Butuh ukur CPU/memori per run?** → **Judge0** — cuma jalan di server Linux beneran.

**Tiga yang wajib dibenerin, urut prioritas:**
1. 🔴 Nyalain lagi blokir network Piston — `PISTON_DISABLE_NETWORKING: "true"`.
2. 🔴 Berhenti ngandelin sanitizer sebagai keamanan; container-nya yang jadi tembok asli.
3. 🟠 Tambah rate limit biar nggak ada yang bisa nge-banjirin service.

---

_Versi lengkap teknis: `bench/REPORT.md`. Versi penjelasan (Inggris): `bench/REPORT-explained.md`.
Data mentah: `bench/results/`._
