const BasePage = require('./BasePage');
const {t} = require('../i18n');

class ReadingListsPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'reading-lists';
        this.title = 'opds.readingLists';
    }

    async body(req) {
        const result = {};
        const entry = [];
        const userId = this.getScopeUserId(req);

        if (!userId) {
            entry.push(
                this.makeEntry({
                    id: 'no-user',
                    title: t('opds.chooseUserProfile'),
                    link: this.navLink({href: '/reading-profiles', req}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': t('opds.openUserProfileOpds'),
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
                        '*TEXT': t('opds.readOfTotal', {read: item.readCount || 0, n: item.bookCount}),
                    },
                }),
            );
        }

        if (!entry.length) {
            entry.push(
                this.makeEntry({
                    id: 'empty',
                    title: t('opds.noListsYet'),
                    link: this.navLink({href: `/${this.id}`, req}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': t('opds.createListWebInterface'),
                    },
                }),
            );
        }

        result.entry = entry;
        return this.makeBody(result, req);
    }
}

module.exports = ReadingListsPage;
