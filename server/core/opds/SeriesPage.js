const BasePage = require('./BasePage');
const {t} = require('../i18n');

class SeriesPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'series';
        this.title = 'opds.series';
    }

    sortSeriesBooks(seriesBooks) {
        seriesBooks.sort((a, b) => {
            const dserno = (a.serno || Number.MAX_VALUE) - (b.serno || Number.MAX_VALUE);
            const dtitle = a.title.localeCompare(b.title);
            const dext = a.ext.localeCompare(b.ext);
            return (dserno ? dserno : (dtitle ? dtitle : dext));        
        });

        return seriesBooks;
    }

    async body(req) {
        const result = {};

        const query = {
            series: req.query.series || '',
            genre: req.query.genre || '',
            del: '0',
            
            all: req.query.all || '',
            depth: 0,
        };
        query.depth = query.series.length + 1;

        if (query.series == '___others') {
            query.series = '';
            query.depth = 1;
            query.others = true;
        }

        const entry = [];
        if (query.series && query.series[0] == '=') {
            //книги по серии
            const bookList = await this.webWorker.getSeriesBookList(query.series.substring(1));

            if (bookList.books) {
                let books = bookList.books;
                const booksAll = this.filterBooks(books);
                const filtered = (query.all ? booksAll : this.filterBooks(books, query));
                const sorted = this.sortSeriesBooks(filtered);

                if (booksAll.length > filtered.length) {
                    entry.push(
                        this.makeEntry({
                            id: 'all_series_books',
                            title: t('opds.allBooksSeries'),
                            link: this.navLink({
                                href: `/${this.id}?series=${encodeURIComponent(query.series)}&all=1`}),
                        })
                    );
                }

                for (const book of sorted) {
                    const title = `${book.serno ? `${book.serno}. `: ''}${book.title || t('common.untitled')} (${book.ext})`;

                    entry.push(
                        this.makeEntry({
                            id: book._uid,
                            title,
                            link: this.acqLink({href: `/book?uid=${encodeURIComponent(book._uid)}`}),
                            content: {
                                '*ATTRS': {type: 'text'},
                                '*TEXT': this.bookAuthor(book.author),
                            },
                        })
                    );
                }
            }
        } else {
            if (query.depth == 1 && !query.genre && !query.others) {
                entry.push(
                    this.makeEntry({
                        id: 'select_genre',
                        title: t('opds.chooseGenre'),
                        link: this.navLink({href: `/genre?from=${this.id}`}),
                    })
                );
            }

            //навигация по каталогу
            const queryRes = await this.opdsQuery('series', query, t('opds.otherSeries'));

            for (const rec of queryRes) {
                const e = {
                    id: rec.id,
                    title: (rec.count ? rec.title : t('common.seriesWithName', {name: rec.title})),
                    link: this.navLink({href: `/${this.id}?series=${rec.q}&genre=${encodeURIComponent(query.genre)}`}),
                };

                let countStr = '';
                if (rec.count)
                    countStr = `${t('series.foundCount', {n: rec.count})}${(query.genre ? t('opds.selectedGenre') : '')}`;
                if (!countStr && rec.bookCount && !query.genre)
                    countStr = t('common.bookCount', {n: rec.bookCount});

                if (countStr) {
                    e.content = {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': countStr,
                    };
                }

                entry.push(this.makeEntry(e));
            }
        }

        result.entry = entry;
        return this.makeBody(result, req);
    }
}

module.exports = SeriesPage;