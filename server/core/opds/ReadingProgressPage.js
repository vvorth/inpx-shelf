const BasePage = require('./BasePage');
const {t} = require('../i18n');

class ReadingProgressPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'reading-progress';
        this.title = 'opds.myReading';
    }

    stateTitle(state = 'reading') {
        switch (state) {
            case 'read':
                return t('common.read');
            case 'hidden':
                return t('opds.hidden');
            case 'all':
                return t('opds.allProfileBooks');
            case 'reading':
            default:
                return t('opds.continueReading');
        }
    }

    stateDescription(state = 'reading') {
        switch (state) {
            case 'read':
                return t('opds.booksMarkedAsRead');
            case 'hidden':
                return t('opds.booksHiddenFromCurrent');
            case 'all':
                return t('opds.allBooksPersonalProgress');
            case 'reading':
            default:
                return t('opds.booksCurrentlyBeingRead');
        }
    }

    myEntry(req = null, state = 'reading', count = 0) {
        const title = this.stateTitle(state);
        return this.makeEntry({
            id: `${this.id}-${state}`,
            title,
            link: this.navLink({href: `/${this.id}`, req, query: {state}}),
            content: {
                '*ATTRS': {type: 'text'},
                '*TEXT': count ? t('common.bookCount', {n: count}) : this.stateDescription(state),
            },
        });
    }

    async body(req) {
        const state = String(req.query.state || 'reading').trim();
        const userId = this.getScopeUserId(req);
        if (!userId)
            throw new Error('user is empty');

        const response = await this.webWorker.getOpdsUserReadingLibrary(userId, {
            state,
            sort: 'updatedDesc',
            limit: 300,
        });
        const result = {};
        const entry = [];

        this.title = this.stateTitle(response.state);

        for (const book of response.items || []) {
            const percent = Math.max(0, Math.min(100, Math.round((Number(book.percent || 0) || 0) * 100)));
            const title = `${book.state === 'read' ? '✓ ' : ''}${book.serno ? `${book.serno}. ` : ''}${book.title || t('common.untitled')}${book.ext ? ` (${book.ext})` : ''}`;
            const subtitle = [
                this.bookAuthor(book.author),
                book.series ? t('common.seriesWithName', {name: book.series}) : '',
                `${percent}%`,
                book.hidden ? t('opds.hidden') : '',
                book.unavailable ? t('opds.progressSavedButBook') : '',
            ].filter(Boolean).join(' · ');

            entry.push(
                this.makeEntry({
                    id: book.bookUid,
                    title,
                    link: book.unavailable
                        ? this.navLink({href: `/${this.id}`, req, query: {state: response.state}})
                        : this.acqLink({href: `/book?uid=${encodeURIComponent(book.bookUid)}`, req}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': subtitle,
                    },
                }),
            );
        }

        if (!entry.length) {
            entry.push(
                this.makeEntry({
                    id: 'empty',
                    title: t('opds.noBooksYet'),
                    link: this.navLink({href: `/${this.id}`, req, query: {state: response.state}}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': this.stateDescription(response.state),
                    },
                }),
            );
        }

        result.entry = entry;
        return this.makeBody(result, req);
    }
}

module.exports = ReadingProgressPage;
