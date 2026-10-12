const BasePage = require('./BasePage');
const {t} = require('../i18n');

class TitlePage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'title';
        this.title = 'opds.books';
    }

    async body(req) {
        const result = {};

        const query = {
            title: req.query.title || '',
            genre: req.query.genre || '',
            del: '0',
            
            depth: 0,
        };
        query.depth = query.title.length + 1;

        if (query.title == '___others') {
            query.title = '';
            query.depth = 1;
            query.others = true;
        }

        const entry = [];
        if (query.title && query.title[0] == '=') {
            //книги по названию
            const res = await this.webWorker.catalogSearch.call('findBooks', {title: query.title, genre: query.genre, del: query.del, limit: 1000});
            const books = await this.webWorker.catalogSearch.loadBooks(res.ids);

            if (books.length) {
                const filtered = this.filterBooks(books, query);

                for (const book of filtered)
                    entry.push(this.bookEntry(book));
            }
        } else {
            entry.push(...await this.catalogEntries('title', query, t('opds.otherTitles'), 'opds.titleCount'));
        }

        result.entry = entry;
        return this.makeBody(result, req);
    }
}

module.exports = TitlePage;