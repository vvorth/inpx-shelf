const BasePage = require('./BasePage');
const iconv = require('iconv-lite');
const {t} = require('../i18n');

class SearchPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'search';
        this.title = 'opds.search';
    }

    async searchBooks(term = '', genre = '') {
        const normalized = String(term || '').trim();
        if (!normalized)
            return [];

        const queries = [
            {title: `*${normalized}`, genre, del: '0', limit: 120, offset: 0},
            {series: `*${normalized}`, genre, del: '0', limit: 120, offset: 0},
            {author: `*${normalized}`, genre, del: '0', limit: 120, offset: 0},
        ];

        const result = [];
        const seen = new Set();

        for (const query of queries) {
            const res = await this.webWorker.catalogSearch.findBooks(query);
            for (const book of res.books) {
                if (!book || seen.has(book._uid))
                    continue;

                seen.add(book._uid);
                result.push(book);
            }
        }

        return result;
    }

    async body(req) {
        const result = {};

        const query = {
            type: req.query.type || '',
            term: req.query.term || '',
            genre: req.query.genre || '',
            page: parseInt(req.query.page, 10) || 1,
        };

        let entry = [];
        if (query.type) {
            if (query.type == 'title') {
                try {
                    let found = await this.searchBooks(query.term, query.genre);

                    if (!found.length) {
                        const fallbackTerm = iconv.encode(query.term, 'ISO-8859-1').toString();
                        found = await this.searchBooks(fallbackTerm, query.genre);
                    }

                    const page = query.page;
                    const limit = 100;
                    const offset = (page - 1)*limit;
                    const pageItems = found.slice(offset, offset + limit);

                    for (const book of pageItems) {
                        const subtitle = [this.bookAuthor(book.author), book.series ? t('common.seriesWithName', {name: book.series}) : ''].filter(Boolean).join(' · ');

                        entry.push(this.bookEntry(book, undefined, subtitle));
                    }

                    if (found.length > offset + pageItems.length) {
                        entry.push(
                            this.makeEntry({
                                id: 'next_page',
                                title: t('opds.nextPage'),
                                link: this.navLink({href: `/${this.id}?type=title&term=${encodeURIComponent(query.term)}&genre=${encodeURIComponent(query.genre)}&page=${page + 1}`}),
                            })
                        );
                    }
                } catch(e) {
                    entry.push(
                        this.makeEntry({
                            id: 'error',
                            title: t('common.errorWithMessage', {message: e.message}),
                            link: this.navLink({href: `/fake-error-link`}),
                        })
                    );
                }
            } else if (['author', 'series'].includes(query.type)) {
                try {
                    const from = query.type;
                    const page = query.page;

                    const limit = 100;
                    const offset = (page - 1)*limit;

                    const searchQuery = {[from]: query.term, genre: query.genre, del: '0', offset, limit};
                    let queryRes = await this.webWorker.catalogSearch.call('opdsNames', from, searchQuery);
                    
                    if (queryRes.totalFound === 0) {
                        searchQuery[from] = iconv.encode(query.term, 'ISO-8859-1').toString();
                        queryRes = await this.webWorker.catalogSearch.call('opdsNames', from, searchQuery);
                    }

                    const found = queryRes.found;

                    for (let i = 0; i < found.length; i++) {
                        const row = found[i];
                        if (!row.bookCount)
                            continue;

                        entry.push(
                            this.makeEntry({
                                id: row.id,
                                title: `${(from === 'series' ? t('opds.series2') : '')}${from === 'author' ? this.bookAuthor(row[from]) : row[from]}`,
                                link: this.navLink({href: `/${from}?${from}==${encodeURIComponent(row[from])}`}),
                                content: {
                                    '*ATTRS': {type: 'text'},
                                    '*TEXT': t('common.bookCount', {n: row.bookCount}),
                                },
                            }),
                        );
                    }

                    if (queryRes.totalFound > offset + found.length) {
                        entry.push(
                            this.makeEntry({
                                id: 'next_page',
                                title: t('opds.nextPage'),
                                link: this.navLink({href: `/${this.id}?type=${from}&term=${encodeURIComponent(query.term)}&genre=${encodeURIComponent(query.genre)}&page=${page + 1}`}),
                            })
                        );
                    }
                } catch(e) {
                    entry.push(
                        this.makeEntry({
                            id: 'error',
                            title: t('common.errorWithMessage', {message: e.message}),
                            link: this.navLink({href: `/fake-error-link`}),
                        })
                    );
                }
            }
        } else {
            entry = [
                this.makeEntry({
                    id: 'search_author',
                    title: t('opds.searchAuthors'),
                    link: this.navLink({href: `/${this.id}?type=author&term=${encodeURIComponent(query.term)}`}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': t('opds.searchAuthorNames'),
                    },
                }),
                this.makeEntry({
                    id: 'search_series',
                    title: t('opds.searchSeries'),
                    link: this.navLink({href: `/${this.id}?type=series&term=${encodeURIComponent(query.term)}`}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': t('opds.searchSeriesTitles'),
                    },
                }),
                this.makeEntry({
                    id: 'search_title',
                    title: t('opds.searchBooks'),
                    link: this.navLink({href: `/${this.id}?type=title&term=${encodeURIComponent(query.term)}`}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': t('opds.searchBooksWordTitle'),
                    },
                }),
                this.makeEntry({
                    id: 'search_genre',
                    title: t('opds.searchBooksGenre'),
                    link: this.navLink({href: `/genre?from=search&term=${encodeURIComponent(query.term)}`}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': t('opds.searchBookTitlesSelected'),
                    },
                }),
                this.makeEntry({
                    id: 'search_help',
                    title: t('opds.searchHelp'),
                    link: this.acqLink({href: `/search-help`}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': t('opds.searchValueFormatDescription'),
                    },
                }),
            ];
        }

        result.entry = entry;
        return this.makeBody(result, req);
    }
}

module.exports = SearchPage;
