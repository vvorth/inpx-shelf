const BasePage = require('./BasePage');
const {t} = require('../i18n');

class SeriesPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'series';
        this.title = 'opds.series';
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

                for (const book of sorted)
                    entry.push(this.bookEntry(book));
            }
        } else {
            entry.push(...await this.catalogEntries('series', query, t('opds.otherSeries'), 'series.foundCount', rec => (rec.count ? rec.title : t('common.seriesWithName', {name: rec.title}))));
        }

        result.entry = entry;
        return this.makeBody(result, req);
    }
}

module.exports = SeriesPage;