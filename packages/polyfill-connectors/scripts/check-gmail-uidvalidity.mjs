import { ImapFlow } from 'imapflow';
import { readFileSync } from 'node:fs';

for (const line of readFileSync('/home/user/code/pdpp/.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)='?(.*?)'?$/);
  if (m) process.env[m[1]] = m[2];
}

const client = new ImapFlow({
  host: process.env.GMAIL_IMAP_HOST || 'imap.gmail.com',
  port: 993,
  secure: true,
  auth: { user: process.env.GMAIL_ADDRESS, pass: process.env.GOOGLE_APP_PASSWORD_PDPP },
  logger: false,
});

await client.connect();
const lock = await client.getMailboxLock('[Gmail]/All Mail');
try {
  const mb = client.mailbox;
  console.log('uidValidity type:', typeof mb.uidValidity, 'value:', mb.uidValidity);
  console.log('uidNext type:', typeof mb.uidNext, 'value:', mb.uidNext);
  console.log('highestModseq type:', typeof mb.highestModseq, 'value:', mb.highestModseq);
  console.log('Number(uidValidity):', Number(mb.uidValidity));
  console.log('String(uidValidity):', String(mb.uidValidity));
} finally {
  lock.release();
  await client.logout();
}
