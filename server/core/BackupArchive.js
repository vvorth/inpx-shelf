const fs = require('fs-extra');
const path = require('path');
const StreamZip = require('node-stream-zip');
const {limits} = require('./RequestLimits');
const {t} = require('./i18n');
const BackupFiles = require('./BackupFiles');

// discovery-cache.json: older and upstream inpx-web backups carry it; it is rebuilt, never restored
const names = new Set(['backup-info.json', 'discovery-cache.json', ...BackupFiles.names]);

// `only`: the data files this archive may hold (the author names import takes a names-only archive)
// source: {file} - the uploaded ZIP on disk, or {buffer}
async function read(source, config, folder, options = {}) {
    const maximum = limits(config);
    let file = source && source.file;
    if (!file && source && Buffer.isBuffer(source.buffer)) {
        file = path.join(folder, 'backup.zip');
        await fs.writeFile(file, source.buffer, {mode: 0o600});
    }
    if (!file || !await fs.pathExists(file))
        throw new Error(t('errors.backupTooLargeOrInvalid'));
    if ((await fs.stat(file)).size > maximum.backup)
        throw new Error(t('errors.backupTooLarge'));
    const zip = new StreamZip.async({file});
    try {
        const entries = Object.values(await zip.entries());
        if (entries.length > names.size || await zip.entriesCount !== entries.length)
            throw new Error(t('errors.backupTooManyFiles'));
        let declared = 0;
        for (const entry of entries) {
            if (!names.has(entry.name) || entry.isDirectory || (options.only && BackupFiles.names.includes(entry.name) && !options.only.includes(entry.name)))
                throw new Error(t('errors.backupUnknownFile'));
            declared += entry.size;
            if (!Number.isSafeInteger(entry.size) || entry.size < 0 || declared > maximum.expanded)
                throw new Error(t('errors.backupUnpackedTooLarge'));
        }
        const result = {};
        let total = 0;
        for (const entry of entries) {
            if (entry.name === 'discovery-cache.json')
                continue;
            const stream = await zip.stream(entry.name);
            const chunks = [];
            for await (const chunk of stream) {
                total += chunk.length;
                if (total > maximum.expanded) {
                    stream.destroy();
                    throw new Error(t('errors.backupUnpackedTooLarge'));
                }
                chunks.push(chunk);
            }
            result[entry.name] = Buffer.concat(chunks);
        }
        const wanted = options.only || ['config.json', 'reading-lists.json'];
        if (!result['backup-info.json'] || !wanted.some(name => result[name]))
            throw new Error(options.only ? t('errors.backupMissingFile', {name: wanted.join(', ')}) : t('errors.backupNotFull'));
        for (const name of Object.keys(result)) {
            if (name !== 'backup-info.json')
                result[name] = BackupFiles.parse(name, result[name]);
        }
        const key = result['secret.key'];
        if (key && (!result['config.json'] || !/^[A-Za-z0-9+/]{43}=\s*$/.test(key.toString('utf8'))))
            throw new Error(t('errors.backupKeyDamaged'));
        return result;
    } finally {
        await zip.close();
    }
}

module.exports = {read};
