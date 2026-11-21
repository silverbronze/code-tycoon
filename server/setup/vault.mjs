// The vault: the secrets cut out of a snapshot, encrypted on this machine.
//
// A random 256-bit data key encrypts the secrets (AES-256-GCM). The data key is
// stored twice, each copy wrapped by a key-encryption key:
//   passphrase    scrypt(passphrase, salt, N=2^17, r=8, p=1)
//   recovery      SHA-256 of a random 160-bit recovery key shown once at creation
// The passphrase, the recovery key and the data key are never written anywhere.
// Node's built-in crypto only, so the whole scheme is this file.
import crypto from 'node:crypto';

const AAD = Buffer.from('code-tycoon-vault-v1');
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 512 << 20 };
const B32 = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'; // Crockford-ish, no I L O U

function seal(key, plain, aad = AAD) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
function open(key, box, aad = AAD) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAAD(aad);
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]);
}

const passKey = (pass, kdf) => crypto.scryptSync(pass.normalize('NFKC'), Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT.maxmem });
const recKey = code => crypto.createHash('sha256').update('code-tycoon-recovery\0' + code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest();

function recoveryCode() {
  const b = crypto.randomBytes(20); // 160 bits -> 32 base32 chars
  let bits = 0, val = 0, out = '';
  for (const x of b) { val = (val << 8) | x; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  return out.match(/.{4}/g).join('-');
}

// A new vault. Returns { vault, recovery, key } (recovery is shown to the person once).
export function createVault(passphrase) {
  const key = crypto.randomBytes(32);
  const recovery = recoveryCode();
  const kdf = { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: crypto.randomBytes(16).toString('base64') };
  const vault = {
    format: 'code-tycoon-vault', version: 1, cipher: 'aes-256-gcm',
    keys: [
      { kind: 'passphrase', kdf, ...seal(passKey(passphrase, kdf), key) },
      { kind: 'recovery', kdf: { name: 'sha256' }, ...seal(recKey(recovery), key) },
    ],
    data: null,
  };
  return { vault, recovery, key };
}

// The data key, from the passphrase or the recovery key. Throws on a wrong one.
export function unlock(vault, secret, kind = 'passphrase') {
  if (vault?.format !== 'code-tycoon-vault' || vault.version !== 1) throw new Error('not a Code Tycoon vault (or a newer version)');
  const k = vault.keys.find(x => x.kind === kind);
  if (!k) throw new Error(`this vault has no ${kind} key`);
  try { return open(kind === 'passphrase' ? passKey(secret, k.kdf) : recKey(secret), k); }
  catch { throw new Error(kind === 'passphrase' ? 'wrong passphrase' : 'wrong recovery key'); }
}

export function writeSecrets(vault, key, secrets) {
  vault.data = seal(key, Buffer.from(JSON.stringify(secrets)));
  return vault;
}
export function readSecrets(vault, key) {
  return vault.data ? JSON.parse(open(key, vault.data).toString('utf8')) : {};
}

// Hidden prompt on a terminal, or CODETYCOON_PASSPHRASE when there is none.
export async function askSecret(prompt, envName = 'CODETYCOON_PASSPHRASE') {
  if (process.env[envName]) return process.env[envName];
  if (!process.stdin.isTTY) throw new Error(`no terminal to ask on; set ${envName}`);
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin; let s = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const on = ch => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { done(); return resolve(s); }
        if (c === '\u0003') { done(); return reject(new Error('cancelled')); }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
    };
    const done = () => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); process.stdout.write('\n'); };
    stdin.on('data', on);
  });
}
