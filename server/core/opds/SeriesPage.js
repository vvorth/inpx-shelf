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

            if (bookList.books)
                entry.push(...this.seriesEntries(bookList.books, query, `/${this.id}?series=${encodeURIComponent(query.series)}&all=1`));
        } else {
            entry.push(...await this.catalogEntries('series', query, t('opds.otherSeries'), 'series.foundCount', rec => (rec.count ? rec.title : t('common.seriesWithName', {name: rec.title}))));
        }

        result.entry = entry;
        return this.makeBody(result, req);
    }
}

module.exports = SeriesPage;