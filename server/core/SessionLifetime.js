const maxAgeMs = 30*24*60*60*1000;
const idleMs = 7*24*60*60*1000;

function expired(session, now = Date.now()) {
    return !session || !Number.isFinite(session.createdAt)
        || now - session.createdAt >= maxAgeMs
        || now - session.updatedAt >= idleMs;
}

module.exports = {expired, maxAgeMs, idleMs};
