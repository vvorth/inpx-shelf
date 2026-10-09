const utils = require('../utils');
const BasePage = require('./BasePage');
const {t} = require('./i18n');

class ReadingListsPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'reading-lists';
        this.title = 'Списки чтения';
    }

    async body(req) {
        const result = {};
        const entry = [];
        const userId = this.getScopeUserId(req);

        if (!userId) {
            entry.push(
                this.makeEntry({
                    id: 'no-user',
                    title: t('[Выберите профиль пользователя]'),
                    link: this.navLink({href: '/reading-profiles', req}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': t('Для OPDS-подборок откройте профиль пользователя'),
                    },
                }),
            );

            result.entry = entry;
            return this.makeBody(result, req);
        }

        const response = await this.webWorker.getReadingLists(userId, '', {visibility: 'opds'});
        for (const item of response.lists) {
            entry.push(
                this.makeEntry({
                    id: item.id,
                    title: item.name,
                    link: this.navLink({href: `/${this.id}/list?id=${encodeURIComponent(item.id)}`, req}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': t('{read}/{n} книг{e} прочитано', {read: item.readCount || 0, n: item.bookCount, e: utils.wordEnding(item.bookCount, 8)}),
                    },
                }),
            );
        }

        if (!entry.length) {
            entry.push(
                this.makeEntry({
                    id: 'empty',
                    title: t('[Списков пока нет]'),
                    link: this.navLink({href: `/${this.id}`, req}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': t('Создайте список в веб-интерфейсе и переведите его в режим OPDS'),
                    },
                }),
            );
        }

        result.entry = entry;
        return this.makeBody(result, req);
    }
}

module.exports = ReadingListsPage;
