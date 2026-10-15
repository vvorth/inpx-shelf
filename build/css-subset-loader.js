const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

//Из CSS Quasar и Line Awesome в сборку попадает только то, что использует приложение:
//без этого первая загрузка тянет ~300 КБ стилей ради нескольких компонентов и сотни иконок.

const clientDir = path.resolve(__dirname, '../client');
const quasarIconSet = require.resolve('quasar/icon-set/line-awesome.js');

//Компоненты Quasar, которых нет ни в шаблонах, ни внутри используемых компонентов (QSelect, QBtnToggle, Notify...).
//Компонент из этого списка нельзя зарегистрировать в client/quasar.js: это проверяет тест в scripts/client-tests.js.
const unusedQuasarComponents = [
    'q-bar', 'q-banner', 'q-bottom-sheet', 'q-btn-dropdown', 'q-card', 'q-carousel', 'q-chat', 'q-circular-progress',
    'q-color-picker', 'q-date', 'q-drawer', 'q-editor', 'q-expansion-item', 'q-fab', 'q-footer', 'q-header', 'q-img',
    'q-infinite-scroll', 'q-intersection', 'q-knob', 'q-layout', 'q-loading', 'q-loading-bar', 'q-markup-table', 'q-message',
    'q-option-group', 'q-page', 'q-page-container', 'q-page-sticky', 'q-pagination', 'q-panel', 'q-panel-parent', 'q-parallax',
    'q-pull-to-refresh', 'q-radio', 'q-range', 'q-rating', 'q-responsive', 'q-scrollarea', 'q-skeleton', 'q-slide-item',
    'q-slider', 'q-splitter', 'q-stepper', 'q-tab', 'q-tab-panel', 'q-tab-panels', 'q-table', 'q-tabs', 'q-time',
    'q-timeline', 'q-toolbar', 'q-tree', 'q-uploader', 'q-video',
];

function walk(dir, result = []) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory())
            walk(fullPath, result);
        else if (/\.(vue|js)$/.test(entry.name))
            result.push(fullPath);
    }
    return result;
}

//Имена иконок пишутся в коде целиком ('la la-check'): собираем все la-* из клиента и набора иконок Quasar
function usedIcons() {
    const icons = new Set();
    for (const file of [...walk(clientDir), quasarIconSet]) {
        for (const m of fs.readFileSync(file, 'utf8').matchAll(/\bla-[a-z0-9]+(?:-[a-z0-9]+)*/g))
            icons.add(m[0]);
    }
    return icons;
}

//Правила иконок (.la-name:before и совместимые с FA4 .la.la-name:before, .la.la-name) остаются только для используемых,
//остальной CSS (шрифты, .la, .la-spin и т.п.) - как есть
function lineAwesomeSubset(css, icons) {
    const root = postcss.parse(css);
    const iconSelector = /^(?:\.la)?\.(la-[a-z0-9-]+)(:before)?$/;
    const allIcons = new Set();
    root.walkRules(rule => rule.selectors.forEach((selector) => {
        const m = selector.match(iconSelector);
        if (m && m[2])
            allIcons.add(m[1]);
    }));
    root.walkRules((rule) => {
        const selectors = rule.selectors.filter((selector) => {
            const m = selector.match(iconSelector);
            return !m || !allIcons.has(m[1]) || icons.has(m[1]);
        });
        if (!selectors.length)
            rule.remove();
        else
            rule.selectors = selectors;
    });
    return root.toString();
}

function quasarSubset(css) {
    const unused = new Set(unusedQuasarComponents);
    const root = postcss.parse(css);
    root.walkRules((rule) => {
        if (rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name))
            return;
        //.q-table__top, .q-tab--active: имя компонента - до модификатора или элемента
        const selectors = rule.selectors.filter(selector => ![...selector.matchAll(/\.(q-[a-z0-9-]+?)(?=--|__|[^a-z0-9-]|$)/g)].some(m => unused.has(m[1])));
        if (!selectors.length)
            rule.remove();
        else
            rule.selectors = selectors;
    });
    root.walkAtRules((atRule) => {
        if (atRule.nodes && !atRule.nodes.length)
            atRule.remove();
    });
    return root.toString();
}

module.exports = function(source) {
    if (path.basename(this.resourcePath) === 'line-awesome.css') {
        //новая иконка в клиенте должна попасть в сборку и в режиме разработки
        this.addContextDependency(clientDir);
        return lineAwesomeSubset(source, usedIcons());
    }
    return quasarSubset(source);
};

Object.assign(module.exports, {unusedQuasarComponents, usedIcons, lineAwesomeSubset, quasarSubset});
