import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { fileURLToPath } from 'url';

// __dirname replacement for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * CONFIG
 */
const GMAIL_USER = 'gegagagua@gmail.com';
const GMAIL_APP_PASSWORD = 'YOUR_APP_PASSWORD_HERE';
const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;

const SENDER = 'gega.gagua@slick.global';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const CRON_SCHEDULE = '*/5 * * * *'; // ყოველ 5 წუთში

if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !SENDER) {
  console.error('Missing required config values');
  process.exit(1);
}

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const STATE_FILE = path.join(DOWNLOAD_DIR, 'state.json');

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { processedUids: [] };
    }

    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (error) {
    console.error('Failed to load state file:', error.message);
    return { processedUids: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function isExcelFile(filename = '', contentType = '') {
  const lower = filename.toLowerCase();

  return (
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xls') ||
    lower.endsWith('.csv') ||
    contentType.includes('spreadsheetml') ||
    contentType.includes('ms-excel') ||
    contentType.includes('csv')
  );
}

async function processMailbox() {
  const state = loadState();
  const processedUids = new Set(state.processedUids || []);

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
    logger: false,
  });

  try {
    await client.connect();

    const lock = await client.getMailboxLock('INBOX');

    try {
      const query = {
        seen: false,
        from: SENDER,
      };

      for await (const msg of client.fetch(query, {
        uid: true,
        envelope: true,
        source: true,
      })) {
        if (processedUids.has(msg.uid)) {
          continue;
        }

        const parsed = await simpleParser(msg.source);

        if (!parsed.attachments || parsed.attachments.length === 0) {
          processedUids.add(msg.uid);
          continue;
        }

        let savedAny = false;

        for (const att of parsed.attachments) {
          const filename = att.filename || `attachment-${Date.now()}`;

          if (!isExcelFile(filename, att.contentType || '')) {
            continue;
          }

          const safeName = sanitizeFileName(filename);
          const finalPath = path.join(
            DOWNLOAD_DIR,
            `${msg.uid}-${Date.now()}-${safeName}`
          );

          fs.writeFileSync(finalPath, att.content);
          savedAny = true;

          console.log(`Saved: ${finalPath}`);
          console.log(`From: ${parsed.from?.text || 'Unknown'}`);
          console.log(`Subject: ${parsed.subject || ''}`);
        }

        if (savedAny) {
          await client.messageFlagsAdd(msg.uid, ['\\Seen']);
        }

        processedUids.add(msg.uid);
      }
    } finally {
      lock.release();
    }

    const trimmed = Array.from(processedUids).slice(-5000);
    saveState({ processedUids: trimmed });

    await client.logout();
  } catch (error) {
    console.error('IMAP processing error:', error);

    try {
      await client.logout();
    } catch {}
  }
}

console.log(`Watcher started. Schedule: ${CRON_SCHEDULE}`);

await processMailbox();

cron.schedule(CRON_SCHEDULE, async () => {
  console.log(`Checking mailbox at ${new Date().toISOString()}`);
  await processMailbox();
});