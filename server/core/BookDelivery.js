const fs = require('fs-extra');
const axios = require('axios');
const FormData = require('form-data');
const nodemailer = require('nodemailer');

// Sending books to Telegram and email, and checking those integrations. Mixed into
// WebWorker.prototype: `this` is the worker.

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
                throw new Error('SMTP host не указан');

            const transporter = nodemailer.createTransport(this.buildSmtpTransportOptions());
            await transporter.verify();
            return {success: true, message: 'SMTP подключение проверено'};
        }

        if (normalizedKind === 'telegram') {
            if (!this.config.telegramBotToken)
                throw new Error('Telegram bot token не указан');

            const response = await axios.get(`https://api.telegram.org/bot${this.config.telegramBotToken}/getMe`, {
                timeout: 15000,
            });

            if (!response.data || response.data.ok !== true)
                throw new Error('Telegram API не принял токен');

            return {
                success: true,
                message: `Telegram бот доступен: ${((response.data.result || {}).username || (response.data.result || {}).first_name || 'ok')}`,
            };
        }

        throw new Error('Неизвестный тип проверки');
    },

    async sendBookToTelegram(bookUid, format = '', userId = '') {
        const {currentUser} = await this.readingListStore.getUsers(userId);
        const chatId = String((currentUser && currentUser.telegramChatId) || '').trim();
        if (!this.config.telegramShareEnabled)
            throw new Error('Отправка в Telegram отключена в настройках');
        if (!this.config.telegramBotToken)
            throw new Error('Telegram bot token не указан');
        if (!chatId)
            throw new Error('Telegram chat id не указан в текущем профиле пользователя');

        const {book, rawFile, downFileName} = await this.getPreparedBookFile(bookUid, format);
        this.addAdminEvent('info', 'delivery', `Отправка книги в Telegram: ${book.title || downFileName}`);
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
            throw new Error('Telegram API не принял файл');

        this.addAdminEvent('info', 'delivery', `Книга отправлена в Telegram: ${book.title || downFileName}`);
        return {success: true};
    },

    async sendBookToEmail(bookUid, format = '', userId = '') {
        const {currentUser} = await this.readingListStore.getUsers(userId);
        const emailTo = String((currentUser && currentUser.emailTo) || this.config.emailTo || '').trim();
        if (!this.config.emailShareEnabled || !this.config.smtpHost || !emailTo)
            throw new Error('Отправка на email не настроена');

        const {book, rawFile, downFileName} = await this.getPreparedBookFile(bookUid, format);
        this.addAdminEvent('info', 'delivery', `Отправка книги на email: ${book.title || downFileName}`, {
            to: emailTo,
            format: format || book.ext || '',
        });
        const transporter = nodemailer.createTransport(this.buildSmtpTransportOptions());

        const subject = [book.author, book.title].filter(Boolean).join(' - ') || downFileName;
        try {
            await transporter.sendMail({
                from: this.config.emailFrom || this.config.smtpUser || 'inpx-web@localhost',
                to: emailTo,
                subject: `Книга: ${subject}`,
                text: `Во вложении книга "${book.title || downFileName}".`,
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
            const message = `Email не отправлен: ${response}`;
            this.addAdminEvent('error', 'delivery', message, {
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
            throw new Error(message);
        }

        this.addAdminEvent('info', 'delivery', `Книга отправлена на email: ${book.title || downFileName}`);
        return {success: true};
    },
};
