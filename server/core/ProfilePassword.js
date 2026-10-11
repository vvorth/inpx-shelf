const crypto = require('crypto');
const {promisify} = require('util');
const {t} = require('./i18n');
const scrypt = promisify(crypto.scrypt);

// OWASP's 16 MiB scrypt configuration; version fixes costs independently of input.
const prefix = 'scrypt:v1:';
const options = {N: 16384, r: 8, p: 5, maxmem: 32*1024*1024};
const maxPasswordBytes = 4096;
let active = 0;

// OPDS clients send the password with every request, and scrypt takes ~0.3 s inside the
// profile store lock. Remember recent successes; the stored hash is part of the key, so a
// password change drops them. HMAC with a process key: the cache is no offline shortcut.
const verifiedKey = crypto.randomBytes(32);
const verified = new Map();
const verifiedTtlMs = 10*60*1000;
const verifiedMax = 1000;

function verifiedId(stored, password) {
    return crypto.createHmac('sha256', verifiedKey).update(`${stored}\0${password}`).digest('hex');
}

function legacy(login, password) {
    return crypto.createHash('sha256').update(`${String(login || '').trim().toLowerCase()}::${String(password || '')}`).digest('hex');
}

async function derive(password, salt) {
    if (Buffer.byteLength(String(password || '')) > maxPasswordBytes)
        throw new Error(t('errors.passwordTooLong'));
    if (active >= 4)
        throw new Error(t('errors.passwordCheckBusy'));
    active++;
    try {
        return await scrypt(String(password || ''), salt, 32, options);
    } finally {
        active--;
    }
}

async function hash(password) {
    const salt = crypto.randomBytes(16);
    const key = await derive(password, salt);
    return `${prefix}${salt.toString('hex')}:${key.toString('hex')}`;
}

function isLegacy(value) {
    return /^[a-f0-9]{64}$/.test(value);
}

async function verify(stored, login, password) {
    if (Buffer.byteLength(String(password || '')) > maxPasswordBytes)
        return false;
    if (isLegacy(stored))
        return crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(legacy(login, password), 'hex'));
    const match = /^scrypt:v1:([a-f0-9]{32}):([a-f0-9]{64})$/.exec(stored);
    if (!match)
        return false;
    const id = verifiedId(stored, String(password || ''));
    if (verified.get(id) > Date.now())
        return true;
    const key = await derive(password, Buffer.from(match[1], 'hex'));
    if (!crypto.timingSafeEqual(key, Buffer.from(match[2], 'hex')))
        return false;
    verified.delete(id);
    if (verified.size >= verifiedMax)
        verified.delete(verified.keys().next().value);
    verified.set(id, Date.now() + verifiedTtlMs);
    return true;
}

module.exports = {hash, verify, isLegacy, legacy};
