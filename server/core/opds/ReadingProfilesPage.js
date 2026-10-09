const BasePage = require('./BasePage');
const {t} = require('./i18n');

class ReadingProfilesPage extends BasePage {
    constructor(config) {
        super(config);

        this.id = 'reading-profiles';
        this.title = 'Подборки пользователей';
    }

    async body(req) {
        const result = {};
        const entry = [];
        let users = await this.webWorker.getOpdsUsers();
        if (req.profileAccessIdentity && req.profileAccessIdentity.user)
            users = users.filter(user => user.id === req.profileAccessIdentity.user.id);

        for (const item of users) {
            entry.push(
                this.makeEntry({
                    id: item.id,
                    title: item.name,
                    link: this.navLink({href: '/root', req, query: {user: item.publicId || item.id}}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': t('Списков: {lists}, в чтении: {reading}', {lists: item.opdsListCount, reading: item.opdsProgressCount || 0}),
                    },
                }),
            );
        }

        if (!entry.length) {
            entry.push(
                this.makeEntry({
                    id: 'empty',
                    title: t('[Публичных подборок пока нет]'),
                    link: this.navLink({href: `/${this.id}`, req}),
                    content: {
                        '*ATTRS': {type: 'text'},
                        '*TEXT': t('Включите публикацию списков в профиле и переведите нужные списки в режим OPDS'),
                    },
                }),
            );
        }

        result.entry = entry;
        return this.makeBody(result, req);
    }
}

module.exports = ReadingProfilesPage;
