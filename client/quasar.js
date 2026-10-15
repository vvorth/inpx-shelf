import 'quasar/dist/quasar.css';
import {
    Quasar, QLinearProgress, QInput, QBtn, QBtnToggle, QIcon, QTooltip, QCheckbox, QToggle, QSelect,
    QDialog, QSpace, QSpinner, QMenu, Ripple, ClosePopup, Dark, Notify,
} from 'quasar';
import lang from 'quasar/lang/ru';
import langEn from 'quasar/lang/en-US';
import '@quasar/extras/line-awesome/line-awesome.css';
import lineAwesome from 'quasar/icon-set/line-awesome.js';

//только компоненты из шаблонов: каждый зарегистрированный попадает в бандл, даже если не используется
const components = {
    QLinearProgress, QInput, QBtn, QBtnToggle, QIcon, QTooltip, QCheckbox, QToggle, QSelect,
    QDialog, QSpace, QSpinner, QMenu,
};

export default {
    quasar: Quasar,
    langs: {ru: lang, en: langEn},
    options: {
        config: {},
        components,
        directives: {Ripple, ClosePopup},
        plugins: {Dark, Notify},
        lang,
    },
    init: () => {
        Quasar.iconSet.set(lineAwesome);
    },
};
