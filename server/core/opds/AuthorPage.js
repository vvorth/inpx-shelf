const BasePage = require('./BasePage');
const {t} = require('../i18n');

class AuthorPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'author';
        this.title = 'opds.authors';
    }

    sortBooks(bookList) {
        //схлопывание серий
        const books = [];
        const seriesMap = new Map();
        for (const book of bookList) {
            if (book.series) {
                let seriesIndex = seriesMap.get(book.series);
                if (seriesIndex === undefined) {
                    seriesIndex = books.length;
                    books.push({
                        type: 'series',
                        book,
                        bookCount: 0,
                    });

                    seriesMap.set(book.series, seriesIndex);
                }

                books[seriesIndex].bookCount++;
            } else {
                books.push({
                    type: 'book',
                    book
                });
            }
        }

        //сортировка
        books.sort((a, b) => {
            if (a.type == 'series') {
                return (b.type == 'series' ? a.book.series.localeCompare(b.book.series) : -1);
            } else {
                return (b.type == 'book' ? a.book.title.localeCompare(b.book.title) : 1);
            }
        });

        return books;
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
            author: req.query.author || '',
            series: req.query.series || '',
            genre: req.query.genre || '',
            del: '0',
            
            all: req.query.all || '',
            depth: 0,
        };
        query.depth = query.author.length + 1;

        if (query.author == '___others') {
            query.author = '';
            query.depth = 1;
            query.others = true;
        }

        const entry = [];
        if (query.series) {
            //книги по серии
            const bookList = await this.webWorker.getSeriesBookList(query.series);

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
                                href: `/${this.id}?author=${encodeURIComponent(query.author)}` +
                                    `&series=${encodeURIComponent(query.series)}&all=1`}),
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
        } else if (query.author && query.author[0] == '=') {
            //книги по автору
            const bookList = await this.webWorker.getAuthorBookList(0, query.author.substring(1));

            if (bookList.books) {
                let books = bookList.books;
                books = this.sortBooks(this.filterBooks(books, query));

                for (const b of books) {
                    if (b.type == 'series') {
                        entry.push(
                            this.makeEntry({
                                id: b.book._uid,
                                title: t('common.seriesWithName', {name: b.book.series}),
                                link: this.navLink({
                                    href: `/${this.id}?author=${encodeURIComponent(query.author)}` +
                                        `&series=${encodeURIComponent(b.book.series)}&genre=${encodeURIComponent(query.genre)}`}),
                                content: {
                                    '*ATTRS': {type: 'text'},
                                    '*TEXT': `${t('opds.booksByAuthor', {n: b.bookCount})}${(query.genre ? t('opds.selectedGenre') : '')}`,
                                },
                            })
                        );
                    } else {
                        const title = `${b.book.title || t('common.untitled')} (${b.book.ext})`;
                        entry.push(
                            this.makeEntry({
                                id: b.book._uid,
                                title,
                                link: this.acqLink({href: `/book?uid=${encodeURIComponent(b.book._uid)}`}),
                                content: {
                                    '*ATTRS': {type: 'text'},
                                    '*TEXT': this.bookAuthor(b.book.author),
                                },
                            })
                        );
                    }
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
            const queryRes = await this.opdsQuery('author', query, t('opds.otherAuthors'));

            for (const rec of queryRes) {
                const e = {
                    id: rec.id,
                    title: this.bookAuthor(rec.title),
                    link: this.navLink({href: `/${this.id}?author=${rec.q}&genre=${encodeURIComponent(query.genre)}`}),
                };

                let countStr = '';
                if (rec.count)
                    countStr = `${t('authors.foundCount', {n: rec.count})}${(query.genre ? t('opds.selectedGenre') : '')}`;
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

module.exports = AuthorPage;