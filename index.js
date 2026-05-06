import TelegramBot from "node-telegram-bot-api";
import { google } from "googleapis";

/* =======================
   ENV
======================= */
const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;

const SHEET_NAME = "DB INCES"; // ganti ke "DB LGN" kalau sheet tab kamu DB LGN

if (!BOT_TOKEN || !SHEET_ID || !GOOGLE_CREDENTIALS) {
  console.error("❌ ENV belum lengkap");
  process.exit(1);
}

/* =======================
   GOOGLE SHEETS
======================= */
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

/* =======================
   TELEGRAM BOT (LONG POLLING — OPTIMIZED)
======================= */
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    autoStart: false,
    interval: 0,
    params: {
      timeout: 50,
      allowed_updates: ["message"],
    },
  },
});

// Bersihin webhook lama dari setup Render
await bot.deleteWebHook({ drop_pending_updates: true });

// Start long polling
await bot.startPolling();

console.log("🤖 BOT VCARD aktif (polling mode) — FILE PASTI TERKIRIM");

/* =======================
   UTIL
======================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Split array jadi potongan fix perChunk.
 * contoh: splitBySize([..1500..], 500) => 3 chunks masing2 500
 */
const splitBySize = (arr, perChunk) => {
  const out = [];
  for (let i = 0; i < arr.length; i += perChunk) {
    out.push(arr.slice(i, i + perChunk));
  }
  return out;
};

/* =======================
   COMMAND MAP
======================= */
const COMMANDS = {
  vcardfresh: { col: "A", label: "FRESH" },
  vcardfu: { col: "D", label: "FU" },
};

/* =======================
   QUEUE
======================= */
const queue = [];
let busy = false;

async function processQueue() {
  if (busy || queue.length === 0) return;
  busy = true;

  const job = queue.shift();
  const { chatId, userId, perFile, fileCount, type } = job;

  const cmd = COMMANDS[type];
  if (!cmd) {
    busy = false;
    return processQueue();
  }

  const { col, label } = cmd;

  try {
    await bot.sendMessage(chatId, "📥 Sebentar, otw kirim...");

    // WAJIB: user harus pernah /start biar bot bisa japri
    await bot.sendMessage(userId, "⏳ Sebentar beb...");

    const totalNeed = perFile * fileCount;

    // GET numbers from sheet
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!${col}:${col}`,
    });

    const numbers = (res.data.values || [])
      .map((v) => String(v?.[0] ?? "").replace(/\D/g, ""))
      .filter((v) => v.length >= 10);

    if (numbers.length < totalNeed) {
      await bot.sendMessage(
        chatId,
        `❌ Stok tidak cukup.\nButuh: ${totalNeed}\nTersedia: ${numbers.length}`
      );
      busy = false;
      return processQueue();
    }

    // TAKE totalNeed numbers, then split by perFile into fileCount files
    const selectedAll = numbers.slice(0, totalNeed);
    const remain = numbers.slice(totalNeed);

    const files = splitBySize(selectedAll, perFile); // harusnya panjang = fileCount
    // keamanan: kalau karena bug jadi lebih, potong aja
    const filesToSend = files.slice(0, fileCount);

    // kirim file
    let globalCounter = 1;
    for (let i = 0; i < filesToSend.length; i++) {
      const chunkNums = filesToSend[i];

      const vcardText = chunkNums
        .map(
          (n) => `BEGIN:VCARD
VERSION:3.0
FN:${label}-${globalCounter++}
TEL;TYPE=CELL:${n}
END:VCARD`
        )
        .join("\n");

      const buffer = Buffer.from(vcardText, "utf8");

      await bot.sendDocument(
        userId,
        buffer,
        {},
        {
          filename: `${label}_${i + 1}.vcf`,
          contentType: "text/vcard",
        }
      );

      await sleep(1200);
    }

    // UPDATE SHEET (hapus kolom, lalu isi sisa)
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!${col}:${col}`,
    });

    if (remain.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!${col}1`,
        valueInputOption: "RAW",
        requestBody: {
          values: remain.map((v) => [v]),
        },
      });
    }

    await bot.sendMessage(
      userId,
      `✅ Selesai.\nDikirim: ${fileCount} file\nIsi per file: ${perFile}\nTotal: ${totalNeed}`
    );
  } catch (e) {
    console.error("❌ ERROR:", e);
    await bot.sendMessage(
      chatId,
      "❌ Gagal kirim file. Pastikan kamu sudah /start bot dulu (biar bot bisa japri)."
    );
  }

  busy = false;
  processQueue();
}

/* =======================
   MESSAGE HANDLER
======================= */
bot.on("message", (msg) => {
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (msg.text === "/start") {
    bot.sendMessage(
      chatId,
      "✅ Bot aktif.\n\nFormat:\n#vcardfresh JUMLAH_PER_FILE JUMLAH_FILE\n#vcardfu JUMLAH_PER_FILE JUMLAH_FILE\n\nContoh:\n#vcardfresh 500 3\n(= kirim 3 file, masing-masing isi 500 nomor)"
    );
    return;
  }

  // format: #vcardfresh 500 3
  const m = msg.text.match(/^#(vcardfresh|vcardfu)\s+(\d+)\s+(\d+)$/i);
  if (!m) return;

  const type = m[1].toLowerCase();
  const perFile = parseInt(m[2], 10);
  const fileCount = parseInt(m[3], 10);

  if (!Number.isFinite(perFile) || perFile <= 0) {
    bot.sendMessage(chatId, "❌ JUMLAH_PER_FILE harus angka > 0");
    return;
  }
  if (!Number.isFinite(fileCount) || fileCount <= 0) {
    bot.sendMessage(chatId, "❌ JUMLAH_FILE harus angka > 0");
    return;
  }

  // optional safety limit biar gak kebangetan (ubah sesuai kebutuhan)
  const total = perFile * fileCount;
  if (total > 50000) {
    bot.sendMessage(chatId, "❌ Kebanyakan. Turunin jumlahnya dulu.");
    return;
  }

  queue.push({ chatId, userId, type, perFile, fileCount });
  processQueue();
});

// Error handler buat polling errors (network glitch, dll) — bot gak crash diam-diam
bot.on("polling_error", (err) => {
  console.error("⚠️ Polling error:", err.code, "-", err.message);
});
