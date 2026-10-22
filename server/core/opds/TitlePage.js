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
            //книги по названию, по 100 на страницу. Название (без учёта регистра, ё и знаков, как в счётчике каталога),
            //жанр и удалённые отбирает запрос к БД: фильтр после него сбил бы страницы
            const page = parseInt(req.query.page, 10) || 1;
            const limit = 100;
            const offset = (page - 1)*limit;
            const {books, totalFound} = await this.webWorker.catalogSearch.findBooks({title: query.title, genre: query.genre, del: query.del, offset, limit});

            for (const book of books)
                entry.push(this.bookEntry(book));

            if (totalFound > offset + limit) {
                entry.push(
                    this.makeEntry({
                        id: 'next_page',
                        title: t('opds.nextPage'),
                        link: this.navLink({href: `/${this.id}?title=${encodeURIComponent(query.title)}&genre=${encodeURIComponent(query.genre)}&page=${page + 1}`}),
                    })
                );
            }
        } else {
            entry.push(...await this.catalogEntries('title', query, t('opds.otherTitles'), 'opds.titleCount'));
        }

        result.entry = entry;
        return this.makeBody(result, req);
    }
}

module.exports = TitlePage;