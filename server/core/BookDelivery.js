const fs = require('fs-extra');
const axios = require('axios');
const FormData = require('form-data');
const nodemailer = require('nodemailer');

const {t, msg} = require('./i18n');

// Sending books to Telegram and email, and checking those integrations. Mixed into
// WebWorker.prototype: `this` is the worker.

const deliveryWindowMs = 60*60*1000;

function formatTemplate(template, book = {}) {
    return String(template || '')
        .replace(/\$\{AUTHOR\}/g, book.author || '')
        .replace(/\$\{TITLE\}/g, book.title || '')
        .replace(/\$\{SERIES\}/g, book.series || '')
        .replace(/\$\{EXT\}/g, book.ext || '');
}

module.exports = {
    buildSmtpTransportOptions() {
        return {
            host: this.config.smtpHost,
            port: parseInt(this.config.smtpPort, 10) || 587,
            secure: !!this.config.smtpSecure,
            auth: (this.config.smtpUser ? {
                user: this.config.smtpUser,
                pass: this.config.smtpPass,
            } : undefined),
        };
    },

    async testAdminIntegrationConfig(userId = '', profileAccessToken = '', kind = '') {
        this.checkMyState();
        await this.requireAdmin(userId, profileAccessToken);

        const normalizedKind = String(kind || '').trim().toLowerCase();
        if (normalizedKind === 'smtp') {
            if (!this.config.smtpHost)
                throw new Error(t('errors.smtpHostMissing'));

            const transporter = nodemailer.createTransport(this.buildSmtpTransportOptions());
            await transporter.verify();
            return {success: true, message: t('admin.smtpVerified')};
        }

        if (normalizedKind === 'telegram') {
            if (!this.config.telegramBotToken)
                throw new Error(t('errors.telegramTokenMissing'));

            const response = await axios.get(`https://api.telegram.org/bot${this.config.telegramBotToken}/getMe`, {
                timeout: 15000,
            });

            if (!response.data || response.data.ok !== true)
                throw new Error(t('errors.telegramTokenRejected'));

            return {
                success: true,
                message: t('admin.telegramBotAvailable', {name: ((response.data.result || {}).username || (response.data.result || {}).first_name || 'ok')}),
            };
        }

        throw new Error(t('errors.unknownTestType'));
    },

    //отправки профиля (email и Telegram вместе) за последний час: открытый SMTP или бот не должны стать рассылкой
    checkDeliveryRate(userId) {
        const limit = Math.max(1, Math.min(1000, parseInt(this.config.deliveryRateLimit, 10) || 20));
        const now = Date.now();
        if (!this.deliverySends)
            this.deliverySends = new Map();
        const times = (this.deliverySends.get(userId) || []).filter(time => now - time < deliveryWindowMs);
        if (times.length >= limit)
            throw new Error(t('errors.deliveryRateLimit', {n: limit}));
        times.push(now);
        this.deliverySends.set(userId, times);
    },

    async sendBookToTelegram(bookUid, format = '', userId = '') {
        const {currentUser} = await this.readingListStore.getUsers(userId);
        const chatId = String((currentUser && currentUser.telegramChatId) || '').trim();
        if (!this.config.telegramShareEnabled)
            throw new Error(t('errors.telegramDisabled'));
        if (!this.config.telegramBotToken)
            throw new Error(t('errors.telegramTokenMissing'));
        if (!chatId)
            throw new Error(t('errors.telegramChatIdMissing'));
        this.checkDeliveryRate(currentUser.id);

        const {book, rawFile, downFileName} = await this.getPreparedBookFile(bookUid, format);
        this.addAdminEvent('info', 'delivery', msg('admin.deliveryTelegramSending', {title: book.title || downFileName}));
        const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendDocument`;
        const form = new FormData();

        form.append('chat_id', chatId);
        form.append('caption', formatTemplate(this.config.telegramCaptionTemplate, book).trim());
        form.append('document', fs.createReadStream(rawFile), downFileName);

        const response = await axios.post(url, form, {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 300000,
        });

        if (!response.data || response.data.ok !== true)
            throw new Error(t('errors.telegramFileRejected'));

        this.addAdminEvent('info', 'delivery', msg('admin.deliveryTelegramSent', {title: book.title || downFileName}));
        return {success: true};
    },

    async sendBookToEmail(bookUid, format = '', userId = '') {
        const {currentUser} = await this.readingListStore.getUsers(userId);
        const emailTo = String((currentUser && currentUser.emailTo) || this.config.emailTo || '').trim();
        if (!this.config.emailShareEnabled || !this.config.smtpHost || !emailTo)
            throw new Error(t('errors.emailNotConfigured'));
        this.readingListStore.validateEmailTo(emailTo);
        this.checkDeliveryRate(currentUser.id);

        const {book, rawFile, downFileName} = await this.getPreparedBookFile(bookUid, format);
        this.addAdminEvent('info', 'delivery', msg('admin.deliveryEmailSending', {title: book.title || downFileName}), {
            to: emailTo,
            format: format || book.ext || '',
        });
        const transporter = nodemailer.createTransport(this.buildSmtpTransportOptions());

        const subject = [book.author, book.title].filter(Boolean).join(' - ') || downFileName;
        try {
            await transporter.sendMail({
                from: this.config.emailFrom || this.config.smtpUser || 'inpx-shelf@localhost',
                to: emailTo,
                subject: t('delivery.emailSubject', {subject}),
                text: t('delivery.emailText', {title: book.title || downFileName}),
                attachments: [
                    {
                        filename: downFileName,
                        path: rawFile,
                    },
                ],
            });
        } catch (err) {
            const response = String((err && (err.response || err.message)) || 'SMTP error');
            const code = (err && (err.responseCode || err.code)) || '';
            this.addAdminEvent('error', 'delivery', msg('errors.emailNotSent', {details: response}), {
                to: emailTo,
                code,
                command: err && err.command,
                rejected: err && err.rejected,
                rejectedErrors: err && err.rejectedErrors ? err.rejectedErrors.map(item => ({
                    recipient: item.recipient,
                    response: item.response,
                    responseCode: item.responseCode,
                    command: item.command,
                })) : undefined,
            });
            throw new Error(t('errors.emailNotSent', {details: response}));
        }

        this.addAdminEvent('info', 'delivery', msg('admin.deliveryEmailSent', {title: book.title || downFileName}));
        return {success: true};
    },
};
