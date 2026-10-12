// Расписание очистки кешей (интервал или cron) и лимиты их размеров: чистые функции от конфига
const utils = require('./utils');
const {t} = require('./i18n');

function cleanDirInterval(config) {
    const minutes = parseFloat(config.cacheCleanInterval);
    if (!Number.isFinite(minutes) || minutes <= 0)
        return 0;

    return minutes*60*1000;
}

function cleanDirNextAlignedDelay(config, now = new Date()) {
    const interval = cleanDirInterval(config);
    if (!interval)
        return null;

    const date = now instanceof Date ? now : new Date(now);
    const localTime = date.getTime() - date.getTimezoneOffset()*60*1000;
    const remainder = ((localTime % interval) + interval) % interval;
    return Math.round(remainder === 0 ? 0 : interval - remainder);
}

function parseCronField(field, min, max, options = {}) {
    const text = String(field || '').trim().toLowerCase();
    const values = new Set();
    const aliases = options.aliases || {};
    const normalize = options.normalize || (value => value);
    const inputMin = options.inputMin === undefined ? min : options.inputMin;
    const inputMax = options.inputMax === undefined ? max : options.inputMax;
    const parseValue = (value) => {
        const normalized = aliases[String(value || '').toLowerCase()];
        const number = parseInt(normalized !== undefined ? normalized : value, 10);
        if (!Number.isFinite(number))
            throw new Error(t('errors.cronInvalidValue', {value}));

        if (number < inputMin || number > inputMax)
            throw new Error(t('errors.cronOutOfRange', {value}));

        return number;
    };

    if (!text)
        throw new Error(t('errors.cronEmptyField'));

    for (const token of text.split(',')) {
        const item = token.trim();
        if (!item)
            throw new Error(t('errors.cronEmptyValue'));

        const [rangeText, stepText] = item.split('/');
        const step = stepText === undefined ? 1 : parseInt(stepText, 10);
        if (!Number.isFinite(step) || step <= 0)
            throw new Error(t('errors.cronInvalidStep', {value: item}));

        let start;
        let end;
        if (rangeText === '*') {
            start = min;
            end = max;
        } else if (rangeText.includes('-')) {
            const parts = rangeText.split('-');
            if (parts.length !== 2)
                throw new Error(t('errors.cronInvalidRange', {value: item}));

            start = parseValue(parts[0]);
            end = parseValue(parts[1]);
        } else {
            start = parseValue(rangeText);
            end = start;
        }

        if (start > end)
            throw new Error(t('errors.cronInvalidRange', {value: item}));

        for (let value = start; value <= end; value += step) {
            const normalized = normalize(value);
            if (normalized < min || normalized > max)
                throw new Error(t('errors.cronOutOfRange', {value}));

            values.add(normalized);
        }
    }

    return values;
}

function parseCleanDirCron(schedule) {
    const fields = String(schedule || '').trim().split(/\s+/);
    if (fields.length !== 5)
        throw new Error(t('errors.cronFormat'));

    const monthAliases = {
        jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
        jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    };
    const weekAliases = {
        sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
    };

    return {
        minute: parseCronField(fields[0], 0, 59),
        hour: parseCronField(fields[1], 0, 23),
        dayOfMonth: parseCronField(fields[2], 1, 31),
        month: parseCronField(fields[3], 1, 12, {aliases: monthAliases}),
        dayOfWeek: parseCronField(fields[4], 0, 6, {
            aliases: weekAliases,
            inputMax: 7,
            normalize: value => value === 7 ? 0 : value,
        }),
        dayOfMonthAny: fields[2] === '*',
        dayOfWeekAny: fields[4] === '*',
    };
}

function cleanDirCronMatches(parsed, date) {
    if (!parsed.minute.has(date.getMinutes()) || !parsed.hour.has(date.getHours()) || !parsed.month.has(date.getMonth() + 1))
        return false;

    const dayOfMonthMatches = parsed.dayOfMonth.has(date.getDate());
    const dayOfWeekMatches = parsed.dayOfWeek.has(date.getDay());
    if (parsed.dayOfMonthAny && parsed.dayOfWeekAny)
        return true;
    if (parsed.dayOfMonthAny)
        return dayOfWeekMatches;
    if (parsed.dayOfWeekAny)
        return dayOfMonthMatches;

    return dayOfMonthMatches || dayOfWeekMatches;
}

function cleanDirNextCronDelay(schedule, now = new Date()) {
    const parsed = parseCleanDirCron(schedule);
    const current = now instanceof Date ? now : new Date(now);
    const candidate = new Date(current.getTime());
    candidate.setSeconds(0, 0);

    if (cleanDirCronMatches(parsed, candidate))
        return 0;

    candidate.setMinutes(candidate.getMinutes() + 1);
    for (let i = 0; i < 366*24*60; i++) {
        if (cleanDirCronMatches(parsed, candidate))
            return Math.max(0, candidate.getTime() - current.getTime());

        candidate.setMinutes(candidate.getMinutes() + 1);
    }

    throw new Error(t('errors.cronNoNextRun'));
}

function cleanDirSchedule(config) {
    if (!utils.hasProp(config, 'cacheCleanSchedule'))
        return null;

    return String(config.cacheCleanSchedule || '').trim();
}

function cleanDirNextScheduledDelay(config, now = new Date()) {
    const schedule = cleanDirSchedule(config);
    if (schedule !== null)
        return schedule ? cleanDirNextCronDelay(schedule, now) : null;

    return cleanDirNextAlignedDelay(config, now);
}

function cleanDirMaxSize(value) {
    if (value === null || value === undefined || value === '')
        return null;

    const maxSize = Number(value);
    return (Number.isFinite(maxSize) && maxSize >= 0 ? maxSize : null);
}

function cleanDirTargetRatio(value) {
    const ratio = Number(value);
    if (!Number.isFinite(ratio) || ratio <= 0)
        return 0.8;

    return Math.max(0.1, Math.min(1, ratio));
}

function cleanDirTargetSize(maxSize, value, ratio) {
    const targetSize = cleanDirMaxSize(value);
    if (targetSize !== null)
        return Math.max(0, Math.min(maxSize, targetSize));

    return Math.floor(maxSize * cleanDirTargetRatio(ratio));
}

module.exports = {cleanDirInterval, cleanDirNextAlignedDelay, parseCleanDirCron, cleanDirSchedule, cleanDirNextScheduledDelay, cleanDirMaxSize, cleanDirTargetRatio, cleanDirTargetSize};
