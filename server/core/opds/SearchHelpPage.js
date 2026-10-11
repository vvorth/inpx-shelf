const BasePage = require('./BasePage');
const {t} = require('../i18n');

class SearchHelpPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'search_help';
        this.title = 'opds.searchHelp2';

    }

    async body(req) {
        const result = {};

        result.link = this.baseLinks(req, true);

        const content = t('opds.searchHelpHtml');
        const entry = [
            this.makeEntry({
                id: 'help',
                title: t(this.title),
                content: {
                    '*ATTRS': {type: 'text/html'},
                    '*TEXT': this.escape(content),
                },
                link: [
                    this.downLink({href: '/book/fake-link', type: `application/fb2+zip`})
                ],
            })
        ];

        result.entry = entry;

        return this.makeBody(result, req);
    }
}

module.exports = SearchHelpPage;